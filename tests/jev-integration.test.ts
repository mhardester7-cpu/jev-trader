import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INITIAL_JEV_LIMITS, JEV_INPUT_TOKEN_CEILING, JevBudget } from "../src/jev-budget";
import { requestJev, jevHttpTransport, JEV_ENDPOINT } from "../src/jev-request";
import { loadRecording } from "../src/recording";
import { RecordedJevSession } from "../src/jev-session";
import { buildTradeState } from "../src/state";

const recording = loadRecording(join(import.meta.dir, "../research/mon-usdc-20260917"));
const state = buildTradeState(recording.frames.slice(0, 151), { buy: true, sell: false }, 100);
const fixtureResponse = (tokens = 1000) => ({ model: "jev-1.13.0", answers: { direction: { type: "choice", choice: "buy", probabilities: { buy: 0.8, sell: 0.2 } } }, usage: { input_tokens: tokens, output_tokens: 10 } });
const key = "unit-fixture-credential-never-sent";

test("HTTP adapter is fixed to Jev, never redirects/retries, and suppresses provider error bodies", async () => {
  const original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = (async (url, options) => {
      calls++; expect(url).toBe(JEV_ENDPOINT); expect(options?.redirect).toBe("error");
      expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer ${key}`);
      return new Response(`provider echoed ${key}`, { status: 429 });
    }) as typeof fetch;
    await expect(jevHttpTransport("{}", key, new AbortController().signal)).rejects.toThrow("provider_http_429");
    expect(calls).toBe(1);
  } finally { globalThis.fetch = original; }
});

test("full-context reservation caps attempts and never recycles cheaper actual usage", () => {
  const budget = new JevBudget({ maxRequests: 10, maxUsd: 0.006, maxSeconds: 120 });
  budget.reserve(); expect(() => budget.reserve()).toThrow("in_flight"); budget.settle(1);
  budget.reserve(); budget.settle(1);
  expect(() => budget.reserve()).toThrow("budget_limit");
  expect(budget.snapshot().attempts).toBe(2);
  expect(budget.snapshot().reservedUsd).toBe(0.005505024);
  expect(budget.snapshot().reportedCostUsd).toBe(0.000000084);
});
test("request count and wall-time limits fail before another billable attempt", () => {
  let now = Date.now();
  const budget = new JevBudget({ maxRequests: 1, maxUsd: 0.03, maxSeconds: 5 }, () => now);
  budget.reserve(); budget.settle(null);
  expect(() => budget.reserve()).toThrow("budget_limit");
  expect(budget.snapshot().uncertainCostUsd).toBe(0.002752512);
  const expired = new JevBudget(INITIAL_JEV_LIMITS, () => now); now += 120000;
  expect(() => expired.reserve()).toThrow("time_limit"); expect(expired.snapshot().attempts).toBe(0);
});
test("Jev transport receives the pinned causal request only after reservation persistence", async () => {
  const budget = new JevBudget(INITIAL_JEV_LIMITS); let persisted = false;
  const result = await requestJev(state, key, budget, new AbortController().signal, () => { persisted = true; expect(budget.snapshot().inFlight).toBe(true); }, async (body, credential) => {
    expect(persisted).toBe(true); expect(credential).toBe(key);
    const request = JSON.parse(body);
    expect(request.model).toBe("jev-1.13.0"); expect(request.state.block).toBe(recording.frames[150]!.book.block);
    expect(request.questions.direction.type).toBe("choice"); expect(body).not.toContain(key);
    return fixtureResponse();
  });
  expect(result.action).toBe("buy"); expect(result.inputTokens).toBe(1000);
  expect(budget.snapshot().reportedCostUsd).toBe(0.000042);
});
test("unavailable usage, cancellation and provider failure retain their full reservation with no retry", async () => {
  for (const response of [null, { ...fixtureResponse(), usage: {} }, fixtureResponse(JEV_INPUT_TOKEN_CEILING + 1)]) {
    const budget = new JevBudget(INITIAL_JEV_LIMITS); let calls = 0;
    await expect(requestJev(state, key, budget, new AbortController().signal, () => {}, async () => { calls++; if (!response) throw new Error(`provider echoed ${key}`); return response; })).rejects.toThrow();
    expect(calls).toBe(1); expect(budget.snapshot().uncertainCostUsd).toBe(0.002752512);
    expect(budget.snapshot().inFlight).toBe(false);
  }
});
test("malformed probabilities/model and a broken journal cannot produce a decision", async () => {
  for (const response of [{ ...fixtureResponse(), model: "different" }, { ...fixtureResponse(), answers: { direction: { type: "choice", choice: "buy", probabilities: { buy: 0.1, sell: 0.9 } } } }]) {
    await expect(requestJev(state, key, new JevBudget(INITIAL_JEV_LIMITS), new AbortController().signal, () => {}, async () => response)).rejects.toThrow("invalid_provider_response");
  }
  let calls = 0;
  await expect(requestJev(state, key, new JevBudget(INITIAL_JEV_LIMITS), new AbortController().signal, () => { throw new Error("disk unavailable"); }, async () => { calls++; return fixtureResponse(); })).rejects.toThrow("request_failed");
  expect(calls).toBe(0);
});
test("recorded Jev session requires explicit approval, honors limits and never writes a key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-session-test-"));
  try {
    let calls = 0;
    const session = new RecordedJevSession(recording, dir, () => {}, async () => { calls++; return fixtureResponse(); }, async () => {});
    expect(session.phase).toBe("ready"); expect(calls).toBe(0);
    expect(() => session.start(key, INITIAL_JEV_LIMITS, false)).toThrow("approval_required");
    session.start(key, { ...INITIAL_JEV_LIMITS, maxRequests: 2 }, true);
    expect(() => session.start(key, INITIAL_JEV_LIMITS, true)).toThrow("already_running");
    await session.settled();
    expect(calls).toBe(2); expect(session.phase).toBe("budget_limit");
    expect(session.history[0]!.block).toBe(recording.frames[150]!.book.block);
    expect(session.history[0]!.fills).toHaveLength(0); // first decision cannot fill in its own block
    expect(session.history.at(-1)!.totals.jevUsd).toBeCloseTo(0.000084, 12);
    expect(session.history.at(-1)!.resting).toEqual({ bidMon: 0, askMon: 0 });
    const runDir = join(dir, session.runId!);
    for (const name of readdirSync(runDir)) expect(readFileSync(join(runDir, name), "utf8")).not.toContain(key);
    expect(JSON.stringify(session.snapshot())).not.toContain(key);
  } finally { rmSync(dir, { recursive: true }); }
});
test("Stop during an in-flight response cannot place a new order or leak the key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-stop-test-"));
  try {
    let resolve!: (value: unknown) => void;
    const session = new RecordedJevSession(recording, dir, () => {}, async () => new Promise(r => { resolve = r; }), async () => {});
    session.start(key, INITIAL_JEV_LIMITS, true); session.stop(); resolve(fixtureResponse()); await session.settled();
    expect(session.phase).toBe("stopped"); expect(session.history.at(-1)!.totals.quotes).toBe(0);
    expect(session.metadata().budget!.attempts).toBe(1);
  } finally { rmSync(dir, { recursive: true }); }
});
test("provider errors stop the session with conservative unknown cost and no mock fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-error-test-"));
  try {
    let calls = 0;
    const session = new RecordedJevSession(recording, dir, () => {}, async () => { calls++; throw new Error(key); }, async () => {});
    session.start(key, INITIAL_JEV_LIMITS, true); await session.settled();
    expect(calls).toBe(1); expect(session.phase).toBe("error"); expect(session.reason).toBe("request_failed");
    expect(session.history.at(-1)!.totals.decisions).toBe(0); expect(session.history.at(-1)!.totals.quotes).toBe(0);
    expect(session.history.at(-1)!.totals.jevUsd).toBe(0.002752512);
    expect(JSON.stringify(session.snapshot())).not.toContain(key);
  } finally { rmSync(dir, { recursive: true }); }
});
