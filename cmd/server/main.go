// Package main is the entry point for the Deal Onboarding API server.
package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"github.com/ElcanoTek/deal-onboarding/internal/auth"
	"github.com/ElcanoTek/deal-onboarding/internal/config"
	"github.com/ElcanoTek/deal-onboarding/internal/envfile"
	"github.com/ElcanoTek/deal-onboarding/internal/handlers"
	"github.com/ElcanoTek/deal-onboarding/internal/idempotency"
	"github.com/ElcanoTek/deal-onboarding/internal/lists"
	"github.com/ElcanoTek/deal-onboarding/internal/overrideaudit"
	"github.com/ElcanoTek/deal-onboarding/internal/pubcatalog"
	"github.com/ElcanoTek/deal-onboarding/internal/runner"
	"github.com/ElcanoTek/deal-onboarding/internal/users"
	"github.com/ElcanoTek/deal-onboarding/internal/validation"
)

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// getEnvAny returns the first non-empty value among the given keys. It lets
// the operator-facing DEAL_ONBOARDING_* names take precedence while the
// internal MANIFEST_* names an existing deployment may still export keep
// working (see .env.example).
func getEnvAny(def string, keys ...string) string {
	for _, k := range keys {
		if v := os.Getenv(k); v != "" {
			return v
		}
	}
	return def
}

