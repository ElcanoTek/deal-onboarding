package handlers

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The parse prompt hands the extraction model a literal menu of PubMatic
// adFormat / platform labels. Those labels are looked up by EXACT string in
// PUBMATIC_AD_FORMAT_ID / PUBMATIC_PLATFORM_ID (frontend/src/lib/dealPromptYaml.ts)
// and an unrecognised one is dropped by `.filter(Boolean)` — silently, with no
// validation layer in between. So a label that drifts out of sync here does not
// fail: it books the wrong format, or quietly loses the trader's pick.
//
// This is not hypothetical. The schema shipped "Video (12)"|"Native (13)" and
// "CTV (5)" long after e87342c corrected the enums everywhere else, which meant
// the import path could book a Native deal as Video (12 aliases to 13) and could
// not express Mobile App Android at all — the iOS-only footprint the 2026-08-11
// environment audit caught.
//
// SspSelection.tsx is the source of truth because it is what the form renders;
// anything the parser emits that a trader could not have picked by hand is by
// definition unreachable state.
const sspSelectionPath = "../../frontend/src/components/SspSelection.tsx"

// deadPubMaticLabels are enum labels that were live at some point, are now
// wrong, and are retained ONLY as legacy aliases for forms already persisted in
// a trader's localStorage. Offering one to the extraction model mints NEW deals
// on a dead label, which is exactly what the alias was never meant to cover.
var deadPubMaticLabels = []string{"Video (12)", "Native (13)", "CTV (5)"}

func pubmaticSchemaLine(t *testing.T) string {
	t.Helper()
	for _, line := range strings.Split(parseSystemPrompt(), "\n") {
		if strings.Contains(line, `"pubmaticConfig"`) {
			return line
		}
	}
	t.Fatal("parseSystemPrompt() has no pubmaticConfig line")
	return ""
}

// tsStringArray pulls the string literals out of a `const NAME = ['a', 'b']`
// declaration in a TypeScript source file.
func tsStringArray(t *testing.T, src, name string) []string {
	t.Helper()
	decl := regexp.MustCompile(`(?m)^const ` + regexp.QuoteMeta(name) + `\s*=\s*\[([^\]]*)\]`)
	m := decl.FindStringSubmatch(src)
	if m == nil {
		t.Fatalf("could not find `const %s = [...]` in %s", name, sspSelectionPath)
	}
	var out []string
	for _, lit := range regexp.MustCompile(`'([^']*)'`).FindAllStringSubmatch(m[1], -1) {
		out = append(out, lit[1])
	}
	if len(out) == 0 {
		t.Fatalf("%s parsed to an empty list", name)
	}
	return out
}

func TestParsePromptPubMaticEnumsMatchForm(t *testing.T) {
	raw, err := os.ReadFile(filepath.Clean(sspSelectionPath))
	if err != nil {
		t.Fatalf("read %s: %v", sspSelectionPath, err)
	}
	src := string(raw)
	line := pubmaticSchemaLine(t)

	for _, tc := range []struct{ constName, field string }{
		{"PM_AD_FORMATS", "adFormats"},
		{"PM_PLATFORMS", "platforms"},
	} {
		for _, label := range tsStringArray(t, src, tc.constName) {
			if !strings.Contains(line, `"`+label+`"`) {
				t.Errorf("parse prompt %s omits %q, which the form offers (%s in %s). "+
					"A trader can pick it by hand but the parser will never emit it.",
					tc.field, label, tc.constName, sspSelectionPath)
			}
		}
	}
}

func TestParsePromptOffersNoDeadPubMaticLabels(t *testing.T) {
	line := pubmaticSchemaLine(t)
	for _, label := range deadPubMaticLabels {
		if strings.Contains(line, `"`+label+`"`) {
			t.Errorf("parse prompt offers the dead label %q. It survives only as a "+
				"legacy alias for already-persisted forms and must not be offered to "+
				"the extraction model — Video is 13, Native is 12, CTV is 7.", label)
		}
	}
}
