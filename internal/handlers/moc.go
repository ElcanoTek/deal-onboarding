package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/ElcanoTek/deal-onboarding/internal/idempotency"
	"github.com/ElcanoTek/deal-onboarding/internal/lists"
	"github.com/ElcanoTek/deal-onboarding/internal/moc"
	"github.com/ElcanoTek/deal-onboarding/internal/overrideaudit"
	"github.com/ElcanoTek/deal-onboarding/internal/validation"
)

// maxAttachRefs caps the number of attachments (ad-hoc uploads + standard
// lists) one submission may carry. Real batches attach a handful; a much larger
// count means a malformed or hostile body, and each ref becomes a sequential
// MOC upload holding the whole file in memory.
const maxAttachRefs = 64

// dealBriefUploadName is the logical file name the validated structured brief
// is uploaded under alongside the prompt. It is RESERVED: fleet rejects
// duplicate logical file_names on a create (a definitive 400), so a trader
// attachment with this exact name would fail the whole submission (#282.2).
// The UI renames colliding attachments deterministically at attach time
// (uniqueLogicalName, frontend/src/lib/files.ts); the handler rejects any that
// slip through.
const dealBriefUploadName = "deal_brief.json"

// mcpLoadServerRe matches one seat-routing load line as the prompt builders
// emit it — mcp_load_servers(names=["<server>"], client="<variant slug>")
// (buildVariantLoadBlock / buildVariantLoadBlockForSsps in dealPromptYaml.ts) —
// capturing the (server, variant) PAIR per line, so a batch loading several
// variant servers routes each to its own account.
var mcpLoadServerRe = regexp.MustCompile(`mcp_load_servers\(\s*names\s*=\s*\[\s*["']([A-Za-z0-9._-]+)["']\s*\]\s*,\s*client\s*=\s*["']([A-Za-z0-9._-]+)["']\s*\)`)

// sspServerByKey maps a normalized SSP key to its runner MCP server name.
// Kept in lockstep with SSP_SERVER in frontend/src/lib/dealPromptYaml.ts and
// pinned by frontend/src/lib/fleet-contract.json.
var sspServerByKey = map[string]string{
	"indexexchange": "indexexchange_mcp",
	"openx":         "openx_mcp",
	"pubmatic":      "pubmatic_mcp",
	"xandr":         "xandr_mcp",
	"medianet":      "medianet_mcp",
	"triplelift":    "triplelift_mcp",
	"magnite":       "magnite_mcp",
}

// sspServerForDisplay maps a form deal's SSP display name ("Index Exchange",
// "Media.net", …) to its runner MCP server name.
func sspServerForDisplay(ssp string) (string, bool) {
	key := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(ssp), " ", ""))
	if key == "media.net" {
		key = "medianet"
	}
	server, ok := sspServerByKey[key]
	return server, ok
}

// resolveMCPSelection derives the fleet backend's per-run (server, account)
// pairs for THIS submission. On fleet the list is BOTH the task's
// mcp_selection and its credential_allowlist, and Gate-3 makes a populated
// allowlist exclusive — every pair the run must call has to be present, or
// the broker denies the call (#279: default-seat batches used to ship
// [deal_sheet, sendgrid] only, locking the run out of every SSP).
//
// The derivation unions two sources:
//
//   - variant-routed servers, from the prompt's mcp_load_servers lines
//     (per-line (server, variant-slug) pairs — the account is the slug);
//   - the batch's remaining SSP servers on the DEFAULT seat: the audited
//     form's non-sheet-only deal SSPs. A server already variant-routed is NOT
//     added on the default seat too (least privilege — the prompt forbids the
//     bare tools for those SSPs).
//
// plus the deal_sheet + sendgrid default-seat services every run needs for
// its single consolidated email. When NEITHER source
// yields a server (a hand-written free-text prompt with no recognizable batch
// structure), it returns nil so the moc client falls back to the configured/
// full default-seat roster — failing open to the global policy rather than
// allowlisting the run into a deal_sheet/sendgrid-only lockout.
func resolveMCPSelection(req *mocCreateRequest) []moc.MCPChoice {
	variantFor := map[string]string{} // server -> variant slug
	var variantServers []string
	for _, m := range mcpLoadServerRe.FindAllStringSubmatch(req.Prompt, -1) {
		server, slug := m[1], m[2]
		if _, seen := variantFor[server]; !seen {
			variantFor[server] = slug
			variantServers = append(variantServers, server)
		}
	}

	seen := map[string]bool{}
	var defaultServers []string
	addDefault := func(server string) {
		if _, variant := variantFor[server]; variant || seen[server] {
			return
		}
		seen[server] = true
		defaultServers = append(defaultServers, server)
	}
	if req.Form != nil {
		for _, deal := range req.Form.Deals {
			if deal.SheetOnly {
				continue
			}
			if server, ok := sspServerForDisplay(deal.SSP); ok {
				addDefault(server)
			}
		}
	}

	if len(variantServers) == 0 && len(defaultServers) == 0 {
		return nil // unrecognizable batch shape — inherit the full roster
	}
	out := make([]moc.MCPChoice, 0, len(variantServers)+len(defaultServers)+2)
	for _, server := range variantServers {
		out = append(out, moc.MCPChoice{Server: server, Account: variantFor[server]})
	}
	for _, server := range defaultServers {
		out = append(out, moc.MCPChoice{Server: server})
	}
	return append(out, moc.MCPChoice{Server: "deal_sheet"}, moc.MCPChoice{Server: "sendgrid"})
}

// mocCreateRequest is the body from the builder's Submit button.
//
//   - prompt:    the generated batch prompt (required).
//   - listIds:   standard allow/block list ids to attach — resolved to files
//     server-side via the lists registry (trusted paths).
//   - filePaths: absolute paths of ad-hoc uploads (UploadedFile.path). Validated
//     to live under the trader upload dir before we touch them.
//   - fileNames: the ORIGINAL client filename for each filePaths entry
//     (positionally paired) — see the field comment below.
type mocCreateRequest struct {
	Prompt    string   `json:"prompt"`
	ListIDs   []string `json:"listIds"`
	FilePaths []string `json:"filePaths"`
	// FileNames carries the ORIGINAL client filename for each FilePaths entry,
	// paired by index. The generated prompt references every attachment by its
	// original name (dealPromptYaml's dealFilePath emits file.name, never the
	// server path), but an ad-hoc upload lives on disk under a hash-suffixed
	// name (<ts>-<rand>.ext from the upload handler). Uploading it under that
	// hashed basename is the #157 bug: the agent's fuzzy name-match against the
	// prompt fails because the uploaded file's name doesn't match the name the
	// prompt references. When a name is supplied for an index we upload under
	// it (while still reading bytes from the validated path); an absent/blank
	// entry falls back to the path basename for legacy callers.
	FileNames []string `json:"fileNames,omitempty"`
	// Brief is the serialized structured deal brief (JSON). REQUIRED: the
	// audit gate binds its deal names to the audited form and the prompt. It
	// is schema-validated and attached to the task as deal_brief.json, so the
	// batch travels as a structured file instead of only the inline prompt.
	Brief string `json:"brief,omitempty"`
	// IdempotencyKey is a stable client-minted token (one per form instance /
	// user intent) that makes this submit safe to retry: the server reserves it
	// before creating the task and returns the ORIGINAL task on a duplicate, so
	// a reload / remount / network retry can never create a second live batch.
	// Empty => no idempotency protection (legacy callers).
	IdempotencyKey string `json:"idempotencyKey,omitempty"`
	// Operation names the flow. The runner seam is create-only: the only
	// accepted value is "create" (the default when blank).
	Operation string `json:"operation,omitempty"`
	// MocEnv selects which configured MOC instance receives the task: "prod"
	// (the default when blank — every pre-picker caller omits the field) or
	// "dev" (the MOC_DEV_* instance). Unknown values are rejected outright so
	// a typo can never silently submit a live batch to the wrong MOC.
	MocEnv string `json:"mocEnv,omitempty"`
	// Form is the audited form snapshot — the exact payload a passing POST
	// /api/audit run approved. REQUIRED: the server re-runs the same
	// deterministic audit pipeline (evaluateAudit) against it and rejects the
	// submit unless it still passes, so the QA gate holds server-side rather
	// than only in React state.
	Form *validation.AuditRequest `json:"form,omitempty"`
}

