// Package api is the host's HTTP server: GET /health, GET /api/tools,
// POST /api/tools/call and POST /api/hook (contract/errors.json), behind the
// Host / browser-origin guard, the body limit and the rate limits. Tools and
// the hook handler are registered by the core and agents packages.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/n2ns/n2n-nexus/host/internal/clock"
	"github.com/n2ns/n2n-nexus/host/internal/protocol"
	"github.com/n2ns/n2n-nexus/host/internal/testhooks"
)

// MaxBodyBytes is the request body limit (contract/errors.json).
const MaxBodyBytes = 16 << 20

// AddressLimitFactor: instance ids are self-declared, so every request is also
// counted per client address at this multiple of the per-instance limit.
const AddressLimitFactor = 5

// UnknownInstance is the actor recorded for tool calls that name no instance.
const UnknownInstance = "unknown"

// Caller is who calls a tool, as the MCP adapter read it from the request _meta.
type Caller struct {
	Client    string `json:"client"`
	ToolUseID string `json:"toolUseId,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
}

// Call is one tool call.
type Call struct {
	Ctx context.Context
	// InstanceID is the calling adapter's instance, or "" when the request named none.
	InstanceID string
	// Caller is set only when the request carried a well-formed caller.
	Caller *Caller
	// Session is the conversation Options.SessionOf found for Caller, "" when
	// none was found (or SessionOf is not set).
	Session string
	// Args passed the tool's input schema; handlers decode them into their own struct.
	Args json.RawMessage
}

// Tool decodes the (already schema-validated) arguments over defaults, which
// carries the defaults the JSON Schema declares but does not apply.
func Tool[A any](defaults A, fn func(c Call, args A) (any, error)) ToolFunc {
	return func(c Call) (any, error) {
		args := defaults
		if err := json.Unmarshal(c.Args, &args); err != nil {
			return nil, Errorf("Invalid arguments: %v", err)
		}
		return fn(c, args)
	}
}

// Actor is the instance to record in events: InstanceID, or "unknown".
func (c Call) Actor() string {
	if c.InstanceID == "" {
		return UnknownInstance
	}
	return c.InstanceID
}

// Platforms maps each platform a session's hooks may report to how it is shown.
var Platforms = map[string]string{"darwin": "macOS", "linux": "Linux", "wsl": "WSL", "win32": "Windows"}

// Identity is who a chat or meeting tool call acts as: the conversation when
// its hooks made it known, else the adapter instance.
type Identity struct {
	// Kind is IdentitySession or IdentityInstance.
	Kind string
	// ID is the session key (claude:<id> / codex:<id>) or the instance id.
	ID string
	// Name is the session's name; "" for an instance.
	Name string
	// Instance is the calling adapter's instance (Call.Actor()), kept for events.
	Instance string
}

// Identity kinds.
const (
	IdentitySession  = "session"
	IdentityInstance = "instance"
)

// IdentityResolver resolves the identity of a call. It uses the database and
// must be called outside any store transaction (the store has one connection).
// It returns a ToolError when the call names a conversation that cannot be
// resolved although its instance has resolved one before: falling back to the
// instance would share the instance's cursors with its other conversations.
type IdentityResolver interface {
	Identity(c Call) (Identity, error)
}

// MeetingNotifier tells the conversations about meeting changes. Call it after
// the change is committed, outside any store transaction.
type MeetingNotifier interface {
	// MeetingUpdated: the meeting has new messages; its active members are woken.
	MeetingUpdated(meetingID string)
	// MeetingClosed: the meeting ended; each member but byID (who ended it) gets one notice that needs no reply.
	MeetingClosed(meetingID, byID string)
	// MeetingNotice gives each of the sessions to one notice from the meeting;
	// active members are woken with it, others see it at their next hook.
	MeetingNotice(meetingID string, to []string, text string)
}

// Cleaner removes the old rows of the conversations (internal/agents) for
// the host's cleanup; with dryRun it only reports what it would remove.
type Cleaner interface {
	Cleanup(ctx context.Context, dryRun bool) (Cleanup, error)
}

// Cleanup is what a cleanup of the conversations removed or would remove.
type Cleanup struct {
	// MessagesExpired: unread direct messages past their expiry, marked expired.
	MessagesExpired, Messages, Notices, ToolUseBindings, Instances int64
	Sessions                                                       []CleanedSession
}

// CleanedSession is a session a cleanup removed or would remove.
type CleanedSession struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ToolFunc handles a tool; the result must satisfy the tool's output schema.
type ToolFunc func(c Call) (any, error)

// HookFunc handles one client hook event; it returns the hook's output or nil.
// ctx ends when the client goes away or the host shuts down.
type HookFunc func(ctx context.Context, client string, input map[string]any) (map[string]any, error)

// ToolError is a failure the caller caused (400 with its message).
type ToolError struct{ Message string }

func (e *ToolError) Error() string { return e.Message }

// Errorf returns a ToolError.
func Errorf(format string, args ...any) error {
	return &ToolError{Message: fmt.Sprintf(format, args...)}
}

// Options configure a Server.
type Options struct {
	Version      string
	Contract     *protocol.Contract
	Clock        clock.Clock
	AllowedHosts []string
	RateLimit    float64
	RateBurst    float64
	Logger       *log.Logger
	// Health adds fields to GET /health (the agents' session count), nil for none.
	Health func() map[string]any
	// SessionOf names the conversation a caller belongs to, "" when it cannot be
	// identified; tool calls are then limited per conversation instead of per
	// instance. Nil limits every call per instance.
	SessionOf func(c *Caller) string
}

// Server routes requests to the registered tools and hook handler.
type Server struct {
	opts      Options
	mu        sync.RWMutex
	tools     map[string]ToolFunc
	hook      HookFunc
	instances *RateLimiter
	addresses *RateLimiter
	hooks     *RateLimiter
	// hookAddresses bounds hooks per client address apart from tool calls (many sessions from one address).
	hookAddresses *RateLimiter
	allowed       map[string]bool
}

// DefaultAllowedHosts may address the host besides IP literals.
var DefaultAllowedHosts = []string{"localhost", "host.docker.internal"}

// New returns a server with no tools registered.
func New(opts Options) *Server {
	allowed := map[string]bool{}
	for _, h := range append(append([]string{}, DefaultAllowedHosts...), opts.AllowedHosts...) {
		allowed[strings.ToLower(strings.TrimSpace(h))] = true
	}
	now := opts.Clock.Now
	return &Server{
		opts:          opts,
		tools:         map[string]ToolFunc{},
		instances:     NewRateLimiter(opts.RateLimit, opts.RateBurst, now),
		addresses:     NewRateLimiter(opts.RateLimit*AddressLimitFactor, opts.RateBurst*AddressLimitFactor, now),
		hooks:         NewRateLimiter(opts.RateLimit, opts.RateBurst, now),
		hookAddresses: NewRateLimiter(opts.RateLimit*AddressLimitFactor, opts.RateBurst*AddressLimitFactor, now),
		allowed:       allowed,
	}
}

// Register adds a tool handler; the tool must exist in the contract.
func (s *Server) Register(name string, fn ToolFunc) {
	if s.opts.Contract.Tool(name) == nil {
		panic("api: tool not in contract: " + name)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tools[name] = fn
}

// SetHook sets the hook handler.
func (s *Server) SetHook(fn HookFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hook = fn
}

// Missing lists contract tools without a handler; a complete host returns none.
func (s *Server) Missing() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var missing []string
	for _, t := range s.opts.Contract.Tools {
		if s.tools[t.Name] == nil {
			missing = append(missing, t.Name)
		}
	}
	return missing
}

type httpError struct {
	status  int
	message string
	headers map[string]string
}

func (e *httpError) Error() string { return e.message }

func writeJSON(w http.ResponseWriter, status int, body any, headers map[string]string) {
	raw, _ := json.Marshal(body)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(raw)))
	if status == http.StatusRequestEntityTooLarge {
		w.Header().Set("Connection", "close")
	}
	for k, v := range headers {
		w.Header().Set(k, v)
	}
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

func writeError(w http.ResponseWriter, e *httpError) {
	writeJSON(w, e.status, map[string]any{"ok": false, "error": e.message}, e.headers)
}

func rateLimited(wait int, scope string) *httpError {
	return &httpError{http.StatusTooManyRequests, fmt.Sprintf("Rate limit exceeded for %s; retry after %ds.", scope, wait),
		map[string]string{"Retry-After": strconv.Itoa(wait)}}
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if e := s.guard(r); e != nil {
		writeError(w, e)
		return
	}
	path := r.URL.Path
	if testhooks.Enabled && path == "/test/clock" {
		testhooks.Handler(s.opts.Clock).ServeHTTP(w, r)
		return
	}
	if testhooks.Enabled && path == "/test/shutdown" {
		testhooks.ShutdownHandler().ServeHTTP(w, r)
		return
	}
	// Health and the tool list stay reachable so adapters can tell "busy" from "down";
	// hooks have their own per-session budget (serveHook).
	exempt := (r.Method == http.MethodGet && (path == "/health" || path == "/api/tools")) ||
		(r.Method == http.MethodPost && path == "/api/hook")
	if !exempt {
		if wait := s.addresses.Take("address:" + remoteIP(r)); wait > 0 {
			writeError(w, rateLimited(wait, "this client address"))
			return
		}
	}
	switch {
	case r.Method == http.MethodGet && path == "/health":
		body := map[string]any{}
		if s.opts.Health != nil {
			for k, v := range s.opts.Health() {
				body[k] = v
			}
		}
		for k, v := range map[string]any{"ok": true, "service": "n2n-nexus", "version": s.opts.Version, "contractVersion": s.opts.Contract.Version} {
			body[k] = v
		}
		writeJSON(w, 200, body, nil)
	case r.Method == http.MethodGet && path == "/api/tools":
		defs := make([]map[string]any, 0, len(s.opts.Contract.Tools))
		for _, t := range s.opts.Contract.Tools {
			defs = append(defs, t.Definition())
		}
		writeJSON(w, 200, map[string]any{"tools": defs}, nil)
	case r.Method == http.MethodPost && path == "/api/tools/call":
		s.serveToolCall(w, r)
	case r.Method == http.MethodPost && path == "/api/hook":
		s.serveHook(w, r)
	default:
		writeError(w, &httpError{status: http.StatusNotFound, message: fmt.Sprintf("Not found: %s %s", r.Method, path)})
	}
}

func (s *Server) serveToolCall(w http.ResponseWriter, r *http.Request) {
	body, e := readBody(r)
	if e != nil {
		writeError(w, e)
		return
	}
	var req struct {
		Tool       string          `json:"tool"`
		Args       json.RawMessage `json:"args"`
		InstanceID any             `json:"instanceId"`
		Caller     json.RawMessage `json:"caller"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		writeError(w, &httpError{status: 400, message: "Request body must be a JSON object"})
		return
	}
	if req.Tool == "" {
		writeError(w, &httpError{status: 400, message: "tool is required"})
		return
	}
	tool := s.opts.Contract.Tool(req.Tool)
	s.mu.RLock()
	fn := s.tools[req.Tool]
	s.mu.RUnlock()
	if tool == nil || fn == nil {
		writeError(w, &httpError{status: 404, message: fmt.Sprintf("Unknown tool: '%s'", req.Tool)})
		return
	}
	instance, _ := req.InstanceID.(string)
	caller := parseCaller(req.Caller)
	session := ""
	if caller != nil && s.opts.SessionOf != nil {
		session = s.opts.SessionOf(caller)
	}
	switch {
	case session != "":
		if wait := s.instances.Take("session:" + session); wait > 0 {
			writeError(w, rateLimited(wait, fmt.Sprintf("conversation '%s'", session)))
			return
		}
	case instance != "":
		if wait := s.instances.Take("instance:" + instance); wait > 0 {
			writeError(w, rateLimited(wait, fmt.Sprintf("instance '%s'", instance)))
			return
		}
	}
	args := req.Args
	if len(args) == 0 || string(args) == "null" {
		args = json.RawMessage("{}")
	}
	args, err := tool.StripArgs(args)
	if err != nil {
		writeError(w, &httpError{status: 400, message: fmt.Sprintf("Invalid arguments for %s: %s", req.Tool, err)})
		return
	}
	if err := tool.ValidateArgs(args); err != nil {
		writeError(w, &httpError{status: 400, message: fmt.Sprintf("Invalid arguments for %s: %s", req.Tool, err)})
		return
	}
	call := Call{Ctx: r.Context(), InstanceID: instance, Caller: caller, Session: session, Args: args}
	result, err := fn(call)
	if err != nil {
		var te *ToolError
		if errors.As(err, &te) {
			writeError(w, &httpError{status: 400, message: te.Message})
			return
		}
		s.opts.Logger.Printf("tool %s failed: %v", req.Tool, err)
		writeError(w, &httpError{status: 500, message: err.Error()})
		return
	}
	raw, err := json.Marshal(result)
	if err == nil {
		err = tool.ValidateResult(raw)
	}
	if err != nil {
		// A host defect, not the caller's fault.
		s.opts.Logger.Printf("result of %s does not match its contract: %v", req.Tool, err)
		writeError(w, &httpError{status: 500, message: fmt.Sprintf("Result of %s does not match its contract: %v", req.Tool, err)})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "result": json.RawMessage(raw)}, nil)
}

