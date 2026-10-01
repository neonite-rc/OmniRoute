---
name: omni-swarm
description: Dynamic specialist swarm and Jev System-1 decision routing over OmniRoute. Use to eliminate agent hesitation, route specialist subtasks, and execute parallel multi-model swarms across diverse providers (4 to 8+ models).
---

# omni-swarm — Dynamic Specialist Swarm & Jev Decision Engine

Harness OmniRoute as your subagent federation mesh. Execute subtasks in parallel across diverse model providers (Kiro, NVIDIA NIM, OpenAI, Anthropic, Gemini, DeepSeek) while **keeping your main model constant**.

---

## 1. Zero-Dilemma Jev Decision Matrix (When & How to Use)

Never hesitate or waste reasoning tokens debating how to execute. Follow this deterministic 3-level rule:

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
- **When**: Complex tasks with ≥2 independent deliverables:
  - Feature implementation + Unit test suites
  - Multi-file refactoring
  - Competitive code reviews (2 models reviewing diff simultaneously)
  - MoA (Mixture of Agents) multi-perspective evaluation
- **Action**: Call the `omni-swarm` MCP tool or `POST /v1/orchestrate/plan`.

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

## 2. Tool Reference

### Tool A: `omni_decide(task)`
Fast Jev-style System-1 decision to resolve agent routing dilemma.
- **Input**: `task` (string) — The prompt or subtask to evaluate.
- **Returns**: `{"action": "SELF"|"DELEGATE"|"SWARM", "should_use_omniroute": bool, "confidence": float, "recommended_model": string, "reason": string}`.

### Tool B: `swarm(goal, subtasks)`
Runs headless specialist workers across diverse models in parallel waves.
- **Input**:
  - `goal` (string) — High-level objective.
  - `subtasks` (list of dicts):
    ```json
    [
      {
        "id": "backend",
        "prompt": "Write the fast Hono API handler for user sessions.",
        "capability": "code",
        "depends_on": []
      },
      {
        "id": "tests",
        "prompt": "Write unit tests for the session handler verifying token expiry.",
        "capability": "code",
        "depends_on": []
      },
      {
        "id": "review",
        "prompt": "Review the API handler and tests for security vulnerabilities.",
        "capability": "reasoning",
        "depends_on": ["backend", "tests"]
      }
    ]
    ```
- **Returns**: Per-subtask output text, assigned models, latency, and success flags.
- **Automatic Orchestration**:
  - Independent subtasks (`depends_on: []`) run simultaneously (up to 8 parallel).
  - Dependent subtasks wait for their prerequisites and automatically receive their output.

---

## 3. Proven Swarm Patterns

### Pattern 1: Competitive Code Review
Launch two distinct provider models to review the same patch simultaneously:
```json
{
  "goal": "Review security of cryptographic session rotation",
  "subtasks": [
    {
      "id": "reviewer_a",
      "prompt": "Review this git diff for timing attacks and replay flaws: <DIFF>",
      "capability": "reasoning",
      "depends_on": []
    },
    {
      "id": "reviewer_b",
      "prompt": "Review this git diff for memory leaks and resource exhaustion: <DIFF>",
      "capability": "code",
      "depends_on": []
    }
  ]
}
```

### Pattern 2: Parallel TDD (Test-Driven Development)
Split implementation and test generation across independent models:
- **Subtask 1 (`impl`)**: Writes clean TypeScript implementation.
- **Subtask 2 (`tests`)**: Writes comprehensive test fixtures and edge cases.
- **Subtask 3 (`verify`)**: Depends on `impl` and `tests`; runs the test suite and verifies assertions.

---

## 4. Synthesis & Ground Rules

1. **Main Brain Constancy**: You (the orchestrator) remain on your constant model. You hold the user context, plan the decomposition, and synthesize the final answer.
2. **Review Worker Output**: Subagents are headless specialists. Inspect their results for completeness before presenting them to the user.
3. **No Refire Loops**: If a worker fails due to rate limits or invalid arguments, do not loop infinitely. Either retry with an alternate model or execute the fallback yourself.
4. **Attribute Work**: When synthesizing the final response, briefly mention the specialist contributions (e.g. *"Verified by Qwen Coder and Claude Sonnet in parallel"*).
