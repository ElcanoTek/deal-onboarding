package runner

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestEnabled(t *testing.T) {
	cases := []struct {
		name string
		cfg  Config
		want bool
	}{
		{"both set", Config{BaseURL: "https://fleet", APIKey: "k"}, true},
		{"no url", Config{APIKey: "k"}, false},
		{"no key", Config{BaseURL: "https://fleet"}, false},
		{"empty", Config{}, false},
	}
	for _, c := range cases {
		if got := c.cfg.Enabled(); got != c.want {
			t.Errorf("%s: Enabled()=%v want %v", c.name, got, c.want)
		}
	}
}

func TestUpload(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/upload" {
			t.Errorf("path: got %s", r.URL.Path)
		}
		if r.Header.Get("X-API-Key") != "secret" {
			t.Errorf("missing/wrong api key header: %q", r.Header.Get("X-API-Key"))
		}
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
			t.Errorf("not multipart: %q", r.Header.Get("Content-Type"))
		}
		f, hdr, err := r.FormFile("file")
		if err != nil {
			t.Fatalf("FormFile: %v", err)
		}
		defer f.Close()
		b, _ := io.ReadAll(f)
		if string(b) != "example.com\nfoo.com\n" {
			t.Errorf("file body: %q", b)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"filename": hdr.Filename + "_abc", "checksum": "sha"})
	}))
	defer srv.Close()

	c := New(Config{BaseURL: srv.URL, APIKey: "secret"})
	res, err := c.Upload(context.Background(), "block.csv", strings.NewReader("example.com\nfoo.com\n"))
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if res.Filename != "block.csv_abc" || res.Checksum != "sha" {
		t.Errorf("unexpected result: %+v", res)
	}
}

func TestUploadErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("nope"))
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL, APIKey: "k"})
	if _, err := c.Upload(context.Background(), "x.csv", strings.NewReader("a")); err == nil {
		t.Error("expected error on 400")
	}
}

func TestUploadStreamsBeforeSourceEOF(t *testing.T) {
	serverRead := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mr, err := r.MultipartReader()
		if err != nil {
			t.Errorf("MultipartReader: %v", err)
			return
		}
		part, err := mr.NextPart()
		if err != nil {
			t.Errorf("NextPart: %v", err)
			return
		}
		buf := make([]byte, 6)
		if _, err := io.ReadFull(part, buf); err != nil || string(buf) != "first-" {
			t.Errorf("first streamed bytes = %q, err=%v", buf, err)
			return
		}
		close(serverRead)
		body, _ := io.ReadAll(part)
		if string(body) != "second" {
			t.Errorf("remaining body = %q", body)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"filename": "stream.csv"})
	}))
	defer srv.Close()

	sourceR, sourceW := io.Pipe()
	done := make(chan error, 1)
	go func() {
		_, err := New(Config{BaseURL: srv.URL, APIKey: "k"}).Upload(context.Background(), "stream.csv", sourceR)
		done <- err
	}()
	if _, err := sourceW.Write([]byte("first-")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-serverRead:
		// The server received bytes while the source is still open: Upload did
		// not buffer the entire attachment before starting the request.
	case <-time.After(2 * time.Second):
		t.Fatal("server received no bytes before source EOF; upload appears buffered")
	}
	_, _ = sourceW.Write([]byte("second"))
	_ = sourceW.Close()
	if err := <-done; err != nil {
		t.Fatalf("Upload: %v", err)
	}
}

func TestCreateTask(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/tasks" {
			t.Errorf("path: got %s", r.URL.Path)
		}
		if r.Header.Get("X-API-Key") != "secret" {
			t.Errorf("missing api key")
		}
		var body CreateTaskInput
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if body.Prompt != "do the thing" {
			t.Errorf("prompt: %q", body.Prompt)
		}
		if len(body.Files) != 1 || body.Files[0] != "block.csv_abc" {
			t.Errorf("files: %v", body.Files)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "task-123", "status": "pending"})
	}))
	defer srv.Close()

	c := New(Config{BaseURL: srv.URL, APIKey: "secret"})
	res, err := c.CreateTask(context.Background(), CreateTaskInput{Prompt: "do the thing", Files: []string{"block.csv_abc"}})
	if err != nil {
		t.Fatalf("CreateTask: %v", err)
	}
	if res.ID != "task-123" {
		t.Errorf("id: %q", res.ID)
	}
	if got := c.TaskURL(res.ID); got != srv.URL+"/orchestrator/tasks/task-123" {
		t.Errorf("TaskURL: %q", got)
	}
}

