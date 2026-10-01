#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# agent-setup.sh — Universal Zero-Dilemma 1-Step Agent Onboarding (< 1 second)
#
# Eliminates agent hesitation and installation delays completely.
# 1. Installs the Hermes Subagent Mod with Jev System-1 decision routing (< 0.5s)
# 2. Injects the Jev Decision Matrix (Zero Dilemma: SELF vs DELEGATE vs SWARM)
# 3. Detects if OmniRoute engine is running; if not, gives smooth start command.
#
# Usage:
#   ./bin/agent-setup.sh
#   or via curl:
#   curl -sSL https://raw.githubusercontent.com/neonite-rc/OmniRoute/fork/parallel-execution/bin/agent-setup.sh | bash
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "⚡ [agent-setup] Running zero-dilemma lightweight agent setup..."

# 1. Run the instant standalone mod installer (< 0.5s)
if [ -f "${SCRIPT_DIR}/bin/install-hermes-mod.sh" ]; then
  "${SCRIPT_DIR}/bin/install-hermes-mod.sh"
else
  # Remote curl execution fallback
  curl -sSL "https://raw.githubusercontent.com/neonite-rc/OmniRoute/fork/parallel-execution/bin/install-hermes-mod.sh" | bash
fi

# 2. Check engine connectivity
ENGINE_ACTIVE=false
if curl -sf --max-time 1 "http://localhost:20128/api/monitoring/health" 2>/dev/null | grep -q '"healthy"'; then
  ENGINE_ACTIVE=true
  echo "✔ [agent-setup] OmniRoute engine is healthy and active on :20128"
else
  echo "ℹ [agent-setup] OmniRoute engine is not currently running on :20128."
  echo "  To start smoothly without building UI: omniroute serve  (or: ./bin/upgrade-from-base.sh --lite --yes)"
fi

# 3. Print the Zero-Dilemma Decision Matrix
cat << 'EOF'

================================================================================
🎯 AGENT ZERO-DILEMMA JEV EXECUTION FLOW (HOW & WHEN TO USE OMNIROUTE)
================================================================================
When you receive any prompt or task, resolve it instantly with this 3-rule flow:

1. LEVEL 0 (SELF): Simple conversation, greetings, direct math, quick answers
   → Answer immediately using your constant model weights (0 network calls, 0 delay).

2. LEVEL 1 (DELEGATE): Single focused task needing a specialized capability
   (Vision, deep math reasoning, specialized coding)
   → Call POST http://localhost:20128/v1/orchestrate/quick (tag: vision|code|reasoning)
   → Or: hermes chat --oneshot -m <model-id> -q '<task>'

3. LEVEL 2 (SWARM): Complex, multi-file refactoring, writing code + parallel tests,
   or multi-perspective peer review (4 to 8+ concurrent models)
   → Call tool omni-swarm(goal=..., subtasks=[...])
   → Or: POST http://localhost:20128/v1/orchestrate/plan

4. IN ANY DOUBT OR HESITATION:
   → Call tool omni_decide(task="...") or POST /v1/orchestrate/decide
   → In 15ms it returns the exact verdict: "SELF", "DELEGATE", or "SWARM"!
================================================================================
EOF