type mocCreateResponse struct {
	TaskID  string `json:"taskId"`
	TaskURL string `json:"taskUrl,omitempty"`
	Files   int    `json:"files"`
	// MocEnv echoes the environment the task ran on ("prod" | "dev") so the
	// client can label the result without re-deriving it from the task URL.
	MocEnv string `json:"mocEnv,omitempty"`
	// Duplicate is true when this response replays a prior submission (matched
	// by idempotency key) rather than creating a new task.
	Duplicate bool     `json:"duplicate,omitempty"`
	Uploaded  []string `json:"uploaded,omitempty"`
	// Warnings carries non-fatal submit-time conditions the trader must see
	// (e.g. the recipient-typo tripwire).
	Warnings []string `json:"warnings,omitempty"`
}

// HandleMOCCreate creates a MOC task from the generated prompt, uploading any
// attached list files first. The integration is OFF unless MOC_BASE_URL +
// MOC_API_KEY are set (per environment — a dev submit needs MOC_DEV_*) — a
// disabled config returns 503 with a clear message and never touches the
// network.
func HandleMOCCreate(envs moc.Environments, listReg *lists.Registry, idem *idempotency.Store, uploadDirs ...string) http.HandlerFunc {
	return handleMOCCreate(envs, listReg, idem, nil, uploadDirs...)
}

// HandleMOCCreateWithOverrideAudit is the production constructor. The legacy
// wrapper above keeps focused handler tests terse; any request carrying an
// active override still fails closed when its store is nil.
func HandleMOCCreateWithOverrideAudit(envs moc.Environments, listReg *lists.Registry, idem *idempotency.Store, auditStore *overrideaudit.Store, uploadDirs ...string) http.HandlerFunc {
	return handleMOCCreate(envs, listReg, idem, auditStore, uploadDirs...)
}