func parseCaller(raw json.RawMessage) *Caller {
	if len(raw) == 0 {
		return nil
	}
	var c Caller
	if json.Unmarshal(raw, &c) != nil {
		return nil
	}
	switch {
	case c.Client == "claude" && c.ToolUseID != "":
		return &Caller{Client: "claude", ToolUseID: c.ToolUseID}
	case c.Client == "codex" && c.SessionID != "":
		return &Caller{Client: "codex", SessionID: c.SessionID}
	}
	// A malformed caller names no session: direct-message tools then refuse, every other tool ignores it.
	return nil
}

func (s *Server) serveHook(w http.ResponseWriter, r *http.Request) {
	body, e := readBody(r)
	if e != nil {
		writeError(w, e)
		return
	}
	var req struct {
		Client string         `json:"client"`
		Input  map[string]any `json:"input"`
	}
	if err := json.Unmarshal(body, &req); err != nil || req.Input == nil || (req.Client != "claude" && req.Client != "codex") {
		writeError(w, &httpError{status: 400, message: "Invalid hook request: expected {client: \"claude\" | \"codex\", input: object}"})
		return
	}
	// Hooks are limited per conversation and per address, apart from tool calls: a busy session cannot starve the others.
	if wait := s.hookAddresses.Take("address:" + remoteIP(r)); wait > 0 {
		writeError(w, rateLimited(wait, "this client address's hooks"))
		return
	}
	if session, _ := req.Input["session_id"].(string); session != "" {
		if wait := s.hooks.Take("session:" + req.Client + ":" + session); wait > 0 {
			writeError(w, rateLimited(wait, "this session's hooks"))
			return
		}
	}
	s.mu.RLock()
	hook := s.hook
	s.mu.RUnlock()
	if hook == nil {
		writeJSON(w, 200, map[string]any{"output": nil}, nil)
		return
	}
	out, err := hook(r.Context(), req.Client, req.Input)
	if r.Context().Err() != nil {
		return // the client went away (a listening Stop hook killed by the user)
	}
	if err != nil {
		var te *ToolError
		if errors.As(err, &te) {
			writeError(w, &httpError{status: 400, message: te.Message})
			return
		}
		s.opts.Logger.Printf("hook %s failed: %v", req.Client, err)
		writeError(w, &httpError{status: 500, message: err.Error()})
		return
	}
	var output any
	if out != nil {
		output = out
	}
	writeJSON(w, 200, map[string]any{"output": output}, nil)
}

func readBody(r *http.Request) ([]byte, *httpError) {
	if r.ContentLength > MaxBodyBytes {
		return nil, &httpError{status: 413, message: fmt.Sprintf("Request body exceeds %d bytes", MaxBodyBytes)}
	}
	body, err := readAll(http.MaxBytesReader(nil, r.Body, MaxBodyBytes))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return nil, &httpError{status: 413, message: fmt.Sprintf("Request body exceeds %d bytes", MaxBodyBytes)}
		}
		return nil, &httpError{status: 400, message: "Could not read the request body"}
	}
	if len(body) == 0 {
		return []byte("{}"), nil
	}
	var probe any
	if json.Unmarshal(body, &probe) != nil {
		return nil, &httpError{status: 400, message: "Invalid JSON"}
	}
	if _, ok := probe.(map[string]any); !ok {
		return nil, &httpError{status: 400, message: "Request body must be a JSON object"}
	}
	return body, nil
}

func remoteIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
