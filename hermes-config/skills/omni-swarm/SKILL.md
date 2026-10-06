---
name: omni-swarm
description: Dynamic specialist swarm and Jev System-1 decision routing over OmniRoute. Use to eliminate agent hesitation, route specialist subtasks, and execute parallel multi-model swarms across diverse providers (max 4 parallel workers, max 8 subtasks in waves).
---

# omni-swarm — Dynamic Specialist Swarm & Jev Decision Engine

Harness OmniRoute as your subagent federation mesh. Execute subtasks in parallel across diverse model providers (Kiro, NVIDIA NIM, OpenAI, Anthropic, Gemini, DeepSeek) while **keeping your main model constant**.

---

## 0. Bounds (Non-Negotiable)

- **Max 4 parallel workers per wave**: Strictly bounded by the shipped admission profile (`OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT=4`) and MCP server `MAX_PARALLEL = 4`. Launching more than 4 concurrent heavy chats risks 503 capacity rejection.
- **Max 8 subtasks per swarm total**: Any task decomposed into 5–8 subtasks must be organized into sequential waves of $\le 4$ parallel workers.
- **One MoE panel invocation max**: Single invocation per task (`moe` profile / `moa:omniroute-moe`).
- **Never re-fire a failed slot**: If a model fails with rate-limit, timeout, or quota exhaustion, never retry the same model. Switch to a different provider model or execute locally.
- **Level 0 self-execution stays default**: Trivial single-step tasks must never be swarmed.
- **Provider diversity enforced**: Ensure workers use distinct provider tokens (`_provider_of`):
  - Hub prefixes (`nvidia`, `hf`, `together`, `fireworks`, `azure`, `bedrock`) use two segments: `nvidia/moonshotai` and `nvidia/deepseek-ai` are distinct.
  - Gateway prefixes (`kiro`, `lma`, `kr`, `zc`) use the first segment: `kiro/claude-sonnet-4.5` and `kr/claude-sonnet-4.5` are distinct gateways.

---

## 1. Zero-Dilemma Jev Decision Matrix (When & How to Use)

Never hesitate or waste reasoning tokens debating whether to use OmniRoute. Follow this deterministic 3-level rule:

```
                            [Task Received]
                                   │
                      ┌────────────┴────────────┐
             Simple chat /                 Specialized or
             short answer?                 complex task?
                   │                             │
                   ▼                             ▼
            [LEVEL 0: SELF]             Needs multi-model /
          Answer immediately             swarm / specialist?
         with constant weights                   │
          (0 net, 0 latency)                     ├────────────────────────┐
                                                 ▼                        ▼
                                         Single capability?       Multi-step / swarm?
                                         (Vision, Code, Math)    (2+ files, tests, MoA)
                                                 │                        │
                                                 ▼                        ▼
                                        [LEVEL 1: DELEGATE]       [LEVEL 2: SWARM]
                                        /v1/orchestrate/quick     omni-swarm tool
                                        (tag: code|vision)        or /v1/orchestrate/plan
```

### Level 0: Self-Execution (Default)
- **When**: Conversational replies, short explanations, 1-line edits, general knowledge, greetings.
- **Action**: Answer directly with your own weights. Do NOT call OmniRoute or spawn subagents.

### Level 1: Specialist Delegation
- **When**: A single focused task needing a specialized capability (e.g. Vision/OCR sensing, deep math proofs, heavy algorithmic code).
- **Action**: Call `POST /v1/orchestrate/quick` with the capability tag:
  ```bash
  curl -s http://localhost:20128/v1/orchestrate/quick \
    -H "Authorization: Bearer $HERMES_CUSTOM_LOCALHOST_20128_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
      "tag": "code",
      "prompt": "Optimize this SQLite B-tree query for high concurrency"
    }'
  ```
  *(Supported tags: `code`, `vision`, `research`, `reasoning`, `image_gen`).*

### Level 2: Parallel Multi-Model Swarm
- **When**: Complex tasks with $\ge 2$ deliverables (e.g. implementation + tests, multi-file refactoring, competitive code review).
- **Action**: Call the `omni-swarm` MCP tool (`swarm(goal, subtasks)`) or use the waved runner below.

