// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

package handlers

import (
	"net/http"
	"net/url"
	"strings"
)

// RequireSameOrigin rejects state-changing cookie requests whose Origin does
// not match our own host. This is a stateless CSRF defense
// for the cookie login paths (the deal_onboarding_session cookie): browsers always send Origin on cross-origin mutating requests and
// can't be tricked into forging it, while same-origin requests from Deal Onboarding's
// own frontend carry the right Origin automatically.
//
// Behind Caddy the request host arrives in X-Forwarded-Host; in dev the Vite
// proxy forwards the browser's own Host header (changeOrigin is off for this
// reason), so both compare equal to the Origin.
func RequireSameOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		if !originMatchesHost(r) {
			http.Error(w, "cross-origin request blocked", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func originMatchesHost(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return false
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	expected := r.Header.Get("X-Forwarded-Host")
	if expected == "" {
		expected = r.Host
	}
	return strings.EqualFold(u.Host, expected)
}
