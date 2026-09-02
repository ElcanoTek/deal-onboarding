package main

import (
	"crypto/rand"
	"encoding/base64"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ElcanoTek/deal-onboarding/internal/envfile"
	"github.com/ElcanoTek/deal-onboarding/internal/gc"
	"github.com/ElcanoTek/deal-onboarding/internal/users"
)

func main() {
	if err := envfile.Load(".env"); err != nil {
		fmt.Fprintf(os.Stderr, "error: load .env: %v\n", err)
		os.Exit(1)
	}
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 {
		printUsage(os.Stderr)
		return 2
	}
	switch args[0] {
	case "user":
		return runUser(args[1:])
	case "gc":
		return cmdGC(args[1:])
	case "-h", "--help", "help":
		printUsage(os.Stdout)
		return 0
	default:
		printUsage(os.Stderr)
		return 2
	}
}

func printUsage(w io.Writer) {
	fmt.Fprint(w, `deal-onboarding-admin - Deal Onboarding operator tools

Usage:
  deal-onboarding-admin user add <email> [--password X | --password -]
  deal-onboarding-admin user del <email>
  deal-onboarding-admin user list
  deal-onboarding-admin user passwd <email> [--password X | --password -]

  deal-onboarding-admin gc [--data-dir PATH] [--min-age DUR] [--apply]
      Retention sweep of the ad-hoc upload dir (DATA_DIR/uploads).
      DRY-RUN by default — prints what it WOULD delete and why. Pass --apply
      to actually delete. Never touches reusable standard lists, users.json,
      or files newer than --min-age (default 168h / 7d).

Flags:
  --user-store PATH   Path to users.json (default: $DEAL_ONBOARDING_USER_STORE)
`)
}

func runUser(args []string) int {
	if len(args) == 0 {
		printUsage(os.Stderr)
		return 2
	}
	switch args[0] {
	case "add":
		return cmdUserAdd(args[1:])
	case "del", "delete", "rm":
		return cmdUserDel(args[1:])
	case "list", "ls":
		return cmdUserList(args[1:])
	case "passwd", "password":
		return cmdUserPasswd(args[1:])
	case "-h", "--help", "help":
		printUsage(os.Stdout)
		return 0
	default:
		fmt.Fprintf(os.Stderr, "unknown subcommand: %s\n", args[0])
		return 2
	}
}

func parseUserFlags(argv []string, expectEmail bool) (string, string, string, error) {
	positional := make([]string, 0, len(argv))
	flagTokens := make([]string, 0, len(argv))
	for i := 0; i < len(argv); i++ {
		a := argv[i]
		if strings.HasPrefix(a, "-") && a != "-" {
			flagTokens = append(flagTokens, a)
			switch a {
			case "--user-store", "-user-store", "--password", "-password":
				if i+1 < len(argv) {
					flagTokens = append(flagTokens, argv[i+1])
					i++
				}
			}
			continue
		}
		positional = append(positional, a)
	}

	fs := flag.NewFlagSet("user", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	storePath := fs.String("user-store", "", "Path to users.json")
	password := fs.String("password", "", "Password ('-' to read from stdin)")
	if err := fs.Parse(flagTokens); err != nil {
		return "", "", "", err
	}

	path := *storePath
	if path == "" {
		path = os.Getenv("DEAL_ONBOARDING_USER_STORE")
	}
	if path == "" {
		if dataDir := os.Getenv("DATA_DIR"); dataDir != "" {
			path = filepath.Join(dataDir, "users.json")
		}
	}
	if path == "" {
		return "", "", "", fmt.Errorf("DEAL_ONBOARDING_USER_STORE is unset - pass --user-store or export it")
	}

	email := ""
	if expectEmail {
		if len(positional) == 0 {
			return "", "", "", fmt.Errorf("email required")
		}
		email = positional[0]
	}

	pw := *password
	if pw == "-" {
		b, err := io.ReadAll(os.Stdin)
		if err != nil {
			return "", "", "", err
		}
		pw = strings.TrimRight(string(b), "\r\n")
	}
	return path, pw, email, nil
}

func cmdUserAdd(argv []string) int {
	storePath, password, email, err := parseUserFlags(argv, true)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 2
	}
	generated := false
	if password == "" {
		password = generatePassword()
		generated = true
	}
	user, err := users.NewStore(storePath).CreateUser(email, password)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}
	fmt.Printf("✓ user created: %s\n", user.Email)
	if generated {
		fmt.Printf("  password: %s\n", password)
		fmt.Println("  shown once - rotate later with: deal-onboarding-admin user passwd <email>")
	}
	return 0
}

func cmdUserDel(argv []string) int {
	storePath, _, email, err := parseUserFlags(argv, true)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 2
	}
	if err := users.NewStore(storePath).DeleteUser(email); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}
	fmt.Printf("✓ user deleted: %s\n", email)
	return 0
}

