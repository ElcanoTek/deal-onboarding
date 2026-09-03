// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

package idempotency

import (
	"testing"
	"time"
)

func TestReserveThenCompleteReturnsPriorResult(t *testing.T) {
	s, err := NewStore(t.TempDir(), time.Hour)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	// First reserve claims the key.
	_, reserved, err := s.Reserve("create", "key-1")
	if err != nil || !reserved {
		t.Fatalf("first Reserve: reserved=%v err=%v (want true,nil)", reserved, err)
	}

	// While pending (no task yet), a duplicate is NOT reserved and NOT done.
	rec, reserved, _ := s.Reserve("create", "key-1")
	if reserved {
		t.Fatal("second Reserve must not re-claim a pending key")
	}
	if rec.Status != "pending" {
		t.Fatalf("in-flight duplicate should be pending, got %q", rec.Status)
	}

	// Complete records the task; a later duplicate returns the ORIGINAL task.
	if err := s.Complete("create", "key-1", "task-123", "https://fleet.example/orchestrator/tasks/task-123"); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	rec, reserved, _ = s.Reserve("create", "key-1")
	if reserved {
		t.Fatal("duplicate of a completed submit must not re-claim")
	}
	if rec.Status != "done" || rec.TaskID != "task-123" {
		t.Fatalf("duplicate must return the original task, got status=%q task=%q", rec.Status, rec.TaskID)
	}
}

func TestOperationNamespacesKeys(t *testing.T) {
	s, _ := NewStore(t.TempDir(), time.Hour)
	// Same client key under different operations must NOT collide.
	_, r1, _ := s.Reserve("create", "shared")
	_, r2, _ := s.Reserve("update", "shared")
	if !r1 || !r2 {
		t.Fatalf("create and update with the same key must both reserve, got %v/%v", r1, r2)
	}
}

func TestReleaseAllowsRetry(t *testing.T) {
	s, _ := NewStore(t.TempDir(), time.Hour)
	_, reserved, _ := s.Reserve("create", "k")
	if !reserved {
		t.Fatal("first reserve should succeed")
	}
	s.Release("create", "k")
	_, reserved, _ = s.Reserve("create", "k")
	if !reserved {
		t.Fatal("after Release the key must be reusable (failed submit can retry)")
	}
}

func TestExpiredKeyReusable(t *testing.T) {
	s, _ := NewStore(t.TempDir(), time.Millisecond)
	s.Reserve("create", "k")
	s.Complete("create", "k", "t1", "")
	time.Sleep(5 * time.Millisecond)
	_, reserved, _ := s.Reserve("create", "k")
	if !reserved {
		t.Fatal("an expired key must be reclaimable (TTL is a GC horizon)")
	}
}
