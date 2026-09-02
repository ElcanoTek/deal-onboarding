package handlers

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// Shared OpenRouter chat plumbing. Used by parse.go (deal extraction) and
// audit_ai.go (deal critique). Same client + same response-shape extraction;
// the only thing that varies is the system prompt and the requested model.

const openRouterChatURL = "https://openrouter.ai/api/v1/chat/completions"

type orMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type orRequest struct {
	Model       string      `json:"model"`
	MaxTokens   int         `json:"max_tokens"`
	Temperature float64     `json:"temperature"`
	Messages    []orMessage `json:"messages"`
}

type orChoice struct {
	Message orMessage `json:"message"`
}

type orResponse struct {
	Choices []orChoice `json:"choices"`
	Error   *struct {
		Message string `json:"message"`
		Code    any    `json:"code,omitempty"`
	} `json:"error,omitempty"`
}

// CallOpenRouter posts a chat completion and returns the trimmed response text.
// Returns an error tagged for the caller to surface — model errors and HTTP
// errors are normalized into one shape.
func CallOpenRouter(apiKey, model, systemPrompt, userPrompt string, maxTokens int, temperature float64) (string, error) {
	if strings.TrimSpace(apiKey) == "" {
		return "", errors.New("OPENROUTER_API_KEY not configured")
	}
	body := orRequest{
		Model:       model,
		MaxTokens:   maxTokens,
		Temperature: temperature,
		Messages: []orMessage{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userPrompt},
		},
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequest("POST", openRouterChatURL, bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("HTTP-Referer", "https://github.com/ElcanoTek/deal-onboarding")
	req.Header.Set("X-Title", "Deal Onboarding")

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	var cr orResponse
	if err := json.Unmarshal(respBody, &cr); err != nil {
		return "", fmt.Errorf("unexpected response from OpenRouter: %s", truncateText(string(respBody), 200))
	}
	if cr.Error != nil {
		return "", fmt.Errorf("OpenRouter API error: %s", cr.Error.Message)
	}
	if len(cr.Choices) == 0 {
		return "", errors.New("empty response from OpenRouter")
	}
	return strings.TrimSpace(cr.Choices[0].Message.Content), nil
}

// ExtractJSONObject strips markdown fences then returns the substring between
// the first `{` and the last `}`. Used when the model's content is JSON.
func ExtractJSONObject(s string) (string, error) {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "```json")
	s = strings.TrimPrefix(s, "```")
	s = strings.TrimSuffix(s, "```")
	s = strings.TrimSpace(s)
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start < 0 || end <= start {
		return "", fmt.Errorf("no JSON object in response: %s", truncateText(s, 200))
	}
	return s[start : end+1], nil
}

// OpenRouterAPIKey is a small helper so handlers don't duplicate the env read
// + trim. Returns "" when unset.
func OpenRouterAPIKey() string {
	return strings.TrimSpace(os.Getenv("OPENROUTER_API_KEY"))
}

func truncateText(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
