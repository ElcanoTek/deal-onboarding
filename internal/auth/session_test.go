package auth

import (
	"net/http/httptest"
	"testing"
	"time"
)

func TestManagerRoundTrip(t *testing.T) {
	mgr, err := NewManager("0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}

	token, err := mgr.Create("Tester@Example.com")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	payload, err := mgr.Verify(token)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if payload.Email != "tester@example.com" {
		t.Fatalf("email = %q, want lowercase", payload.Email)
	}
	if payload.Exp <= time.Now().Unix() {
		t.Fatal("expected future expiration")
	}
}

func TestSetCookieMarksSecureBehindProxy(t *testing.T) {
	mgr, err := NewManager("0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "http://deals.example.com/", nil)
	req.Header.Set("X-Forwarded-Proto", "https")

	if err := mgr.SetCookie(rec, req, "user@example.com"); err != nil {
		t.Fatalf("SetCookie: %v", err)
	}

	result := rec.Result()
	if len(result.Cookies()) != 1 || !result.Cookies()[0].Secure {
		t.Fatal("expected secure session cookie")
	}
}
