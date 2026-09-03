// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

const (
	SessionCookieName   = "deal_onboarding_session"
	SessionMaxAge       = 14 * 24 * time.Hour
	forwardedProtoHTTPS = "https"
)

type SessionPayload struct {
	Email string `json:"email"`
	Exp   int64  `json:"exp"`
}

type Manager struct {
	secret []byte
}

func NewManager(secret string) (*Manager, error) {
	secret = strings.TrimSpace(secret)
	if len(secret) < 32 {
		return nil, errors.New("DEAL_ONBOARDING_SESSION_SECRET must be at least 32 characters")
	}
	return &Manager{secret: []byte(secret)}, nil
}

func (m *Manager) Create(email string) (string, error) {
	payloadBytes, err := json.Marshal(SessionPayload{
		Email: strings.ToLower(strings.TrimSpace(email)),
		Exp:   time.Now().Add(SessionMaxAge).Unix(),
	})
	if err != nil {
		return "", err
	}

	encodedPayload := base64.RawURLEncoding.EncodeToString(payloadBytes)
	mac := hmac.New(sha256.New, m.secret)
	mac.Write([]byte(encodedPayload))
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return encodedPayload + "." + signature, nil
}

func (m *Manager) Verify(token string) (*SessionPayload, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return nil, errors.New("invalid session token")
	}

	mac := hmac.New(sha256.New, m.secret)
	mac.Write([]byte(parts[0]))
	expected := mac.Sum(nil)
	actual, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(actual, expected) {
		return nil, errors.New("invalid session signature")
	}

	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, errors.New("invalid session payload")
	}

	var payload SessionPayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return nil, errors.New("invalid session payload")
	}
	if payload.Email == "" || payload.Exp <= time.Now().Unix() {
		return nil, errors.New("session expired")
	}
	return &payload, nil
}

func (m *Manager) SetCookie(w http.ResponseWriter, r *http.Request, email string) error {
	token, err := m.Create(email)
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   IsSecureRequest(r),
		MaxAge:   int(SessionMaxAge.Seconds()),
	})
	return nil
}

func ClearCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   IsSecureRequest(r),
		MaxAge:   -1,
		Expires:  time.Unix(0, 0),
	})
}

func IsSecureRequest(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), forwardedProtoHTTPS)
}
