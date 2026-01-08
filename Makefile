# Load .env if present (non-secret config only)
ifneq (,$(wildcard .env))
include .env
export
endif

IMAGE := claude-code-docker
CONTAINER := claude-term

PROJECT_ID ?=
REGION ?= global

SA_PATH ?= $(HOME)/.config/claude-vertex/sa.json

# Persistent workspace (sibling of this repo)
WORKSPACE_DIR ?= $(abspath $(PWD)/../claude-workspace)

# Persistent Claude config (inside this repo)
CLAUDE_CONFIG_DIR ?= $(abspath $(PWD)/claude-config)

.PHONY: build claude check-sa ensure-dirs usage usage-live

build:
	docker build -t $(IMAGE) .

ensure-dirs:
	@mkdir -p "$(WORKSPACE_DIR)" "$(CLAUDE_CONFIG_DIR)"
	@echo "📁 Workspace dir: $(WORKSPACE_DIR)"
	@echo "🔧 Claude config dir: $(CLAUDE_CONFIG_DIR)"

check-sa:
	@test -f "$(SA_PATH)" || (echo "❌ Service account not found at $(SA_PATH)" && exit 1)
	@test -n "$(PROJECT_ID)" || (echo "❌ PROJECT_ID not set (create .env with PROJECT_ID=...)" && exit 1)

claude: ensure-dirs check-sa
	docker run --rm -it \
	  --name $(CONTAINER) \
	  --read-only \
	  --cap-drop=ALL \
	  --security-opt no-new-privileges:true \
	  --pids-limit=256 \
	  --memory=2g \
	  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=256m \
	  -e HOME=/claude-home \
	  -v "$(WORKSPACE_DIR):/workspace:rw" \
	  -v "$(PWD):/workspace-ro:ro" \
	  -v "$(CLAUDE_CONFIG_DIR):/claude-home:rw" \
	  -v "$(SA_PATH):/secrets/sa.json:ro" \
	  -e GOOGLE_APPLICATION_CREDENTIALS=/secrets/sa.json \
	  -e CLAUDE_CODE_USE_VERTEX=1 \
	  -e CLOUD_ML_REGION=$(REGION) \
	  -e ANTHROPIC_VERTEX_PROJECT_ID=$(PROJECT_ID) \
	  $(IMAGE)

usage: ensure-dirs
	CLAUDE_CONFIG_DIR="$(CLAUDE_CONFIG_DIR)/.claude" \
	npm run --silent ccusage --compact

usage-live: ensure-dirs
	@while true; do \
		clear; \
		date; \
		echo; \
		CLAUDE_CONFIG_DIR="$(CLAUDE_CONFIG_DIR)/.claude" \
		npm run --silent ccusage --compact; \
		echo; \
		sleep 5; \
	done