func TestFleetCreateTaskWire(t *testing.T) {
	var got fleetTaskCreateWire
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/tasks" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "fleet-1"})
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL, APIKey: "k", Persona: "runner-persona"})
	_, err := c.CreateTask(context.Background(), CreateTaskInput{
		Prompt: "create", Files: []string{"domains_abcd.csv"}, FileNames: []string{"domains.csv"},
		MCPSelection: []MCPChoice{
			{Server: "openx_mcp", Account: "client-a"},
			{Server: "pubmatic_mcp"},
			{Server: "deal_sheet"},
		},
		SerializationKey: "campaign:DEAL00002",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.FileNames) != 1 || got.FileNames[0] != "domains.csv" || got.Persona != "runner-persona" {
		t.Fatalf("fleet wire = %+v", got)
	}
	// The caller's per-pair selection rides BOTH mcp_selection and the Gate-3
	// credential_allowlist verbatim: variant pairs keep their account, default-
	// seat pairs stay accountless (#279 — a mixed batch must carry both).
	want := []fleetMCPChoice{
		{Server: "openx_mcp", Account: "client-a"},
		{Server: "pubmatic_mcp"},
		{Server: "deal_sheet"},
	}
	if !reflect.DeepEqual(got.MCPSelection, want) {
		t.Fatalf("mcp_selection = %+v, want %+v", got.MCPSelection, want)
	}
	if !reflect.DeepEqual(got.CredentialAllowlist, want) {
		t.Fatalf("credential_allowlist = %+v, want %+v", got.CredentialAllowlist, want)
	}
	if got.SerializationKey != "campaign:DEAL00002" {
		t.Fatalf("serialization_key = %q", got.SerializationKey)
	}
}

// An empty MCPSelection means the caller could not derive the batch's MCP
// needs: the client falls back to the FULL default-seat roster (#279 — the
// fallback is the fail-open escape hatch, never a deal_sheet/sendgrid-only
// allowlist), preferring the deployment's pinned MCP_SERVERS when set.
func TestFleetCreateTaskEmptySelectionFallsBackToFullRoster(t *testing.T) {
	var got fleetTaskCreateWire
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "fleet-1"})
	}))
	defer srv.Close()

	c := New(Config{BaseURL: srv.URL, APIKey: "k"})
	if _, err := c.CreateTask(context.Background(), CreateTaskInput{Prompt: "free text"}); err != nil {
		t.Fatal(err)
	}
	servers := make([]string, 0, len(got.CredentialAllowlist))
	for _, ch := range got.CredentialAllowlist {
		if ch.Account != "" {
			t.Fatalf("fallback roster must be default-seat only, got %+v", ch)
		}
		servers = append(servers, ch.Server)
	}
	if !reflect.DeepEqual(servers, defaultFleetMCPServers) {
		t.Fatalf("fallback servers = %v, want %v", servers, defaultFleetMCPServers)
	}

	// A deployment pin (MCP_SERVERS) overrides the built-in roster.
	got = fleetTaskCreateWire{}
	c = New(Config{BaseURL: srv.URL, APIKey: "k", MCPServers: []string{"openx_mcp", "deal_sheet", "sendgrid"}})
	if _, err := c.CreateTask(context.Background(), CreateTaskInput{Prompt: "free text"}); err != nil {
		t.Fatal(err)
	}
	if len(got.MCPSelection) != 3 || got.MCPSelection[0].Server != "openx_mcp" {
		t.Fatalf("pinned roster = %+v", got.MCPSelection)
	}
}

// TestCreateTaskSerializationKeyWire pins the exact wire name of the
// serialization key: present verbatim when supplied, omitted entirely when
// empty so runner versions that predate the field see an unchanged body.
func TestCreateTaskSerializationKeyWire(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatalf("decode: %v", err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "t1"})
	}))
	defer srv.Close()

	c := New(Config{BaseURL: srv.URL, APIKey: "k"})
	if _, err := c.CreateTask(context.Background(), CreateTaskInput{Prompt: "p", SerializationKey: "campaign:DEAL00001"}); err != nil {
		t.Fatalf("CreateTask: %v", err)
	}
	if got["serialization_key"] != "campaign:DEAL00001" {
		t.Errorf("serialization_key: %v", got["serialization_key"])
	}

	got = nil
	if _, err := c.CreateTask(context.Background(), CreateTaskInput{Prompt: "p"}); err != nil {
		t.Fatalf("CreateTask: %v", err)
	}
	if _, present := got["serialization_key"]; present {
		t.Errorf("expected serialization_key omitted when unset, got %v", got["serialization_key"])
	}
}