func handleMOCCreate(envs moc.Environments, listReg *lists.Registry, idem *idempotency.Store, overrideStore *overrideaudit.Store, uploadDirs ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// A deployment with NO MOC instance configured keeps the legacy
		// contract: 503 before reading the body — a disabled integration never
		// spends up to 8MB of parsing per request, and monitors keyed on the
		// 503 stay accurate even for malformed bodies.
		if !envs.Prod.Enabled() && !envs.Dev.Enabled() {
			writeError(w, http.StatusServiceUnavailable, "MOC integration not configured — set MOC_BASE_URL and MOC_API_KEY to enable one-click submission.")
			return
		}
		var req mocCreateRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		// Resolve the target environment before the other gates: an unknown id
		// is a hard 400 (never a silent prod fallback), and a picked-but-unset
		// env gets its own actionable 503 rather than the generic one.
		mocEnv := strings.ToLower(strings.TrimSpace(req.MocEnv))
		if mocEnv == "" {
			mocEnv = moc.EnvProd
		}
		cfg, envErr := envs.For(mocEnv)
		if envErr != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error":   "moc_env_invalid",
				"message": envErr.Error(),
			})
			return
		}
		if !cfg.Enabled() {
			if mocEnv == moc.EnvDev {
				writeJSON(w, http.StatusServiceUnavailable, map[string]any{
					"error":   "moc_env_not_configured",
					"message": "dev MOC environment not configured — set MOC_DEV_BASE_URL and MOC_DEV_API_KEY to enable dev submissions.",
				})
				return
			}
			writeError(w, http.StatusServiceUnavailable, "MOC integration not configured — set MOC_BASE_URL and MOC_API_KEY to enable one-click submission.")
			return
		}
		// #237: a PROD deal task must be pinned to the dedicated runner node.
		// An untargeted MOC task matches EVERY registered node — a stale test
		// runner or one provisioned with different credentials could pick up a
		// live batch (full prompt with client terms + attached domain lists),
		// and the task is visible to every scoped MOC principal. Fail closed
		// when the pin is missing rather than submit an any-node batch. The
		// dev instance stays unpinned-capable by design (its node pool is the
		// test pool).
		if mocEnv == moc.EnvProd && cfg.Backend != "fleet" && strings.TrimSpace(cfg.TargetNode) == "" {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{
				"error":   "moc_target_node_required",
				"message": "MOC_TARGET_NODE is not set — a prod deal batch must be pinned to the dedicated runner node (an untargeted task can run on ANY registered node). Set MOC_TARGET_NODE and restart the server.",
			})
			return
		}
		// Allowlist the operation. It namespaces the idempotency ledger (below,
		// composed with the environment as op+"@"+env), so a free-form value
		// like "create@dev" could forge another environment's namespace and
		// replay that environment's task as this submit's "duplicate".
		operation := strings.TrimSpace(req.Operation)
		var exclusionOverrides []validation.ExclusionOverrideDetails
		if operation == "" {
			operation = "create"
		}
		if operation != "create" {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error":   "operation_invalid",
				"message": fmt.Sprintf("unknown operation %q — the runner seam is create-only (\"create\").", req.Operation),
			})
			return
		}
		if strings.TrimSpace(req.Prompt) == "" {
			writeError(w, http.StatusBadRequest, "prompt is required")
			return
		}
		// Attachment-reference sanity, fail-closed before any network call:
		//   - cap the total number of attachments so a malformed/hostile body
		//     can't fan out into hundreds of MOC uploads;
		//   - when fileNames is present it MUST pair 1:1 with filePaths, since
		//     each file is uploaded to MOC under its paired original name. A
		//     length mismatch would silently shift names onto the wrong files.
		if n := len(req.FilePaths) + len(req.ListIDs); n > maxAttachRefs {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("too many attachments (%d) — at most %d per submission", n, maxAttachRefs))
			return
		}
		if len(req.FileNames) > 0 && len(req.FileNames) != len(req.FilePaths) {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("fileNames (%d) must pair 1:1 with filePaths (%d)", len(req.FileNames), len(req.FilePaths)))
			return
		}
		// Unconditional fail-closed gate on the PROMPT itself — it's what MOC
		// actually runs. An unresolved placeholder (<FILL…>, <UNSET…>, ${…},
		// {{…}}) means a required deal field was never filled; sending it would
		// either mis-route, 422 at the SSP mid-batch, or email a literal
		// non-address. The structured brief is optional (the deal-update flow
		// sends prompt-only), so this guard — not the brief check below — is the
		// floor that covers BOTH the create and update flows.
		if briefHasUnresolvedToken(req.Prompt) {
			writeError(w, http.StatusBadRequest, "prompt contains an unresolved placeholder (<FILL…>, <UNSET…>, ${…}, or {{…}}) — fill every required field before sending to MOC.")
			return
		}
		// #237 (#136 follow-through): the prompt builders emit line-anchored
		// "# BLOCKED…" markers for deals that must NOT run as-is (an OpenX deal
		// with no inventory attachment, a Media.net deal with an inapplicable
		// app-bundle list). Those were prompt-comment-only — the agent was
		// trusted to honor them, and a direct API caller could submit one
		// anyway, consuming a live MOC run that dies (or half-applies) mid-
		// batch. This is the server-side fail-loud: a blocked marker is a
		// hard reject, same tier as the unresolved-token floor above. Line-
		// anchored so summary prose that merely mentions "BLOCKED" mid-
		// sentence never matches.
		if m := promptBlockedMarker(req.Prompt); m != "" {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
				"error":   "prompt_blocked_marker",
				"message": fmt.Sprintf("the prompt carries a BLOCKED marker and must not be submitted as-is: %q — fix the flagged deal (e.g. attach the required inventory list) and regenerate the prompt.", m),
			})
			return
		}
		// Schema-validate the structured brief (if any) BEFORE any network call,
		// so a malformed/garbled brief never reaches a live MOC task.
		if strings.TrimSpace(req.Brief) != "" {
			if issues := validateDealBrief([]byte(req.Brief)); len(issues) > 0 {
				writeError(w, http.StatusBadRequest, "deal brief failed validation: "+strings.Join(issues, "; "))
				return
			}
		}
		// Server-side audit gate (#152). The UI's run-audit-then-unlock flow is
		// advisory only — any authenticated session can POST here directly — so
		// a CREATE must carry the audited form and must still pass the exact
		// /api/audit pipeline (evaluateAudit) right now. Create is the only
		// operation this handler accepts, so every submit passes this gate.
		if !gateCreateAudit(w, listReg, &req) {
			return
		}
		exclusionOverrides = collectExclusionOverrides(req.Form)
		if !gateExclusionOverrideEnvelope(w, r, overrideStore, req.Prompt, req.Brief, exclusionOverrides) {
			return
		}
		var submitWarnings []string
		// Recipient-typo tripwire: a deal-sheet recipient one letter-swap
		// from the trader's real domain sails through every gate, the mail
		// provider queues the send, and the batch's only email vanishes into
		// a non-existent domain. When the prompt's recipient is a small
		// mutation of the submitting session's email (or of its domain),
		// warn loudly in the submit response. Non-blocking: a genuinely
		// different recipient is legitimate.
		if actor, ok := SessionEmailFromRequest(r); ok {
			if recipient := promptRecipient(req.Prompt); recipient != "" {
				if msg := recipientTypoWarning(recipient, actor); msg != "" {
					submitWarnings = append(submitWarnings, msg)
				}
			}
		}

		// Idempotency: reserve the client-minted key BEFORE any work (uploads +
		// task creation) so a reload/remount/retry cannot create a second live
		// batch. A duplicate of an already-completed submit returns the ORIGINAL
		// task; a still-in-flight duplicate is rejected. Reserved keys are
		// completed after task creation; they are released ONLY on failures
		// provably before CreateTask could have taken effect (#225) — an
		// ambiguous downstream failure holds the reservation (fail closed).
		idemKey := strings.TrimSpace(req.IdempotencyKey)
		// The ledger namespace is the (allowlisted) operation, suffixed with
		// the environment for non-prod so records never collide across
		// instances. Prod keeps the bare operation namespace for continuity
		// with keys reserved before the environment picker existed.
		envOp := func(env string) string {
			if env == moc.EnvProd {
				return operation
			}
			return operation + "@" + env
		}
		idemOp := envOp(mocEnv)
		reservedKey := false
		if idem != nil && idemKey != "" {
			// One key maps to at most one live task EVER, across environments:
			// deals a credentialed dev runner books are just as live as prod's,
			// so a retry whose environment flipped mid-flight must never book
			// the batch twice. A cross-env reuse is a conflict, not a replay —
			// replaying the other env's task here would mislabel where it ran.
			// (Best-effort: a concurrent pair racing this probe can still slip
			// through; the client-minted per-intent key is the primary guard.)
			otherEnv := moc.EnvDev
			if mocEnv == moc.EnvDev {
				otherEnv = moc.EnvProd
			}
			if prior, exists := idem.Get(envOp(otherEnv), idemKey); exists {
				writeJSON(w, http.StatusConflict, map[string]any{
					"error": "idempotency_env_conflict",
					// The key is content-derived now (#225), so "use a new key"
					// is no longer actionable — the only ways forward are to
					// change the batch content (which re-derives the key) or
					// have an operator clear the stale reservation.
					"message": fmt.Sprintf("this exact batch was already submitted to the %s MOC environment%s — it cannot be re-booked on %s. To proceed, change the batch content (which re-derives the submission key) or have an operator clear the reservation.", otherEnv, taskNote(prior.TaskID), mocEnv),
				})
				return
			}
			existing, reserved, rerr := idem.Reserve(idemOp, idemKey)
			if rerr != nil {
				writeError(w, http.StatusInternalServerError, "could not reserve submission")
				return
			}
			if !reserved {
				if existing.Status == "done" && existing.TaskID != "" {
					// Duplicate of a completed submit — return the original task,
					// NOT a new one and NOT an error (an error would make the
					// client's own retry look like a failure).
					writeJSON(w, http.StatusOK, mocCreateResponse{TaskID: existing.TaskID, TaskURL: existing.TaskURL, MocEnv: mocEnv, Duplicate: true})
					return
				}
				// A reservation exists but has no task yet — a concurrent submit
				// is in flight. Reject rather than double-book.
				writeError(w, http.StatusConflict, "a submission with this key is already in progress")
				return
			}
			reservedKey = true
		}
		// Reservation lifecycle (#225). Release ONLY on failures provably
		// BEFORE CreateTask could have taken effect — local validation,
		// attachment resolution, and the MOC file uploads, none of which
		// create a task — so the client can retry with the same key. From the
		// moment the CreateTask request is handed to the transport
		// (createTaskAttempted below), a failure is AMBIGUOUS: MOC may have
		// accepted the task and started booking live deals even though the
		// response was lost (timeout, proxy 502, connection reset). Releasing
		// there would let a re-click book a SECOND live batch, so the
		// reservation is HELD pending instead (fail closed; it expires via
		// the store TTL). A Complete() persistence failure after the task
		// exists is post-CreateTask and also holds. The success path sets
		// completed=true.
		completed := false
		createTaskAttempted := false
		defer func() {
			if reservedKey && !completed && !createTaskAttempted {
				idem.Release(idemOp, idemKey)
			}
		}()

		// Commit the authenticated authorization BEFORE any external upload or
		// task call. This append-only event survives any later
		// bookkeeping failure and records an attempted dispatch even when local
		// attachment validation subsequently rejects it.
		if len(exclusionOverrides) > 0 {
			actor, _ := SessionEmailFromRequest(r)
			for _, detail := range exclusionOverrides {
				if err := overrideStore.Append(overrideaudit.Event{Actor: actor, IdempotencyKey: idemKey, Operation: operation, Status: "authorized", Override: detail}); err != nil {
					writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "exclusion_override_audit_failed", "message": "could not durably record the exclusion override — no MOC task was created; retry after the audit store is healthy."})
					return
				}
			}
		}

		// Resolve the files to attach: trusted standard-list paths + validated
		// ad-hoc upload paths. Each entry is (display name, absolute path).
		type fileRef struct{ name, path string }
		refs := make([]fileRef, 0, len(req.ListIDs)+len(req.FilePaths))
		if listReg != nil && len(req.ListIDs) > 0 {
			// Fail closed on any requested standard-list id that doesn't resolve
			// to a real file. The generated prompt still NAMES every selected
			// list, so a silently-dropped id (stale/edited registry, a runtime
			// list wiped by a deploy, a typo) would create a task whose targeting
			// file never arrives — the batch would run under-targeted with no
			// error. Reject and name the offenders instead. Resolve preserves
			// order and drops unknowns, so a resolved list with an empty Path or
			// a requested id that never resolved is a hard error here.
			requested := make(map[string]struct{}, len(req.ListIDs))
			for _, id := range req.ListIDs {
				if s := strings.TrimSpace(id); s != "" {
					requested[s] = struct{}{}
				}
			}
			resolvedIDs := make(map[string]struct{}, len(requested))
			missing := make([]string, 0)
			for _, l := range listReg.Resolve(req.ListIDs) {
				if strings.TrimSpace(l.Path) == "" {
					missing = append(missing, l.ID)
					continue
				}
				resolvedIDs[l.ID] = struct{}{}
				// Upload under the list's UploadName — the human name with the
				// data file's extension appended when the name has none (#198:
				// IX rejects an extensionless list; OpenX routes .csv vs .xlsx
				// to different parsers). This is exactly the name the prompt
				// references (standardListAsFile → standardListUploadName sets
				// file.name from Summary.FileExt), so the agent's name match
				// stays exact — never the on-disk basename.
				refs = append(refs, fileRef{name: l.UploadName(), path: l.Path})
			}
			for id := range requested {
				if _, ok := resolvedIDs[id]; !ok {
					missing = append(missing, id)
				}
			}
			if len(missing) > 0 {
				sort.Strings(missing)
				writeError(w, http.StatusBadRequest, "unknown or unavailable standard list(s): "+strings.Join(missing, ", ")+" — reselect the list(s) and try again")
				return
			}
		}
		// Allowed roots: the trader upload dir(s). Traversal outside these is
		// rejected.
		cleanDirs := make([]string, 0, len(uploadDirs))
		for _, d := range uploadDirs {
			if cd := safeDir(d); cd != "" {
				cleanDirs = append(cleanDirs, cd)
			}
		}
		underAllowed := func(abs string) bool {
			for _, cd := range cleanDirs {
				if abs == cd || strings.HasPrefix(abs, cd+string(os.PathSeparator)) {
					return true
				}
			}
			return false
		}
		for i, p := range req.FilePaths {
			// Upload paths may be relative when DATA_DIR is (the default
			// ./data) — anchor them to the cwd the upload handler used.
			abs, err := filepath.Abs(p)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid attached file path")
				return
			}
			// Resolve symlinks before the containment check so a link planted
			// inside an upload dir can't smuggle reads outside it. Also
			// rejects paths that don't exist.
			resolved, err := filepath.EvalSymlinks(abs)
			if err != nil {
				// Name the file so a trader resuming a stale form (or hit by a
				// data-dir migration / retention sweep) knows WHICH attachment
				// to re-upload, instead of a blind whole-batch failure.
				display := filepath.Base(p)
				if i < len(req.FileNames) {
					if orig := strings.TrimSpace(req.FileNames[i]); orig != "" {
						display = filepath.Base(orig)
					}
				}
				writeError(w, http.StatusBadRequest, fmt.Sprintf("attached file %q is no longer available — re-upload it and try again", display))
				return
			}
			if !underAllowed(resolved) {
				writeError(w, http.StatusBadRequest, "attached file path outside the allowed upload directories")
				return
			}
			// The prompt references this attachment by its ORIGINAL filename, but
			// on disk it carries the hash-suffixed upload name. Prefer the original
			// name (positionally supplied in FileNames) as the MOC display name so
			// the agent can match it; keep reading bytes from the validated path.
			// filepath.Base defends against a client-supplied name with separators.
			name := filepath.Base(abs)
			if i < len(req.FileNames) {
				if orig := strings.TrimSpace(req.FileNames[i]); orig != "" {
					name = filepath.Base(orig)
				}
			}
			refs = append(refs, fileRef{name: name, path: resolved})
		}

		// #238 (create-scoped): on a CREATE, every attachment is consumed by a
		// per-SSP domain/app-bundle extractor (IX/OpenX/PubMatic), which parse
		// ONLY .csv + .xlsx/.xlsm and raise "Unsupported domain file format"
		// mid-batch otherwise. Fail loud at SUBMIT instead, naming the file.
		// This is NOT applied to UPDATE attachments: the update/merge value-set
		// path (cutlass value_set.py) is newline-delimited and
		// extension-agnostic, so a one-per-line .txt/.tsv list is valid there —
		// rejecting those would dead-path the update flow and #209 re-attach of
		// legacy lists. The DISPLAY name is checked because that is what the
		// SSP MCP routes its parser on.
		if operation == "create" {
			for _, ref := range refs {
				if ext := strings.ToLower(filepath.Ext(ref.name)); !createExtractorReadableExts[ext] {
					writeError(w, http.StatusBadRequest, fmt.Sprintf("attachment %q has a file type the create-time SSP extractors cannot read (%s) — export it as .csv or .xlsx and re-attach it", ref.name, extLabel(ext)))
					return
				}
			}
		}

		// Reject two attachments that would upload under the same display name
		// (e.g. two different files both named "domains.csv", or a standard list
		// whose name collides with an ad-hoc upload). The prompt references files
		// by name, so a collision is genuinely ambiguous — the agent could match
		// the wrong file. Fail closed with an actionable message rather than let
		// MOC silently clobber one upload with the other. The name the
		// structured brief uploads under is reserved the same way when a brief
		// rides this submission (#282.2): fleet 400s duplicate logical
		// file_names, so a same-named trader attachment would fail the create
		// AFTER every upload — reject it here instead. (The UI already renames
		// collisions deterministically at attach time; this is the direct-API
		// backstop.)
		hasBrief := strings.TrimSpace(req.Brief) != ""
		seenNames := make(map[string]struct{}, len(refs)+1)
		if hasBrief {
			seenNames[dealBriefUploadName] = struct{}{}
		}
		for _, ref := range refs {
			if _, dup := seenNames[ref.name]; dup {
				if hasBrief && ref.name == dealBriefUploadName {
					writeError(w, http.StatusBadRequest, fmt.Sprintf("attachment name %q is reserved for the structured deal brief this submission uploads — rename the file and try again", dealBriefUploadName))
					return
				}
				writeError(w, http.StatusBadRequest, fmt.Sprintf("two attachments share the name %q — rename one so the prompt references each unambiguously", ref.name))
				return
			}
			seenNames[ref.name] = struct{}{}
		}

		// Fail closed when the PROMPT references an attachment that is not in
		// the upload set (#221). The generated prompts reference every list/
		// file by name (domain_file_path/app_bundle_file_path args, the
		// Media.net/TripleLift `values_file:` post-create merge blocks, the
		// update flow's attachments `file_path:` rows) — a referenced name with
		// no matching upload means the SSP MCP fails missing_domain_file
		// mid-batch, or worse (Media.net) creates the deal LIVE and never
		// applies the list. The client-side validateBrief cross-check is
		// advisory (any authenticated session can POST here directly, and the
		// update flow sends prompt-only); this is the enforcement point,
		// covering create AND update — the same UI-advisory/server-enforced
		// split as the #152 audit gate.
		if missingRefs := unattachedPromptRefs(req.Prompt, seenNames); len(missingRefs) > 0 {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
				"error": "prompt_reference_unattached",
				"message": "the prompt references attachment(s) not included in this submission: " +
					strings.Join(missingRefs, ", ") +
					" — attach each named list (listIds) or file (filePaths/fileNames) and try again.",
			})
			return
		}

		client := moc.New(cfg)
		ctx := r.Context()
		uploaded := make([]string, 0, len(refs))
		logicalNames := make([]string, 0, len(refs)+1)
		for _, ref := range refs {
			f, err := os.Open(ref.path)
			if err != nil {
				writeError(w, http.StatusBadGateway, fmt.Sprintf("could not read attachment %q: %v", ref.name, err))
				return
			}
			res, err := client.Upload(ctx, ref.name, f)
			f.Close()
			if err != nil {
				writeError(w, http.StatusBadGateway, err.Error())
				return
			}
			uploaded = append(uploaded, res.Filename)
			logicalNames = append(logicalNames, ref.name)
		}

		// Attach the validated structured brief as a file alongside the prompt.
		if strings.TrimSpace(req.Brief) != "" {
			res, err := client.Upload(ctx, dealBriefUploadName, strings.NewReader(req.Brief))
			if err != nil {
				writeError(w, http.StatusBadGateway, err.Error())
				return
			}
			uploaded = append(uploaded, res.Filename)
			logicalNames = append(logicalNames, dealBriefUploadName)
		}

		// PRE/POST boundary (#225): everything ABOVE this line is provably
		// before task creation (safe to release the reservation on failure);
		// the CreateTask call itself is classified below (its error carries an
		// Ambiguous() verdict) — a provably-not-created failure still releases,
		// only a genuinely-ambiguous one holds.
		createTaskAttempted = true
		// Serialize per campaign: the runner executes at most one task per
		// serialization_key at a time, so two batches for the same campaign
		// can never interleave. The key is the audited form's campaign id —
		// never invented here.
		serializationKey := ""
		if req.Form != nil {
			if id := strings.TrimSpace(req.Form.CampaignID); id != "" {
				serializationKey = "campaign:" + id
			}
		}
		task, err := client.CreateTask(ctx, moc.CreateTaskInput{
			Prompt:           req.Prompt,
			Files:            uploaded,
			FileNames:        logicalNames,
			MCPSelection:     resolveMCPSelection(&req),
			SerializationKey: serializationKey,
		})
		if err != nil {
			// Classify the failure. Ambiguous (default): MOC may have created
			// the task despite the error (timeout / reset mid-flight / 5xx /
			// undecodable 2xx) → HOLD the reservation (fail closed). Provably
			// not created (request never sent, connection never established,
			// or a definitive 4xx rejection) → RELEASE so the same key can be
			// retried cleanly. A non-*CreateTaskError (shouldn't happen — the
			// client always returns one) is treated as ambiguous.
			ambiguous := true
			var cte *moc.CreateTaskError
			if errors.As(err, &cte) {
				ambiguous = cte.Ambiguous()
			}
			if !ambiguous {
				// Not created — let the deferred cleanup release the key.
				createTaskAttempted = false
			}
			if reservedKey && ambiguous {
				// Fail closed — the deferred cleanup keeps the reservation
				// pending, and this 409 tells the client the batch is locked,
				// so a retry with the same key can never create a second live
				// batch. The lock clears when the reservation TTL expires (or
				// an operator clears it). A transient not-created failure does
				// NOT reach here (it released above), so a MOC blip no longer
				// wedges the batch for the full TTL.
				writeJSON(w, http.StatusConflict, map[string]any{
					"error":   "moc_submission_state_unknown",
					"message": fmt.Sprintf("MOC task creation failed after the request was sent (%v) — the task MAY have been created. This submission is held to prevent a duplicate live batch: check the MOC dashboard for the task before doing anything else; the same batch stays locked until the reservation expires.", err),
				})
				return
			}
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		if len(exclusionOverrides) > 0 {
			actor, _ := SessionEmailFromRequest(r)
			for _, detail := range exclusionOverrides {
				// The pre-dispatch "authorized" record is the enforcement log. This
				// second append links it to the returned task; a rare disk failure here
				// must not conceal a task that already exists.
				_ = overrideStore.Append(overrideaudit.Event{Actor: actor, IdempotencyKey: idemKey, Operation: operation, Status: "dispatched", TaskID: task.ID, Override: detail})
			}
		}
		taskURL := client.TaskURL(task.ID)
		// Record the task against the idempotency key BEFORE responding, so a
		// duplicate that races the response still resolves to this same task.
		// A Complete failure leaves the reservation "pending" (never released —
		// createTaskAttempted is set): duplicates then 409 as in-flight rather
		// than replaying, which is the fail-closed side of #225.
		if reservedKey {
			if cerr := idem.Complete(idemOp, idemKey, task.ID, taskURL); cerr == nil {
				completed = true
			}
		}
		writeJSON(w, http.StatusOK, mocCreateResponse{
			TaskID:   task.ID,
			TaskURL:  taskURL,
			Files:    len(uploaded),
			MocEnv:   mocEnv,
			Uploaded: uploaded,
			Warnings: submitWarnings,
		})
	}
}