### In Any Doubt? (Jev System-1 Decision)
If you are uncertain which level fits, call the **`omni_decide`** tool (or `POST /v1/orchestrate/decide`). In **< 20ms**, it returns the exact calibrated verdict:
```json
{
  "action": "SWARM",
  "should_use_omniroute": true,
  "confidence": 0.94,
  "tag": "code",
  "recommended_model": "kr/qwen3-coder-next",
  "reason": "Decomposable multi-step task with parallel deliverables"
}
```

---

## 2. Model Selection (Router Candidates First, Heuristics Fallback)

### Primary: OmniRoute Candidates Endpoint (Evidence-Backed)
Query `POST /v1/router/candidates` per subtask to obtain ranked models based on live workload telemetry and failure penalty tracking:
```bash
curl -s http://localhost:20128/v1/router/candidates \
  -H "Authorization: Bearer $HERMES_CUSTOM_LOCALHOST_20128_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "<subtask prompt>",
    "capability": "code",
    "top": 8
  }'
```
Use the primary candidate from `tiers.primary`. If unavailable, fall back to `tiers.secondary`.

### Fallback: Segment Matching & Ledger Inspection
Only if the candidates endpoint is unreachable, inspect the local ledger and match model segments:
- Read `~/.hermes/omni-swarm/ledger.json`. If corrupt, log warning and back up to `ledger.corrupt.<timestamp>`:
  ```bash
  python3 -c "import json, os, time; p=os.path.expanduser('~/.hermes/omni-swarm/ledger.json'); (json.load(open(p)) if os.path.exists(p) else {})" 2>/dev/null || (mv ~/.hermes/omni-swarm/ledger.json ~/.hermes/omni-swarm/ledger.corrupt.$(date +%s) && echo "[omni-swarm] WARNING: Corrupt ledger backed up")
  ```
- Match capability tokens on segment boundaries (`id.split('/')[-1].split('-')`):
  - **code**: `coder`, `codestral`, `deepseek`, `qwen`, `kimi`
  - **reasoning**: `reasoning`, `opus`, `qwq`, `r1`, `think`
  - **vision**: `vision`, `vl`, `multimodal`
  - **fast/chat**: `haiku`, `flash`, `lite`, `mini`
- **Notice on `lmarena`**: Check ledger history before assigning `lmarena` slots; many Arena models are quota-bound or ephemeral.

---

## 3. Execution (Turnkey Waved Runner)

When executing via CLI instead of MCP, use this turnkey runner pattern. It enforces a 300s timeout, captures timing, and writes isolated JSON results per worker without race conditions:

```bash
RUN_DIR="$HOME/.hermes/omni-swarm/runs/$(date +%s)"
mkdir -p "$RUN_DIR"

run_worker() {
  local id="$1" model="$2" prompt="$3"
  local t0=$(date +%s%3N)
  local out rc
  if out=$(timeout 300 hermes chat --oneshot --yolo -m "$model" -q "$prompt" 2>&1); then
    rc=0
  else
    rc=$?
  fi
  local t1=$(date +%s%3N)
  local ms=$((t1 - t0))
  python3 -c "import json, sys; json.dump({'id': sys.argv[1], 'model': sys.argv[2], 'ok': sys.argv[3] == '0', 'ms': int(sys.argv[4]), 'text': sys.argv[5][:4000], 'exit': int(sys.argv[3])}, open(sys.argv[6], 'w'))" \
    "$id" "$model" "$rc" "$ms" "$out" "$RUN_DIR/${id}.json"
}

# Wave 1 (Max 4 parallel workers):
run_worker "t1" "kr/qwen3-coder-next" "Write session authentication handler" &
run_worker "t2" "kiro/claude-sonnet-4.5" "Write session test fixtures" &
wait

# Wave 2 (Dependent on Wave 1):
DEP_CONTEXT=$(python3 -c "import json, glob; print('\n'.join(json.load(open(f))['text'] for f in sorted(glob.glob('$RUN_DIR/t*.json'))))")
run_worker "t3" "kr/qwen3-coder-next" "Review code and tests: $DEP_CONTEXT" &
wait
```

---

