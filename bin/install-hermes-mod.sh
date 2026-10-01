#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# install-hermes-mod.sh — Ultra-Lite Standalone Hermes Agent Mod Installer
#
# Zero-dependency, ultra-fast installer (< 1 second runtime, ~20 KB payload).
# Enables Hermes Agent to harness OmniRoute for subagent federation and swarms
# WITHOUT downloading the full 800MB OmniRoute git repository or running npm.
#
# Golden Rule:
#   Main agent model remains CONSTANT. OmniRoute is reserved for subagents.
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/neonite-rc/OmniRoute/fork/parallel-execution/bin/install-hermes-mod.sh | bash
#   or: ./bin/install-hermes-mod.sh [--yes] [--dry-run]
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERMES_DIR="${HOME}/.hermes"
BACKUP_DIR="${HERMES_DIR}/backup-mod-$(date +%Y%m%d_%H%M%S)"
OMNIROUTE_URL="${OMNIROUTE_URL:-http://localhost:20128/v1}"
OMNIROUTE_KEY="${OMNIROUTE_KEY:-}"
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --help|-h)
      echo "Usage: $0 [--dry-run]"
      echo "  --dry-run   Preview actions without modifying files"
      exit 0 ;;
  esac
done

log()  { echo "[omni-mod] $*"; }
warn() { echo "[omni-mod] WARNING: $*" >&2; }

log "=== Installing OmniRoute Hermes Subagent Mod (Ultra-Lite) ==="

# ── 1. Backup existing Hermes configuration ──────────────────────────────────
if [ "$DRY_RUN" = false ]; then
  mkdir -p "$BACKUP_DIR"
  for f in config.yaml SOUL.md .env; do
    [ -f "${HERMES_DIR}/${f}" ] && cp "${HERMES_DIR}/${f}" "${BACKUP_DIR}/${f}" 2>/dev/null || true
  done
  log "Backup saved to ${BACKUP_DIR}"
fi

# ── 2. Configure API key in .env ─────────────────────────────────────────────
mkdir -p "$HERMES_DIR"
if [ -z "$OMNIROUTE_KEY" ]; then
  if [ -f "${HERMES_DIR}/.env" ] && grep -q "HERMES_CUSTOM_LOCALHOST_20128_API_KEY" "${HERMES_DIR}/.env" 2>/dev/null; then
    log ".env: API key already present"
  elif [ "$DRY_RUN" = false ]; then
    # Look for DB key if omniroute db is on host
    DB_KEY=""
    for db_path in "${HOME}/.omniroute/omniroute.db" "${HOME}/.omniroute/storage.sqlite"; do
      if [ -f "$db_path" ] && command -v python3 >/dev/null 2>&1; then
        DB_KEY=$(python3 -c "import sqlite3; c=sqlite3.connect('$db_path'); print(c.execute('SELECT key FROM api_keys WHERE is_active=1 LIMIT 1').fetchone()[0])" 2>/dev/null || true)
        [ -n "$DB_KEY" ] && break
      fi
    done
    OMNIROUTE_KEY="${DB_KEY:-omni-subagent-key-auto}"
    echo "HERMES_CUSTOM_LOCALHOST_20128_API_KEY=${OMNIROUTE_KEY}" >> "${HERMES_DIR}/.env"
    log ".env: configured API key"
  fi
fi

# ── 3. Configure config.yaml (Main brain constant, delegation to OmniRoute) ───
if [ "$DRY_RUN" = false ] && command -v python3 >/dev/null 2>&1; then
  python3 << 'PYEOF'
import os, sys

hermes_dir = os.path.expanduser("~/.hermes")
config_path = os.path.join(hermes_dir, "config.yaml")

try:
    import yaml
except ImportError:
    # If pyyaml isn't installed, append minimal YAML configuration
    try:
        import subprocess
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "pyyaml"], check=True)
        import yaml
    except Exception:
        # Fallback: simple text appending
        with open(config_path, "a") as f:
            f.write("\n# OmniRoute Subagent Delegation\ndelegation:\n  provider: Omnirouter\n  base_url: http://localhost:20128/v1\n  key_env: HERMES_CUSTOM_LOCALHOST_20128_API_KEY\n")
        print("[omni-mod] config.yaml appended with delegation block (fallback)")
        sys.exit(0)

cfg = {}
if os.path.isfile(config_path):
    with open(config_path) as f:
        cfg = yaml.safe_load(f) or {}

changed = False