// mocEnvironmentInfo is the non-secret projection of one configured MOC
// instance, for the frontend's environment picker.
type mocEnvironmentInfo struct {
	ID      string `json:"id"`
	Backend string `json:"backend,omitempty"`
	// BaseURL and TargetNode are informational (the task URL embeds the host
	// anyway); API keys never leave the server.
	BaseURL    string `json:"baseUrl,omitempty"`
	TargetNode string `json:"targetNode,omitempty"`
	Enabled    bool   `json:"enabled"`
}

// HandleMOCEnvironments reports which MOC instances are configured so the UI
// can offer the submit-environment picker. The picker only renders when the
// dev entry is enabled, so prod-only deployments see no UI change.
func HandleMOCEnvironments(envs moc.Environments) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"environments": []mocEnvironmentInfo{
				{ID: moc.EnvProd, Backend: envs.Prod.Backend, BaseURL: envs.Prod.BaseURL, TargetNode: envs.Prod.TargetNode, Enabled: envs.Prod.Enabled()},
				{ID: moc.EnvDev, Backend: envs.Dev.Backend, BaseURL: envs.Dev.BaseURL, TargetNode: envs.Dev.TargetNode, Enabled: envs.Dev.Enabled()},
			},
		})
	}
}

// HandleRunnerCheck probes one configured runner instance and reports whether
// it is reachable and whether the configured key clears the create gate. It
// creates nothing — see moc.Client.Check for the two-stage probe and why the
// endpoints it hits are side-effect free.
//
// Defaults to the dev instance: this exists for the Fleet port, where the
// operator needs to confirm a new deployment answers BEFORE risking a submit
// that books live deals. ?env=prod is accepted so the same button can verify
// production, but an unknown id is refused rather than silently probing prod.
func HandleRunnerCheck(envs moc.Environments) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		env := strings.TrimSpace(r.URL.Query().Get("env"))
		if env == "" {
			env = moc.EnvDev
		}
		cfg, err := envs.For(env)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error":   "moc_env_invalid",
				"message": err.Error(),
			})
			return
		}
		res := moc.New(cfg).Check(r.Context())
		writeJSON(w, http.StatusOK, map[string]any{"env": env, "check": res})
	}
}