## 4. Record Outcomes & Close Feedback Loop

Ingest the run directory into the local ledger with atomic file replacement AND report outcomes to OmniRoute's evidence layer (`POST /v1/router/outcomes`):

```bash
python3 - "$RUN_DIR" << 'PYEOF'
import glob, json, os, sys, time, urllib.request

run_dir = sys.argv[1]
ledger_path = os.path.expanduser("~/.hermes/omni-swarm/ledger.json")
api_key = os.environ.get("HERMES_CUSTOM_LOCALHOST_20128_API_KEY", "")
omni_base = os.environ.get("OMNIROUTE_BASE_URL", "http://localhost:20128/v1")

# 1. Load ledger safely
ledger = {}
if os.path.exists(ledger_path):
    try:
        with open(ledger_path) as f:
            ledger = json.load(f)
    except Exception as e:
        corrupt_backup = f"{ledger_path}.corrupt.{int(time.time())}"
        os.rename(ledger_path, corrupt_backup)
        print(f"[omni-swarm] WARNING: Corrupt ledger backed up to {corrupt_backup}")

# 2. Process all worker result files
for res_file in sorted(glob.glob(os.path.join(run_dir, "*.json"))):
    try:
        with open(res_file) as f:
            r = json.load(f)
    except Exception:
        continue

    model = r.get("model", "")
    ok = bool(r.get("ok"))
    ms = int(r.get("ms", 5000))
    text = r.get("text", "")

    # Failure taxonomy classification
    cat = ""
    t_low = text.lower()
    if not ok:
        if "429" in t_low or "rate" in t_low and "limit" in t_low or "quota" in t_low:
            cat = "RATE_LIMIT"
        elif "504" in t_low or "timeout" in t_low or r.get("exit") == 124:
            cat = "PROVIDER_TIMEOUT"
        elif "502" in t_low or "503" in t_low or "unavailable" in t_low:
            cat = "SERVICE_UNAVAILABLE"
        elif "400" in t_low or "invalid" in t_low:
            cat = "INVALID_REQUEST"
        else:
            cat = "MODEL_QUALITY_FAILURE"

    # Update local ledger stats
    entry = ledger.setdefault(model, {"ok": 0, "fail": 0, "infra_fail": 0, "ema_ms": 5000})
    if ok:
        entry["ok"] += 1
    elif cat in ("RATE_LIMIT", "PROVIDER_TIMEOUT", "SERVICE_UNAVAILABLE"):
        entry["infra_fail"] = entry.get("infra_fail", 0) + 1
    else:
        entry["fail"] += 1
    entry["ema_ms"] = round(0.7 * entry.get("ema_ms", 5000) + 0.3 * ms)
    entry["last"] = int(time.time())

    # 3. Close the loop into OmniRoute evidence layer
    try:
        payload = {
            "workflow": "swarm-cli",
            "model": model,
            "tools": [],
            "success": ok,
            "latency_ms": ms,
            "quality_score": 1.0 if ok else 0.0,
            "failure_category": cat
        }
        req = urllib.request.Request(
            f"{omni_base}/router/outcomes",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            pass
    except Exception:
        pass

# 4. Atomic ledger file write
os.makedirs(os.path.dirname(ledger_path), exist_ok=True)
tmp_path = f"{ledger_path}.{os.getpid()}.{int(time.time() * 1000)}.tmp"
with open(tmp_path, "w") as f:
    json.dump(ledger, f, indent=1)
os.replace(tmp_path, ledger_path)
print(f"[omni-swarm] Outcomes recorded to ledger and OmniRoute evidence layer.")
PYEOF
```

---

## 5. Synthesis & Single-Retry Protocol

1. **Judge Completeness**: Inspect each worker's returned text for correctness, schema match, and syntax validity.
2. **One Retry Maximum**: If a subtask returns below-bar results or encounters an infrastructure error, retry it **exactly once** using a **different model from another provider** (or execute it locally with your constant weights). Never re-fire the same model that just failed.
3. **Attribute Specialist Contributions**: In your final response to the user, synthesize the integrated result and briefly attribute worker contributions (e.g. *"Implemented via Qwen Coder with security review by Claude Sonnet in parallel"*).
