import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fastCapacity, accountReadiness } from "../src/paper-readiness";
import { PaperSession } from "../src/paper-session";
import { frame } from "./fixtures";

test("capacity uses weighted method costs and flags the real free-tier throughput shortfall", () => {
  const r = fastCapacity(3600, 2000);
  expect(r.decisionsAtEveryBlock).toBe(12000);
  expect(r.steadyMethodsPerSecond.currentSingleBlock).toBe(20);
  expect(r.alchemyCuPerSecond.pairedCatchup).toBeGreaterThan(500);
  expect(r.alchemyCuPerSecond.currentSingleBlock).toBe(560);
  expect(r.quicknodeCreditsAtEveryBlock.high).toBe(2160000);
  expect(fastCapacity(900).quicknodeCreditsAtEveryBlock.low).toBe(495000);
  expect(r.jev.estimatedUsdAtEveryBlock).toBeCloseTo(1.008, 10);
  expect(() => fastCapacity(0)).toThrow(); expect(() => fastCapacity(60, -1)).toThrow();
});

test("offline doctor distinguishes saved, halted and corrupt accounts without altering them", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-doctor-"));
  try {
    expect(accountReadiness(dir).state).toBe("not_started");
    const account = new PaperSession(dir, "fixture:doctor"); account.step(frame(1));
    expect(accountReadiness(dir).state).toBe("saved");
    account.fail(); const path = join(dir, "account.json"), before = readFileSync(path, "utf8");
    expect(accountReadiness(dir).halted).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(before);
    writeFileSync(path, "{}"); expect(accountReadiness(dir).valid).toBe(false);
    rmSync(path); expect(accountReadiness(dir).state).toBe("missing_checkpoint");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