// gateCreateAudit enforces the create-flow audit gate: the submit must carry
// the audited form AND the structured brief, the form must still pass the
// exact /api/audit evaluation (evaluateAudit — client resolution +
// standard-list folding + rule audit), the brief must describe the same batch
// the form regenerates, and the prompt must embed every audited deal name.
// Writes the rejection response and returns false on any failure; every
// rejection carries a machine code in "error" and an actionable human
// "message". This guards the money path — a create that passes here is
// exactly a create the trader-facing audit would approve, expressed in the
// prompt MOC actually runs.
func gateCreateAudit(w http.ResponseWriter, listReg *lists.Registry, req *mocCreateRequest) bool {
	if req.Form == nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":   "audit_form_required",
			"message": "create submissions must include the audited form (the exact payload the passing /api/audit run approved) as \"form\" — run the audit, then submit again.",
		})
		return false
	}
	// The brief is REQUIRED on creates: it is the structured artifact the
	// form↔batch name binding below runs against, and the legitimate create
	// flow always sends one. Leaving it optional would let a caller ship an
	// arbitrary prompt alongside audit evidence for an unrelated form.
	if strings.TrimSpace(req.Brief) == "" {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error":   "brief_required",
			"message": "create submissions must include the structured deal brief — regenerate the batch (prompt + brief) from the audited form, then submit again.",
		})
		return false
	}
	// The deal names in the prompt/brief embed the FINAL campaign id — a
	// blank one here would regenerate different names and mis-flag every
	// brief comparison. Require it explicitly instead of failing obliquely.
	if strings.TrimSpace(req.Form.CampaignID) == "" {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error":   "campaign_id_required",
			"message": fmt.Sprintf("the audited form has no campaignId — assign one (%s#####), re-run the audit, and submit again.", validation.Operator().CampaignIDPrefix),
		})
		return false
	}
	// Re-run the audit. The form's own campaignId doubles as the fallback so
	// the evaluation is fully deterministic.
	result := evaluateAudit(listReg, req.Form, req.Form.CampaignID)
	if result.Status != "passed" {
		failed := make([]validation.CheckResult, 0, len(result.Checks))
		for _, c := range result.Checks {
			if !c.Passed {
				failed = append(failed, c)
			}
		}
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error":   "audit_failed",
			"message": fmt.Sprintf("server-side audit re-run failed %d check(s) — fix the flagged fields, re-run the audit, and submit again.", len(failed)),
			"checks":  failed,
		})
		return false
	}
	// Consistency cross-check: the audited form must describe the SAME batch
	// the brief carries — otherwise a caller could audit form A and submit
	// prompt/brief B. The brief's create rows (deals[].deal_name) plus its
	// sheet-only rows (already_created_for_sheet[].deal_name) must equal the
	// re-audit's regenerated deal names: same count, same set. Both sides
	// derive names from the same form fields (nameOverride verbatim, else the
	// canonical slot join), so a brief generated from the audited form matches
	// byte-for-byte; set comparison suffices because a passing audit already
	// rejects duplicate deal names (qa_duplicate_deals).
	var b dealBriefDoc
	// Schema-validated earlier in the handler, so this cannot fail here.
	_ = json.Unmarshal([]byte(req.Brief), &b)
	briefNames := make([]string, 0, len(b.Deals)+len(b.AlreadyCreatedForSheet))
	for _, d := range b.Deals {
		briefNames = append(briefNames, strings.TrimSpace(d.DealName))
	}
	for _, row := range b.AlreadyCreatedForSheet {
		briefNames = append(briefNames, strings.TrimSpace(row.DealName))
	}
	if len(briefNames) != result.TotalDeals || !equalNameSets(briefNames, result.DealNames) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error":              "audit_brief_mismatch",
			"message":            fmt.Sprintf("the brief carries %d deal(s) that don't match the audited form's %d — regenerate the prompt and brief from the audited form, then submit again.", len(briefNames), result.TotalDeals),
			"brief_deal_names":   briefNames,
			"audited_deal_names": result.DealNames,
		})
		return false
	}
	// Prompt binding: the PROMPT is what MOC actually executes, so tie it to
	// the audited batch too — every audited deal name must appear in it.
	// buildBatchPrompt (dealPromptYaml.ts) embeds the name of EVERY SSP-bearing
	// deal: create rows as `name:` entries under `deals:` (with tool +
	// prompt_inputs), and sheet-only rows as `name:` entries under the
	// non-executable `already_created_for_sheet:` section (no tool, no
	// prompt_inputs — they only ride the deal sheet + email, mirroring the
	// brief's section of the same name). A passing audit requires every deal to
	// carry an SSP (deal_ssp) — so all of result.DealNames are provably
	// embedded in a genuine create prompt. We deliberately bind the FULL
	// audited set, not just the brief's create rows: binding create rows alone
	// would be bypassable by declaring every row sheet-only in the brief (sheet
	// rows carry no tool, so the brief still validates) and shipping an
	// arbitrary prompt.
	missing := make([]string, 0)
	for _, name := range result.DealNames {
		if !promptEmbedsName(req.Prompt, name) {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error":              "audit_prompt_mismatch",
			"message":            fmt.Sprintf("the prompt is missing %d of the audited form's deal name(s) — regenerate the prompt from the audited form, then submit again.", len(missing)),
			"missing_deal_names": missing,
		})
		return false
	}
	// Full-set binding (#232): the substring check above is one-directional —
	// it proves every AUDITED name appears somewhere, but nothing stopped a
	// prompt from carrying EXTRA un-audited deal entries (or a duplicated
	// audited entry) that Cutlass would execute alongside the audited batch.
	// Bind the prompt's structural deal entries — the `name:` lines of the
	// `deals:` + `already_created_for_sheet:` sections, which is exactly what
	// the batch driver iterates — to the audited set by identity AND count.
	// A prompt embedding audited names only in prose (zero structural
	// entries) also fails here: the gate accepts exactly the shape
	// buildBatchPrompt generates, nothing looser.
	audited := make(map[string]struct{}, len(result.DealNames))
	for _, n := range result.DealNames {
		audited[strings.TrimSpace(n)] = struct{}{}
	}
	embedded := promptDealNames(req.Prompt)
	extras := make([]string, 0)
	embeddedSet := make(map[string]struct{}, len(embedded))
	for _, n := range embedded {
		n = strings.TrimSpace(n)
		embeddedSet[n] = struct{}{}
		if _, ok := audited[n]; !ok {
			extras = append(extras, n)
		}
	}
	if len(extras) > 0 {
		sort.Strings(extras)
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error":            "audit_prompt_unaudited_deals",
			"message":          fmt.Sprintf("the prompt carries %d deal entr%s the audited form does not describe — every deal in a create prompt must come from the audited batch. Regenerate the prompt from the audited form, then submit again.", len(extras), pluralIes(len(extras))),
			"extra_deal_names": extras,
		})
		return false
	}
	if len(embedded) != result.TotalDeals || len(embeddedSet) != result.TotalDeals {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error":   "audit_prompt_deal_count_mismatch",
			"message": fmt.Sprintf("the prompt embeds %d deal entr%s but the audited form describes %d — regenerate the prompt from the audited form, then submit again.", len(embedded), pluralIes(len(embedded)), result.TotalDeals),
		})
		return false
	}
	return true
}

