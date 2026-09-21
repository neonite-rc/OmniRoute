#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# additional-programming.sh — append OmniRoute fork configs to Hermes
#
# This does NOT replace your existing Hermes setup. It APPENDS fork-specific
# additions (subagent delegation, presets, MCP tool, SOUL policy, memory)
# to whatever you already have. A timestamped backup is created before any change.
#
# GOLDEN ARCHITECTURAL RULE:
#   The main Hermes agent model remains CONSTANT. OmniRoute access is reserved
#   strictly for subagents, delegation, and parallel worker swarms across providers.
#
# Safe to run multiple times — skips anything already present.
#
# Usage:
#   ./additional-programming.sh              # interactive
#   ./additional-programming.sh --yes        # non-interactive / agent-driven
#   ./additional-programming.sh --dry-run    # preview only
#   ./additional-programming.sh --rollback   # restore last backup
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERMES_DIR="${HOME}/.hermes"
BACKUP_DIR="${HERMES_DIR}/backup-$(date +%Y%m%d_%H%M%S)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OMNIROUTE_KEY="${OMNIROUTE_KEY:-}"
DRY_RUN=false
ROLLBACK=false
ASSUME_YES=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --rollback) ROLLBACK=true ;;
    --yes|-y) ASSUME_YES=true ;;
    --help|-h)
      echo "Usage: $0 [--dry-run] [--rollback] [--yes]"
      echo "  --dry-run   Show what would change without modifying anything"
      echo "  --rollback  Restore the most recent backup"
      echo "  --yes, -y   Run non-interactively without prompting (for AI agents)"
      exit 0 ;;
  esac
done

log()  { echo "[additional] $*"; }
warn() { echo "[additional] WARNING: $*" >&2; }

# ─── Rollback ───────────────────────────────────────────────────────────────
if [ "$ROLLBACK" = true ]; then
  LATEST=$(ls -dt "${HERMES_DIR}"/backup-* 2>/dev/null | head -1)
  [ -z "$LATEST" ] && { warn "No backup found"; exit 1; }
  log "Restoring from ${LATEST} ..."
  for f in config.yaml SOUL.md .env; do
    [ -f "${LATEST}/${f}" ] && cp "${LATEST}/${f}" "${HERMES_DIR}/${f}"
  done
  for d in profiles mcp-servers skills memories; do
    [ -d "${LATEST}/${d}" ] && cp -r "${LATEST}/${d}" "${HERMES_DIR}/${d}"
  done
  log "Rollback complete. Restart your shell: exec bash"
  exit 0
fi

# ─── Backup (always, before any change) ────────────────────────────────────
if [ "$DRY_RUN" = false ]; then
  mkdir -p "$BACKUP_DIR"
  for f in config.yaml SOUL.md .env; do
    [ -f "${HERMES_DIR}/${f}" ] && cp "${HERMES_DIR}/${f}" "${BACKUP_DIR}/${f}" 2>/dev/null
  done
  for d in profiles mcp-servers skills memories; do
    [ -d "${HERMES_DIR}/${d}" ] && cp -r "${HERMES_DIR}/${d}" "${BACKUP_DIR}/${d}" 2>/dev/null
  done
  log "Backup saved to ${BACKUP_DIR}"
fi

# ─── 1. SOUL.md — append execution policy ──────────────────────────────────
SOUL_ADDITION='
## EXECUTION POLICY — OmniRoute Subagent Federation (appended)

### 1. Main Agent Constancy (Golden Rule)
You are the primary Hermes agent. Your default conversational model is CONSTANT and must NEVER be switched or pointed to OmniRoute auto-routing for direct dialog. You maintain persona continuity, conversational history, and stable reasoning.

