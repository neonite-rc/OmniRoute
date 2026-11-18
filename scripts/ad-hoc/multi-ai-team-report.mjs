#!/usr/bin/env node
/**
 * Multi-AI team — capacity & team-quality report.
 *
 * Runs the MOCK team test (no provider is contacted) and prints what the
 * multi-model machinery can actually do on this host:
 *
 *   - how many upstream calls can be in flight at once,
 *   - what the admission gate admits before it sheds,
 *   - how the pieces behave as a team (composition, isolation, diversity).
 *
 * The numbers are measured, not quoted: the mock drives the real combo
 * engine, the real swarm pool and the real admission gate.
 *
 * Run:
 *   node --import tsx scripts/ad-hoc/multi-ai-team-report.mjs
 *
 * Optional: point it at a running OmniRoute to include the live catalog size.
 *   OMNIROUTE_BASE_URL=http://127.0.0.1:20128 OMNIROUTE_API_KEY=... node --import tsx scripts/ad-hoc/multi-ai-team-report.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const testFile = path.join(repoRoot, "tests/unit/services/multi-ai-team-mock.test.ts");

const line = "─".repeat(72);

function heading(title) {
  console.log(`\n${line}\n${title}\n${line}`);
}

async function runMockTest() {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx/esm", "--test", testFile],
      { cwd: repoRoot, env: process.env }
    );
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      out += chunk;
    });
    child.on("close", (code) => resolve({ code, out }));
  });
}

/** The live catalog — how big the team can be drawn from. */
async function liveCatalog() {
  const base = process.env.OMNIROUTE_BASE_URL;
  if (!base) return null;
  const headers = {};
  if (process.env.OMNIROUTE_API_KEY) headers.Authorization = `Bearer ${process.env.OMNIROUTE_API_KEY}`;
  try {
    const response = await fetch(`${base.replace(/\/$/, "")}/api/models/tags`, { headers });
    if (!response.ok) return null;
    const data = await response.json();
    // The tag index answers { object: "list", data: [...] }.
    const entries = Array.isArray(data) ? data : (data.data ?? data.models ?? data.entries ?? []);
    if (!Array.isArray(entries)) return null;
    const providers = new Set(
      entries.map((e) => String(e.provider ?? String(e.id ?? "").split("/")[0])).filter(Boolean)
    );
    return { models: entries.length, providers: providers.size };
  } catch {
    return null;
  }
}

heading("Multi-AI team — mock capacity & team-quality report");
console.log(`host: ${process.platform}/${process.arch}`);
console.log(`node: ${process.version}`);

const { code, out } = await runMockTest();

heading("Measured behaviour");
for (const raw of out.split("\n")) {
  const match = raw.match(/#\s*(\[team\].*)$/);
  if (match) console.log(match[1].trim());
}

heading("What the numbers mean");
console.log(
  [
    "• Swarm pool        : maxConcurrency workers in flight per request",
    "                      (shipped default 8, hard cap maxTasks=40).",
    "• Admission gate    : concurrent HEAVY chat requests admitted before",
    "                      OmniRoute sheds with 503 chat_admission_busy —",
    "                      bounded by an ingest byte budget derived from the",
    "                      host memory ceiling (override:",
    "                      OMNIROUTE_CHAT_MAX_INFLIGHT_BYTES).",
    "• Per-provider lanes : each provider/account has its own semaphore, so a",
    "                      panel is only as wide as its distinct providers.",
    "• Team composition  : one synthesizer call per run; it receives every",
    "                      successful contribution, labeled, plus an explicit",
    "                      note for each failed task.",
    "• Failure isolation : one dead worker never sinks the run; only a total",
    "                      failure returns 503 with per-task reasons.",
    "• Diversity         : identical task specs still resolve to different",
    "                      models from different providers.",
  ].join("\n")
);

const catalog = await liveCatalog();
if (catalog) {
  heading("Live catalog");
  console.log(`• tagged models  : ${catalog.models}`);
  console.log(`• providers      : ${catalog.providers}`);
} else {
  console.log(
    "\n(live catalog not queried — set OMNIROUTE_BASE_URL and OMNIROUTE_API_KEY to include it)"
  );
}

heading("Result");
console.log(code === 0 ? "PASS — the mock team test is green." : `FAIL — exit code ${code}`);
process.exit(code);
