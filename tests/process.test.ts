import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isPaperProcess } from "../src/paper-process";
import { syntheticFrames } from "./fixtures";

const control = resolve(import.meta.dir, "../scripts/paper-control.ts");
const invoke = async (args: string[]) => {
  const p = Bun.spawn([process.execPath, "--no-env-file", control, ...args], { env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

test("offline start/status/stop, duplicate start, and durable stopped account", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-control-"));
  const fixture = join(dir, "fixture.jsonl");
  writeFileSync(fixture, syntheticFrames(600).map(f => JSON.stringify(f)).join("\n"));
  const base = ["--source", "fixture", "--data-dir", dir];
  try {
    const start = await invoke(["start", ...base, "--fixture", fixture, "--seconds", "10", "--interval-ms", "10"]);
    expect(start.code).toBe(0);
    expect(JSON.parse(start.out).running).toBe(true);
    const duplicate = await invoke(["start", ...base, "--fixture", fixture]);
    expect(duplicate.code).not.toBe(0); expect(duplicate.err).toContain("already running");
    const status = await invoke(["status", ...base]);
    expect(JSON.parse(status.out).model).toBe("mock"); expect(JSON.parse(status.out).paidInferenceUsd).toBe(0);
    const stop = await invoke(["stop", ...base]);
    expect(stop.code).toBe(0); expect(JSON.parse(stop.out).running).toBe(false); expect(JSON.parse(stop.out).phase).toBe("stopped");
    const checkpoint = JSON.parse(readFileSync(join(dir, "account.json"), "utf8"));
    expect(checkpoint.data.paper.state.block).toBeGreaterThan(0); expect(checkpoint.data.paper.state.order).toBeNull();
  } finally {
    await invoke(["stop", ...base]);
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test("PID identity mismatch never targets the test process; public mode needs explicit choice", async () => {
  expect(isPaperProcess({ pid: process.pid, runId: "00000000-0000-0000-0000-000000000000" })).toBe(false);
  const missing = await invoke(["start"]); expect(missing.code).not.toBe(0); expect(missing.err).toContain("Usage");
  const unsafe = await invoke(["start", "--source", "public", "--interval-ms", "1"]); expect(unsafe.code).not.toBe(0);
});