### 2. OmniRoute Reserved Exclusively for Subagents & Swarms
OmniRoute (http://localhost:20128/v1) is your high-throughput subagent and model federation cluster. Use it exclusively for:
- Spawning subagents (`hermes chat --oneshot -m <model>`, `hermes kanban swarm`, MCP `omni-swarm`)
- Specialist task delegations (`POST /v1/orchestrate/quick` with tags: `vision`, `code`, `research`, `image_gen`, `reasoning`)
- Parallel multi-task DAG plans (`POST /v1/orchestrate/plan`)
- Expert panels (`moe chat --oneshot -q "<task>"`)

### 3. Delegation Tiers
- Level 0 (Self-Execution Default): Answer single-step questions, code fixes, and conversational queries directly using your own weights.
- Level 1 (Specialist Model): Tasks requiring non-text sensing (vision, OCR) or specialized reasoning — route to a single specialist via `/v1/orchestrate/quick` or `hermes chat --oneshot`.
- Level 2 (Parallel Subagent Swarm): Multi-part or bulk work — spawn independent subagents simultaneously via MCP `omni-swarm` or `/v1/orchestrate/plan`. The OmniRoute fork runs 4–8+ concurrent models without 503 errors.
- Level 3 (MoE Panel): "moe mode" / "expert panel" or high-stakes multi-expert deliberation → `moe chat --oneshot -q`.

### 4. Multimodal Input
When the user provides an image/audio/video file:
1. Detect media type and delegate extraction to a vision specialist via `/v1/orchestrate/quick` (`tag: "vision"`).
2. Synthesize the extracted understanding into your reply naturally — never show raw data URIs or base64.

### 5. Swarm & Provider Diversity
- Subagents should be spread across diverse providers (Kiro, NVIDIA NIM, OpenAI, Anthropic, Gemini, DeepSeek).
- When submitting orchestrator jobs, always pass `caller_model: "<your-model>"` so OmniRoute'\''s bias guard avoids routing subagents back to your own model family on ties.
'

if [ "$DRY_RUN" = true ]; then
  if grep -q "OmniRoute Subagent Federation" "${HERMES_DIR}/SOUL.md" 2>/dev/null; then
    log "SOUL.md: OmniRoute policy already present — would skip"
  else
    log "SOUL.md: would append execution policy"
  fi
else
  mkdir -p "${HERMES_DIR}"
  if grep -q "OmniRoute Subagent Federation" "${HERMES_DIR}/SOUL.md" 2>/dev/null; then
    log "SOUL.md: OmniRoute policy already present — skipping"
  else
    echo "$SOUL_ADDITION" >> "${HERMES_DIR}/SOUL.md"
    log "SOUL.md: appended execution policy"
  fi
fi

# ─── 2. .env — add API key if missing ──────────────────────────────────────
# Helper to look up an existing key from OmniRoute SQLite database if available
lookup_omniroute_db_key() {
  python3 -c "
import sqlite3, os
paths = [
    os.path.expanduser('~/.omniroute/omniroute.db'),
    os.path.join(os.environ.get('DATA_DIR', ''), 'omniroute.db'),
    os.path.join(os.environ.get('DATA_DIR', ''), 'data.db'),
]
for p in paths:
    if os.path.isfile(p):
        try:
            conn = sqlite3.connect(p)
            row = conn.cursor().execute('SELECT key FROM api_keys WHERE is_active=1 LIMIT 1').fetchone()
            if row and row[0]:
                print(row[0])
                break
        except Exception:
            pass
" 2>/dev/null || true
}

if [ -z "$OMNIROUTE_KEY" ]; then
  if [ -f "${HERMES_DIR}/.env" ] && grep -q "HERMES_CUSTOM_LOCALHOST_20128_API_KEY" "${HERMES_DIR}/.env" 2>/dev/null; then
    log ".env: API key already present — skipping"
  elif [ "$DRY_RUN" = false ]; then
    DB_KEY="$(lookup_omniroute_db_key)"
    if [ -n "$DB_KEY" ]; then
      OMNIROUTE_KEY="$DB_KEY"
      echo "HERMES_CUSTOM_LOCALHOST_20128_API_KEY=${OMNIROUTE_KEY}" >> "${HERMES_DIR}/.env"
      log ".env: discovered and linked active OmniRoute API key from database"
    elif [ "$ASSUME_YES" = true ] || [ ! -t 0 ]; then
      OMNIROUTE_KEY="omni-hermes-subagent-key-$(head -c 8 /dev/urandom | xxd -p 2>/dev/null || echo 'auto')"
      echo "HERMES_CUSTOM_LOCALHOST_20128_API_KEY=${OMNIROUTE_KEY}" >> "${HERMES_DIR}/.env"
      log ".env: generated local API key placeholder for subagent access (${OMNIROUTE_KEY})"
    else
      read -rp "Enter OmniRoute API key (Dashboard → Keys): " OMNIROUTE_KEY
      if [ -n "$OMNIROUTE_KEY" ]; then
        echo "HERMES_CUSTOM_LOCALHOST_20128_API_KEY=${OMNIROUTE_KEY}" >> "${HERMES_DIR}/.env"
        log ".env: added API key"
      fi
    fi
  else
    log ".env: would add API key"
  fi
else
  if grep -q "HERMES_CUSTOM_LOCALHOST_20128_API_KEY" "${HERMES_DIR}/.env" 2>/dev/null; then
    log ".env: API key already present — skipping"
  elif [ "$DRY_RUN" = false ]; then
    echo "HERMES_CUSTOM_LOCALHOST_20128_API_KEY=${OMNIROUTE_KEY}" >> "${HERMES_DIR}/.env"
    log ".env: added API key"
  fi
fi

# ─── 3. config.yaml — merge provider + presets + delegation (append, never overwrite) ────
if [ "$DRY_RUN" = true ]; then
  log "config.yaml: would merge Omnirouter provider + delegation + MoA presets (main model preserved)"
else
  python3 << 'PYEOF'
import yaml, os

hermes_dir = os.path.expanduser("~/.hermes")
config_path = os.path.join(hermes_dir, "config.yaml")

cfg = {}
if os.path.isfile(config_path):
    with open(config_path) as f:
        cfg = yaml.safe_load(f) or {}

changed = False

# --- Provider (append, never replace) ---
providers = cfg.get("providers", [])
omnirouter_entry = next((p for p in providers if p.get("name") == "Omnirouter"), None)
if not omnirouter_entry:
    omnirouter_entry = {
        "name": "Omnirouter",
        "base_url": "http://localhost:20128/v1",
        "key_env": "HERMES_CUSTOM_LOCALHOST_20128_API_KEY",
        "models": {}
    }
    providers.append(omnirouter_entry)
    cfg["providers"] = providers
    changed = True
    print("[additional] Added Omnirouter provider (without default model override)")
else:
    # Ensure provider doesn't advertise a global default model that clobbers the main agent
    if "model" in omnirouter_entry:
        del omnirouter_entry["model"]
        changed = True
        print("[additional] Cleaned up provider-level model override to ensure main agent remains constant")

# --- Delegation: reserve OmniRoute specifically for subagents ---
delegation = cfg.get("delegation", {})
if not delegation or delegation.get("base_url") != "http://localhost:20128/v1":
    cfg["delegation"] = {
        "provider": "Omnirouter",
        "base_url": "http://localhost:20128/v1",
        "key_env": "HERMES_CUSTOM_LOCALHOST_20128_API_KEY"
    }
    changed = True
    print("[additional] Configured delegation: OmniRoute reserved exclusively for subagents")

# --- Guard Main Agent Model: Ensure main model does NOT point to OmniRoute auto ---
main_model = cfg.get("model")
if main_model == "auto/best-coding" or main_model == "auto":
    print("[additional] WARNING: Main Hermes model was pointing to OmniRoute auto.")
    print("[additional] Reverting main model so primary agent brain remains constant.")
    del cfg["model"]
    changed = True
elif isinstance(main_model, dict) and main_model.get("provider") in ("Omnirouter", "omniroute", "custom:omnirouter") and main_model.get("default") in ("auto", "auto/best-coding"):
    print("[additional] WARNING: Main Hermes model was pointing to Omnirouter default auto.")
    print("[additional] Removing default model pointer; main agent should use its primary fixed brain.")
    del cfg["model"]
    changed = True

# --- MoA presets (append, never replace) ---
moa = cfg.setdefault("moa", {})
presets = moa.setdefault("presets", {})

if "omniroute-duo" not in presets:
    presets["omniroute-duo"] = {
        "enabled": True,
        "reference_models": [
            {"provider": "custom:omnirouter", "model": "kiro/claude-sonnet-4.5"},
            {"provider": "custom:omnirouter", "model": "kr/qwen3-coder-next"},
        ],
        "aggregator": {"provider": "custom:omnirouter", "model": "kr/qwen3-coder-next"},
    }
    changed = True
    print("[additional] Added omniroute-duo preset")
else:
    print("[additional] omniroute-duo exists — skipping")

if "omniroute-moe" not in presets:
    presets["omniroute-moe"] = {
        "enabled": True,
        "reference_models": [
            {"provider": "custom:omnirouter", "model": "kiro/claude-sonnet-4.5"},
            {"provider": "custom:omnirouter", "model": "kiro/claude-haiku-4.5"},
            {"provider": "custom:omnirouter", "model": "kiro/deepseek-3.2"},
            {"provider": "custom:omnirouter", "model": "kr/qwen3-coder-next"},
            {"provider": "custom:omnirouter", "model": "nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"},
        ],
        "aggregator": {"provider": "custom:omnirouter", "model": "kr/qwen3-coder-next"},
    }
    changed = True
    print("[additional] Added omniroute-moe preset")
else:
    print("[additional] omniroute-moe exists — skipping")

moa.setdefault("default_preset", "omniroute-duo")

if changed:
    with open(config_path, "w") as f:
        yaml.dump(cfg, f, default_flow_style=False, sort_keys=False, allow_unicode=True)
    print("[additional] config.yaml updated")
else:
    print("[additional] config.yaml unchanged")
PYEOF
fi

# ─── 4. MCP server — copy omni-swarm (append, never replace) ───────────────
MCP_DIR="${HERMES_DIR}/mcp-servers/omni-swarm"
if [ -f "${MCP_DIR}/server.py" ]; then
  log "MCP omni-swarm: already present — skipping"
else
  if [ "$DRY_RUN" = true ]; then
    log "MCP omni-swarm: would install"
  else
    mkdir -p "$MCP_DIR"
    cp "${SCRIPT_DIR}/hermes-config/mcp-servers/omni-swarm/server.py" "${MCP_DIR}/server.py"
    log "MCP omni-swarm: installed"
    # Register if not already
    if ! hermes mcp list 2>/dev/null | grep -q "omni-swarm"; then
      VENV_PY="${HERMES_DIR}/hermes-agent/venv/bin/python"
      [ ! -f "$VENV_PY" ] && VENV_PY="$(which python3)"
      echo Y | hermes mcp add omni-swarm \
        --command "$VENV_PY" \
        --args "${MCP_DIR}/server.py" 2>/dev/null || true
      log "MCP omni-swarm: registered"
    fi
  fi
fi

# ─── 5. Skill — copy omni-swarm skill (append) ─────────────────────────────
SKILL_DIR="${HERMES_DIR}/skills/omni-swarm"
if [ -d "$SKILL_DIR" ]; then
  log "Skill omni-swarm: already present — skipping"
else
  if [ "$DRY_RUN" = true ]; then
    log "Skill omni-swarm: would install"
  else
    mkdir -p "$SKILL_DIR"
    cp "${SCRIPT_DIR}/hermes-config/skills/omni-swarm/SKILL.md" "${SKILL_DIR}/SKILL.md"
    cp "${SCRIPT_DIR}/hermes-config/skills/omni-swarm/DESCRIPTION.md" "${SKILL_DIR}/DESCRIPTION.md"
    log "Skill omni-swarm: installed"
  fi
fi

# ─── 6. MoE profile (append) ───────────────────────────────────────────────
MOE_PROFILE="${HERMES_DIR}/profiles/moe"
if [ -f "$MOE_PROFILE" ]; then
  log "Profile moe: already present — skipping"
else
  if [ "$DRY_RUN" = true ]; then
    log "Profile moe: would create"
  else
    mkdir -p "${HERMES_DIR}/profiles"
    echo "model: moa:omniroute-moe" > "$MOE_PROFILE"
    log "Profile moe: created"
  fi
fi

# ─── 7. Persistent Memory — add superpowers memory for Hermes ─────────────
MEM_DIR="${HERMES_DIR}/memories"
MEM_FILE="${MEM_DIR}/omniroute-superpowers.md"
if [ "$DRY_RUN" = true ]; then
  log "Memory: would save omniroute-superpowers.md to ${MEM_DIR}"
else
  mkdir -p "$MEM_DIR"
  cat > "$MEM_FILE" << 'MEMEOF'
# Memory: OmniRoute Subagent Mesh & Parallel Powers

## Architectural Role
- **Main Agent (Hermes)**: Stays on its constant primary model. Retains user context, executive planning, and response synthesis.
- **Subagent Federation (OmniRoute)**: Accessible at `http://localhost:20128/v1`. Reserved exclusively for spawning subagents, parallel swarms, and specialist delegations across diverse providers (Kiro, NVIDIA NIM, OpenAI, Anthropic, Gemini, DeepSeek).

## Powers & Capabilities
1. **High Concurrency**: The OmniRoute fork supports 4 to 8+ concurrent model requests simultaneously without 503 errors (unlike upstream OmniRoute).
2. **Subagent Delegation Endpoints**:
   - `POST /v1/orchestrate/quick`: Fast synchronous task execution with specialized tags (`vision`, `code`, `research`, `image_gen`, `reasoning`).
   - `POST /v1/orchestrate/plan`: Parallel/swarm DAG task execution with dependencies.
   - `GET /v1/orchestrate/jobs/{id}/wait-first`: Fast per-completion wake-up polling.
   - `POST /v1/orchestrate/spawn`: Hierarchical subagent job creation.
   - `POST /v1/route`: Query ranked model candidates by task capability and benchmark scores.
3. **MCP Tool `omni-swarm`**:
   - `swarm(goal, subtasks)`: Fans out up to 8 headless worker agents across diverse providers and logs reliability into `~/.hermes/omni-swarm/ledger.json`.
4. **Swarm Collaboration & Quality Loop**:
   - Shared `blackboard` for inter-agent context.
   - Automated `judge` verification loop up to `max_rounds`.
5. **Bias Guard**:
   - Pass `"caller_model": "<your-model>"` in orchestrator calls so OmniRoute avoids picking your own model family for subagents on ties.
MEMEOF
  log "Memory: saved omniroute-superpowers.md"
fi

# ─── 8. Bashrc wrapper (append, never duplicate) ───────────────────────────
if grep -q "OmniRoute auto-boot" "${HOME}/.bashrc" 2>/dev/null; then
  log "Bashrc wrapper: already present — skipping"
else
  if [ "$DRY_RUN" = true ]; then
    log "Bashrc wrapper: would append"
  else
    cat >> "${HOME}/.bashrc" << BASHRC

# ── OmniRoute auto-boot for Hermes ──
OMNIROUTE_DIR="${SCRIPT_DIR}"
OMNIROUTE_HEALTH_URL="http://localhost:20128/api/monitoring/health"
hermes() {
  local _need_server=1 _a
  for _a in "\$@"; do
    case "\$_a" in -h|--help|-V|--version) _need_server=0; break ;; esac
  done
  if [ "\$_need_server" = "1" ]; then
    case "\${1:-}" in
      config|model|moa|hooks|doctor|status|auth|login|logout|completion|
      skin|update|migrate|backup|logs|dashboard|pairing|prompt-size|
      version|worktree) _need_server=0 ;;
    esac
  fi
  if [ "\$_need_server" = "1" ]; then
    if ! curl -sf --max-time 2 "\$OMNIROUTE_HEALTH_URL" 2>/dev/null | grep -q '"healthy"'; then
      if [ -d "\$OMNIROUTE_DIR/node_modules" ]; then
        echo "[hermes] Starting OmniRoute ..." >&2
        (cd "\$OMNIROUTE_DIR" && setsid npm run dev >>"\$HOME/.omniroute-dev.log" 2>&1 < /dev/null &)
        for _i in \$(seq 1 18); do
          sleep 5
          if curl -sf --max-time 2 "\$OMNIROUTE_HEALTH_URL" 2>/dev/null | grep -q '"healthy"'; then
            echo "[hermes] OmniRoute ready." >&2; break
          fi
        done
      fi
    fi
  fi
  command hermes "\$@"
}
BASHRC
    log "Bashrc wrapper: appended"
  fi
fi

# ─── Summary ────────────────────────────────────────────────────────────────
if [ "$DRY_RUN" = true ]; then
  log ""
  log "=== DRY RUN COMPLETE — no changes made ==="
  log "Run without --dry-run to apply"
else
  log ""
  log "=== DONE ==="
  log "Backup: ${BACKUP_DIR}"
  log "Rollback: $0 --rollback"
  log "Main model: preserved (constant brain)"
  log "Subagent delegation: configured -> http://localhost:20128/v1"
  log "Memory added: ${MEM_FILE}"
  log "Reload: exec bash"
  log "Test subagent: hermes chat --oneshot -m moa:omniroute-duo -q 'Say OK'"
fi