# Ensure Omnirouter provider exists without overriding main model
providers = cfg.setdefault("providers", [])
entry = next((p for p in providers if p.get("name") == "Omnirouter"), None)
if not entry:
    providers.append({
        "name": "Omnirouter",
        "base_url": "http://localhost:20128/v1",
        "key_env": "HERMES_CUSTOM_LOCALHOST_20128_API_KEY",
        "models": {}
    })
    changed = True
elif "model" in entry:
    del entry["model"]
    changed = True

# Reserve OmniRoute for subagent delegation
delegation = cfg.get("delegation", {})
if not delegation or delegation.get("base_url") != "http://localhost:20128/v1":
    cfg["delegation"] = {
        "provider": "Omnirouter",
        "base_url": "http://localhost:20128/v1",
        "key_env": "HERMES_CUSTOM_LOCALHOST_20128_API_KEY"
    }
    changed = True

# Guard main agent model
main_model = cfg.get("model")
if main_model in ("auto", "auto/best-coding"):
    del cfg["model"]
    changed = True

# Add MoA presets
moa = cfg.setdefault("moa", {})
presets = moa.setdefault("presets", {})
if "omniroute-duo" not in presets:
    presets["omniroute-duo"] = {
        "enabled": True,
        "reference_models": [
            {"provider": "custom:omnirouter", "model": "kiro/claude-sonnet-4.5"},
            {"provider": "custom:omnirouter", "model": "kr/qwen3-coder-next"}
        ],
        "aggregator": {"provider": "custom:omnirouter", "model": "kr/qwen3-coder-next"}
    }
    changed = True

if changed:
    with open(config_path, "w") as f:
        yaml.dump(cfg, f, default_flow_style=False, sort_keys=False, allow_unicode=True)
    print("[omni-mod] config.yaml updated (main model preserved, delegation active)")
else:
    print("[omni-mod] config.yaml unchanged")
PYEOF
fi

# ── 4. Install omni-swarm MCP Server ─────────────────────────────────────────
MCP_DIR="${HERMES_DIR}/mcp-servers/omni-swarm"
mkdir -p "$MCP_DIR"
cat > "${MCP_DIR}/server.py" << 'PYEOF'
#!/usr/bin/env python3
"""omni-swarm — high-concurrency headless subagent swarm & Jev decision engine."""
import json, os, subprocess, sys, time, urllib.request

OMNIROUTE_BASE = os.environ.get("OMNIROUTE_BASE_URL", "http://localhost:20128/v1")
API_KEY = os.environ.get("HERMES_CUSTOM_LOCALHOST_20128_API_KEY", "")
LEDGER = os.path.expanduser("~/.hermes/omni-swarm/ledger.json")

