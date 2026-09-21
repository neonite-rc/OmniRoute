# HERMES_AGENT.md — Autonomous Agent Onboarding & Upgrade Guide

> **For AI Agents (Hermes Agent, Claude, Codex, etc.)**:
> This document specifies how you can autonomously read, upgrade, and integrate this OmniRoute fork into your existing environment, unlocking high-concurrency subagent federation while preserving your main brain's stability.

---

## 1. What This Repository Provides

This is the **OmniRoute Parallel Execution Fork** (`neonite-rc/OmniRoute`).
Compared to upstream/base OmniRoute:
- **High Concurrency**: Runs **4 to 8+ concurrent model calls** with an optimized admission controller and zero 503 throttling errors.
- **Model Federation**: Unified access to models across multiple providers (Kiro, NVIDIA NIM, Anthropic, OpenAI, Google Gemini, DeepSeek, etc.) via a single local endpoint (`http://localhost:20128/v1`).
- **Orchestration Surface**: Dedicated endpoints for synchronous specialist execution (`/v1/orchestrate/quick`), multi-task DAG planning (`/v1/orchestrate/plan`), per-completion polling (`wait-first`), and child job spawning (`/spawn`).
- **Swarm Coordination**: Shared inter-agent blackboard state, `@ask` mailbox messaging, and automatic judge verification loops.
- **Bias Guard**: Automatically prevents routing subagents to your own model family on near-ties when `caller_model` is supplied.

---

## 2. The Golden Architectural Rule

> **MAIN AGENT BRAIN REMAINS CONSTANT. OMNIROUTE IS STRICTLY RESERVED FOR SUBAGENTS.**

- **Your Identity (Main Agent)**:
  - Your default conversational model (e.g., Claude 3.5 Sonnet, GPT-4o, Qwen) is **CONSTANT** and must **NEVER** be switched or pointed to OmniRoute auto-routing for direct dialog.
  - You maintain user context, conversational history, executive planning, and final synthesis.
- **Subagent Federation (OmniRoute)**:
  - OmniRoute (`http://localhost:20128/v1`) is reserved exclusively as your **subagent execution cluster**.
  - Whenever you spawn subagents, delegate specialist work, or run parallel worker swarms across multiple providers, those subagents route through OmniRoute.

---

## 3. Autonomous One-Step Upgrade & Integration

If you have been directed by the user to upgrade and integrate:

```bash
./bin/hermes-agent-integrate.sh --yes
```

This single command autonomously:
1. **Detects & Upgrades Base OmniRoute In-Place**:
   - If an existing base OmniRoute installation exists (git clone, npm global, or Docker), it creates a timestamped database backup and upgrades it in place without data loss or uninstall.
2. **Configures Subagent Delegation in Hermes**:
   - Adds the `Omnirouter` provider and sets `delegation:` in `~/.hermes/config.yaml` to point to `http://localhost:20128/v1`.
   - **Guards your main model**: Ensures your default model in `config.yaml` is NOT overridden.
3. **Installs Subagent Swarm Tools**:
   - Installs and registers the `omni-swarm` MCP server (`swarm(goal, subtasks)` tool).
   - Installs the `omni-swarm` skill in `~/.hermes/skills/omni-swarm`.
   - Creates the `moe` subagent profile.
4. **Injects Persistent Memory**:
   - Writes `~/.hermes/memories/omniroute-superpowers.md` so you permanently recall how to use your subagent powers.
   - Appends the execution policy to `~/.hermes/SOUL.md`.

*(To preview without modifying files, pass `--dry-run`).*

---

## 4. How You (The Agent) Should Route Tasks

Follow this 4-tier decision tree:

### Tier 0: Self-Execution (Default)
- **When**: Conversational replies, single-step code edits, explanations, or trivial lookups.
- **Action**: Answer directly from your own constant model weights. Do NOT spawn subagents or call OmniRoute.

### Tier 1: Single Specialist Delegation (`/v1/orchestrate/quick`)
- **When**: Specialized vision/OCR sensing, deep math, or distinct domain execution.
- **Action**: Call the synchronous quick endpoint:
  ```bash
  curl -s http://localhost:20128/v1/orchestrate/quick \
    -H "Authorization: Bearer $HERMES_CUSTOM_LOCALHOST_20128_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
      "tag": "vision",
      "prompt": "Extract the key metrics from this table",
      "images": ["data:image/png;base64,..."]
    }'
  ```
  Supported tags: `vision`, `code`, `research`, `image_gen`, `reasoning`.

### Tier 2: Parallel Subagent Swarm (MCP Tool `omni-swarm` or `/plan`)
- **When**: Complex tasks with ≥2 independent deliverables (e.g., backend API + frontend component + test suite + docs).
- **Action**:
  - **Via MCP**: Use the `swarm` tool:
    ```json
    {
      "goal": "Build authentication module",
      "subtasks": [
        "Implement JWT token generator in auth.ts",
        "Create React login form with error states",
        "Write integration tests for login endpoint"
      ]
    }
    ```
  - **Via HTTP**: Submit a DAG plan to `POST /v1/orchestrate/plan`:
    ```json
    {
      "goal": "Refactor router and add benchmarks",
      "mode": "parallel",
      "caller_model": "claude-3-7-sonnet",
      "tasks": [
        {"id": "t1", "tag": "code", "prompt": "Refactor router.ts", "depends_on": []},
        {"id": "t2", "tag": "code", "prompt": "Add benchmarks in bench.ts", "depends_on": []},
        {"id": "t3", "tag": "research", "prompt": "Verify docs match", "depends_on": ["t1", "t2"]}
      ]
    }
    ```
  - Poll for completion with `GET /v1/orchestrate/jobs/<job_id>/wait-first`.

### Tier 3: MoE Expert Panel
- **When**: Explicit user request ("moe mode", "expert panel", "ask the panel") or high-stakes architectural comparison.
- **Action**: Execute `moe chat --oneshot -q "<task>"`. Never invoke the panel more than once per user turn; synthesize results from all answering slots.

---

## 5. Rules for Spawning Subagents Across Providers

1. **Provider Diversity**:
   - OmniRoute routes across multiple providers (Kiro, NVIDIA NIM, Anthropic, OpenAI, DeepSeek).
   - In parallel swarms, ensure different subtasks use different models/providers to maximize perspective diversity and avoid hitting single-provider rate limits.
2. **Bias Guard**:
   - Always include `"caller_model": "<your-model-id>"` in orchestrator API calls. OmniRoute will automatically avoid assigning subagents back to your own model family on score ties.
3. **Synthesis & Attribution**:
   - The user talks to **you**. You judge and synthesize the outputs from all subagents.
   - Present a clean, unified answer. Do not expose internal model names, raw job IDs, or provider plumbing unless the user explicitly asks.