func cmdUserList(argv []string) int {
	storePath, _, _, err := parseUserFlags(argv, false)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 2
	}
	list, err := users.NewStore(storePath).ListUsers()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}
	if len(list) == 0 {
		fmt.Println("no users yet - add one with: deal-onboarding-admin user add <email>")
		return 0
	}
	fmt.Printf("%-40s  %s\n", "EMAIL", "CREATED")
	for _, user := range list {
		fmt.Printf("%-40s  %s\n", user.Email, time.Unix(user.CreatedAt, 0).Format(time.RFC3339))
	}
	return 0
}

func cmdUserPasswd(argv []string) int {
	storePath, password, email, err := parseUserFlags(argv, true)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 2
	}
	generated := false
	if password == "" {
		password = generatePassword()
		generated = true
	}
	if err := users.NewStore(storePath).UpdatePassword(email, password); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}
	fmt.Printf("✓ password rotated for %s\n", email)
	if generated {
		fmt.Printf("  new password: %s\n", password)
	}
	return 0
}

func generatePassword() string {
	var raw [12]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic(err)
	}
	password := base64.RawURLEncoding.EncodeToString(raw[:])
	return strings.NewReplacer("l", "L", "I", "i", "0", "2", "O", "o").Replace(password)
}

// cmdGC runs the ad-hoc upload retention sweep. Dry-run by default; --apply
// deletes. It classifies every file under DATA_DIR/uploads by age. Reusable
// standard lists (DATA_DIR/lists), users.json, and the idempotency store are
// never scanned.
func cmdGC(argv []string) int {
	fs := flag.NewFlagSet("gc", flag.ContinueOnError)
	dataDir := fs.String("data-dir", "", "Deal Onboarding data dir (default: $DATA_DIR or ./data)")
	minAgeStr := fs.String("min-age", "168h", "grace window — files newer than this are always kept (e.g. 168h, 720h)")
	apply := fs.Bool("apply", false, "actually delete the candidates (default is a dry run)")
	verbose := fs.Bool("verbose", false, "also list every protected file and why it was kept")
	if err := fs.Parse(argv); err != nil {
		return 2
	}

	dir := strings.TrimSpace(*dataDir)
	if dir == "" {
		dir = strings.TrimSpace(os.Getenv("DATA_DIR"))
	}
	if dir == "" {
		dir = "./data"
	}
	minAge, err := time.ParseDuration(*minAgeStr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: invalid --min-age %q: %v\n", *minAgeStr, err)
		return 2
	}
	if minAge < 0 {
		fmt.Fprintln(os.Stderr, "error: --min-age must not be negative")
		return 2
	}

	uploadDirs := []string{filepath.Join(dir, "uploads")}
	plan, err := gc.BuildPlan(uploadDirs, minAge, time.Now())
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: build plan: %v\n", err)
		return 1
	}

	mode := "DRY RUN"
	if *apply {
		mode = "APPLY"
	}
	fmt.Printf("deal-onboarding-admin gc — upload retention sweep (%s)\n", mode)
	fmt.Printf("  data dir:  %s\n", dir)
	if len(plan.ScannedDirs) == 0 {
		fmt.Println("  scanned:   (no upload dirs present)")
	} else {
		fmt.Printf("  scanned:   %s\n", strings.Join(plan.ScannedDirs, ", "))
	}
	fmt.Printf("  min age:   %s (files newer are kept as possible drafts)\n", minAge)
	fmt.Printf("  protected: %d, candidates: %d\n\n", len(plan.Protected), len(plan.Candidates))

	if *verbose && len(plan.Protected) > 0 {
		fmt.Println("PROTECTED (kept):")
		for _, p := range plan.Protected {
			fmt.Printf("  KEEP  %-52s  %10s  %s\n", filepath.Base(p.Path), humanBytes(p.Size), p.Reason)
		}
		fmt.Println()
	}

	if len(plan.Candidates) == 0 {
		fmt.Println("No past-grace uploads found — nothing to delete.")
		return 0
	}

	fmt.Println("CANDIDATES (past grace):")
	for _, c := range plan.Candidates {
		fmt.Printf("  DEL   %-52s  %10s  age %5.1fd  %s\n", filepath.Base(c.Path), humanBytes(c.Size), c.AgeDays, c.Reason)
	}
	fmt.Printf("\nTotal reclaimable: %s across %d file(s)\n", humanBytes(plan.CandidateBytes()), len(plan.Candidates))

	if !*apply {
		fmt.Printf("\nDRY RUN — nothing deleted. Re-run with --apply to delete the %d candidate(s).\n", len(plan.Candidates))
		return 0
	}

	deleted, freed, errs := plan.Apply()
	fmt.Printf("\nDeleted %d file(s), freed %s.\n", deleted, humanBytes(freed))
	if len(errs) > 0 {
		fmt.Fprintf(os.Stderr, "%d deletion(s) failed:\n", len(errs))
		for _, e := range errs {
			fmt.Fprintf(os.Stderr, "  %v\n", e)
		}
		return 1
	}
	return 0
}

// humanBytes renders a byte count compactly (operator-facing; never file data).
func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGTPE"[exp])
}
