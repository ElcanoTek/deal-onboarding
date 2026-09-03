// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

package handlers

import (
	"mime"
	"net/http"
	"strings"
)

// attachmentDisposition uses RFC 5987 filename* encoding for non-ASCII names
// while retaining a safe filename fallback for older clients.
func attachmentDisposition(name string) string {
	safe := sanitizeFilename(name)
	return mime.FormatMediaType("attachment", map[string]string{"filename": safe})
}

// clientIP returns the caller's address, honoring the proxy headers the
// reverse proxy in front of the server sets.
func clientIP(r *http.Request) string {
	if h := r.Header.Get("X-Forwarded-For"); h != "" {
		if i := strings.Index(h, ","); i > 0 {
			return strings.TrimSpace(h[:i])
		}
		return strings.TrimSpace(h)
	}
	if h := r.Header.Get("X-Real-IP"); h != "" {
		return strings.TrimSpace(h)
	}
	return r.RemoteAddr
}

// sanitizeFilename strips characters that would break a Content-Disposition
// header value.
func sanitizeFilename(name string) string {
	r := strings.NewReplacer(`"`, "", "\r", "", "\n", "")
	out := r.Replace(name)
	if out == "" {
		return "attachment"
	}
	return out
}