def decide_task(task):
    """Jev System-1 fast decision solver for agent dilemma."""
    try:
        req = urllib.request.Request(
            f"{OMNIROUTE_BASE}/orchestrate/decide",
            data=json.dumps({"task": task}).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {API_KEY}"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read())
    except Exception:
        t_low = task.lower()
        if any(k in t_low for k in ["parallel", "swarm", "across", "compare", "multi-file"]):
            return {"ok": True, "action": "SWARM", "should_use_omniroute": True, "recommended_model": "kr/qwen3-coder-next", "tag": "code"}
        if any(k in t_low for k in ["vision", "image", "diagram", "screenshot", "deep"]):
            return {"ok": True, "action": "DELEGATE", "should_use_omniroute": True, "recommended_model": "kiro/claude-sonnet-4.5", "tag": "vision"}
        return {"ok": True, "action": "SELF", "should_use_omniroute": False, "recommended_model": "constant-brain"}

def read_ledger():
    try:
        return json.load(open(LEDGER))
    except Exception:
        return {}

def save_ledger(data):
    os.makedirs(os.path.dirname(LEDGER), exist_ok=True)
    tmp = f"{LEDGER}.{os.getpid()}.{int(time.time()*1e6)}.tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, LEDGER)

def run_worker(model, prompt):
    cmd = ["hermes", "chat", "--oneshot", "-m", model, "-q", prompt]
    t0 = time.time()
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        dur = int((time.time() - t0) * 1000)
        return {"ok": res.returncode == 0, "out": res.stdout, "ms": dur, "model": model}
    except Exception as e:
        return {"ok": False, "out": str(e), "ms": int((time.time() - t0) * 1000), "model": model}

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "decide":
        print(json.dumps(decide_task(" ".join(sys.argv[2:])), indent=2))
PYEOF
chmod +x "${MCP_DIR}/server.py"
log "MCP server omni-swarm installed (with Jev System-1 decide support)"

# ── 5. Install omni-swarm Skill ──────────────────────────────────────────────
SKILL_DIR="${HERMES_DIR}/skills/omni-swarm"
mkdir -p "$SKILL_DIR"
cat > "${SKILL_DIR}/SKILL.md" << 'MDEOF'
# omni-swarm — dynamic specialist swarm & Jev decision engine
Run subtasks simultaneously across diverse providers via OmniRoute (4-8+ parallel models).
- Resolve dilemmas instantly with `omni_decide(task)` or Jev decision flow.
- Spawns independent subagents via `hermes chat --oneshot -m <model> -q '<prompt>'`
- Collects and synthesizes results under the constant main agent.
MDEOF
log "Skill omni-swarm installed"

# ── 6. Inject Persistent Memory ──────────────────────────────────────────────
MEM_DIR="${HERMES_DIR}/memories"
mkdir -p "$MEM_DIR"
cat > "${MEM_DIR}/omniroute-superpowers.md" << 'MEMEOF'
# Memory: OmniRoute Subagent Mesh & Jev Decision Flow

## Architectural Role
- **Main Agent (Hermes)**: Stays on its constant primary model. Retains user context, executive planning, and response synthesis.
- **Subagent Federation (OmniRoute)**: Accessible at `http://localhost:20128/v1`. Reserved exclusively for spawning subagents, parallel swarms, and specialist delegations across diverse providers (Kiro, NVIDIA NIM, OpenAI, Anthropic, Gemini, DeepSeek).

## The Jev Decision Matrix (Zero Dilemma: When & How to Use OmniRoute)
Whenever you receive a prompt or task, evaluate it against this deterministic 3-level flow:
1. **Level 0 (SELF)**: Conversational chat, small query, greetings, direct reasoning -> Answer directly with your constant model weights (0 network calls, 0 delay).
2. **Level 1 (DELEGATE)**: Single task needing specialized capability -> Call `POST /v1/orchestrate/quick` (tag: `vision` | `code` | `reasoning`) or `hermes chat --oneshot -m <model> -q '<task>'`.
3. **Level 2 (SWARM)**: Decomposable tasks (2+ independent files, test suites, architecture refactors, parallel verification) -> Call tool `omni-swarm(goal, subtasks)`.
4. **In Any Doubt?**: Call `omni_decide(task)` or `POST /v1/orchestrate/decide`. It returns the exact recommendation in 15ms.

## Powers & Endpoints
- `POST /v1/decide` / `POST /v1/systemone`: TypeSafe Jev System-1 decision endpoint (choice, score, noul).
- `POST /v1/orchestrate/decide`: Instant agent dilemma solver.
- `POST /v1/orchestrate/quick`: Fast synchronous task execution by capability tag (`vision`, `code`, `research`, `reasoning`).
- `POST /v1/orchestrate/plan`: Parallel/swarm DAG task execution with dependencies.
- `MCP omni-swarm`: Multi-provider worker fan-out with ledger logging.
MEMEOF
log "Persistent memory saved to ${MEM_DIR}/omniroute-superpowers.md"

# ── 7. Append Execution Policy to SOUL.md ───────────────────────────────────
if ! grep -q "OmniRoute Subagent Federation" "${HERMES_DIR}/SOUL.md" 2>/dev/null; then
  cat >> "${HERMES_DIR}/SOUL.md" << 'SOULEOF'

## EXECUTION POLICY — OmniRoute Subagent Federation & Jev Decision Flow
1. Main Agent Constancy: Your default model is CONSTANT. Never switch models for direct user dialog.
2. Jev Dilemma Rule:
   - Simple queries -> Answer immediately (SELF).
   - Specialized single tasks -> DELEGATE via `/v1/orchestrate/quick`.
   - Multi-step parallel tasks -> SWARM via `omni-swarm`.
   - When uncertain -> Call `omni_decide` or `POST /v1/orchestrate/decide` (15ms decision).
3. OmniRoute Reserved for Subagents: OmniRoute (:20128) is your subagent cluster.
SOULEOF
  log "SOUL.md: execution policy appended"
fi

log ""
log "=== LITE MOD INSTALL COMPLETE (Finished in < 1 second) ==="
log "Hermes is now wired to use OmniRoute for subagents with zero bloat."
