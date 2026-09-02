package overrideaudit

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ElcanoTek/deal-onboarding/internal/validation"
)

func TestAppendPersistsActorAndExactValues(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.jsonl")
	s, err := NewStore(path)
	if err != nil {
		t.Fatal(err)
	}
	e := Event{Actor: "trader@example.com", Operation: "create", Status: "authorized", Override: validation.ExclusionOverrideDetails{DealID: "d-1", SSP: "OpenX", Audience: []string{"Blocked Segment"}, Geo: []string{"zip:90210"}, Source: "trader"}}
	if err := s.Append(e); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	got := string(b)
	for _, want := range []string{`"actor":"trader@example.com"`, `"deal_id":"d-1"`, `"audience":["Blocked Segment"]`, `"geo":["zip:90210"]`} {
		if !strings.Contains(got, want) {
			t.Errorf("log missing %s: %s", want, got)
		}
	}
	if !strings.HasSuffix(got, "\n") {
		t.Errorf("event must be JSONL: %q", got)
	}
}
