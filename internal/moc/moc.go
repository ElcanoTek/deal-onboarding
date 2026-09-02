// Package moc is a thin client for the MOC task-runner API. Deal Onboarding uses it to
// create a deal-creation task directly (uploading any attached domain/app-bundle
// list files, then POSTing the generated batch prompt) instead of having the
// trader paste into MOC's web UI.
//
// IMPORTANT: this integration is OFF unless both MOC_BASE_URL and MOC_API_KEY
// are set. Nothing fires live until an operator configures those — see
// Config.Enabled. Going through this API path (rather than the web UI) also
// avoids MOC's UI appending its own generic email block, so only the single
// branded deal-sheet email fires.
package moc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Config is the MOC connection, read from the environment.
type Config struct {
	// Backend selects the runner wire protocol. "moc" is the legacy default;
	// "fleet" uses Fleet's versioned in-process task API.
	Backend string
	BaseURL string
	APIKey  string
	// TargetNode pins the MOC node (agent) every Deal Onboarding-created task runs on
	// (MOC's target_node_name). Empty → MOC assigns any eligible node.
	TargetNode string
	// Model / FallbackModel pin the model slugs MOC passes through to the
	// runner. Empty → the runner's default model.
	Model         string
	FallbackModel string
	Persona       string
	MCPServers    []string
}

// configFromEnvPrefix reads one instance's config from <prefix>BASE_URL,
// <prefix>API_KEY (scoped create_task key) plus the optional <prefix>TARGET_NODE /
// <prefix>MODEL / <prefix>FALLBACK_MODEL pins.
func configFromEnvPrefix(prefix string) Config {
	backend := strings.ToLower(strings.TrimSpace(os.Getenv(prefix + "BACKEND")))
	if backend == "" {
		backend = "moc"
	}
	return Config{
		Backend:       backend,
		BaseURL:       strings.TrimRight(strings.TrimSpace(os.Getenv(prefix+"BASE_URL")), "/"),
		APIKey:        strings.TrimSpace(os.Getenv(prefix + "API_KEY")),
		TargetNode:    strings.TrimSpace(os.Getenv(prefix + "TARGET_NODE")),
		Model:         strings.TrimSpace(os.Getenv(prefix + "MODEL")),
		FallbackModel: strings.TrimSpace(os.Getenv(prefix + "FALLBACK_MODEL")),
		Persona:       strings.TrimSpace(os.Getenv(prefix + "PERSONA")),
		MCPServers:    splitCSV(os.Getenv(prefix + "MCP_SERVERS")),
	}
}

func splitCSV(raw string) []string {
	var out []string
	for _, value := range strings.Split(raw, ",") {
		if value = strings.TrimSpace(value); value != "" {
			out = append(out, value)
		}
	}
	return out
}

// ConfigFromEnv reads the prod instance (the MOC_* vars).
func ConfigFromEnv() Config {
	return configFromEnvPrefix("MOC_")
}

// Environment ids a submit may target. Prod is the default; dev is the
// opt-in second instance for testing — during the Fleet port that is the
// Fleet dev operations center running the operator's config bundle. The id stays
// "dev" (not "fleet") because it names the SLOT, not the backend: the wire
// field, the per-environment idempotency ledger namespace and For()'s
// validation are all keyed on it. Which backend a slot speaks is Config.Backend.
//
// Dev is a testing target, NOT a sandbox: its runner holds live SSP
// credentials, so the deals its agent books are just as real as prod's.
const (
	EnvProd = "prod"
	EnvDev  = "dev"
)

// Environments holds every configured runner instance. Prod reads RUNNER_*
// (falling back to the legacy MOC_* vars), Dev reads RUNNER_DEV_*; each is
// independently optional (Enabled() false when unset) and handlers fail
// closed per instance.
type Environments struct {
	Prod Config
	Dev  Config
}

// EnvironmentsFromEnv reads both instances from the environment.
//
// Prod keeps its legacy MOC_* fallback: production traffic still runs on the
// MOC deployment and must not move as a side effect of the Fleet port.
//
// Dev reads RUNNER_DEV_* ONLY. The old dev MOC deployment is gone, so the
// MOC_DEV_* fallback was removed rather than left to resolve against a dead
// host — a stale MOC_DEV_BASE_URL in a deployment's environment would
// otherwise keep the picker enabled and fail every dev submit at the network.
func EnvironmentsFromEnv() Environments {
	prod := configFromEnvPrefix("RUNNER_")
	if !prod.Enabled() {
		prod = configFromEnvPrefix("MOC_")
	}
	return Environments{
		Prod: prod,
		Dev:  configFromEnvPrefix("RUNNER_DEV_"),
	}
}

