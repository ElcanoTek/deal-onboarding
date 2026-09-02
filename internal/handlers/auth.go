package handlers

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/ElcanoTek/deal-onboarding/internal/auth"
	"github.com/ElcanoTek/deal-onboarding/internal/users"
)

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func HandleLogin(store *users.Store, sessions *auth.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Public, unauthenticated endpoint — bound the body before decoding
		// (covers both the JSON and form-encoded paths).
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
		var req loginRequest
		if err := decodeLoginRequest(r, &req); err != nil {
			http.Error(w, "missing email or password", http.StatusBadRequest)
			return
		}

		user, err := store.Authenticate(req.Email, req.Password)
		if err != nil {
			status := http.StatusUnauthorized
			if !errors.Is(err, users.ErrInvalidCredentials) {
				// The store file couldn't be read or parsed. Log it — bad credentials stay
				// silent, store breakage must not.
				log.Printf("auth: password login store error: %v", err)
				status = http.StatusInternalServerError
			}
			http.Error(w, http.StatusText(status), status)
			return
		}

		if err := sessions.SetCookie(w, r, user.Email); err != nil {
			http.Error(w, "failed to create session", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"email": user.Email})
	}
}

// HandleLogout clears the session cookie.
func HandleLogout() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth.ClearCookie(w, r)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

func HandleSession() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		email, ok := SessionEmailFromRequest(r)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"email": email})
	}
}

// RequireSession authenticates a browser request via the HMAC-signed session
// cookie minted by HandleLogin (email/password is the only login path).
func RequireSession(sessions *auth.Manager) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if cookie, err := r.Cookie(auth.SessionCookieName); err == nil && cookie.Value != "" {
				if payload, err := sessions.Verify(cookie.Value); err == nil {
					ctx := WithSessionEmail(r.Context(), payload.Email)
					next.ServeHTTP(w, r.WithContext(ctx))
					return
				}
			}
			http.Error(w, "unauthorized", http.StatusUnauthorized)
		})
	}
}

func decodeLoginRequest(r *http.Request, req *loginRequest) error {
	contentType := r.Header.Get("Content-Type")
	if strings.HasPrefix(contentType, "application/json") {
		if err := json.NewDecoder(r.Body).Decode(req); err != nil {
			return err
		}
	} else {
		if err := r.ParseForm(); err != nil {
			return err
		}
		req.Email = r.FormValue("email")
		req.Password = r.FormValue("password")
	}
	if req.Email == "" || req.Password == "" {
		return errors.New("missing email or password")
	}
	return nil
}
