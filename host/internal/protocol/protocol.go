// Package protocol loads the embedded contract (contract/*.json): the tool
// definitions with their compiled input and output schemas, and the hook
// constants shared with the TypeScript clients.
package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/n2ns/n2n-nexus/contract"
)

// Tool is one entry of contract/tools.json.
type Tool struct {
	Name                string         `json:"name"`
	Title               string         `json:"title"`
	Description         string         `json:"description"`
	Annotations         map[string]any `json:"annotations"`
	InputSchema         map[string]any `json:"inputSchema"`
	OutputSchema        map[string]any `json:"outputSchema"`
	PublishOutputSchema bool           `json:"publishOutputSchema"`

	input  *jsonschema.Schema
	output *jsonschema.Schema
}

// Definition is the tool as GET /api/tools lists it.
func (t *Tool) Definition() map[string]any {
	def := map[string]any{
		"name":        t.Name,
		"title":       t.Title,
		"description": t.Description,
		"inputSchema": t.InputSchema,
		"annotations": t.Annotations,
	}
	if t.PublishOutputSchema {
		def["outputSchema"] = t.OutputSchema
	}
	return def
}

// ValidateArgs checks call arguments against the input schema; the error text is for the caller.
func (t *Tool) ValidateArgs(args json.RawMessage) error {
	return validate(t.input, args)
}

// ValidateResult checks a handler result against the output schema; a failure is a host defect.
func (t *Tool) ValidateResult(result json.RawMessage) error {
	return validate(t.output, result)
}

func validate(schema *jsonschema.Schema, raw json.RawMessage) error {
	value, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	if err := schema.Validate(value); err != nil {
		var verr *jsonschema.ValidationError
		if ok := asValidationError(err, &verr); ok {
			// Drop the "jsonschema validation failed with '<schema url>'" header; keep the "- at '/x': ..." lines.
			lines := strings.Split(strings.TrimSpace(verr.Error()), "\n")
			if len(lines) > 1 {
				lines = lines[1:]
			}
			for i, line := range lines {
				lines[i] = strings.TrimPrefix(strings.TrimSpace(line), "- ")
			}
			return fmt.Errorf("%s", strings.Join(lines, "; "))
		}
		return err
	}
	return nil
}

func asValidationError(err error, target **jsonschema.ValidationError) bool {
	v, ok := err.(*jsonschema.ValidationError)
	if ok {
		*target = v
	}
	return ok
}

// Contract is the loaded contract.
type Contract struct {
	Version int
	Tools   []*Tool
	byName  map[string]*Tool
	Hook    Hook
}

// Tool returns the named tool, or nil.
func (c *Contract) Tool(name string) *Tool { return c.byName[name] }

// Hook mirrors contract/hook.json.
type Hook struct {
	ContractVersion     int               `json:"contractVersion"`
	Clients             []string          `json:"clients"`
	ClientInfoNames     map[string]string `json:"clientInfoNames"`
	MCPServerName       string            `json:"mcpServerName"`
	HookInputFields     []string          `json:"hookInputFields"`
	BackgroundWaitEvent string            `json:"backgroundWaitEvent"`
	WakeResultEvent     string            `json:"wakeResultEvent"`
	AgentStatuses       []string          `json:"agentStatuses"`
	Timing              struct {
		ListenWaitMs               int64 `json:"listenWaitMs"`
		HookStopRequestTimeoutMs   int64 `json:"hookStopRequestTimeoutMs"`
		HookRequestTimeoutMs       int64 `json:"hookRequestTimeoutMs"`
		HookStopTimeoutSec         int64 `json:"hookStopTimeoutSec"`
		WaitHookTimeoutSec         int64 `json:"waitHookTimeoutSec"`
		HookTimeoutSec             int64 `json:"hookTimeoutSec"`
		CodexSessionEndTimeoutSec  int64 `json:"codexSessionEndTimeoutSec"`
		SessionEndRequestTimeoutMs int64 `json:"sessionEndRequestTimeoutMs"`
		WakeRetryFirstDelayMs      int64 `json:"wakeRetryFirstDelayMs"`
		WakeRetryMaxDelayMs        int64 `json:"wakeRetryMaxDelayMs"`
		WakePromptWindowMs         int64 `json:"wakePromptWindowMs"`
		ToolUseBindingTtlMs        int64 `json:"toolUseBindingTtlMs"`
		MessageTtlMs               int64 `json:"messageTtlMs"`
		IdleSubscriptionTtlMs      int64 `json:"idleSubscriptionTtlMs"`
		PeerWindowMs               int64 `json:"peerWindowMs"`
		StaleSessionMs             int64 `json:"staleSessionMs"`
	} `json:"timing"`
	Limits struct {
		DefaultMaxAutoTurns int    `json:"defaultMaxAutoTurns"`
		MaxMessageChars     int    `json:"maxMessageChars"`
		MaxNoteChars        int    `json:"maxNoteChars"`
		MaxTitleChars       int    `json:"maxTitleChars"`
		SessionNamePattern  string `json:"sessionNamePattern"`
		PreviewChars        int    `json:"previewChars"`
		NotifyListLimit     int    `json:"notifyListLimit"`
		NotifyTextChars     int    `json:"notifyTextChars"`
		MaxHostnameChars    int    `json:"maxHostnameChars"`
	} `json:"limits"`
	Texts struct {
		NoticePrefix         string `json:"noticePrefix"`
		NotifyClosing        string `json:"notifyClosing"`
		StopClosing          string `json:"stopClosing"`
		StatusNote           string `json:"statusNote"`
		SessionStartClosing  string `json:"sessionStartClosing"`
		CollaborationRules   string `json:"collaborationRules"`
		MessageTrustNote     string `json:"messageTrustNote"`
		MessageInfoNote      string `json:"messageInfoNote"`
		MessageHeader        string `json:"messageHeader"`
		MessageEnd           string `json:"messageEnd"`
		MessageReplyTo       string `json:"messageReplyTo"`
		MessageCut           string `json:"messageCut"`
		ReplyInstruction     string `json:"replyInstruction"`
		ReadRest             string `json:"readRest"`
		ReplyTool            string `json:"replyTool"`
		NoReplyMark          string `json:"noReplyMark"`
		EarlierUnread        string `json:"earlierUnread"`
		MeetingNews          string `json:"meetingNews"`
		MeetingMessageHeader string `json:"meetingMessageHeader"`
		MeetingMessageEnd    string `json:"meetingMessageEnd"`
		MeetingNotShown      string `json:"meetingNotShown"`
		MeetingReadRest      string `json:"meetingReadRest"`
		MeetingClosing       string `json:"meetingClosing"`
		SentWithUnread       string `json:"sentWithUnread"`
		MeetingEnded         string `json:"meetingEnded"`
		StanceNotice         string `json:"stanceNotice"`
		ApproversChanged     string `json:"approversChanged"`
		ConsensusDecision    string `json:"consensusDecision"`
		StanceReminder       string `json:"stanceReminder"`
		StanceWaiting        string `json:"stanceWaiting"`
		NoAgentSessionError  string `json:"noAgentSessionError"`
	} `json:"texts"`
}

