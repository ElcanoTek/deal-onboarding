// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

// Package fsutil holds small filesystem helpers shared by the JSON
// file-backed stores (lists, idempotency, audit).
package fsutil

import (
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
)

// WriteFileAtomic writes data to path via a temp file + rename so a crash or
// full disk mid-write never leaves a truncated/corrupt file behind. The temp
// file is created in path's directory so the rename stays on one filesystem.
func WriteFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after a successful rename

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, perm); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

// RandomSuffix returns n cryptographically-random characters from a URL-safe
// lowercase alphanumeric alphabet. Used to de-collide time-prefixed IDs.
// The alphabet has 32 characters so the byte→char mapping is modulo-bias-free.
func RandomSuffix(n int) string {
	const alphabet = "abcdefghijkmnopqrstuvwxyz2345679"
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failing means the OS entropy source is broken; an ID
		// helper can't recover meaningfully, so fail loudly.
		panic(fmt.Sprintf("fsutil: crypto/rand unavailable: %v", err))
	}
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b)
}
