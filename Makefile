SHELL := /bin/bash
.PHONY: help dev dev-api dev-web web build test test-go lint migrate schema sqlc check-schema install uninstall start stop restart status logs clean

SERVICE_NAME=weekly-reporter
SERVICE_FILE=$(SERVICE_NAME).service
SYSTEMD_USER_DIR=$(HOME)/.config/systemd/user
DEFAULT_PORT=6868
DEFAULT_HOSTNAME=0.0.0.0

MODULE=github.com/dev-zapi/weekly-reporter
BIN=bin/wr
COMMIT_HASH?=$(shell git rev-parse --short HEAD 2>/dev/null || echo dev)
BUILD_TIME?=$(shell date -u +%Y-%m-%dT%H:%M:%SZ)
# -X 只能写包级 string；与 internal/buildinfo 的两个变量一一对应。
LDFLAGS=-X $(MODULE)/internal/buildinfo.CommitHash=$(COMMIT_HASH) -X $(MODULE)/internal/buildinfo.BuildTime=$(BUILD_TIME)

help:
	@echo "Weekly Reporter - Makefile Commands"
	@echo ""
	@echo "Usage:"
	@echo "  make <command>"
	@echo ""
	@echo "Commands:"
	@echo "  dev          Start dev API (go run) + dev web (vite)"
	@echo "  dev-api      Start the Go API server (go run ./cmd/wr serve)"
	@echo "  dev-web      Start the vite dev server (proxy /api -> Go)"
	@echo "  build        Build the Go single binary $(BIN) (vite -> embed -> go build)"
	@echo "  install      Install systemd user service (default: port=$(DEFAULT_PORT), host=$(DEFAULT_HOSTNAME))"
	@echo "  uninstall    Uninstall systemd user service"
	@echo "  start        Start systemd user service"
	@echo "  stop         Stop systemd user service"
	@echo "  restart      Restart systemd user service"
	@echo "  status       Show service status"
	@echo "  logs         Show service logs"
	@echo "  test         Run vitest (client side)"
	@echo "  test-go      Run Go tests"
	@echo "  lint         Run linter"
	@echo "  migrate      Generate database migration (drizzle-kit)"
	@echo "  schema       Regenerate internal/db/schema.sql from drizzle/ (never hand-edited)"
	@echo "  sqlc         Regenerate internal/db from sqlc.yaml"
	@echo "  check-schema Fail if internal/db/schema.sql is out of date"
	@echo "  clean        Clean build artifacts"
	@echo "  help         Show this help message"
	@echo ""
	@echo "Configuration (.env.production):"
	@echo "  PORT=6868          - Server port"
	@echo "  HOSTNAME=0.0.0.0   - Bind host (0.0.0.0 for LAN, localhost for local only)"

# cutover 后的 dev 终态（蓝图 §7 后即时项）：Go API + vite dev（proxy /api → Go）。
dev: dev-api dev-web

dev-api:
	XDG_DATA_HOME?=$${XDG_DATA_HOME:-$(HOME)/.local/share}
	XDG_CONFIG_HOME?=$${XDG_CONFIG_HOME:-$(HOME)/.config}
	go run ./cmd/wr serve

dev-web:
	pnpm -C web dev

# 唯一构建入口（ADR-0025 / ADR-0029）：前端产物 -> go:embed -> go build。
# B7 起 web 目标真的跑 vite build（web/ 是 pnpm workspace 包，产物落 web/dist）。
# dist 里的 .gitkeep 保证 `//go:embed all:dist` 在 fresh clone + `go build` 时也能编译。
web:
	pnpm -C web build

build: web
	@mkdir -p bin
	CGO_ENABLED=0 go build -trimpath -o $(BIN) \
		-ldflags "$(LDFLAGS)" ./cmd/wr
	@echo "built $(BIN) ($(COMMIT_HASH) $(BUILD_TIME))"

install: build
	@echo "Installing $(SERVICE_NAME) service..."
	mkdir -p $(SYSTEMD_USER_DIR)
	cp $(SERVICE_FILE) $(SYSTEMD_USER_DIR)/$(SERVICE_FILE)
	sed -i "s|%h|$(HOME)|g" $(SYSTEMD_USER_DIR)/$(SERVICE_FILE)
	if [ -f .env.production ]; then \
		PORT=$$(grep -E '^PORT=' .env.production | cut -d'=' -f2 || echo "$(DEFAULT_PORT)"); \
		HOSTNAME=$$(grep -E '^HOSTNAME=' .env.production | cut -d'=' -f2 || echo "$(DEFAULT_HOSTNAME)"); \
		sed -i "s|Environment=PORT=$(DEFAULT_PORT)|Environment=PORT=$$PORT|g" $(SYSTEMD_USER_DIR)/$(SERVICE_FILE); \
		sed -i "s|Environment=HOSTNAME=$(DEFAULT_HOSTNAME)|Environment=HOSTNAME=$$HOSTNAME|g" $(SYSTEMD_USER_DIR)/$(SERVICE_FILE); \
	fi
	systemctl --user daemon-reload
	systemctl --user enable $(SERVICE_NAME).service
	@echo "Service installed and enabled. Run 'make start' to start."

uninstall:
	@echo "Uninstalling $(SERVICE_NAME) service..."
	systemctl --user stop $(SERVICE_NAME).service || true
	systemctl --user disable $(SERVICE_NAME).service || true
	rm -f $(SYSTEMD_USER_DIR)/$(SERVICE_FILE)
	systemctl --user daemon-reload
	@echo "Service uninstalled."

start:
	systemctl --user start $(SERVICE_NAME).service

stop:
	systemctl --user stop $(SERVICE_NAME).service

restart:
	systemctl --user restart $(SERVICE_NAME).service

status:
	systemctl --user status $(SERVICE_NAME).service

logs:
	journalctl --user -u $(SERVICE_NAME).service -f

test:
	source ~/.nvm/nvm.sh && npm run test

test-go:
	go test ./...

lint:
	source ~/.nvm/nvm.sh && npm run lint

migrate:
	source ~/.nvm/nvm.sh && npx drizzle-kit generate

# schema.sql 是 drizzle 语料的只读合并视图：只由脚本产出，不手改（ADR-0025）。
schema:
	go run ./cmd/schema-dump -root . -out internal/db/schema.sql

sqlc: schema
	go tool sqlc generate

# 漂移防护：CI/本地都能发现「语料变了但 schema.sql 没重生成」。
check-schema: schema
	git diff --exit-code -- internal/db/schema.sql

clean:
	rm -rf .next node_modules/.cache bin
	rm -rf data/*.db
