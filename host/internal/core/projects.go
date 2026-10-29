package core

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/n2ns/n2n-nexus/host/internal/api"
	"github.com/n2ns/n2n-nexus/host/internal/store"
)

type relation struct {
	TargetID string `json:"targetId"`
	Type     string `json:"type"`
}

type endpoint struct {
	Name        string `json:"name"`
	URL         string `json:"url"`
	Description string `json:"description"`
}

type apiSpecEntry struct {
	Method  string `json:"method"`
	Path    string `json:"path"`
	Summary string `json:"summary"`
}

type billing struct {
	Plain string `json:"plain"`
	Price string `json:"price"`
}

// manifestIn is the manifest of sync_project_assets; decoding drops undeclared fields.
type manifestIn struct {
	ID                   string            `json:"id"`
	Name                 string            `json:"name"`
	Description          string            `json:"description"`
	TechStack            []string          `json:"techStack"`
	Relations            []relation        `json:"relations"`
	RepositoryURL        string            `json:"repositoryUrl"`
	LocalPath            string            `json:"localPath"`
	Endpoints            []endpoint        `json:"endpoints"`
	APISpec              []apiSpecEntry    `json:"apiSpec"`
	Billing              *billing          `json:"billing"`
	LastUpdated          string            `json:"lastUpdated"`
	APIDependencies      map[string]string `json:"apiDependencies"`
	GatewayCompatibility *string           `json:"gatewayCompatibility"`
	APIVersions          map[string]string `json:"api_versions"`
	FeatureTier          *string           `json:"feature_tier"`
}

// manifestPatch is update_project's patch: a nil field is left unchanged.
type manifestPatch struct {
	Name                 *string            `json:"name"`
	Description          *string            `json:"description"`
	TechStack            *[]string          `json:"techStack"`
	Relations            *[]relation        `json:"relations"`
	RepositoryURL        *string            `json:"repositoryUrl"`
	LocalPath            *string            `json:"localPath"`
	Endpoints            *[]endpoint        `json:"endpoints"`
	APISpec              *[]apiSpecEntry    `json:"apiSpec"`
	Billing              *billing           `json:"billing"`
	APIDependencies      *map[string]string `json:"apiDependencies"`
	GatewayCompatibility *string            `json:"gatewayCompatibility"`
	APIVersions          *map[string]string `json:"api_versions"`
	FeatureTier          *string            `json:"feature_tier"`
}

// patchField is one field of a manifest patch: its name in the manifest, its
// column ("" for relations, kept in their own table), whether the column holds
// JSON, its value (a pointer) and whether the patch sets it.
type patchField struct {
	name, column string
	json         bool
	value        any
	set          bool
}

// table lists the patch's fields in the order of the manifest schema.
func (p manifestPatch) table() []patchField {
	return []patchField{
		{"name", "name", false, p.Name, p.Name != nil},
		{"description", "description", false, p.Description, p.Description != nil},
		{"techStack", "tech_stack", true, p.TechStack, p.TechStack != nil},
		{"relations", "", false, p.Relations, p.Relations != nil},
		{"repositoryUrl", "repository_url", false, p.RepositoryURL, p.RepositoryURL != nil},
		{"localPath", "local_path", false, p.LocalPath, p.LocalPath != nil},
		{"endpoints", "endpoints", true, p.Endpoints, p.Endpoints != nil},
		{"apiSpec", "api_spec", true, p.APISpec, p.APISpec != nil},
		{"billing", "billing", true, p.Billing, p.Billing != nil},
		{"apiDependencies", "api_dependencies", true, p.APIDependencies, p.APIDependencies != nil},
		{"gatewayCompatibility", "gateway_compatibility", false, p.GatewayCompatibility, p.GatewayCompatibility != nil},
		{"api_versions", "api_versions", true, p.APIVersions, p.APIVersions != nil},
		{"feature_tier", "feature_tier", false, p.FeatureTier, p.FeatureTier != nil},
	}
}