func collectExclusionOverrides(req *validation.AuditRequest) []validation.ExclusionOverrideDetails {
	if req == nil {
		return nil
	}
	out := make([]validation.ExclusionOverrideDetails, 0)
	for _, deal := range req.Deals {
		if deal.SheetOnly {
			continue
		}
		if detail, ok := validation.ActiveExclusionOverride(deal, req); ok {
			out = append(out, detail)
		}
	}
	return out
}

// gateExclusionOverrideEnvelope binds the audited form's typed intent to BOTH
// executable artifacts. The exact marker is recomputed server-side; actor and
// time are never accepted from JSON. An orphan marker is rejected so a prompt
// cannot falsely claim an audited exception that the form did not authorize.
func gateExclusionOverrideEnvelope(w http.ResponseWriter, r *http.Request, store *overrideaudit.Store, prompt, brief string, details []validation.ExclusionOverrideDetails) bool {
	const prefix = "# EXCLUSION_OVERRIDE: "
	if len(details) == 0 {
		if strings.Contains(prompt, prefix) || strings.Contains(brief, "EXCLUSION_OVERRIDE") {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "exclusion_override_orphan", "message": "the prompt/brief claims an exclusion override that the audited form does not authorize — regenerate both artifacts from the current form."})
			return false
		}
		return true
	}
	actor, ok := SessionEmailFromRequest(r)
	if !ok || strings.TrimSpace(actor) == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "exclusion_override_actor_required", "message": "an exclusion override must be bound to an authenticated trader session."})
		return false
	}
	if store == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "exclusion_override_audit_unavailable", "message": "the durable exclusion-override audit store is unavailable — the batch remains blocked."})
		return false
	}
	var doc struct {
		Deals []struct {
			PromptInputs string `json:"prompt_inputs"`
		} `json:"deals"`
	}
	if err := json.Unmarshal([]byte(brief), &doc); err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "exclusion_override_brief_invalid", "message": "could not inspect the structured brief's exclusion override envelope."})
		return false
	}
	for _, detail := range details {
		b, _ := json.Marshal(detail)
		marker := prefix + string(b)
		if !strings.Contains(prompt, marker) {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "exclusion_override_prompt_mismatch", "message": fmt.Sprintf("the prompt is missing the canonical exclusion override for deal %q on %s — regenerate it from the audited form.", detail.DealID, detail.SSP)})
			return false
		}
		foundBrief := false
		for _, deal := range doc.Deals {
			if strings.Contains(deal.PromptInputs, marker) {
				foundBrief = true
				break
			}
		}
		if !foundBrief {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "exclusion_override_brief_mismatch", "message": fmt.Sprintf("the structured brief is missing the canonical exclusion override for deal %q on %s — regenerate it with the prompt.", detail.DealID, detail.SSP)})
			return false
		}
	}
	return true
}