func main() {
	if err := envfile.Load(".env"); err != nil {
		log.Fatalf("load .env: %v", err)
	}

	host := getEnv("HOST", "0.0.0.0")
	port := getEnv("PORT", "8080")
	dataDir := getEnv("DATA_DIR", "./data")
	frontendDistDir := getEnv("FRONTEND_DIST_DIR", "./frontend/dist")
	corsOrigins := getEnv("CORS_ORIGINS", "http://localhost:5173,http://localhost:4173")
	userStorePath := getEnvAny(filepath.Join(dataDir, "users.json"), "DEAL_ONBOARDING_USER_STORE", "MANIFEST_USER_STORE")
	sessionSecret := getEnvAny("", "DEAL_ONBOARDING_SESSION_SECRET", "MANIFEST_SESSION_SECRET")
	listsDir := getEnvAny("./lists", "DEAL_ONBOARDING_LISTS_DIR", "MANIFEST_LISTS_DIR")
	// Trader-created ("save as a standard list") lists persist here, UNDER
	// DATA_DIR — never in the repo-shipped listsDir, which a deploy's
	// `rsync --delete` wipes. DATA_DIR is excluded from that rsync and lives on
	// the service's ReadWritePaths volume, so these survive every update.
	listsRuntimeDir := getEnvAny(filepath.Join(dataDir, "lists"), "DEAL_ONBOARDING_LISTS_RUNTIME_DIR", "MANIFEST_LISTS_RUNTIME_DIR")
	uploadsDir := filepath.Join(dataDir, "uploads")

	// Operator identity: the deal-name curator slot, campaign-id prefix, and
	// attribution default. One installation = one organization.
	operator := config.FromEnv()
	validation.Configure(operator)
	log.Printf("Operator: org %q, campaign ids %s#####, attribution default %s", operator.OrgName, operator.CampaignIDPrefix, operator.DefaultAttributionCode)

	sessions, err := auth.NewManager(sessionSecret)
	if err != nil {
		log.Fatalf("session config error: %v", err)
	}
	userStore := users.NewStore(userStorePath)

	listRegistry, err := lists.LoadMerged(listsDir, listsRuntimeDir)
	if err != nil {
		log.Fatalf("standard list load error (%s): %v", listsDir, err)
	}
	log.Printf("Loaded %d standard lists (repo %s + runtime %s)", len(listRegistry.List()), listsDir, listsRuntimeDir)

	// Known publisher list — an operator-generated snapshot behind the
	// allowlist chips' entry-time validation + the advisory
	// publisher_known_list audit check. Missing file = feature quietly off
	// (booking still verifies against the live SSP catalog).
	pubCatalogPath := getEnvAny("./catalogs/publisher-catalog.json", "DEAL_ONBOARDING_PUBLISHER_CATALOG", "MANIFEST_PUBLISHER_CATALOG")
	pubCatalog, err := pubcatalog.Load(pubCatalogPath)
	if err != nil {
		log.Fatalf("publisher catalog load error (%s): %v", pubCatalogPath, err)
	}
	if pubCatalog != nil {
		handlers.SetPublisherCatalog(pubCatalog)
		total := 0
		for _, entries := range pubCatalog.Slices {
			total += len(entries)
		}
		log.Printf("Loaded known publisher list (%d publishers across %d SSP catalogs, snapshot %s)", total, len(pubCatalog.Slices), pubCatalog.AsOf)
	} else {
		log.Printf("No publisher catalog at %s — allowlist entry-time validation off (booking-time verification unaffected)", pubCatalogPath)
	}

	// Idempotency store for runner submissions. TTL is a GC horizon
	// comfortably longer than any end-to-end submit + client-retry budget, so
	// a slow retry still dedups while a stale key is eventually reusable.
	idemStore, err := idempotency.NewStore(filepath.Join(dataDir, "idempotency"), 24*time.Hour)
	if err != nil {
		log.Fatalf("idempotency store error: %v", err)
	}
	overrideAuditStore, err := overrideaudit.NewStore(filepath.Join(dataDir, "audit", "exclusion-overrides.jsonl"))
	if err != nil {
		log.Fatalf("exclusion override audit store error: %v", err)
	}

	// Runner integration is OFF unless a base URL + API key are configured
	// (RUNNER_BASE_URL + RUNNER_API_KEY). When disabled, /api/runner/create
	// returns 503 and never touches the network. A second instance
	// (RUNNER_DEV_*) is optional: configuring it surfaces the environment
	// picker in the submit flow.
	runnerEnvs := runner.EnvironmentsFromEnv()
	if runnerEnvs.Prod.Enabled() {
		log.Printf("Runner submission enabled (%s)", runnerEnvs.Prod.BaseURL)
	} else {
		log.Printf("Runner submission disabled — set RUNNER_BASE_URL and RUNNER_API_KEY to enable")
	}
	if runnerEnvs.Dev.Enabled() {
		log.Printf("Runner dev environment enabled (%s) — submit-environment picker is live", runnerEnvs.Dev.BaseURL)
	}

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.RealIP)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   splitComma(corsOrigins),
		AllowedMethods:   []string{"GET", "POST", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Content-Type"},
		AllowCredentials: false,
		MaxAge:           300,
	}))

	r.Post("/api/auth/login", handlers.HandleLogin(userStore, sessions))
	// POST + the same-origin check prevents forced "logout CSRF".
	r.With(handlers.RequireSameOrigin).Post("/api/auth/logout", handlers.HandleLogout())
	r.With(handlers.RequireSession(sessions)).Get("/api/session", handlers.HandleSession())
	// Operator identity for the frontend name generator (curator slot,
	// campaign-id prefix, attribution default). Non-secret; public so the
	// login page can render the product identity before a session exists.
	r.Get("/api/config", handlers.HandleOperatorConfig(operator))

	r.Group(func(protected chi.Router) {
		protected.Use(handlers.RequireSameOrigin)
		protected.Use(handlers.RequireSession(sessions))
		protected.Post("/api/audit", handlers.HandleAudit(listRegistry))
		protected.Post("/api/audit-ai", handlers.HandleAuditAI(listRegistry))
		protected.Post("/api/upload", handlers.HandleUpload(uploadsDir))
		protected.Get("/api/upload/file", handlers.HandleDownloadUpload(uploadsDir))
		protected.Post("/api/parse-deal", handlers.HandleParseDeal())
		// Model picker catalog: same-origin OpenRouter proxy — full catalog
		// for search, latest-per-lab rankings for browse, and the advisory
		// slug check.
		protected.Get("/api/models/catalog", handlers.HandleModelCatalog())
		protected.Get("/api/models/rankings", handlers.HandleModelRankings())
		protected.Get("/api/models/check", handlers.HandleModelCheck())
		protected.Post("/api/extract-text", handlers.HandleExtractText())
		protected.Get("/api/publisher-catalog", handlers.HandleGetPublisherCatalog())
		protected.Get("/api/lists", handlers.HandleListLists(listRegistry))
		protected.Post("/api/lists/create", handlers.HandleCreateList(listRegistry, uploadsDir))
		// Deal Assistant dock — streaming chat over the current form + audit.
		protected.Post("/api/deal/chat", handlers.HandleDealChat(listRegistry))
		protected.Get("/api/runner/environments", handlers.HandleRunnerEnvironments(runnerEnvs))
		// Reachability + key probe for one runner instance (defaults to dev).
		// Read-only: it creates no task — see runner.Client.Check.
		protected.Get("/api/runner/check", handlers.HandleRunnerCheck(runnerEnvs))
		// The single outbound seam: audited batch → runner task.
		runnerCreate := handlers.HandleRunnerCreateWithOverrideAudit(runnerEnvs, listRegistry, idemStore, overrideAuditStore, uploadsDir)
		protected.Post("/api/runner/create", runnerCreate)
	})
	// Unauthenticated like /health: exposes only a content hash of the built
	// index.html so long-lived tabs can detect a new deploy and offer a reload.
	r.Get("/api/version", handlers.HandleAppVersion(frontendDistDir))
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	r.Get("/*", handlers.NewStaticHandler(frontendDistDir))

	addr := host + ":" + port
	log.Printf("Deal Onboarding API listening on %s", addr)

	srv := &http.Server{
		Addr:         addr,
		Handler:      r,
		ReadTimeout:  5 * time.Minute,
		WriteTimeout: 5 * time.Minute,
		IdleTimeout:  120 * time.Second,
	}
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
}

func splitComma(s string) []string {
	var out []string
	for _, p := range splitString(s, ',') {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func splitString(s string, sep rune) []string {
	var out []string
	start := 0
	for i, r := range s {
		if r == sep {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	out = append(out, s[start:])
	return out
}
