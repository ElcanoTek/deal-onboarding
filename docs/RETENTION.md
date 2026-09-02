# File Storage, Retention & Cleanup

Deal Onboarding handles real client files — domain/app-bundle targeting lists
and deal briefs. This document defines where those files live, how long they
are kept, and how the retention sweep decides what is safe to delete. It is
the policy the `deal-onboarding-admin gc` tool enforces.

## Where files live (under `DATA_DIR`, default `./data`; `/opt/deal-onboarding/data` on a bootstrapped host)

| Path | Contents | Written by |
|---|---|---|
| `DATA_DIR/uploads` | Trader uploads (domain/app-bundle lists, brief attachments) | `POST /api/upload` (auth-gated) |
| `DATA_DIR/lists` | **Trader-created** and **privately provisioned** standard lists (runtime dir) | `POST /api/lists/create`, `scripts/provision-private-lists.sh` |
| `<repo>/lists` | **Repo-shipped** versioned standard lists | git / deploy `rsync` |
| `DATA_DIR/idempotency` | Submit dedup ledger (TTL-GC'd, 24h) | runner submit |
| `DATA_DIR/audit/exclusion-overrides.jsonl` | Append-only authenticated trader acknowledgements for exclusions intentionally stripped from a create | `POST /api/runner/create` before dispatch |
| `DATA_DIR/users.json` | Login store (bcrypt hashes) | `deal-onboarding-admin user …` |

`DATA_DIR` is excluded from the deploy `rsync --delete` and sits on the
service's `ReadWritePaths` volume, so everything under it survives redeploys.

## File classes & retention windows

| Class | Examples | Retention |
|---|---|---|
| **Reusable targeting asset** | Repo `lists/*.csv`, lists in `DATA_DIR/lists` | **Indefinite, versioned.** Never swept. |
| **Compliance audit event** | `audit/exclusion-overrides.jsonl` actor/time/deal/SSP/value records | **Indefinite. Never swept.** Include it in backups. |
| **Ad-hoc upload** | Anything in `DATA_DIR/uploads` | **Swept once older than the grace window** (default 7 days). |

Notes:
- The app keeps no deal-record database, so an upload has no server-side
  reference once its batch is submitted: the runner receives its own copy of
  every list file at submit time.
- **Never sent to SSPs directly:** raw briefs and QA docs. Only
  domain/app-bundle *list* files ride into the runner as targeting inputs.
- **Parsed vs raw:** `.docx` briefs are extracted to text in-memory at parse
  time and never written to disk; only the resulting form data is persisted
  (in the trader's browser localStorage).

## The cleanup tool — `deal-onboarding-admin gc`

An age-based sweep over `DATA_DIR/uploads`. It **never** scans `lists/`,
`idempotency/`, `audit/`, or `users.json`.

```
deal-onboarding-admin gc [--data-dir PATH] [--min-age DUR] [--apply] [--verbose]
```

- **Dry-run by default.** It prints what it *would* delete and why; it deletes
  nothing until you pass `--apply`.
- **Grace window (`--min-age`, default `168h` = 7 days):** a file newer than
  this is always kept — its only reference may be a trader's still-open
  browser draft (localStorage, invisible to the server). **Keep this window
  comfortably larger than the longest realistic draft age.**
- **Safe logging:** the tool prints basenames, sizes, ages, and reasons only —
  never file contents.

### Recommended operation

```bash
sudo -u deal-onboarding /opt/deal-onboarding/bin/deal-onboarding-admin gc            # dry run
sudo -u deal-onboarding /opt/deal-onboarding/bin/deal-onboarding-admin gc --verbose  # + why each file is kept
sudo -u deal-onboarding /opt/deal-onboarding/bin/deal-onboarding-admin gc --apply    # delete after review
```

A weekly systemd timer running `--apply` with a conservative `--min-age`
(e.g. `720h` / 30 days) is a reasonable automation once the team is
comfortable with the candidate list.

## Runbook

- **Disk filling up:** run the gc dry-run to see reclaimable files; `--apply`
  to delete. Reusable lists are never touched.
- **Restoring a lost upload:** uploads are single-copy on the volume. If a
  file is gone, a trader must re-upload it; the runner submit fails closed and
  names the missing file.

## Backup

Deal Onboarding ships no backup automation. Back up the whole `DATA_DIR`
(users, lists, uploads, audit log) with the tool of your choice on your own
schedule, encrypt it off-box, and test a restore periodically. A restore should
contain `users.json`, `lists/`, `uploads/`, and `audit/`. Delete temporary
restores after inspection: they contain client data and password hashes.