// pluralIes returns "y"/"ies" for the deal-entry count messages.
func pluralIes(n int) string {
	if n == 1 {
		return "y"
	}
	return "ies"
}

// createExtractorReadableExts is the set of attachment extensions the CREATE-
// time per-SSP domain/app-bundle extractors parse (#238): IX/OpenX/PubMatic
// read .csv + .xlsx/.xlsm and raise "Unsupported domain file format" for
// anything else. Deliberately NARROWER than allowedUploadExts (upload.go),
// which also admits .tsv/.txt/.xls (newline-delimited lists other runner
// tools read) — this set gates create attachments.
var createExtractorReadableExts = map[string]bool{
	".csv":  true,
	".xlsx": true,
	".xlsm": true,
}

// extLabel names an extension for an error message ("(none)" when missing).
func extLabel(ext string) string {
	if ext == "" {
		return "no extension"
	}
	return ext
}

// promptRecipientRe extracts the top-level `recipient:` line every batch
// prompt (create/update/clone) carries — the address the run's single
// deal-sheet/summary email goes to.
var promptRecipientRe = regexp.MustCompile(`(?m)^recipient:[ \t]*([^\r\n]+?)[ \t]*$`)

// promptRecipient returns the prompt's recipient address, unquoted, or "".
func promptRecipient(prompt string) string {
	m := promptRecipientRe.FindStringSubmatch(prompt)
	if m == nil {
		return ""
	}
	return unquotePromptRef(m[1])
}

