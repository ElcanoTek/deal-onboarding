.PHONY: dev server frontend build build-go build-fe fmt vet test clean tidy

BIN_DIR := ./bin
BIN := $(BIN_DIR)/deal-onboarding
ADMIN_BIN := $(BIN_DIR)/deal-onboarding-admin

dev:
	@echo "Starting Go API (port 8080) and Vite dev server (port 5173)..."
	@trap 'kill 0' INT; \
	  (cd frontend && npm run dev) & \
	  (go run ./cmd/server) & \
	  wait

server:
	go run ./cmd/server

frontend:
	cd frontend && npm run dev

build: build-go build-fe

build-go:
	mkdir -p $(BIN_DIR)
	go build -o $(BIN) ./cmd/server
	go build -o $(ADMIN_BIN) ./cmd/deal-onboarding-admin

build-fe:
	cd frontend && npm run build

fmt:
	gofmt -w .

vet:
	go vet ./...

test:
	go test ./...
	cd frontend && npm test

tidy:
	go mod tidy

clean:
	rm -rf $(BIN_DIR) frontend/dist