// For resolves an environment id to its Config. Blank means prod (every
// pre-picker caller omits the field); ids are case/space-insensitive. An
// unknown id errors rather than falling back — a typo must never silently
// submit a live batch to the wrong MOC.
func (e Environments) For(env string) (Config, error) {
	switch strings.ToLower(strings.TrimSpace(env)) {
	case "", EnvProd:
		return e.Prod, nil
	case EnvDev:
		return e.Dev, nil
	default:
		return Config{}, fmt.Errorf("unknown MOC environment %q (valid: %s, %s)", env, EnvProd, EnvDev)
	}
}

// Enabled reports whether the integration is configured. When false, handlers
// must refuse to call MOC and surface a clear "not configured" error.
func (c Config) Enabled() bool {
	return c.BaseURL != "" && c.APIKey != ""
}

// Client talks to MOC. Construct with New.
type Client struct {
	cfg  Config
	http *http.Client
}

func New(cfg Config) *Client {
	return &Client{cfg: cfg, http: &http.Client{Timeout: 60 * time.Second}}
}

// UploadResult is MOC's /upload response (the fields we use).
type UploadResult struct {
	Filename string `json:"filename"`
	Checksum string `json:"checksum"`
}

// Upload streams one file to MOC's POST /upload (multipart, field "file") and
// returns the stored filename + checksum. The filename is what's referenced in
// a task's files[] array.
func (c *Client) Upload(ctx context.Context, name string, r io.Reader) (UploadResult, error) {
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	contentType := mw.FormDataContentType()
	go func() {
		fw, err := mw.CreateFormFile("file", filepath.Base(name))
		if err == nil {
			_, err = io.Copy(fw, r)
		}
		if err == nil {
			err = mw.Close()
		}
		_ = pw.CloseWithError(err)
	}()

	uploadPath := "/upload"
	if c.cfg.Backend == "fleet" {
		uploadPath = "/v1/upload"
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.cfg.BaseURL+uploadPath, pr)
	if err != nil {
		_ = pr.Close()
		return UploadResult{}, err
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("X-API-Key", c.cfg.APIKey)

	resp, err := c.http.Do(req)
	if err != nil {
		return UploadResult{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return UploadResult{}, fmt.Errorf("MOC upload %s: %d %s", filepath.Base(name), resp.StatusCode, truncate(string(body), 300))
	}
	var out UploadResult
	if err := json.Unmarshal(body, &out); err != nil {
		return UploadResult{}, fmt.Errorf("MOC upload: unexpected response: %s", truncate(string(body), 200))
	}
	if out.Filename == "" {
		return UploadResult{}, fmt.Errorf("MOC upload: response missing filename")
	}
	return out, nil
}

// MCPChoice names one (server, account) MCP pair for the fleet backend's
// per-task MCP selection and credential allowlist. Account=="" is the
// default/shared seat; a non-empty account is an MCP variant
// slug. Mirrors fleet's models.MCPChoice / CredentialAllowlistEntry at the
// JSON level (see fleetMCPChoice).
type MCPChoice struct {
	Server  string
	Account string
}

// CreateTaskInput is the subset of MOC's TaskCreate the caller supplies. The
// target node and model are pinned from Config (see taskCreateWire), not here.
type CreateTaskInput struct {
	Prompt    string   `json:"prompt"`
	Files     []string `json:"files,omitempty"`
	FileNames []string `json:"file_names,omitempty"`
	// MCPSelection is the fleet backend's per-run (server, account) roster: it
	// becomes BOTH the wire's mcp_selection (fleet's per-run-MCP-client
	// trigger, which preserves per-row taskId writeback attribution) and its
	// credential_allowlist (Gate-3: a populated list permits ONLY the listed
	// pairs — every pair the run must call has to be present, #279). Empty
	// means the caller could not derive the batch's MCP needs; CreateTask then
	// falls back to the configured/full default-seat roster rather than
	// shipping an allowlist that locks the run out of every SSP. Ignored by
	// the legacy moc backend.
	MCPSelection []MCPChoice `json:"-"`
	// SerializationKey is an opaque mutual-exclusion token: the runner
	// executes at most one task per key at a time (moc#442; fleet#709), so a
	// same-key task submitted while another is active waits instead of
	// interleaving. Deal Onboarding keys it to the campaign id ("campaign:<id>") so
	// two batches touching the same campaign can never run concurrently.
	// Empty = no serialization. Additive: runner versions that predate the
	// field ignore it (their decoders tolerate unknown fields) — fleet does
	// not honor it until fleet#709 ships, which the fleet contract fixture
	// tracks (frontend/src/lib/fleet-contract.json).
	SerializationKey string `json:"-"`
}

// taskCreateWire is the actual POST /tasks body: the caller's prompt + files
// merged with the node/model pins from Config. Empty fields are omitted so MOC
// applies its own defaults.
type taskCreateWire struct {
	Prompt           string   `json:"prompt"`
	Files            []string `json:"files,omitempty"`
	TargetNodeName   string   `json:"target_node_name,omitempty"`
	Model            string   `json:"model,omitempty"`
	FallbackModel    string   `json:"fallback_model,omitempty"`
	SerializationKey string   `json:"serialization_key,omitempty"`
}

type fleetMCPChoice struct {
	Server  string `json:"server"`
	Account string `json:"account,omitempty"`
}

type fleetTaskCreateWire struct {
	Prompt              string           `json:"prompt"`
	Files               []string         `json:"files,omitempty"`
	FileNames           []string         `json:"file_names,omitempty"`
	Model               string           `json:"model,omitempty"`
	FallbackModel       string           `json:"fallback_model,omitempty"`
	Persona             string           `json:"persona,omitempty"`
	MCPSelection        []fleetMCPChoice `json:"mcp_selection"`
	CredentialAllowlist []fleetMCPChoice `json:"credential_allowlist"`
	SerializationKey    string           `json:"serialization_key,omitempty"`
}

// defaultFleetMCPServers is the full default-seat roster a fleet task falls
// back to when the caller supplied no MCPSelection and the deployment pins no
// <prefix>MCP_SERVERS: every SSP server Deal Onboarding routes deals to, plus the
// deal_sheet/sendgrid services every run needs for the single consolidated
// email and per-deal writeback. Kept in lockstep with updateSSPServer
// (internal/handlers/moc.go), SSP_SERVER (frontend/src/lib/dealPromptYaml.ts),
// and the bundle catalog names pinned in fleet-contract.json.
var defaultFleetMCPServers = []string{
	"indexexchange_mcp", "openx_mcp", "pubmatic_mcp", "magnite_mcp",
	"xandr_mcp", "medianet_mcp", "triplelift_mcp", "deal_sheet", "sendgrid",
}

// CreateTaskResult carries MOC's created-task id (other fields ignored).
type CreateTaskResult struct {
	ID string `json:"id"`
}

// CreateTaskError classifies a failed CreateTask so the caller can decide
// whether the task might exist. This is load-bearing for idempotency (#225):
// the handler RELEASES a reservation (permitting a clean same-key retry) only
// when the task provably was NOT created, and HOLDS it (fail closed, 409) when
// the outcome is ambiguous — MOC may have accepted the task even though we saw
// an error. Ambiguous() is the sole discriminator; the zero classification is
// ambiguous, so an unrecognized failure holds.
type CreateTaskError struct {
	Err error
	// ambiguous is true when the request may have reached MOC and created the
	// task despite the error (timeout / reset mid-flight / 5xx / undecodable
	// 2xx). False only for provably-not-created failures (request never sent,
	// connection never established, or a definitive 4xx rejection).
	ambiguous bool
}

func (e *CreateTaskError) Error() string { return e.Err.Error() }
func (e *CreateTaskError) Unwrap() error { return e.Err }

// Ambiguous reports whether the task MAY have been created despite this error.
func (e *CreateTaskError) Ambiguous() bool { return e.ambiguous }

// doErrorAmbiguous classifies a transport-level (http.Client.Do) error. A
// failure to even establish the connection means the request never reached
// MOC (NOT created → releasable); any other Do error (timeout, connection
// reset on read/write, EOF, TLS mid-handshake) may have delivered the request
// and created the task (AMBIGUOUS → hold).
func doErrorAmbiguous(err error) bool {
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return false // name never resolved — never dialed
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return false // TCP handshake refused — connection never established
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) && opErr.Op == "dial" {
		return false // failed at dial — connection never established
	}
	return true // conservative default: the request may have been delivered
}

// CreateTask creates a MOC task from the prompt + already-uploaded file names.
// A non-nil error is always a *CreateTaskError so the caller can consult
// Ambiguous() (see #225). The classification is deliberately conservative:
// only provably-not-created failures report Ambiguous()==false.
func (c *Client) CreateTask(ctx context.Context, in CreateTaskInput) (CreateTaskResult, error) {
	var wire any
	createPath := "/tasks"
	if c.cfg.Backend == "fleet" {
		// The caller's derived per-batch (server, account) pairs become BOTH
		// mcp_selection and credential_allowlist. Fleet's Gate-3 semantics
		// make the allowlist exclusive (a populated list permits ONLY the
		// listed pairs, every other MCP call is denied at the broker), so a
		// pair the run needs but the caller failed to derive would lock the
		// batch out of its SSPs (#279) — the empty-selection fallback below is
		// the fail-open-to-global-roster escape hatch for callers that cannot
		// determine the batch's MCP needs (e.g. a hand-written free-text
		// prompt with no recognizable batch structure).
		choices := make([]fleetMCPChoice, 0, len(in.MCPSelection))
		for _, choice := range in.MCPSelection {
			choices = append(choices, fleetMCPChoice{Server: choice.Server, Account: choice.Account})
		}
		if len(choices) == 0 {
			servers := c.cfg.MCPServers
			if len(servers) == 0 {
				servers = defaultFleetMCPServers
			}
			for _, server := range servers {
				choices = append(choices, fleetMCPChoice{Server: server})
			}
		}
		wire = fleetTaskCreateWire{Prompt: in.Prompt, Files: in.Files, FileNames: in.FileNames, Model: c.cfg.Model, FallbackModel: c.cfg.FallbackModel, Persona: c.cfg.Persona, MCPSelection: choices, CredentialAllowlist: choices, SerializationKey: in.SerializationKey}
		createPath = "/v1/tasks"
	} else {
		wire = taskCreateWire{Prompt: in.Prompt, Files: in.Files, TargetNodeName: c.cfg.TargetNode, Model: c.cfg.Model, FallbackModel: c.cfg.FallbackModel, SerializationKey: in.SerializationKey}
	}
	payload, err := json.Marshal(wire)
	if err != nil {
		// Nothing was sent — the payload never left the process.
		return CreateTaskResult{}, &CreateTaskError{Err: err, ambiguous: false}
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.cfg.BaseURL+createPath, bytes.NewReader(payload))
	if err != nil {
		// Request construction failed — nothing was sent.
		return CreateTaskResult{}, &CreateTaskError{Err: err, ambiguous: false}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", c.cfg.APIKey)

	resp, err := c.http.Do(req)
	if err != nil {
		return CreateTaskResult{}, &CreateTaskError{
			Err:       fmt.Errorf("MOC create task: %w", err),
			ambiguous: doErrorAmbiguous(err),
		}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		// MOC validates a task request before it creates anything, so a 4xx is
		// a definitive "not created" (releasable). A 5xx (or any other non-2xx)
		// may have failed AFTER the task was persisted → AMBIGUOUS (hold).
		notCreated := resp.StatusCode >= 400 && resp.StatusCode < 500
		return CreateTaskResult{}, &CreateTaskError{
			Err:       fmt.Errorf("MOC create task: %d %s", resp.StatusCode, truncate(string(body), 300)),
			ambiguous: !notCreated,
		}
	}
	// MOC returns the created task object; we only need its id. Decode loosely
	// so a richer response shape doesn't break us. A 2xx we can't decode means
	// the task was very likely created but we can't read its id → AMBIGUOUS.
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return CreateTaskResult{}, &CreateTaskError{
			Err:       fmt.Errorf("MOC create task: unexpected response: %s", truncate(string(body), 200)),
			ambiguous: true,
		}
	}
	id, _ := raw["id"].(string)
	if id == "" {
		// some APIs nest under "task"
		if t, ok := raw["task"].(map[string]any); ok {
			id, _ = t["id"].(string)
		}
	}
	return CreateTaskResult{ID: id}, nil
}

// TaskURL builds a best-effort browser link to a created task. On the fleet
// backend the trader-facing task view lives in the orchestrator web UI at
// /orchestrator/tasks/{id} — the exact link fleet's own notifications build
// (fleet internal/runner/notify.go) — while BaseURL+"/tasks/"+id is fleet's
// auth-gated JSON API route, which 401s in a browser (#282.1). The legacy MOC
// backend keeps its /tasks/{id} web route.
func (c *Client) TaskURL(id string) string {
	if id == "" {
		return ""
	}
	if c.cfg.Backend == "fleet" {
		return c.cfg.BaseURL + "/orchestrator/tasks/" + id
	}
	return c.cfg.BaseURL + "/tasks/" + id
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// CheckResult reports what a connection probe learned about one configured
// runner instance. Reachable and KeyAccepted are independent: a fleet
// deployment answers /api-info without auth, so a reachable server with a
// rejected key is the common misconfiguration and must read differently from
// "host is down".
type CheckResult struct {
	Backend string `json:"backend"`
	BaseURL string `json:"baseUrl"`
	// Reachable is true when the version-discovery endpoint answered.
	Reachable bool `json:"reachable"`
	// APIVersion / ServerVersion come from fleet's /api-info body.
	APIVersion    string `json:"apiVersion,omitempty"`
	ServerVersion string `json:"serverVersion,omitempty"`
	// KeyAccepted is true when the configured API key cleared the SAME
	// authorization gate a real create runs. Nil-ish (false) with a populated
	// KeyError means the probe ran and the key was refused.
	KeyAccepted bool   `json:"keyAccepted"`
	KeyError    string `json:"keyError,omitempty"`
	Error       string `json:"error,omitempty"`
}

// checkTimeout bounds a connection probe. Short on purpose: this is an
// interactive "is it up?" button, not a submit.
const checkTimeout = 10 * time.Second

// Check probes the configured instance without creating anything.
//
// Two stages, because they fail for different reasons and the operator needs
// to tell them apart:
//
//  1. GET /api-info — fleet serves version discovery UNAUTHENTICATED (fleet
//     internal/apiversion: same posture as /healthz), so this isolates pure
//     reachability and reports the API version Deal Onboarding is talking to.
//  2. POST /v1/tasks/estimate — fleet's cost forecast runs
//     authorizeTaskCreate, the SAME gate as POST /v1/tasks, and is read-only
//     by construction ("it creates nothing — so the forecast endpoint cannot
//     become a weaker path to task creation"). Authorization runs BEFORE the
//     body is parsed, so any non-401/403 answer means the key cleared the
//     gate; we deliberately do not require the body to validate.
//
// The estimate probe reuses the same TaskCreate wire shape Deal Onboarding already
// sends, so it adds no new coupling to fleet's API surface.
func (c *Client) Check(ctx context.Context) CheckResult {
	res := CheckResult{Backend: c.cfg.Backend, BaseURL: c.cfg.BaseURL}
	if !c.cfg.Enabled() {
		res.Error = "not configured (base URL and API key are both required)"
		return res
	}
	if c.cfg.Backend != "fleet" {
		// The legacy MOC backend publishes no documented probe endpoint.
		// Report honestly rather than inventing one and misreporting a 404.
		res.Error = "connection check is only implemented for the fleet backend"
		return res
	}

	ctx, cancel := context.WithTimeout(ctx, checkTimeout)
	defer cancel()

	// Stage 1: unauthenticated reachability + version discovery.
	req, err := http.NewRequestWithContext(ctx, "GET", c.cfg.BaseURL+"/api-info", nil)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	resp, err := c.http.Do(req)
	if err != nil {
		res.Error = fmt.Sprintf("cannot reach %s: %v", c.cfg.BaseURL, err)
		return res
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		res.Error = fmt.Sprintf("GET /api-info: %d %s", resp.StatusCode, truncate(string(body), 200))
		return res
	}
	var info struct {
		APIVersion   string `json:"api_version"`
		FleetVersion string `json:"fleet_version"`
	}
	if err := json.Unmarshal(body, &info); err != nil {
		res.Error = fmt.Sprintf("GET /api-info: unexpected response: %s", truncate(string(body), 200))
		return res
	}
	res.Reachable = true
	res.APIVersion = info.APIVersion
	res.ServerVersion = info.FleetVersion

	// Stage 2: does the configured key clear the create gate?
	payload, err := json.Marshal(fleetTaskCreateWire{Prompt: "deal-onboarding connection check", Model: c.cfg.Model, Persona: c.cfg.Persona})
	if err != nil {
		res.KeyError = err.Error()
		return res
	}
	req, err = http.NewRequestWithContext(ctx, "POST", c.cfg.BaseURL+"/v1/tasks/estimate", bytes.NewReader(payload))
	if err != nil {
		res.KeyError = err.Error()
		return res
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", c.cfg.APIKey)
	resp, err = c.http.Do(req)
	if err != nil {
		res.KeyError = fmt.Sprintf("estimate probe failed: %v", err)
		return res
	}
	body, _ = io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	_ = resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		res.KeyError = fmt.Sprintf("key rejected (%d): %s", resp.StatusCode, truncate(string(body), 200))
	default:
		// Authorization precedes body validation, so a 400 on our minimal
		// payload still proves the key cleared the gate.
		res.KeyAccepted = true
	}
	return res
}
