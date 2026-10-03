import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaperExecution } from "../src/paper";
import { REPLAY_OPTIONS } from "../src/replay";
import { PaperSession } from "../src/paper-session";
import { frame, syntheticFrames } from "./fixtures";

test("checkpoint preserves ledger, resting order, day loss and halt through restart", () => {
  const p = new PaperExecution(REPLAY_OPTIONS); p.advance(frame(1)); p.place("buy", 200, 0.02, frame(1).book);
  const restored = PaperExecution.restore(JSON.parse(JSON.stringify(p.checkpoint())));
  expect(restored.checkpoint()).toEqual(p.checkpoint());
  const next = frame(2); next.prints = [{ block: 2, side: "sell", price: 0.0199, size: 800 }];
  expect(restored.advance(next)).toEqual(p.advance(next));
  expect(restored.snapshot(next.book)).toEqual(p.snapshot(next.book));
  p.dailyPaused = true; p.halt();
  const halted = PaperExecution.restore(p.checkpoint());
  expect(halted.dailyPaused).toBe(true); expect(halted.halted).toBe(true); expect(halted.mon).toBe(200);
});

test("corrupt or incompatible checkpoints fail rather than resetting funds", () => {
  const p = new PaperExecution(REPLAY_OPTIONS); p.advance(frame(1));
  const wrongCash = p.checkpoint(); wrongCash.state.cashUsd = 200;
  expect(() => PaperExecution.restore(wrongCash)).toThrow("reconcile");
  const missing = p.checkpoint(); delete missing.state.dailyStartUsd;
  expect(() => PaperExecution.restore(missing)).toThrow("fields");
  const badNumber = p.checkpoint(); badNumber.state.mon = NaN;
  expect(() => PaperExecution.restore(badNumber)).toThrow();
});

test("durable session restores balances without mixing source or resetting daily risk", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-session-"));
  try {
    const s = new PaperSession(dir, "fixture:test");
    syntheticFrames(110).forEach(f => s.step(f));
    s.paper.dailyPaused = true; s.stop();
    const saved = s.paper.checkpoint();
    const resumed = new PaperSession(dir, "fixture:test");
    expect(resumed.paper.checkpoint()).toEqual(saved);
    expect(resumed.paper.dailyPaused).toBe(true);
    expect(resumed.paper.order).toBeNull();
    expect(() => new PaperSession(dir, "public:other")).toThrow("identity");
    const account = JSON.parse(readFileSync(join(dir, "account.json"), "utf8"));
    account.data.paper.state.cashUsd += 10;
    writeFileSync(join(dir, "account.json"), JSON.stringify(account));
    expect(() => new PaperSession(dir, "fixture:test")).toThrow("checksum");
    rmSync(join(dir, "account.json"));
    expect(() => new PaperSession(dir, "fixture:test")).toThrow("refusing to reset");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("entry gating warms up and rejects stale decisions while processing exits/fills", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-session-"));
  try {
    const s = new PaperSession(dir, "fixture:test");
    const frames = syntheticFrames(110);
    for (const f of frames.slice(0, 99)) expect(s.step(f).order).toBeNull();
    const late = s.step(frames[99]!, false);
    expect(late.warmedUp).toBe(true); expect(late.order).toBeNull();
    expect(s.paper.quotes).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
