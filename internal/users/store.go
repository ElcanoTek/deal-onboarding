package users

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type User struct {
	Email        string `json:"email"`
	PasswordHash string `json:"password_hash"`
	CreatedAt    int64  `json:"created_at"`
	UpdatedAt    int64  `json:"updated_at"`
}

type fileData struct {
	Users []User `json:"users"`
}

type Store struct {
	path string
}

func NewStore(path string) *Store {
	return &Store{path: path}
}

func (s *Store) Authenticate(email, password string) (*User, error) {
	users, err := s.load()
	if err != nil {
		return nil, err
	}
	email = normalizeEmail(email)
	for _, user := range users {
		if user.Email != email {
			continue
		}
		if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)) != nil {
			return nil, ErrInvalidCredentials
		}
		copy := user
		return &copy, nil
	}
	return nil, ErrInvalidCredentials
}

func (s *Store) CreateUser(email, password string) (*User, error) {
	users, err := s.load()
	if err != nil {
		return nil, err
	}
	email = normalizeEmail(email)
	if email == "" || password == "" {
		return nil, errors.New("email and password are required")
	}
	for _, user := range users {
		if user.Email == email {
			return nil, ErrUserExists
		}
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("hash password: %w", err)
	}
	now := time.Now().Unix()
	user := User{Email: email, PasswordHash: string(hash), CreatedAt: now, UpdatedAt: now}
	users = append(users, user)
	sort.Slice(users, func(i, j int) bool { return users[i].Email < users[j].Email })
	if err := s.save(users); err != nil {
		return nil, err
	}
	return &user, nil
}

func (s *Store) DeleteUser(email string) error {
	users, err := s.load()
	if err != nil {
		return err
	}
	email = normalizeEmail(email)
	next := users[:0]
	removed := false
	for _, user := range users {
		if user.Email == email {
			removed = true
			continue
		}
		next = append(next, user)
	}
	if !removed {
		return ErrUserNotFound
	}
	return s.save(next)
}

func (s *Store) UpdatePassword(email, password string) error {
	users, err := s.load()
	if err != nil {
		return err
	}
	email = normalizeEmail(email)
	if password == "" {
		return errors.New("password is required")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("hash password: %w", err)
	}
	updated := false
	for i := range users {
		if users[i].Email != email {
			continue
		}
		users[i].PasswordHash = string(hash)
		users[i].UpdatedAt = time.Now().Unix()
		updated = true
		break
	}
	if !updated {
		return ErrUserNotFound
	}
	return s.save(users)
}

// GetUser looks a user up by email without checking credentials. It backs the
// a membership check for any external identity source: the caller proves
// WHO the user is, and this lookup decides whether they're provisioned here. The password hash is cleared — callers never need it.
func (s *Store) GetUser(email string) (*User, error) {
	users, err := s.load()
	if err != nil {
		return nil, err
	}
	email = normalizeEmail(email)
	for _, user := range users {
		if user.Email == email {
			copy := user
			copy.PasswordHash = ""
			return &copy, nil
		}
	}
	return nil, ErrUserNotFound
}

func (s *Store) ListUsers() ([]User, error) {
	users, err := s.load()
	if err != nil {
		return nil, err
	}
	for i := range users {
		users[i].PasswordHash = ""
	}
	return users, nil
}

func (s *Store) load() ([]User, error) {
	b, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []User{}, nil
		}
		return nil, fmt.Errorf("read users: %w", err)
	}
	var data fileData
	if err := json.Unmarshal(b, &data); err != nil {
		return nil, fmt.Errorf("parse users: %w", err)
	}
	if data.Users == nil {
		return []User{}, nil
	}
	sort.Slice(data.Users, func(i, j int) bool { return data.Users[i].Email < data.Users[j].Email })
	return data.Users, nil
}

func (s *Store) save(users []User) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return fmt.Errorf("create user dir: %w", err)
	}
	b, err := json.MarshalIndent(fileData{Users: users}, "", "  ")
	if err != nil {
		return fmt.Errorf("encode users: %w", err)
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return fmt.Errorf("write users: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return fmt.Errorf("replace users: %w", err)
	}
	s.matchDirOwnership()
	return nil
}

// matchDirOwnership chowns users.json to the owner of its directory when the
// process runs as root. Every save rewrites the file, and the rewrite is owned
// by whoever ran it — so a sudo-run `deal-onboarding user add` would otherwise leave
// the store root:root 0600, unreadable by the service user, and every
// login (both cookie paths) starts failing with a 500. The data dir is owned
// by the service user, so it's the right owner to restore. Best-effort: a
// failed chown can't be worse than the status quo it's fixing.
func (s *Store) matchDirOwnership() {
	if os.Geteuid() != 0 {
		return
	}
	info, err := os.Stat(filepath.Dir(s.path))
	if err != nil {
		return
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return
	}
	_ = os.Chown(s.path, int(st.Uid), int(st.Gid))
}

func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

var (
	ErrInvalidCredentials = errors.New("invalid email or password")
	ErrUserExists         = errors.New("user already exists")
	ErrUserNotFound       = errors.New("user not found")
)
