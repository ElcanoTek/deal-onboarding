// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

package handlers

import (
	"context"
	"net/http"
)

type sessionEmailKey struct{}

func WithSessionEmail(ctx context.Context, email string) context.Context {
	return context.WithValue(ctx, sessionEmailKey{}, email)
}

func SessionEmailFromContext(ctx context.Context) (string, bool) {
	email, ok := ctx.Value(sessionEmailKey{}).(string)
	return email, ok && email != ""
}

func SessionEmailFromRequest(r *http.Request) (string, bool) {
	return SessionEmailFromContext(r.Context())
}
