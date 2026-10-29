// Package core implements the project, document, meeting, chat, event and
// task tools and their tables (store/migrations/0001_core.sql).
package core

import (
	"database/sql"
	"encoding/json"
	"log"
	"math/rand/v2"
	"strings"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/api"
	"github.com/n2ns/n2n-nexus/host/internal/clock"
	"github.com/n2ns/n2n-nexus/host/internal/protocol"
	"github.com/n2ns/n2n-nexus/host/internal/store"
)

// Deps are what the core tools need.
type Deps struct {
	Store    *store.Store
	Clock    clock.Clock
	Contract *protocol.Contract
	Logger   *log.Logger
	// Identities resolves who a chat or meeting call acts as; nil = always the instance.
	Identities api.IdentityResolver
	// Meetings is told about meeting changes after they are committed; nil = nobody.
	Meetings api.MeetingNotifier
	// Cleaner cleans up the conversations' rows with the core's; nil = nothing.
	Cleaner api.Cleaner
	// MeetingRetentionDays and RetentionDays are the settings of the same names.
	MeetingRetentionDays, RetentionDays int
}

// Core holds the core tools.
type Core struct {
	d Deps
}

// New returns the core tools.
func New(d Deps) *Core { return &Core{d: d} }

// Register adds every core tool to srv.
func (c *Core) Register(srv *api.Server) {
	// Projects
	srv.Register("sync_project_assets", api.Tool(syncArgs{}, c.syncProjectAssets))
	srv.Register("upload_project_asset", api.Tool(uploadArgs{}, c.uploadProjectAsset))
	srv.Register("update_project", api.Tool(updateProjectArgs{}, c.updateProject))
	srv.Register("rename_project", api.Tool(renameArgs{}, c.renameProject))
	srv.Register("search_projects", api.Tool(searchArgs{Limit: 10}, c.searchProjects))
	srv.Register("get_global_topology", api.Tool(topologyArgs{}, c.getGlobalTopology))
	srv.Register("get_project", api.Tool(getProjectArgs{IncludeDocs: true}, c.getProject))
	srv.Register("host_delete_project", api.Tool(projectIDArgs{}, c.deleteProject))
	// Chat and events
	srv.Register("send_message", api.Tool(sendMessageArgs{}, c.sendMessage))
	srv.Register("read_messages", api.Tool(readMessagesArgs{Count: 10}, c.readMessages))
	srv.Register("list_events", api.Tool(listEventsArgs{Limit: 20}, c.listEvents))
	srv.Register("host_maintenance", api.Tool(maintenanceArgs{}, c.hostMaintenance))
	// Strategy and shared documents
	srv.Register("get_global_strategy", api.Tool(struct{}{}, c.getGlobalStrategy))
	srv.Register("update_global_strategy", api.Tool(strategyArgs{}, c.updateGlobalStrategy))
	srv.Register("list_global_docs", api.Tool(struct{}{}, c.listGlobalDocs))
	srv.Register("get_global_doc", api.Tool(docIDArgs{}, c.getGlobalDoc))
	srv.Register("sync_global_doc", api.Tool(syncDocArgs{}, c.syncGlobalDoc))
	// Meetings
	srv.Register("list_meetings", api.Tool(listMeetingsArgs{Limit: 20}, c.listMeetings))
	srv.Register("start_meeting", api.Tool(startMeetingArgs{}, c.startMeeting))
	srv.Register("end_meeting", api.Tool(endMeetingArgs{}, c.endMeeting))
	srv.Register("archive_meeting", api.Tool(meetingIDArgs{}, c.archiveMeeting))
	srv.Register("reopen_meeting", api.Tool(meetingIDArgs{}, c.reopenMeeting))
	srv.Register("join_meeting", api.Tool(joinMeetingArgs{Mode: "active"}, c.joinMeeting))
	srv.Register("leave_meeting", api.Tool(meetingIDArgs{}, c.leaveMeeting))
	srv.Register("stance", api.Tool(stanceArgs{}, c.stance))
	// Tasks
	srv.Register("create_task", api.Tool(createTaskArgs{}, c.createTask))
	srv.Register("get_task", api.Tool(taskIDArgs{}, c.getTask))
	srv.Register("list_tasks", api.Tool(listTasksArgs{Limit: 50}, c.listTasks))
	srv.Register("update_task", api.Tool(updateTaskArgs{}, c.updateTask))
	srv.Register("cancel_task", api.Tool(taskIDArgs{}, c.cancelTask))
}

// tx runs fn in one transaction of the call.
func (c *Core) tx(call api.Call, fn func(tx *sql.Tx) error) error {
	return c.d.Store.Tx(call.Ctx, fn)
}

func (c *Core) now() string { return store.ISO(c.d.Clock.Now()) }

func exec(tx *sql.Tx, query string, args ...any) (int64, error) {
	return store.Affected(tx.Exec(query, args...))
}

// recordEvent appends to the activity log; target "" and detail nil are stored as NULL.
func (c *Core) recordEvent(tx *sql.Tx, actor, action, target string, detail any) error {
	var t, d any
	if target != "" {
		t = target
	}
	if detail != nil {
		raw, err := json.Marshal(detail)
		if err != nil {
			return err
		}
		d = string(raw)
	}
	_, err := tx.Exec(`INSERT INTO events (timestamp, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)`,
		c.now(), actor, action, t, d)
	return err
}

// randomSuffix is like JavaScript's Math.random().toString(36).substring(2, 6).
func randomSuffix() string {
	const digits = "0123456789abcdefghijklmnopqrstuvwxyz"
	var b strings.Builder
	for range 4 {
		b.WriteByte(digits[rand.IntN(len(digits))])
	}
	return b.String()
}

// compactTime is the ISO timestamp without separators, to the second: 20261023123456.
func compactTime(t time.Time) string {
	return t.UTC().Format("20060102150405")
}

func nullString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullable(s sql.NullString) *string {
	if !s.Valid {
		return nil
	}
	return &s.String
}

func toNull(s *string) sql.NullString {
	if s == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *s, Valid: true}
}
