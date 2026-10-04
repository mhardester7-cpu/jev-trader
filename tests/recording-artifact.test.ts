import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";

const recording = join(import.meta.dir, "../research/mon-usdc-20260917");
const run = (dir: string) => Bun.spawnSync([process.execPath, "--no-env-file", "--preload", "./tests/offline.ts", "scripts/paper-free-replay.ts", dir], {
  cwd: join(import.meta.dir, ".."), env: { DRY_RUN: "true", MODEL: "mock" }, stdout: "pipe", stderr: "pipe",
});
test("bundled authentic recording reproduces the committed report with network disabled", () => {
  const result = run(recording);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(readFileSync(join(import.meta.dir, "../docs/paper-evaluation.recorded.json"), "utf8"));
  const report = JSON.parse(result.stdout.toString());
  expect(report.observation.blocks).toBe(600);
  expect(report.observation.tradePrints).toBe(262);
  expect(report.cases[0].continuous.netLiquidationPnlUsd).toBeLessThan(0);
});
test("offline report rejects altered raw provenance even when normalized frames are intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-recording-tamper-"));
  try {
    for (const name of ["manifest.json", "frames.jsonl"]) copyFileSync(join(recording, name), join(dir, name));
    const cache = JSON.parse(gunzipSync(readFileSync(join(recording, "cache.json.gz"))).toString("utf8"));
    cache.entries.chain.result = "0x1";
    writeFileSync(join(dir, "cache.json"), JSON.stringify(cache));
    const result = run(dir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Recording raw cache checksum mismatch");
    expect(result.stdout.length).toBe(0);
  } finally { rmSync(dir, { recursive: true }); }
});