// Load parses and compiles the embedded contract.
func Load() (*Contract, error) {
	var tools struct {
		ContractVersion int     `json:"contractVersion"`
		Tools           []*Tool `json:"tools"`
	}
	if err := json.Unmarshal(contract.ToolsJSON, &tools); err != nil {
		return nil, fmt.Errorf("contract/tools.json: %w", err)
	}
	c := &Contract{Version: tools.ContractVersion, Tools: tools.Tools, byName: map[string]*Tool{}}
	if err := json.Unmarshal(contract.HookJSON, &c.Hook); err != nil {
		return nil, fmt.Errorf("contract/hook.json: %w", err)
	}
	if c.Hook.ContractVersion != c.Version {
		return nil, fmt.Errorf("contract version mismatch: tools.json %d, hook.json %d", c.Version, c.Hook.ContractVersion)
	}
	compiler := jsonschema.NewCompiler()
	for _, t := range c.Tools {
		var err error
		if t.input, err = compile(compiler, t.Name+"/input", t.InputSchema); err != nil {
			return nil, err
		}
		if t.output, err = compile(compiler, t.Name+"/output", t.OutputSchema); err != nil {
			return nil, err
		}
		c.byName[t.Name] = t
	}
	return c, nil
}

func compile(compiler *jsonschema.Compiler, id string, schema map[string]any) (*jsonschema.Schema, error) {
	url := "contract:///" + id + ".json"
	raw, err := json.Marshal(schema)
	if err != nil {
		return nil, err
	}
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	if err := compiler.AddResource(url, doc); err != nil {
		return nil, fmt.Errorf("schema %s: %w", id, err)
	}
	s, err := compiler.Compile(url)
	if err != nil {
		return nil, fmt.Errorf("schema %s: %w", id, err)
	}
	return s, nil
}

// StripArgs drops object keys the input schema does not declare, at every
// level, as zod strips unknown keys. Objects whose schema sets
// additionalProperties (strict objects, records) are left for validation.
// Without this, Go's case-insensitive JSON decoding would let an undeclared
// "Name" or "NewId" fill a declared field.
func (t *Tool) StripArgs(raw json.RawMessage) (json.RawMessage, error) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return json.Marshal(strip(t.InputSchema, value))
}

func strip(schema map[string]any, value any) any {
	switch v := value.(type) {
	case map[string]any:
		props, hasProps := schema["properties"].(map[string]any)
		_, hasAdditional := schema["additionalProperties"]
		for key, item := range v {
			sub, declared := props[key].(map[string]any)
			if hasProps && !declared && !hasAdditional {
				delete(v, key)
				continue
			}
			if declared {
				v[key] = strip(sub, item)
			}
		}
		return v
	case []any:
		if items, ok := schema["items"].(map[string]any); ok {
			for i, item := range v {
				v[i] = strip(items, item)
			}
		}
		return v
	}
	return value
}
