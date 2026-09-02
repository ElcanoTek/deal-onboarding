// Package idempotency provides a small file-backed store that makes a
// side-effectful submission (creating a MOC task that books real deals on live
// exchanges) safe to retry. A client mints a stable key per user intent (one
// per form instance) and sends it with every submit attempt; the server
// reserves the key BEFORE doing the work and returns the original result on a
// duplicate — so a reload, remount, tab switch, or network retry can never
// create a second batch of live deals.
package idempotency

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/ElcanoTek/deal-onboarding/internal/fsutil"
)

// Record is the persisted state of one submission key.
type Record struct {
	Key       string    `json:"key"`       // storage key (operation|clientKey)
	Operation string    `json:"operation"` // e.g. "create" / "update" — namespaces keys per flow
	TaskID    string    `json:"taskId"`    // set once the downstream task exists
	TaskURL   string    `json:"taskUrl,omitempty"`
	Status    string    `json:"status"` // "pending" (reserved, work in flight) | "done"
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// Store is a single-process, mutex-guarded, file-per-key store. The mutex makes
// Reserve atomic (check-then-write) without a cross-process lock — Deal Onboarding runs
// as one process (see deals.Store, same pattern).
type Store struct {
	mu  sync.Mutex
	dir string
	ttl time.Duration // garbage-collection horizon; MUST exceed the max end-to-end retry/timeout budget
}

// NewStore opens (creating if needed) the key directory. ttl is the retention
// horizon after which a key may be reused (it is a GC horizon, NOT the dedup
// mechanism — dedup is exact-key-match while the record exists and is unexpired).
func NewStore(dir string, ttl time.Duration) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	if ttl <= 0 {
		ttl = 24 * time.Hour
	}
	return &Store{dir: dir, ttl: ttl}, nil
}

func (s *Store) path(op, clientKey string) string {
	sum := sha256.Sum256([]byte(op + "|" + clientKey))
	return filepath.Join(s.dir, hex.EncodeToString(sum[:])+".json")
}

// Reserve atomically claims (op, clientKey). If a non-expired record already
// exists it is returned with reserved=false (the caller must NOT do the work
// again — return the prior result for a "done" record, or a conflict for a
// still-"pending" one). Otherwise a "pending" record is written and
// reserved=true is returned (the caller does the work then calls Complete).
func (s *Store) Reserve(op, clientKey string) (rec Record, reserved bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UTC()
	p := s.path(op, clientKey)
	if data, rerr := os.ReadFile(p); rerr == nil {
		var existing Record
		if json.Unmarshal(data, &existing) == nil && now.Before(existing.ExpiresAt) {
			return existing, false, nil
		}
		// Missing/corrupt/expired: fall through and overwrite with a fresh reservation.
	}

	rec = Record{
		Key:       op + "|" + clientKey,
		Operation: op,
		Status:    "pending",
		CreatedAt: now,
		ExpiresAt: now.Add(s.ttl),
	}
	out, merr := json.MarshalIndent(rec, "", "  ")
	if merr != nil {
		return Record{}, false, merr
	}
	if werr := fsutil.WriteFileAtomic(p, out, 0o644); werr != nil {
		return Record{}, false, werr
	}
	return rec, true, nil
}

// Get returns the non-expired record for (op, clientKey) without reserving —
// a read-only probe for callers that need to know whether a key is already
// spoken for under a DIFFERENT namespace (e.g. the same submission key on the
// other MOC environment) before doing any work.
func (s *Store) Get(op, clientKey string) (Record, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := os.ReadFile(s.path(op, clientKey))
	if err != nil {
		return Record{}, false
	}
	var rec Record
	if json.Unmarshal(data, &rec) != nil || !time.Now().UTC().Before(rec.ExpiresAt) {
		return Record{}, false
	}
	return rec, true
}

// Complete records the downstream task id/url and marks the key "done" so a
// later duplicate returns the original result. Best-effort: a failure to persist
// does not undo the already-created task (the reservation remains "pending" and
// will be treated as in-progress until it expires).
func (s *Store) Complete(op, clientKey, taskID, taskURL string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	p := s.path(op, clientKey)
	now := time.Now().UTC()
	rec := Record{
		Key:       op + "|" + clientKey,
		Operation: op,
		TaskID:    taskID,
		TaskURL:   taskURL,
		Status:    "done",
		CreatedAt: now,
		ExpiresAt: now.Add(s.ttl),
	}
	if data, rerr := os.ReadFile(p); rerr == nil {
		var existing Record
		if json.Unmarshal(data, &existing) == nil {
			rec.CreatedAt = existing.CreatedAt
			rec.ExpiresAt = existing.CreatedAt.Add(s.ttl)
		}
	}
	out, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return err
	}
	return fsutil.WriteFileAtomic(p, out, 0o644)
}

// Release drops a reservation (used when the work failed and the client should
// be able to retry with the same key). Best-effort.
func (s *Store) Release(op, clientKey string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = os.Remove(s.path(op, clientKey))
}
