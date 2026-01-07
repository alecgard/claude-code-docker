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

.PHONY: build claude check-sa ensure-workspace

build:
	docker build -t $(IMAGE) .

ensure-workspace:
	@mkdir -p "$(WORKSPACE_DIR)"
	@echo "📁 Workspace dir: $(WORKSPACE_DIR)"

check-sa:
	@test -f "$(SA_PATH)" || (echo "❌ Service account not found at $(SA_PATH)" && exit 1)
	@test -n "$(PROJECT_ID)" || (echo "❌ PROJECT_ID not set (create .env with PROJECT_ID=...)" && exit 1)

claude: ensure-workspace check-sa
	docker run --rm -it \
	  --name $(CONTAINER) \
	  --read-only \
	  --cap-drop=ALL \
	  --security-opt no-new-privileges:true \
	  --pids-limit=256 \
	  --memory=2g \
	  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=256m \
	  --tmpfs /claude-home:rw,nosuid,nodev,size=1g,uid=1000,gid=1000 \
	  -e HOME=/claude-home \
	  -v "$(WORKSPACE_DIR):/workspace:rw" \
	  -v "$(PWD):/workspace-ro:ro" \
	  -v "$(SA_PATH):/secrets/sa.json:ro" \
	  -e GOOGLE_APPLICATION_CREDENTIALS=/secrets/sa.json \
	  -e CLAUDE_CODE_USE_VERTEX=1 \
	  -e CLOUD_ML_REGION=$(REGION) \
	  -e ANTHROPIC_VERTEX_PROJECT_ID=$(PROJECT_ID) \
	  $(IMAGE)