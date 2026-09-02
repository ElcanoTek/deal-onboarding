// Package overrideaudit persists authenticated exclusion-override events.
// The append-only JSONL log is separate from mutable deal records so an event
// survives post-submit bookkeeping failures.
package overrideaudit

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/ElcanoTek/deal-onboarding/internal/validation"
)

type Event struct {
	At             time.Time                           `json:"at"`
	Actor          string                              `json:"actor"`
	IdempotencyKey string                              `json:"idempotencyKey,omitempty"`
	Operation      string                              `json:"operation"`
	Status         string                              `json:"status"`
	TaskID         string                              `json:"taskId,omitempty"`
	Override       validation.ExclusionOverrideDetails `json:"override"`
}

type Store struct {
	path string
	mu   sync.Mutex
}

func NewStore(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return nil, fmt.Errorf("create override audit dir: %w", err)
	}
	return &Store{path: path}, nil
}

// Append durably commits one newline-delimited event before returning.
func (s *Store) Append(event Event) error {
	if s == nil {
		return fmt.Errorf("override audit store is not configured")
	}
	if event.At.IsZero() {
		event.At = time.Now().UTC()
	}
	b, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal override event: %w", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	f, err := os.OpenFile(s.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open override audit log: %w", err)
	}
	defer f.Close()
	if _, err := f.Write(append(b, '\n')); err != nil {
		return fmt.Errorf("append override audit log: %w", err)
	}
	if err := f.Sync(); err != nil {
		return fmt.Errorf("sync override audit log: %w", err)
	}
	return nil
}
