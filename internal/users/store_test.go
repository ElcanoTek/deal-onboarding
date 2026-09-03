// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

package users

import "testing"

func TestStoreLifecycle(t *testing.T) {
	store := NewStore(t.TempDir() + "/users.json")

	created, err := store.CreateUser("Tester@Example.com", "secret-pass")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if created.Email != "tester@example.com" {
		t.Fatalf("email = %q, want normalized", created.Email)
	}

	if _, err := store.Authenticate("tester@example.com", "secret-pass"); err != nil {
		t.Fatalf("Authenticate: %v", err)
	}

	if err := store.UpdatePassword("tester@example.com", "new-pass"); err != nil {
		t.Fatalf("UpdatePassword: %v", err)
	}
	if _, err := store.Authenticate("tester@example.com", "new-pass"); err != nil {
		t.Fatalf("Authenticate after password update: %v", err)
	}

	users, err := store.ListUsers()
	if err != nil {
		t.Fatalf("ListUsers: %v", err)
	}
	if len(users) != 1 || users[0].PasswordHash != "" {
		t.Fatalf("ListUsers returned unexpected payload: %+v", users)
	}

	if err := store.DeleteUser("tester@example.com"); err != nil {
		t.Fatalf("DeleteUser: %v", err)
	}
	if _, err := store.Authenticate("tester@example.com", "new-pass"); err != ErrInvalidCredentials {
		t.Fatalf("Authenticate after delete err = %v, want %v", err, ErrInvalidCredentials)
	}
}
