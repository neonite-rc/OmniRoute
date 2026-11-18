/**
 * Multi-AI team — MOCK capacity and team-quality test.
 *
 * The user-facing question this answers:
 *
 *   1. "How many calls can it make at a time?"
 *   2. "How well can they work as a team?"
 *
 * Everything here is MOCKED: no provider is contacted, no network is touched.
 * The REAL machinery is exercised — the combo engine, the swarm pool, the
 * admission gate and the synthesizer — with a fake upstream that only records
 * what it was asked to do. That makes the numbers deterministic and safe to
 * run anywhere.
 *
 * The capacities measured here are the real, shipped ones:
 *
 *   - the swarm pool's `maxConcurrency` (default 8, hard cap `maxTasks` = 40),
 *   - the chat admission gate's byte budget (auto-derived from the host's
 *     memory ceiling — `OMNIROUTE_CHAT_MAX_INFLIGHT_BYTES` overrides it),
 *   - the per-task failure isolation (one dead worker never sinks the run),
 *   - the synthesizer's job (it must see EVERY contribution, and exactly one
 *     judge call may happen per run).
 *
 * Run it:
 *   node --import tsx/esm --test tests/unit/services/multi-ai-team-mock.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-team-mock-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "team-mock-secret";

const { handleComboChat } = await import("../../../open-sse/services/combo.ts");
const { SWARM_DEFAULTS } = await import("../../../open-sse/services/swarm.ts");
const { ChatAdmissionController, admitChatRequest } = await import(
  "../../../src/shared/middleware/chatBodyAdmission.ts"
);
const { computeIngestByteBudget } = await import(
  "../../../src/shared/middleware/admissionBudget.ts"
);
const v8 = await import("node:v8");

const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };

type Body = Record<string, unknown>;

function okResponse(content: string, model = "mock"): Response {
  return new Response(
    JSON.stringify({ model, choices: [{ message: { role: "assistant", content } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function errResponse(status = 500): Response {
  return new Response(JSON.stringify({ error: { message: "boom" } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function swarmCombo(config: Record<string, unknown>) {
  return { name: "team-mock", strategy: "swarm", models: [], config };
}

/**
 * A fake upstream that records the concurrency it actually observed.
 *
 * `handleSingleModel` is the seam the combo engine calls for every worker and
 * for the judge, so a fake here measures the REAL fan-out.
 */
function makeProbe(options: { delayMs?: number; failOn?: (model: string) => boolean } = {}) {
  const state = {
    inFlight: 0,
    highWater: 0,
    calls: [] as Array<{ model: string; body: Body }>,
    startedAt: [] as number[],
    finishedAt: [] as number[],
  };

  const handleSingleModel = async (body: Body, model: string): Promise<Response> => {
    state.inFlight += 1;
    state.highWater = Math.max(state.highWater, state.inFlight);
    state.startedAt.push(Date.now());
    state.calls.push({ model, body });
    try {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options.failOn?.(model)) return errResponse(503);
      return okResponse(`work-${model}`);
    } finally {
      state.inFlight -= 1;
      state.finishedAt.push(Date.now());
    }
  };

  return { state, handleSingleModel };
}

// ── 1. How many calls at a time? ─────────────────────────────────────────────

test("team: the swarm pool runs exactly maxConcurrency workers at once", async () => {
  const TASKS = 16;
  const CONCURRENCY = 8;
  const probe = makeProbe({ delayMs: 30 });

  const tasks = Array.from({ length: TASKS }, (_, i) => ({
    label: `t${i}`,
    task: `task ${i}`,
    model: `p/m${i}`,
  }));

  // Warm the caches first: the first dispatch pays for registry/DB lookups,
  // which must not be mistaken for pool serialization in the timing below.
  await handleComboChat({
    body: { messages: [{ role: "user", content: "warmup" }] },
    combo: swarmCombo({ swarm: { tasks: tasks.slice(0, 1), maxConcurrency: 1 } }),
    handleSingleModel: probe.handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });

  const started = Date.now();
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "ship the release" }] },
    combo: swarmCombo({ swarm: { tasks, maxConcurrency: CONCURRENCY } }),
    handleSingleModel: probe.handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });
  const elapsed = Date.now() - started;

  assert.equal(res.status, 200);

  // The pool bound is respected exactly — not exceeded, not under-used.
  assert.equal(
    probe.state.highWater,
    CONCURRENCY,
    `expected ${CONCURRENCY} workers in flight, saw ${probe.state.highWater}`
  );
  assert.equal(probe.state.calls.length, TASKS + 1, "every task ran exactly once");

  // Compare against a SERIAL run of the same work in the same process: the
  // pool must be measurably faster than one-at-a-time.
  const serialProbe = makeProbe({ delayMs: 30 });
  const serialStarted = Date.now();
  await handleComboChat({
    body: { messages: [{ role: "user", content: "ship the release" }] },
    combo: swarmCombo({ swarm: { tasks, maxConcurrency: 1 } }),
    handleSingleModel: serialProbe.handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });
  const serialElapsed = Date.now() - serialStarted;

  assert.ok(
    elapsed < serialElapsed * 0.6,
    `the pool must overlap the calls (parallel ${elapsed}ms vs serial ${serialElapsed}ms)`
  );

  console.log(
    `[team] swarm fan-out: ${TASKS} tasks → ${probe.state.highWater} workers in flight ` +
      `(pool bound ${CONCURRENCY}); parallel ${elapsed}ms vs serial ${serialElapsed}ms`
  );
});

