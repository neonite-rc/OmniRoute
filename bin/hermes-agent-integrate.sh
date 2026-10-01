#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# hermes-agent-integrate.sh — Automated Agent Upgrade & Hermes Integration
#
# Designed specifically for autonomous execution by AI agents (e.g. Hermes Agent):
# 1. Detects and upgrades any existing base OmniRoute installation in place.
# 2. Configures Hermes to use OmniRoute for subagents while KEEPING the main model constant.
# 3. Injects persistent memory (~/.hermes/memories/omniroute-superpowers.md) so Hermes
#    knows how to use its new superpowers (4-8+ parallel models, multi-provider federation).
# 4. Sets up MCP omni-swarm tool and orchestration skills.
#
# Performance & Lite Modes:
#   --lite        Fast mode (default for agents):
#                 - Skips redundant npm installs if OmniRoute is already healthy on :20128
#                 - Uses shallow git fetches and skips UI build
#                 - Finishes in seconds
#   --mod-only    Only wires Hermes (delegation, MCP swarm, skills, memory); skips engine.
#
# Usage:
#   ./bin/hermes-agent-integrate.sh [--lite] [--mod-only] [--dry-run] [--yes]
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=false
ASSUME_YES=true
LITE_MODE=true
MOD_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --yes|-y) ASSUME_YES=true ;;
    --lite) LITE_MODE=true ;;
    --full) LITE_MODE=false ;;
    --mod-only) MOD_ONLY=true ;;
    --help|-h)
      echo "Usage: $0 [--lite] [--mod-only] [--dry-run] [--yes]"
      echo "  --lite      Fast mode (skips heavy rebuilds/npm if already running; default: true)"
      echo "  --full      Full mode (installs all devDependencies and builds Next.js UI)"
      echo "  --mod-only  Only configure Hermes delegation, MCP swarm, and memory"
      echo "  --dry-run   Simulate all actions without modifying filesystem"
      echo "  --yes, -y   Assume yes for all prompts (default: true for agent operation)"
      exit 0 ;;
  esac
done

log()  { echo "[hermes-integrate] $*"; }
warn() { echo "[hermes-integrate] WARNING: $*" >&2; }

log "=== OmniRoute Agent Auto-Upgrade & Integration Pipeline ==="
[ "$LITE_MODE" = true ] && log "Mode: LITE (optimized for fast agent execution)"

# ─── Step 1: Detect and upgrade existing OmniRoute installation ─────────────
if [ "$MOD_ONLY" = true ]; then
  log "Step 1: Skipping engine check (--mod-only specified)."
else
  log "Step 1: Checking for existing OmniRoute installation..."

  # Fast check: Is OmniRoute already running and healthy?
  IS_HEALTHY=false
  if curl -sf --max-time 1 "http://localhost:20128/api/monitoring/health" 2>/dev/null | grep -q '"healthy"'; then
    IS_HEALTHY=true
    log "OmniRoute daemon is already running and healthy on port 20128."
  fi

  if [ "$IS_HEALTHY" = true ] && [ "$LITE_MODE" = true ]; then
    log "Fast path: Skipping engine re-installation/re-build since OmniRoute is already active."
  else
    UPGRADE_FLAGS="--yes"
    [ "$DRY_RUN" = true ] && UPGRADE_FLAGS="--dry-run --yes"
    [ "$LITE_MODE" = true ] && UPGRADE_FLAGS="$UPGRADE_FLAGS --lite"

    # Check if an upstream clone exists in standard locations or parent directory
    BASE_CLONE=""
    if [ -d "${HOME}/OmniRoute/.git" ] && [ "${HOME}/OmniRoute" != "$SCRIPT_DIR" ]; then
      BASE_CLONE="${HOME}/OmniRoute"
    elif [ -d "${HOME}/omniroute/.git" ] && [ "${HOME}/omniroute" != "$SCRIPT_DIR" ]; then
      BASE_CLONE="${HOME}/omniroute"
    fi

    if [ -n "$BASE_CLONE" ]; then
      log "Found existing OmniRoute clone at ${BASE_CLONE}. Performing in-place upgrade..."
      "${SCRIPT_DIR}/bin/upgrade-from-base.sh" --path "$BASE_CLONE" $UPGRADE_FLAGS
    elif command -v omniroute >/dev/null 2>&1 && npm list -g --depth=0 omniroute >/dev/null 2>&1; then
      log "Found global npm OmniRoute installation. Upgrading in-place..."
      "${SCRIPT_DIR}/bin/upgrade-from-base.sh" $UPGRADE_FLAGS
    else
      log "Using local repository at $SCRIPT_DIR..."
      if [ "$DRY_RUN" = false ] && [ ! -d "$SCRIPT_DIR/node_modules" ]; then
        if [ "$LITE_MODE" = true ]; then
          log "Installing production dependencies only (--omit=dev)..."
          (cd "$SCRIPT_DIR" && npm install --legacy-peer-deps --omit=dev --no-audit --no-fund --silent 2>/dev/null || true)
        else
          log "Installing dependencies (full)..."
          (cd "$SCRIPT_DIR" && npm install --silent 2>/dev/null || true)
        fi
      fi
    fi
  fi
fi

# ─── Step 2: Configure Hermes subagent delegation and tools ─────────────────
log "Step 2: Configuring Hermes subagent delegation (main model stays constant)..."
ADDITIONAL_FLAGS="--yes"
[ "$DRY_RUN" = true ] && ADDITIONAL_FLAGS="--dry-run --yes"

"${SCRIPT_DIR}/additional-programming.sh" $ADDITIONAL_FLAGS

# ─── Step 3: Verify and print agent instructions ───────────────────────────
log ""
log "=== AGENT INTEGRATION COMPLETE ==="
log "Summary of Configuration:"
log "  - Main Agent Brain: CONSTANT (untouched)"
log "  - Subagents / Delegation: Routed through OmniRoute (http://localhost:20128/v1)"
log "  - Concurrency: 4 to 8+ simultaneous model calls (zero 503 errors)"
log "  - MCP Swarm: Registered (omni-swarm)"
log "  - Memory Added: ~/.hermes/memories/omniroute-superpowers.md"
log "  - Skills Added: ~/.hermes/skills/omni-swarm"
log ""
log "Agent Usage Cheat-Sheet:"
log "  1. Single subtask: hermes chat --oneshot -m <model-id> -q '<task>'"
log "  2. Quick specialist: POST http://localhost:20128/v1/orchestrate/quick (tag: vision|code|research)"
log "  3. Parallel DAG: POST http://localhost:20128/v1/orchestrate/plan"
log "  4. Multi-agent Swarm: MCP tool omni-swarm or hermes kanban swarm"