// manifestOut is a stored manifest as get_project returns it.
type manifestOut struct {
	ID                   string          `json:"id"`
	Name                 string          `json:"name"`
	Description          string          `json:"description"`
	TechStack            json.RawMessage `json:"techStack"`
	Relations            []relation      `json:"relations"`
	LastUpdated          string          `json:"lastUpdated"`
	RepositoryURL        string          `json:"repositoryUrl"`
	LocalPath            string          `json:"localPath"`
	Endpoints            json.RawMessage `json:"endpoints"`
	APISpec              json.RawMessage `json:"apiSpec"`
	Billing              json.RawMessage `json:"billing,omitempty"`
	APIDependencies      json.RawMessage `json:"apiDependencies,omitempty"`
	GatewayCompatibility *string         `json:"gatewayCompatibility,omitempty"`
	APIVersions          json.RawMessage `json:"api_versions,omitempty"`
	FeatureTier          *string         `json:"feature_tier,omitempty"`
}

// jsonValue marshals a non-nil nested value; nil values (absent optional fields) stay NULL.
func jsonValue(v any, isNil bool) (any, error) {
	if isNil {
		return nil, nil
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return string(raw), nil
}

func notFoundProject(id string) error { return api.Errorf("Project '%s' not found.", id) }

func projectExists(tx *sql.Tx, id string) (bool, error) {
	return store.Exists(tx.QueryRow(`SELECT 1 FROM projects WHERE id = ?`, id))
}

func writeRelations(tx *sql.Tx, projectID string, relations []relation) error {
	if _, err := tx.Exec(`DELETE FROM project_relations WHERE project_id = ?`, projectID); err != nil {
		return err
	}
	for i, r := range relations {
		if _, err := tx.Exec(`INSERT INTO project_relations (project_id, position, target_id, type) VALUES (?, ?, ?, ?)`,
			projectID, i, r.TargetID, r.Type); err != nil {
			return err
		}
	}
	return nil
}

func readRelations(tx *sql.Tx, projectID string) ([]relation, error) {
	rows, err := tx.Query(`SELECT target_id, type FROM project_relations WHERE project_id = ? ORDER BY position`, projectID)
	return store.Append([]relation{}, rows, err, func(rows *sql.Rows) (relation, error) {
		var r relation
		return r, rows.Scan(&r.TargetID, &r.Type)
	})
}

// ---------------------------------------------------------------------------
// sync_project_assets

type syncArgs struct {
	Manifest     manifestIn `json:"manifest"`
	InternalDocs string     `json:"internalDocs"`
}

func (c *Core) syncProjectAssets(call api.Call, a syncArgs) (any, error) {
	m := a.Manifest
	now := c.now()
	lastUpdated := m.LastUpdated
	if lastUpdated == "" {
		lastUpdated = now
	}
	values := []any{}
	for _, v := range []struct {
		v     any
		isNil bool
	}{
		{m.TechStack, false}, {m.Endpoints, false}, {m.APISpec, false},
		{m.Billing, m.Billing == nil}, {m.APIDependencies, m.APIDependencies == nil}, {m.APIVersions, m.APIVersions == nil},
	} {
		j, err := jsonValue(v.v, v.isNil)
		if err != nil {
			return nil, err
		}
		values = append(values, j)
	}
	err := c.tx(call, func(tx *sql.Tx) error {
		// An upsert, not a replace: replacing the row would cascade-delete the project's assets.
		_, err := tx.Exec(`
			INSERT INTO projects (id, position, name, description, tech_stack, repository_url, local_path, endpoints, api_spec,
				billing, api_dependencies, gateway_compatibility, api_versions, feature_tier, internal_docs, last_updated, last_active)
			VALUES (?, (SELECT COALESCE(MAX(position), 0) + 1 FROM projects), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET
				name = excluded.name, description = excluded.description, tech_stack = excluded.tech_stack,
				repository_url = excluded.repository_url, local_path = excluded.local_path, endpoints = excluded.endpoints,
				api_spec = excluded.api_spec, billing = excluded.billing, api_dependencies = excluded.api_dependencies,
				gateway_compatibility = excluded.gateway_compatibility, api_versions = excluded.api_versions,
				feature_tier = excluded.feature_tier, internal_docs = excluded.internal_docs,
				last_updated = excluded.last_updated, last_active = excluded.last_active`,
			m.ID, m.Name, m.Description, values[0], m.RepositoryURL, m.LocalPath, values[1], values[2],
			values[3], values[4], m.GatewayCompatibility, values[5], m.FeatureTier, a.InternalDocs, lastUpdated, now)
		if err != nil {
			return err
		}
		if err := writeRelations(tx, m.ID, m.Relations); err != nil {
			return err
		}
		return c.recordEvent(tx, call.Actor(), "project.sync", m.ID, nil)
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "projectId": m.ID, "message": fmt.Sprintf("Project '%s' manifest and docs synced.", m.ID)}, nil
}

// ---------------------------------------------------------------------------
// upload_project_asset

type uploadArgs struct {
	ProjectID     string `json:"projectId"`
	FileName      string `json:"fileName"`
	Base64Content string `json:"base64Content"`
}

// sanitizeFileName replaces every character but letters, digits, '.', '_' and
// '-' with '_', then every ".." with '_'.
func sanitizeFileName(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			b.WriteRune(r)
		default:
			// JavaScript replaces per UTF-16 code unit: a character outside the BMP becomes "__".
			if r > 0xFFFF {
				b.WriteString("__")
			} else {
				b.WriteByte('_')
			}
		}
	}
	return strings.ReplaceAll(b.String(), "..", "_")
}