// levenshtein is a plain DP edit distance — inputs here are short email
// strings, so the O(len·len) cost is irrelevant.
func levenshtein(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	prev := make([]int, len(rb)+1)
	cur := make([]int, len(rb)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ra); i++ {
		cur[0] = i
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			cur[j] = min(min(cur[j-1]+1, prev[j]+1), prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[len(rb)]
}

// recipientTypoWarning returns a submit warning when `recipient` looks like a
// small mutation of the session email — the whole address within edit
// distance 2, or the DOMAIN within edit distance 1–2 (a typo'd domain with a
// different local part still strands the email: mail to a teammate at
// "elcnaotek.com" bounces just the same). Equal addresses / domains warn
// never; genuinely different recipients warn never.
func recipientTypoWarning(recipient, sessionEmail string) string {
	rec := strings.ToLower(strings.TrimSpace(recipient))
	ses := strings.ToLower(strings.TrimSpace(sessionEmail))
	if rec == "" || ses == "" || rec == ses || !strings.Contains(rec, "@") || !strings.Contains(ses, "@") {
		return ""
	}
	if d := levenshtein(rec, ses); d <= 2 {
		return fmt.Sprintf("The deal-sheet recipient %q is only %d character(s) away from your email %q — if that's a typo, the run's ONLY email will vanish into a non-existent address (a one-letter domain typo did exactly that once). The batch was submitted; verify the address or expect no email.", recipient, d, sessionEmail)
	}
	recDomain := rec[strings.LastIndex(rec, "@")+1:]
	sesDomain := ses[strings.LastIndex(ses, "@")+1:]
	if recDomain != sesDomain {
		if d := levenshtein(recDomain, sesDomain); d >= 1 && d <= 2 {
			return fmt.Sprintf("The deal-sheet recipient's domain %q is only %d character(s) away from %q — if that's a typo, the run's ONLY email will bounce. The batch was submitted; verify the address or expect no email.", recDomain, d, sesDomain)
		}
	}
	return ""
}

// taskNote formats an optional task-id fragment for the cross-environment
// idempotency conflict message.
func taskNote(taskID string) string {
	if taskID == "" {
		return " (still in flight)"
	}
	return fmt.Sprintf(" (task %s)", taskID)
}

// promptBlockedMarkerRe matches the line-anchored "# BLOCKED" comment the
// prompt builders emit for a deal that must not run as-is (dealPromptYaml.ts:
// "# BLOCKED: OpenX requires an inventory attachment…", "# BLOCKED —
// UNSUPPORTED TARGETING…"). Per-deal bodies are re-indented inside the batch
// prompt, so leading whitespace is tolerated; prose that mentions BLOCKED
// mid-sentence (the Required-final-summary contract lines) never matches.
var promptBlockedMarkerRe = regexp.MustCompile(`(?m)^[ \t]*# BLOCKED\b.*$`)

// promptBlockedMarker returns the first blocked-marker line in the prompt
// (trimmed), or "" when there is none.
func promptBlockedMarker(prompt string) string {
	return strings.TrimSpace(promptBlockedMarkerRe.FindString(prompt))
}

// promptDealNameRe matches the deal-entry `name:` lines the batch prompt
// emits — create rows under `deals:` and sheet rows under
// `already_created_for_sheet:` both carry `    name: <value>` at 4-space
// indent (buildBatchPrompt), with `  - name:` for entries whose name leads
// the block. Tolerant of the shape a hand-crafted extra entry might use
// (#232.8): leading tabs, 0–5 leading spaces, an optional `- ` list dash,
// case-insensitive `name`, and a space before the colon. The 0–5 leading-
// whitespace cap is load-bearing: the per-deal prompt_inputs bodies are
// re-indented to EXACTLY ≥6 spaces (buildBatchPrompt prefixes each body line
// with 6 spaces), and those bodies contain their own bare `name:` lines — a
// wider match would DOUBLE-count every deal. An extra entry hidden at ≥6-space
// indent is not a valid `deals:` list item Cutlass would execute either, so
// capping at 5 both avoids the false double-count and still binds every entry
// Cutlass actually iterates.
var promptDealNameRe = regexp.MustCompile(`(?mi)^[ \t]{0,5}(?:-[ \t]*)?name[ \t]*:[ \t]*(.+)$`)

// promptDealNames extracts every deal-entry name embedded in the prompt, in
// order, unquoting quote()-wrapped values.
func promptDealNames(prompt string) []string {
	var out []string
	for _, m := range promptDealNameRe.FindAllStringSubmatch(prompt, -1) {
		if name := unquotePromptRef(m[1]); name != "" {
			out = append(out, name)
		}
	}
	return out
}

// promptEmbedsName reports whether the prompt embeds the deal name literally.
// quote() in dealPromptYaml.ts passes bare slot-joined names ([A-Za-z0-9_.-])
// through verbatim and wraps anything else (e.g. a platform-id nameOverride with
// spaces) in double quotes, escaping `\` and `"` — those two escapes are
// matched here. quote() ALSO escapes control characters (\n, \t, \xNN, …) as
// defense-in-depth, which this matcher deliberately does NOT mirror: a name
// carrying control characters is rejected upstream by the audit's
// deal_name_charset check (rules.go), so it can never pass the gate's audit
// re-run — and if one somehow did, failing closed here is the correct
// outcome.
func promptEmbedsName(prompt, name string) bool {
	if strings.Contains(prompt, name) {
		return true
	}
	escaped := strings.ReplaceAll(strings.ReplaceAll(name, `\`, `\\`), `"`, `\"`)
	return escaped != name && strings.Contains(prompt, escaped)
}

// equalNameSets reports whether two deal-name lists contain the same set of
// names, order-insensitive and whitespace-trimmed. Counts are compared by the
// caller.
func equalNameSets(a, b []string) bool {
	setA := make(map[string]struct{}, len(a))
	for _, n := range a {
		setA[strings.TrimSpace(n)] = struct{}{}
	}
	setB := make(map[string]struct{}, len(b))
	for _, n := range b {
		setB[strings.TrimSpace(n)] = struct{}{}
	}
	if len(setA) != len(setB) {
		return false
	}
	for n := range setA {
		if _, ok := setB[n]; !ok {
			return false
		}
	}
	return true
}

func safeDir(dir string) string {
	d := strings.TrimSpace(dir)
	if d == "" {
		return ""
	}
	if abs, err := filepath.Abs(d); err == nil {
		d = filepath.Clean(abs)
	} else {
		d = filepath.Clean(d)
	}
	// Resolve the root itself so symlink-resolved file paths still compare
	// equal when the upload dir sits behind a symlink (e.g. ./data → /mnt).
	if resolved, err := filepath.EvalSymlinks(d); err == nil {
		return resolved
	}
	return d
}

// promptFileRefPatterns matches every syntax the generated prompts use to
// reference an attached file BY NAME (#221). Kept in lockstep with the
// emissions in frontend/src/lib/dealPromptYaml.ts (fileArgsBlock
// `<prefix>_file_path:`; the Media.net/TripleLift post-create merge blocks'
// commented `#     values_file:`) plus the generic `- file_path:` attachment
// row shape. Line-anchored so prose that merely mentions a
// key mid-sentence never matches.
var promptFileRefPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?m)^[ \t]*(?:domain|app_bundle)_file_path:[ \t]*(.+)$`),
	regexp.MustCompile(`(?m)^[ \t]*#[ \t]*values_file:[ \t]*(.+)$`),
	regexp.MustCompile(`(?m)^[ \t]*-[ \t]*file_path:[ \t]*(.+)$`),
}

var (
	quotedPromptRefRe    = regexp.MustCompile(`^"((?:[^"\\]|\\.)*)"`)
	promptRefEscapeRe    = regexp.MustCompile(`\\(.)`)
	trailingRefCommentRe = regexp.MustCompile(`[ \t]+#.*$`)
)

// unquotePromptRef recovers the referenced name from a matched value: a
// double-quoted value (dealPromptYaml's quote() output) is unescaped; an
// unquoted value keeps everything up to a trailing `<ws>#` comment (the
// values_file lines emit raw names that may contain spaces).
func unquotePromptRef(raw string) string {
	s := strings.TrimSpace(raw)
	if m := quotedPromptRefRe.FindStringSubmatch(s); m != nil {
		return promptRefEscapeRe.ReplaceAllString(m[1], "$1")
	}
	return strings.TrimSpace(trailingRefCommentRe.ReplaceAllString(s, ""))
}

// unattachedPromptRefs returns (sorted, deduped) every file name the prompt
// references that is absent from the attachment display-name set — the
// fail-closed server backstop behind the client-side validateBrief check.
func unattachedPromptRefs(prompt string, attached map[string]struct{}) []string {
	seen := map[string]struct{}{}
	var missing []string
	for _, re := range promptFileRefPatterns {
		for _, m := range re.FindAllStringSubmatch(prompt, -1) {
			name := unquotePromptRef(m[1])
			if name == "" {
				continue
			}
			if _, dup := seen[name]; dup {
				continue
			}
			seen[name] = struct{}{}
			if _, ok := attached[name]; !ok {
				missing = append(missing, name)
			}
		}
	}
	sort.Strings(missing)
	return missing
}