func TestCreateTaskNestedID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"task":{"id":"nested-9"}}`))
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL, APIKey: "k"})
	res, err := c.CreateTask(context.Background(), CreateTaskInput{Prompt: "p"})
	if err != nil {
		t.Fatalf("CreateTask: %v", err)
	}
	if res.ID != "nested-9" {
		t.Errorf("nested id: %q", res.ID)
	}
}

func TestEnvironmentsFromEnv(t *testing.T) {
	t.Setenv("RUNNER_BASE_URL", "https://fleet.example/")
	t.Setenv("RUNNER_API_KEY", "pk")
	t.Setenv("RUNNER_PERSONA", "runner-persona")
	t.Setenv("RUNNER_MCP_SERVERS", "openx_mcp, deal_sheet ,sendgrid")
	t.Setenv("RUNNER_DEV_BASE_URL", "https://fleetdev.example/")
	t.Setenv("RUNNER_DEV_API_KEY", "dk")

	envs := EnvironmentsFromEnv()
	if envs.Prod.BaseURL != "https://fleet.example" || envs.Prod.APIKey != "pk" || envs.Prod.Persona != "runner-persona" || !envs.Prod.Enabled() {
		t.Fatalf("bad prod config: %+v", envs.Prod)
	}
	if !reflect.DeepEqual(envs.Prod.MCPServers, []string{"openx_mcp", "deal_sheet", "sendgrid"}) {
		t.Fatalf("MCP_SERVERS not split/trimmed: %v", envs.Prod.MCPServers)
	}
	if envs.Dev.BaseURL != "https://fleetdev.example" || envs.Dev.APIKey != "dk" || !envs.Dev.Enabled() {
		t.Fatalf("bad dev config: %+v", envs.Dev)
	}
}

// Legacy MOC_* variables are NOT read: a stale block in a deployment's
// environment must never configure a slot.
func TestLegacyMOCVarsIgnored(t *testing.T) {
	t.Setenv("MOC_BASE_URL", "https://old.example")
	t.Setenv("MOC_API_KEY", "stale")
	envs := EnvironmentsFromEnv()
	if envs.Prod.Enabled() || envs.Dev.Enabled() {
		t.Fatalf("MOC_* must not configure any slot: %+v", envs)
	}
}

func TestEnvironmentsFor(t *testing.T) {
	envs := Environments{
		Prod: Config{BaseURL: "https://fleet.example", APIKey: "pk"},
		Dev:  Config{BaseURL: "https://dev.example", APIKey: "dk"},
	}
	for _, id := range []string{"", "prod", "Prod", " PROD "} {
		cfg, err := envs.For(id)
		if err != nil || cfg.BaseURL != envs.Prod.BaseURL {
			t.Fatalf("For(%q): want prod, got %+v err=%v", id, cfg, err)
		}
	}
	for _, id := range []string{"dev", "DEV", " dev "} {
		cfg, err := envs.For(id)
		if err != nil || cfg.BaseURL != envs.Dev.BaseURL {
			t.Fatalf("For(%q): want dev, got %+v err=%v", id, cfg, err)
		}
	}
	// Unknown ids must error — never fall back to prod.
	if _, err := envs.For("staging"); err == nil {
		t.Fatal("For(staging): want error, got nil")
	}
}

// Check must distinguish the three states an operator actually hits: host
// down, host up but key refused, and fully working. Conflating the middle one
// with "unreachable" sends them chasing DNS instead of the key.
func TestCheckFleetReachableAndKeyAccepted(t *testing.T) {
	var estimateAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api-info":
			if r.Method != "GET" {
				t.Errorf("api-info method = %s, want GET", r.Method)
			}
			_, _ = w.Write([]byte(`{"api_version":"1","fleet_version":"2.3.4"}`))
		case "/v1/tasks/estimate":
			estimateAuth = r.Header.Get("X-API-Key")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{}`))
		default:
			t.Errorf("unexpected probe path %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	res := New(Config{BaseURL: srv.URL, APIKey: "k"}).Check(context.Background())
	if !res.Reachable || !res.KeyAccepted {
		t.Fatalf("want reachable+accepted, got %+v", res)
	}
	if res.APIVersion != "1" || res.ServerVersion != "2.3.4" {
		t.Fatalf("version discovery not surfaced: %+v", res)
	}
	if estimateAuth != "k" {
		t.Fatalf("estimate probe sent X-API-Key %q, want %q", estimateAuth, "k")
	}
}

func TestCheckFleetKeyRejected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api-info" {
			_, _ = w.Write([]byte(`{"api_version":"1","fleet_version":"2.3.4"}`))
			return
		}
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"insufficient key scope"}`))
	}))
	defer srv.Close()

	res := New(Config{BaseURL: srv.URL, APIKey: "bad"}).Check(context.Background())
	if !res.Reachable {
		t.Fatalf("a 403 on the key probe must NOT read as unreachable: %+v", res)
	}
	if res.KeyAccepted || res.KeyError == "" {
		t.Fatalf("want key rejected with a reason, got %+v", res)
	}
}

// Authorization runs before body validation on fleet's estimate endpoint, so a
// 400 on our minimal payload still proves the key cleared the create gate.
func TestCheckFleetTreatsBadRequestAsKeyAccepted(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api-info" {
			_, _ = w.Write([]byte(`{"api_version":"1","fleet_version":"2.3.4"}`))
			return
		}
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer srv.Close()

	res := New(Config{BaseURL: srv.URL, APIKey: "k"}).Check(context.Background())
	if !res.Reachable || !res.KeyAccepted {
		t.Fatalf("400 must count as key-accepted: %+v", res)
	}
}

func TestCheckUnreachableAndUnconfigured(t *testing.T) {
	// Closed port → unreachable, and no key verdict is claimed.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close()
	res := New(Config{BaseURL: url, APIKey: "k"}).Check(context.Background())
	if res.Reachable || res.Error == "" || res.KeyAccepted {
		t.Fatalf("want unreachable with an error and no key claim, got %+v", res)
	}

	if res := (New(Config{}).Check(context.Background())); res.Error == "" || res.Reachable {
		t.Fatalf("unconfigured instance must report not-configured, got %+v", res)
	}

}