// decodeBase64 decodes like Node's Buffer.from(s, "base64"): characters outside
// the standard and URL-safe alphabets are skipped, decoding stops at the first
// '=', and trailing bits that do not fill a byte are dropped.
func decodeBase64(s string) []byte {
	out := make([]byte, 0, len(s)*3/4)
	var acc uint32
	var bits uint
	for i := 0; i < len(s); i++ {
		ch := s[i]
		var v uint32
		switch {
		case ch >= 'A' && ch <= 'Z':
			v = uint32(ch - 'A')
		case ch >= 'a' && ch <= 'z':
			v = uint32(ch-'a') + 26
		case ch >= '0' && ch <= '9':
			v = uint32(ch-'0') + 52
		case ch == '+' || ch == '-':
			v = 62
		case ch == '/' || ch == '_':
			v = 63
		case ch == '=':
			return out
		default:
			continue
		}
		acc = acc<<6 | v
		bits += 6
		if bits >= 8 {
			bits -= 8
			out = append(out, byte(acc>>bits))
			acc &= 1<<bits - 1
		}
	}
	return out
}

func (c *Core) uploadProjectAsset(call api.Call, a uploadArgs) (any, error) {
	name := sanitizeFileName(a.FileName)
	data := decodeBase64(a.Base64Content)
	err := c.tx(call, func(tx *sql.Tx) error {
		ok, err := projectExists(tx, a.ProjectID)
		if err != nil {
			return err
		}
		if !ok {
			return notFoundProject(a.ProjectID)
		}
		if name == "." {
			return api.Errorf("Invalid fileName '%s': it names no file.", name)
		}
		if _, err := tx.Exec(`
			INSERT INTO project_assets (project_id, file_name, data, updated_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (project_id, file_name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
			a.ProjectID, name, data, c.now()); err != nil {
			return err
		}
		return c.recordEvent(tx, call.Actor(), "project.asset", a.ProjectID, map[string]any{"fileName": name, "bytes": len(data)})
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "projectId": a.ProjectID, "fileName": name,
		"message": fmt.Sprintf("Asset '%s' saved to project '%s'.", name, a.ProjectID)}, nil
}

// ---------------------------------------------------------------------------
// update_project

type updateProjectArgs struct {
	ProjectID string        `json:"projectId"`
	Patch     manifestPatch `json:"patch"`
}

func (c *Core) updateProject(call api.Call, a updateProjectArgs) (any, error) {
	p := a.Patch
	now := c.now()
	sets := []string{"last_updated = ?", "last_active = ?"}
	values := []any{now, now}
	fields := []string{}
	for _, f := range p.table() {
		if !f.set {
			continue
		}
		fields = append(fields, f.name)
		if f.column == "" {
			continue
		}
		v := f.value
		if f.json {
			j, err := jsonValue(v, false)
			if err != nil {
				return nil, err
			}
			v = j
		}
		sets = append(sets, f.column+" = ?")
		values = append(values, v)
	}
	values = append(values, a.ProjectID)
	err := c.tx(call, func(tx *sql.Tx) error {
		n, err := exec(tx, `UPDATE projects SET `+strings.Join(sets, ", ")+` WHERE id = ?`, values...)
		if err != nil {
			return err
		}
		if n == 0 {
			return notFoundProject(a.ProjectID)
		}
		if p.Relations != nil {
			if err := writeRelations(tx, a.ProjectID, *p.Relations); err != nil {
				return err
			}
		}
		return c.recordEvent(tx, call.Actor(), "project.update", a.ProjectID, map[string]any{"fields": fields})
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "projectId": a.ProjectID, "message": fmt.Sprintf("Project '%s' updated.", a.ProjectID)}, nil
}

// ---------------------------------------------------------------------------
// rename_project

type renameArgs struct {
	OldID string `json:"oldId"`
	NewID string `json:"newId"`
}

func (c *Core) renameProject(call api.Call, a renameArgs) (any, error) {
	if a.OldID == a.NewID {
		return nil, api.Errorf("oldId and newId are identical.")
	}
	err := c.tx(call, func(tx *sql.Tx) error {
		ok, err := projectExists(tx, a.OldID)
		if err != nil {
			return err
		}
		if !ok {
			return notFoundProject(a.OldID)
		}
		if taken, err := projectExists(tx, a.NewID); err != nil {
			return err
		} else if taken {
			return api.Errorf("Project '%s' already exists.", a.NewID)
		}
		// The project's own relations and assets follow through ON UPDATE CASCADE;
		// relations of every project that point at it are rewritten here.
		if _, err := tx.Exec(`UPDATE projects SET id = ?, position = (SELECT MAX(position) + 1 FROM projects) WHERE id = ?`,
			a.NewID, a.OldID); err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE project_relations SET target_id = ? WHERE target_id = ?`, a.NewID, a.OldID); err != nil {
			return err
		}
		return c.recordEvent(tx, call.Actor(), "project.rename", a.NewID, map[string]any{"oldId": a.OldID})
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "oldId": a.OldID, "newId": a.NewID,
		"message": fmt.Sprintf("Project renamed '%s' → '%s'.", a.OldID, a.NewID)}, nil
}

// ---------------------------------------------------------------------------
// host_delete_project

type projectIDArgs struct {
	ProjectID string `json:"projectId"`
}

func (c *Core) deleteProject(call api.Call, a projectIDArgs) (any, error) {
	err := c.tx(call, func(tx *sql.Tx) error {
		// Its relations and assets go with it (ON DELETE CASCADE); relations of
		// other projects that name it stay, as they did in the manifests.
		n, err := exec(tx, `DELETE FROM projects WHERE id = ?`, a.ProjectID)
		if err != nil {
			return err
		}
		if n == 0 {
			return notFoundProject(a.ProjectID)
		}
		return c.recordEvent(tx, call.Actor(), "project.delete", a.ProjectID, nil)
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "projectId": a.ProjectID, "message": fmt.Sprintf("Project '%s' deleted.", a.ProjectID)}, nil
}

// ---------------------------------------------------------------------------
// search_projects

type searchArgs struct {
	Query string `json:"query"`
	Limit int    `json:"limit"`
}

type searchResult struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

func (c *Core) searchProjects(call api.Call, a searchArgs) (any, error) {
	q := strings.ToLower(a.Query)
	results := []searchResult{}
	err := c.tx(call, func(tx *sql.Tx) error {
		rows, err := tx.Query(`SELECT id, name, description FROM projects ORDER BY position`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() && len(results) < a.Limit {
			var r searchResult
			if err := rows.Scan(&r.ID, &r.Name, &r.Description); err != nil {
				return err
			}
			if strings.Contains(strings.ToLower(r.ID), q) || strings.Contains(strings.ToLower(r.Name), q) ||
				strings.Contains(strings.ToLower(r.Description), q) {
				if r.Name == "" {
					r.Name = r.ID
				}
				results = append(results, r)
			}
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"query": a.Query, "count": len(results), "results": results}, nil
}

// ---------------------------------------------------------------------------
// get_global_topology

type topologyArgs struct {
	ProjectID string `json:"projectId"`
}

type topologyNode struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Summary    string `json:"summary"`
	LastActive string `json:"lastActive"`
}

type topologyEdge struct {
	From string `json:"from"`
	To   string `json:"to"`
	Type string `json:"type"`
}

func (c *Core) getGlobalTopology(call api.Call, a topologyArgs) (any, error) {
	var nodes []topologyNode
	var edges []topologyEdge
	err := c.tx(call, func(tx *sql.Tx) error {
		rows, err := tx.Query(`SELECT id, name, description, last_active FROM projects ORDER BY position`)
		nodes, err = store.Append(nodes, rows, err, func(rows *sql.Rows) (topologyNode, error) {
			var n topologyNode
			err := rows.Scan(&n.ID, &n.Name, &n.Summary, &n.LastActive)
			if n.Name == "" {
				n.Name = n.ID
			}
			return n, err
		})
		if err != nil {
			return err
		}
		// Edges to projects that do not exist are left out.
		rows, err = tx.Query(`
			SELECT r.project_id, r.target_id, r.type FROM project_relations r
			JOIN projects p ON p.id = r.project_id
			WHERE EXISTS (SELECT 1 FROM projects t WHERE t.id = r.target_id)
			ORDER BY p.position, r.position`)
		edges, err = store.Append(edges, rows, err, func(rows *sql.Rows) (topologyEdge, error) {
			var e topologyEdge
			return e, rows.Scan(&e.From, &e.To, &e.Type)
		})
		return err
	})
	if err != nil {
		return nil, err
	}

	if a.ProjectID == "" {
		projects := map[string]topologyNode{}
		for _, n := range nodes {
			projects[n.ID] = n
		}
		return map[string]any{
			"mode":     "list",
			"summary":  map[string]any{"totalProjects": len(nodes), "totalEdges": len(edges)},
			"projects": projects,
		}, nil
	}

	known := false
	for _, n := range nodes {
		known = known || n.ID == a.ProjectID
	}
	if !known {
		return nil, notFoundProject(a.ProjectID)
	}
	// Everything reachable from the project along outgoing edges.
	visited := map[string]bool{}
	queue := []string{a.ProjectID}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		if visited[current] {
			continue
		}
		visited[current] = true
		for _, e := range edges {
			if e.From == current && !visited[e.To] {
				queue = append(queue, e.To)
			}
		}
	}
	focusedNodes, focusedEdges := []topologyNode{}, []topologyEdge{}
	for _, n := range nodes {
		if visited[n.ID] {
			focusedNodes = append(focusedNodes, n)
		}
	}
	for _, e := range edges {
		if visited[e.From] && visited[e.To] {
			focusedEdges = append(focusedEdges, e)
		}
	}
	return map[string]any{"mode": "focused", "nodes": focusedNodes, "edges": focusedEdges}, nil
}

// ---------------------------------------------------------------------------
// get_project

type getProjectArgs struct {
	ProjectID   string `json:"projectId"`
	IncludeDocs bool   `json:"includeDocs"`
}

func (c *Core) getProject(call api.Call, a getProjectArgs) (any, error) {
	var m manifestOut
	var docs string
	err := c.tx(call, func(tx *sql.Tx) error {
		var techStack, endpoints, apiSpec string
		var bill, deps, gateway, versions, tier sql.NullString
		err := tx.QueryRow(`
			SELECT id, name, description, tech_stack, last_updated, repository_url, local_path, endpoints, api_spec,
				billing, api_dependencies, gateway_compatibility, api_versions, feature_tier, internal_docs
			FROM projects WHERE id = ?`, a.ProjectID).Scan(
			&m.ID, &m.Name, &m.Description, &techStack, &m.LastUpdated, &m.RepositoryURL, &m.LocalPath, &endpoints, &apiSpec,
			&bill, &deps, &gateway, &versions, &tier, &docs)
		if errors.Is(err, sql.ErrNoRows) {
			return notFoundProject(a.ProjectID)
		}
		if err != nil {
			return err
		}
		if m.Name == "" {
			m.Name = m.ID
		}
		m.TechStack, m.Endpoints, m.APISpec = json.RawMessage(techStack), json.RawMessage(endpoints), json.RawMessage(apiSpec)
		if bill.Valid {
			m.Billing = json.RawMessage(bill.String)
		}
		if deps.Valid {
			m.APIDependencies = json.RawMessage(deps.String)
		}
		if versions.Valid {
			m.APIVersions = json.RawMessage(versions.String)
		}
		if gateway.Valid {
			m.GatewayCompatibility = &gateway.String
		}
		if tier.Valid {
			m.FeatureTier = &tier.String
		}
		m.Relations, err = readRelations(tx, a.ProjectID)
		return err
	})
	if err != nil {
		return nil, err
	}
	if a.IncludeDocs {
		return map[string]any{"manifest": m, "internalDocs": docs}, nil
	}
	return map[string]any{"manifest": m}, nil
}
