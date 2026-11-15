package core

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"reflect"
	"slices"
	"testing"
)

func manifest(id, name, description string, relations ...map[string]any) map[string]any {
	if relations == nil {
		relations = []map[string]any{}
	}
	return map[string]any{
		"id": id, "name": name, "description": description, "techStack": []string{"go"}, "relations": relations,
		"repositoryUrl": "https://example.com/" + id, "localPath": "/src/" + id, "endpoints": []any{}, "apiSpec": []any{},
	}
}

func dependsOn(id string) map[string]any { return map[string]any{"targetId": id, "type": "dependency"} }

func (h *harness) sync(m map[string]any) {
	h.t.Helper()
	h.ok("sync_project_assets", map[string]any{"manifest": m, "internalDocs": "# " + m["id"].(string)}, "ide-a")
}

func (h *harness) relationsOf(id string) []any {
	h.t.Helper()
	return h.ok("get_project", map[string]any{"projectId": id}, "")["manifest"].(map[string]any)["relations"].([]any)
}

func TestSyncAndGetProject(t *testing.T) {
	h := newHarness(t)
	m := manifest("web_a", "A", "storefront", dependsOn("web_b"))
	m["endpoints"] = []any{map[string]any{"name": "api", "url": "http://x", "description": "main", "extra": "dropped"}}
	m["billing"] = map[string]any{"plain": "free", "price": "0"}
	m["apiDependencies"] = map[string]any{}
	m["unknownField"] = true
	h.sync(m)

	got := h.ok("get_project", map[string]any{"projectId": "web_a"}, "")
	want := map[string]any{
		"internalDocs": "# web_a",
		"manifest": map[string]any{
			"id": "web_a", "name": "A", "description": "storefront", "techStack": []any{"go"},
			"relations":   []any{map[string]any{"targetId": "web_b", "type": "dependency"}},
			"lastUpdated": "2026-10-23T12:00:00.000Z", "repositoryUrl": "https://example.com/web_a", "localPath": "/src/web_a",
			"endpoints": []any{map[string]any{"name": "api", "url": "http://x", "description": "main"}},
			"apiSpec":   []any{}, "billing": map[string]any{"plain": "free", "price": "0"}, "apiDependencies": map[string]any{},
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("get_project:\n got %v\nwant %v", got, want)
	}
	slim := h.ok("get_project", map[string]any{"projectId": "web_a", "includeDocs": false}, "")
	if _, ok := slim["internalDocs"]; ok {
		t.Fatal("includeDocs false still returns internalDocs")
	}
	h.fails(400, "Project 'web_none' not found.", "get_project", map[string]any{"projectId": "web_none"}, "")

	// A given lastUpdated is kept; a second sync replaces the manifest but keeps the assets.
	h.ok("upload_project_asset", map[string]any{"projectId": "web_a", "fileName": "a.txt", "base64Content": "eA=="}, "ide-a")
	m2 := manifest("web_a", "A2", "")
	m2["lastUpdated"] = "2020-01-01T00:00:00.000Z"
	h.sync(m2)
	got = h.ok("get_project", map[string]any{"projectId": "web_a"}, "")["manifest"].(map[string]any)
	if got["name"] != "A2" || got["lastUpdated"] != "2020-01-01T00:00:00.000Z" || len(got["relations"].([]any)) != 0 || got["billing"] != nil {
		t.Fatalf("resync: %v", got)
	}
	if n := h.count(`SELECT COUNT(*) FROM project_assets WHERE project_id = 'web_a'`); n != 1 {
		t.Fatalf("resync dropped assets: %d", n)
	}
}

func TestUpdateProject(t *testing.T) {
	h := newHarness(t)
	h.sync(manifest("web_a", "A", "old"))
	h.clock.Set(start.Add(60_000_000_000))
	h.ok("update_project", map[string]any{"projectId": "web_a", "patch": map[string]any{
		"relations": []any{dependsOn("web_b")}, "description": "new", "feature_tier": "team", "gatewayCompatibility": "",
	}}, "ide-b")
	m := h.ok("get_project", map[string]any{"projectId": "web_a"}, "")["manifest"].(map[string]any)
	if m["description"] != "new" || m["name"] != "A" || m["feature_tier"] != "team" || m["gatewayCompatibility"] != "" ||
		m["lastUpdated"] != "2026-10-23T12:01:00.000Z" || len(m["relations"].([]any)) != 1 {
		t.Fatalf("patched manifest: %v", m)
	}
	ev := h.ok("list_events", map[string]any{"action": "project.update"}, "")["events"].([]any)[0].(map[string]any)
	if !reflect.DeepEqual(ev["detail"], map[string]any{"fields": []any{"description", "relations", "gatewayCompatibility", "feature_tier"}}) ||
		ev["actor"] != "ide-b" || ev["target"] != "web_a" {
		t.Fatalf("event: %v", ev)
	}
	h.fails(400, "not found", "update_project", map[string]any{"projectId": "nope", "patch": map[string]any{}}, "")
	h.fails(400, "Invalid arguments", "update_project", map[string]any{"projectId": "web_a", "patch": map[string]any{"id": "x"}}, "")
}

func TestSearchProjects(t *testing.T) {
	h := newHarness(t)
	h.sync(manifest("web_shop", "Shop", "storefront"))
	h.sync(manifest("api_auth", "Auth", "login service"))
	h.sync(manifest("lib_shopkit", "Kit", "shared shop helpers"))
	for _, tc := range []struct {
		query string
		limit int
		want  []string
	}{
		{"shop", 0, []string{"web_shop", "lib_shopkit"}},
		{"shop", 1, []string{"web_shop"}},
		{"AUTH", 0, []string{"api_auth"}},
		{"LOGIN", 0, []string{"api_auth"}},
		{"kit", 0, []string{"lib_shopkit"}},
		{"zzz", 0, nil},
	} {
		args := map[string]any{"query": tc.query}
		if tc.limit > 0 {
			args["limit"] = tc.limit
		}
		res := h.ok("search_projects", args, "")
		var ids []string
		for _, r := range res["results"].([]any) {
			ids = append(ids, r.(map[string]any)["id"].(string))
		}
		if !slices.Equal(ids, tc.want) || int(res["count"].(float64)) != len(tc.want) {
			t.Errorf("%q limit %d: %v", tc.query, tc.limit, res)
		}
	}
}

func TestTopology(t *testing.T) {
	h := newHarness(t)
	h.sync(manifest("a", "A", "", dependsOn("b"), dependsOn("ghost")))
	h.sync(manifest("b", "B", "", dependsOn("c")))
	h.sync(manifest("c", "C", ""))
	h.sync(manifest("d", "D", "", dependsOn("a")))

	list := h.ok("get_global_topology", map[string]any{}, "")
	if list["mode"] != "list" || !reflect.DeepEqual(list["summary"], map[string]any{"totalProjects": 4.0, "totalEdges": 3.0}) ||
		len(list["projects"].(map[string]any)) != 4 {
		t.Fatalf("list: %v", list)
	}
	if _, ok := list["nodes"]; ok {
		t.Fatal("list mode has nodes")
	}

	for _, tc := range []struct {
		id    string
		nodes []string
		edges int
	}{
		{"a", []string{"a", "b", "c"}, 2},
		{"c", []string{"c"}, 0},
		{"d", []string{"a", "b", "c", "d"}, 3},
	} {
		res := h.ok("get_global_topology", map[string]any{"projectId": tc.id}, "")
		var nodes []string
		for _, n := range res["nodes"].([]any) {
			nodes = append(nodes, n.(map[string]any)["id"].(string))
		}
		if res["mode"] != "focused" || !slices.Equal(nodes, tc.nodes) || len(res["edges"].([]any)) != tc.edges {
			t.Errorf("%s: %v", tc.id, res)
		}
	}
	// A dependency target that was never synced is not a project.
	h.fails(400, "Project 'ghost' not found.", "get_global_topology", map[string]any{"projectId": "ghost"}, "")
}

func TestRenameCascades(t *testing.T) {
	h := newHarness(t)
	h.sync(manifest("a", "A", "", dependsOn("b")))
	h.sync(manifest("b", "B", "", dependsOn("b"), dependsOn("c")))
	h.sync(manifest("c", "C", ""))
	h.ok("upload_project_asset", map[string]any{"projectId": "b", "fileName": "logo.png", "base64Content": "cG5n"}, "ide-a")

	res := h.ok("rename_project", map[string]any{"oldId": "b", "newId": "b2"}, "ide-a")
	if res["newId"] != "b2" || res["oldId"] != "b" {
		t.Fatalf("rename: %v", res)
	}
	h.fails(400, "Project 'b' not found.", "get_project", map[string]any{"projectId": "b"}, "")
	renamed := h.ok("get_project", map[string]any{"projectId": "b2"}, "")
	if renamed["internalDocs"] != "# b" || renamed["manifest"].(map[string]any)["id"] != "b2" {
		t.Fatalf("renamed project: %v", renamed)
	}
	// Relations pointing at it, its own self-relation, and its assets follow.
	if got := h.relationsOf("a"); got[0].(map[string]any)["targetId"] != "b2" {
		t.Fatalf("a relations: %v", got)
	}
	if got := h.relationsOf("b2"); got[0].(map[string]any)["targetId"] != "b2" || got[1].(map[string]any)["targetId"] != "c" {
		t.Fatalf("b2 relations: %v", got)
	}
	if n := h.count(`SELECT COUNT(*) FROM project_assets WHERE project_id = 'b2' AND CAST(data AS TEXT) = 'png'`); n != 1 {
		t.Fatal("asset did not follow the rename")
	}
	// The renamed project moves to the end of the list.
	if n := h.count(`SELECT COUNT(*) FROM projects WHERE id = 'b2' AND position = (SELECT MAX(position) FROM projects)`); n != 1 {
		t.Fatal("renamed project is not last")
	}
	ev := h.ok("list_events", map[string]any{"action": "project.rename"}, "")["events"].([]any)
	if len(ev) != 1 || ev[0].(map[string]any)["target"] != "b2" ||
		!reflect.DeepEqual(ev[0].(map[string]any)["detail"], map[string]any{"oldId": "b"}) {
		t.Fatalf("events: %v", ev)
	}

	h.fails(400, "oldId and newId are identical.", "rename_project", map[string]any{"oldId": "a", "newId": "a"}, "")
	h.fails(400, "Project 'c' already exists.", "rename_project", map[string]any{"oldId": "a", "newId": "c"}, "")
	h.fails(400, "Project 'zz' not found.", "rename_project", map[string]any{"oldId": "zz", "newId": "yy"}, "")
}

func TestConcurrentRenameHasOneWinner(t *testing.T) {
	h := newHarness(t)
	h.sync(manifest("original", "O", ""))
	statuses := make(chan int, 2)
	for _, id := range []string{"target_a", "target_b"} {
		go func() {
			// Not h.call: its t.Fatal would end only this goroutine and leave the test waiting.
			raw, _ := json.Marshal(map[string]any{"tool": "rename_project", "args": map[string]any{"oldId": "original", "newId": id}})
			res, err := http.Post(h.http.URL+"/api/tools/call", "application/json", bytes.NewReader(raw))
			if err != nil {
				t.Error(err)
				statuses <- 0
				return
			}
			res.Body.Close()
			statuses <- res.StatusCode
		}()
	}
	got := []int{<-statuses, <-statuses}
	slices.Sort(got)
	if !slices.Equal(got, []int{200, 400}) {
		t.Fatalf("statuses %v", got)
	}
	if n := h.count(`SELECT COUNT(*) FROM projects`); n != 1 {
		t.Fatalf("%d projects", n)
	}
}

func TestDeleteProject(t *testing.T) {
	h := newHarness(t)
	h.sync(manifest("a", "A", "", dependsOn("b")))
	h.sync(manifest("b", "B", "", dependsOn("a")))
	h.ok("upload_project_asset", map[string]any{"projectId": "b", "fileName": "x", "base64Content": "eA"}, "")

	h.ok("host_delete_project", map[string]any{"projectId": "b"}, "ide-a")
	h.fails(400, "not found", "get_project", map[string]any{"projectId": "b"}, "")
	if n := h.count(`SELECT COUNT(*) FROM project_relations WHERE project_id = 'b'`) + h.count(`SELECT COUNT(*) FROM project_assets`); n != 0 {
		t.Fatalf("%d rows of the deleted project left", n)
	}
	// Another project's relation to it stays (as it did in the manifests), but is no edge.
	if got := h.relationsOf("a"); len(got) != 1 || got[0].(map[string]any)["targetId"] != "b" {
		t.Fatalf("a relations: %v", got)
	}
	topo := h.ok("get_global_topology", map[string]any{}, "")
	if topo["summary"].(map[string]any)["totalEdges"] != 0.0 {
		t.Fatalf("topology: %v", topo)
	}
	// Re-creating it brings the edge back.
	h.sync(manifest("b", "B", ""))
	if h.ok("get_global_topology", map[string]any{}, "")["summary"].(map[string]any)["totalEdges"] != 1.0 {
		t.Fatal("edge to the re-created project missing")
	}
	h.fails(400, "Project 'zz' not found.", "host_delete_project", map[string]any{"projectId": "zz"}, "")
	if got := h.eventActions("project.delete"); len(got) != 1 {
		t.Fatalf("delete events: %v", got)
	}
}

func TestUploadProjectAsset(t *testing.T) {
	h := newHarness(t)
	content := base64.StdEncoding.EncodeToString([]byte("png-bytes"))
	h.fails(400, "Project 'web_assets' not found.", "upload_project_asset",
		map[string]any{"projectId": "web_assets", "fileName": "logo.png", "base64Content": content}, "")
	h.sync(manifest("web_assets", "Assets", ""))

	res := h.ok("upload_project_asset", map[string]any{"projectId": "web_assets", "fileName": "../etc/../logo v2.png", "base64Content": content}, "ide-u")
	if res["fileName"] != "__etc___logo_v2.png" {
		t.Fatalf("fileName %v", res["fileName"])
	}
	var data []byte
	if err := h.store.DB.QueryRow(`SELECT data FROM project_assets WHERE file_name = ?`, res["fileName"]).Scan(&data); err != nil || string(data) != "png-bytes" {
		t.Fatalf("stored %q %v", data, err)
	}
	// Same name again overwrites.
	h.ok("upload_project_asset", map[string]any{"projectId": "web_assets", "fileName": "../etc/../logo v2.png", "base64Content": "eA=="}, "ide-u")
	if n := h.count(`SELECT COUNT(*) FROM project_assets WHERE CAST(data AS TEXT) = 'x'`); n != 1 || h.count(`SELECT COUNT(*) FROM project_assets`) != 1 {
		t.Fatal("re-upload did not overwrite")
	}
	h.fails(400, "Invalid fileName '.': it names no file.", "upload_project_asset",
		map[string]any{"projectId": "web_assets", "fileName": ".", "base64Content": content}, "")

	ev := h.ok("list_events", map[string]any{"action": "project.asset"}, "")["events"].([]any)[1].(map[string]any)
	if !reflect.DeepEqual(ev["detail"], map[string]any{"fileName": "__etc___logo_v2.png", "bytes": 9.0}) {
		t.Fatalf("event %v", ev)
	}
}

func TestSanitizeFileName(t *testing.T) {
	for in, want := range map[string]string{
		"logo.png":     "logo.png",
		"logo..png":    "logo_png",
		"...":          "_.",
		"..":           "_",
		"a/b\\c:d*e?f": "a_b_c_d_e_f",
		"résumé.pdf":   "r_sum_.pdf",
		"😀.txt":        "__.txt",
		"name with sp": "name_with_sp",
	} {
		if got := sanitizeFileName(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

func TestDecodeBase64LikeNode(t *testing.T) {
	// Expected values from Node's Buffer.from(s, "base64").
	for in, want := range map[string]string{
		"aGVsbG8=":  "hello",
		"aGVsbG8":   "hello",
		"aGV sbG8":  "hello",
		"aGVs=bG8":  "hel",
		"a":         "",
		"aGVsbG8-_": "hello>",
		"!!!aGk":    "hi",
		"aGk=aGk=":  "hi",
	} {
		if got := string(decodeBase64(in)); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

func TestFailedStatementRollsBackTheWholeWrite(t *testing.T) {
	h := newHarness(t)
	h.sync(manifest("a", "A", ""))
	// Any event insert fails: every write records one in the same transaction.
	h.exec(`CREATE TRIGGER fail_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'boom'); END`)

	if r := h.call("rename_project", map[string]any{"oldId": "a", "newId": "b"}, ""); r.status != 500 {
		t.Fatalf("rename: %d %s", r.status, r.err)
	}
	if r := h.call("sync_project_assets", map[string]any{"manifest": manifest("n", "N", "", dependsOn("a")), "internalDocs": ""}, ""); r.status != 500 {
		t.Fatalf("sync: %d", r.status)
	}
	if r := h.call("send_message", map[string]any{"message": "x"}, "i"); r.status != 200 {
		t.Fatalf("send_message records no event: %d %s", r.status, r.err)
	}
	if r := h.call("start_meeting", map[string]any{"topic": "t"}, "i"); r.status != 500 {
		t.Fatalf("start_meeting: %d", r.status)
	}
	h.exec(`DROP TRIGGER fail_events`)

	h.ok("get_project", map[string]any{"projectId": "a"}, "")
	h.fails(400, "not found", "get_project", map[string]any{"projectId": "b"}, "")
	h.fails(400, "not found", "get_project", map[string]any{"projectId": "n"}, "")
	if n := h.count(`SELECT COUNT(*) FROM project_relations`) + h.count(`SELECT COUNT(*) FROM meetings`); n != 0 {
		t.Fatalf("%d rows of failed writes left", n)
	}
	if got := h.eventActions(""); !slices.Equal(got, []string{"project.sync"}) {
		t.Fatalf("events %v", got)
	}
}

func TestResultJSONShapes(t *testing.T) {
	h := newHarness(t)
	h.sync(manifest("a", "A", ""))
	// Absent optional manifest fields are omitted, not null.
	r := h.call("get_project", map[string]any{"projectId": "a"}, "")
	var raw struct {
		Manifest map[string]json.RawMessage `json:"manifest"`
	}
	if err := json.Unmarshal(r.result, &raw); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"billing", "apiDependencies", "gatewayCompatibility", "api_versions", "feature_tier"} {
		if _, ok := raw.Manifest[k]; ok {
			t.Errorf("%s present", k)
		}
	}
}