test("team: the pool scales up to its bound and never exceeds it", async () => {
  for (const concurrency of [1, 4, 8]) {
    const probe = makeProbe({ delayMs: 15 });
    const tasks = Array.from({ length: 12 }, (_, i) => ({
      label: `t${i}`,
      task: `task ${i}`,
      model: `p/m${i}`,
    }));
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "q" }] },
      combo: swarmCombo({ swarm: { tasks, maxConcurrency: concurrency } }),
      handleSingleModel: probe.handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });
    assert.equal(res.status, 200);
    assert.equal(
      probe.state.highWater,
      concurrency,
      `maxConcurrency=${concurrency} must be the exact in-flight bound`
    );
  }
  console.log(
    `[team] pool scaling verified at maxConcurrency 1 / 4 / 8 ` +
      `(shipped default ${SWARM_DEFAULTS.maxConcurrency}, hard cap ${SWARM_DEFAULTS.maxTasks})`
  );
});

test("team: the admission gate admits as many concurrent agent requests as the byte budget allows", async () => {
  // The SHIPPED budget formula: a quarter of the host's memory ceiling,
  // divided by the transient amplification factor, floored at 8 MiB.
  const budget = computeIngestByteBudget({
    heapSizeLimitBytes: v8.getHeapStatistics().heap_size_limit,
  });
  assert.ok(budget.bytes > 0, "the budget must be positive");

  // A realistic coding-agent turn (big system prompt + tool schemas).
  const bodySize = 400_000;
  const filler = "x".repeat(bodySize);
  const raw = JSON.stringify({ model: "m", messages: [{ role: "user", content: filler }] });
  // The gate charges the CONTENT LENGTH, so the expectation is computed from
  // the real request size — the JSON envelope counts too.
  const requestBytes = Buffer.byteLength(raw);
  const expectedAdmitted = Math.max(1, Math.floor(budget.bytes / requestBytes));

  const controller = new ChatAdmissionController(Number.MAX_SAFE_INTEGER, undefined, 0, noop, {
    maxInflightBytes: budget.bytes,
    checkPressureSeverity: () => "normal",
  });

  const requests = Array.from({ length: expectedAdmitted + 2 }, () => {
    return new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(requestBytes) },
      body: raw,
    });
  });

  const results = await Promise.all(
    requests.map((request) =>
      admitChatRequest(request, {
        controller,
        sessionId: "team",
        largeBodyBytes: 1024,
        hardMaxBytes: 64 * 1024 * 1024,
        queueMs: 0,
      })
    )
  );

  const admitted = results.filter((r) => r.admit === true);
  assert.equal(
    admitted.length,
    expectedAdmitted,
    `expected ${expectedAdmitted} admitted (budget ${budget.bytes} / request ${requestBytes}), got ${admitted.length}`
  );

  for (const result of results) {
    if (result.admit) result.lease?.release();
  }
  assert.equal(controller.inflightBytes, 0, "every charge is released");

  console.log(
    `[team] admission gate: budget ${(budget.bytes / 1024 / 1024).toFixed(1)} MiB ` +
      `(${budget.source}), ${Math.round(requestBytes / 1024)} KiB agent turns → ` +
      `${admitted.length} concurrent requests admitted`
  );
});

// ── 2. How well do they work as a team? ──────────────────────────────────────

