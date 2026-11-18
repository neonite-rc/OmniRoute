---
name: Omni Multi-AI Team
description: Run work as a team of models through OmniRoute — fan out tasks to specialists in parallel, compose the result with a synthesizer, and know the real limits (workers in flight, admission gate, provider lanes, failure isolation). Use when a task should be split across several models/providers, when a swarm or fusion combo is involved, or when asked how many parallel calls OmniRoute can make.
---

# Omni multi-AI team

How to drive OmniRoute's multi-model machinery **as a team**, and what the
team can actually do.

Everything below is measured, not aspirational. The mock test
(`tests/unit/services/multi-ai-team-mock.test.ts`) drives the real combo
engine, the real swarm pool and the real admission gate with a fake upstream;
run the report to see the numbers on the current host:

```bash
node --import tsx scripts/ad-hoc/multi-ai-team-report.mjs
```

## 1. Pick the right shape

| Shape | Use it when | How |
| --- | --- | --- |
| **Single model** | One model can do it. This is the default — never fan out for trivia. | normal request |
| **Fusion panel** | ONE prompt, several models must answer it, one judge picks/composes. | combo `strategy: "fusion"` |
| **Swarm** | N *different* tasks, each to its own specialist, all at once. | combo `strategy: "swarm"` (or per-request `body.swarm`) |
| **Pipeline** | Tasks depend on each other — sequential by nature. | combo `strategy: "pipeline"` |

The main agent's own subagents map onto the swarm shape: independent
subtasks → wave 1 together; anything that needs an earlier answer → the next
wave. Never run dependent work in parallel.

## 2. How many calls at a time

| Limit | Value | Where it comes from |
| --- | --- | --- |
| Workers in flight per request | `maxConcurrency`, **default 8** | `config.swarm.maxConcurrency`; hard cap `maxTasks` = 40 |
| Tasks per run | **40** | `SWARM_DEFAULTS.maxTasks` — refused *before* fan-out (#1905 heap discipline) |
| Heavy chat requests admitted at once | host-memory-derived byte budget | `OMNIROUTE_CHAT_MAX_INFLIGHT_BYTES`; otherwise a quarter of the memory ceiling ÷ 8 |
| Concurrent tunnels through one proxy | **32** by default, **64** in the shipped profile | `OMNIROUTE_PROXY_DISPATCHER_CONNECTIONS` (cap 256) |
| Per provider/account | its own semaphore | the account lane — a panel is only as wide as its distinct providers |

So the **effective width of one request** is
`min(maxConcurrency, distinct providers available, admission budget)`.
On the reference host the admission gate admits hundreds of concurrent agent
turns, so in practice **the pool bound and the provider lanes are what you
feel** — not the gate.

Raising the count costs memory (every in-flight request buffers a body).
Prefer a wider *pool* over more *processes*; prefer waiting (`queueMs`) over
shedding.

## 3. Building the team

Workers are chosen from the live tag index, so the team follows the catalog:

```bash
# what a panel would resolve to right now
curl -s "http://localhost:20128/api/models/tags?panel=true&category=coder&size=4&minBenchmark=80"

# the specialists available for a task
curl -s "http://localhost:20128/api/models/tags?category=chat&minBenchmark=85&diverse=true&distinct=true"
```

- `distinct=true` collapses relay duplicates (the same model behind 20 provider
  keys is one entry).
- `diverse=true` round-robins across providers.
- `minBenchmark>0` drops every unscored model — unscored means "no evidence",
  never a made-up number.
- Tag resolution **skips models already claimed by an earlier task**, so two
  identical specs still yield two different models from two different
  providers. A swarm of one model behind N front doors is not a swarm.

Per-request override (a single swarm combo serves any workload):

```json
{
  "model": "my-swarm-combo",
  "messages": [{ "role": "user", "content": "…" }],
  "swarm": {
    "tasks": [
      { "label": "api", "task": "Draft the API reference.", "fromTags": { "category": "coder", "minBenchmark": 80 } },
      { "label": "docs", "task": "Write the quickstart.", "model": "openai/gpt-5.6" }
    ],
    "synthesize": true
  }
}
```

`body.swarm` accepts every run-level field (`tasks`, `synthesize`,
`judgeModel`, `defaultModel`, `maxConcurrency`, `resultFormat`) and wins over
the combo's stored `config.swarm`.

## 4. Composing the answer

- `synthesize: false` (default) → labeled sections, one per task. Cheap, no
  extra call, and the operator sees which specialist produced what.
- `synthesize: true` → **one** synthesizer call. It receives every successful
  contribution, labeled by task, plus an explicit note for every failed task
  ("this task FAILED, do not invent its content"). The synthesizer composes;
  it does not adjudicate.
- The synthesizer keeps the client's `tools` and `stream` — an agentic client
  gets a tool call back, not prose.
- A tool-bearing request **without** `synthesize` bypasses the fan-out and
  goes straight to the judge/worker with tools intact: workers run
  tool-stripped, so fanning out there would silently lose the tool call.

## 5. Failure discipline

- One dead worker never sinks the run: it is reported as a failed section and
  the rest completes.
- Only a **total** failure returns 503, with a per-task reason
  (`a=status_503, b=status_503`).
- A lane-full worker (its provider is busy) is dropped before the pool
  starts, and reported as `no_worker_or_lane_full` — not silently missing.
- Per-task timeout: 120 s.

## 6. Rules of engagement

1. **Do not swarm trivia.** A single model is faster and cheaper.
2. **Independent → parallel, dependent → waves.** Never fake a dependency with
   parallelism.
3. **One specialist per task, from a different provider** when the catalog
   allows it.
4. **Synthesize once.** Never let two synthesizers compose the same run.
5. **A failed task is reported, never invented.** Do not let a worker
   fabricate what another worker failed to deliver.
6. **Watch the ceiling.** If a run is wider than the pool, it queues — that is
   the pool doing its job, not a hang.
7. **Measure before you tune.** Run the mock report; do not guess capacities.

## 7. Where the machinery lives

| Piece | Path |
| --- | --- |
| Swarm strategy | `open-sse/services/swarm.ts` |
| Fusion (panel + judge) | `open-sse/services/fusion.ts` |
| Combo engine | `open-sse/services/combo.ts` |
| Tag index / retrieval | `open-sse/services/modelTags/` |
| Admission gate | `src/shared/middleware/chatBodyAdmission.ts` + `admissionBudget.ts` |
| Mock test | `tests/unit/services/multi-ai-team-mock.test.ts` |
| Report script | `scripts/ad-hoc/multi-ai-team-report.mjs` |
| Guide | `docs/guides/PARALLEL_EXECUTION.md` |

## 8. Related

- `hermes-config/skills/omni-swarm/SKILL.md` — the same discipline for the
  Hermes agent (ledger-based worker ranking, kanban DAGs).
- `docs/guides/PARALLEL_EXECUTION.md` — the full fork guide: tagging, panels,
  swarms, admission tuning.