test("team: the synthesizer sees EVERY contribution and notes the gaps", async () => {
  const probe = makeProbe({ failOn: (model) => model === "flaky/x" });

  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "launch the product" }] },
    combo: swarmCombo({
      swarm: {
        synthesize: true,
        judgeModel: "judge/model",
        tasks: [
          { label: "strategy", task: "Draft the strategy.", model: "solid/a" },
          { label: "copy", task: "Write the copy.", model: "solid/b" },
          { label: "audit", task: "Red-team it.", model: "flaky/x" },
        ],
      },
    }),
    handleSingleModel: probe.handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });

  assert.equal(res.status, 200, "one dead worker must not sink the run");

  const judgeCalls = probe.state.calls.filter((c) => c.model === "judge/model");
  assert.equal(judgeCalls.length, 1, "exactly ONE synthesizer call per run");

  const judgeBody = judgeCalls[0].body;
  const messages = judgeBody.messages as Array<{ role: string; content: string }>;
  const synthesisPrompt = messages[messages.length - 1].content;

  // Every successful contribution reached the synthesizer...
  assert.ok(synthesisPrompt.includes("work-solid/a"), "strategy output reached the synthesizer");
  assert.ok(synthesisPrompt.includes("work-solid/b"), "copy output reached the synthesizer");
  assert.ok(synthesisPrompt.includes("### strategy"), "contributions stay labeled by task");
  assert.ok(synthesisPrompt.includes("### copy"), "every task keeps its label");
  // ...and the gap is explicit, not silently dropped.
  assert.ok(synthesisPrompt.includes("FAILED"), "the failed task is reported as a gap");
  assert.ok(synthesisPrompt.includes("audit"), "the failed task is named");
  assert.ok(!synthesisPrompt.includes("work-flaky/x"), "a failed worker contributes nothing");

  console.log(
    "[team] composition: 3 tasks → 2 contributions + 1 explicit gap → 1 synthesizer call"
  );
});

test("team: the synthesizer receives the ORIGINAL request (stream + tools intact)", async () => {
  const probe = makeProbe();
  const TOOLS = [{ type: "function", function: { name: "f", parameters: {} } }];

  const res = await handleComboChat({
    body: {
      messages: [{ role: "user", content: "q" }],
      stream: true,
      tools: TOOLS,
      tool_choice: "auto",
    },
    combo: swarmCombo({
      swarm: {
        synthesize: true,
        judgeModel: "judge/model",
        tasks: [{ label: "one", task: "t", model: "p/a" }],
      },
    }),
    handleSingleModel: probe.handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });

  assert.equal(res.status, 200);
  const judge = probe.state.calls.find((c) => c.model === "judge/model");
  assert.ok(judge, "the judge ran");
  assert.equal(judge.body.stream, true, "the client's stream flag survives to the judge");
  assert.deepEqual(judge.body.tools, TOOLS, "the client's tools survive to the judge");

  // The worker, in contrast, is prose-only: no tools, no streaming.
  const worker = probe.state.calls.find((c) => c.model === "p/a");
  assert.ok(worker);
  assert.equal(worker.body.stream, false, "workers run non-streaming");
  assert.ok(!("tools" in worker.body), "workers run without tools");
});

test("team: a total worker failure is reported per task, not swallowed", async () => {
  const probe = makeProbe({ failOn: () => true });
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "q" }] },
    combo: swarmCombo({
      swarm: {
        tasks: [
          { label: "a", task: "ta", model: "p/one" },
          { label: "b", task: "tb", model: "p/two" },
        ],
      },
    }),
    handleSingleModel: probe.handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });

  assert.equal(res.status, 503, "total failure is a 503 with per-task reasons");
  const json = await res.json();
  const message = json.error?.message ?? "";
  assert.ok(message.includes("a=status_503"), `per-task reason missing: ${message}`);
  assert.ok(message.includes("b=status_503"));
});

test("team: the team is diverse by construction — one worker per provider", async () => {
  // Same tag spec for every task: the resolver must still hand out DIFFERENT
  // models from DIFFERENT providers, otherwise the "team" is one model behind
  // N front doors.
  const { getModelTagIndex, findModelsByTags } = await import(
    "../../../open-sse/services/modelTags/index.ts"
  );
  const spec = { category: "chat", minBenchmark: 85 };
  const expected = findModelsByTags(getModelTagIndex(), {
    ...spec,
    distinctModels: true,
    diverseProviders: true,
  });

  const probe = makeProbe();
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "plan" }] },
    combo: swarmCombo({
      swarm: {
        tasks: [
          { label: "one", task: "t1", fromTags: spec },
          { label: "two", task: "t2", fromTags: spec },
        ],
      },
    }),
    handleSingleModel: probe.handleSingleModel,
    log,
    settings: {},
    allCombos: [],
  });

  assert.equal(res.status, 200);
  const workers = probe.state.calls.map((c) => c.model);
  assert.equal(workers.length, 2);
  assert.equal(new Set(workers).size, 2, "identical specs must yield different models");
  const providers = workers.map((m) => m.slice(0, m.indexOf("/")));
  assert.equal(new Set(providers).size, 2, "the team spans distinct providers");
  assert.deepEqual(
    workers.sort(),
    expected.slice(0, 2).map((e) => e.id).sort(),
    "the resolved workers match the tag index"
  );

  console.log(`[team] diversity: 2 identical specs → ${workers.join(" + ")}`);
});
