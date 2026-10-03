import { expect, test } from "bun:test";
import { historicalHash } from "../src/historical";
import { PAPER_MARKET, PUBLIC_RPC, PublicPaperSource, type ChainFrame } from "../src/paper-source";
import { evaluateRecording, RECORDING_PROTOCOL, type RecordingManifest } from "../src/recording-report";
import { syntheticFrames } from "./fixtures";
import raw from "./fixtures/mon-usdc-rpc-block.json";
import next from "./fixtures/mon-usdc-rpc-next-block.json";

function manifest(frames: ChainFrame[]): RecordingManifest {
  return { version: 1, endpoint: PUBLIC_RPC, chainId: 143, market: PAPER_MARKET, requestedStart: frames[0]!.book.block, requestedEnd: frames.at(-1)!.book.block, requestedBlocks: frames.length, completeBlocks: frames.length, missingBlocks: 0, firstTimestampMs: frames[0]!.timestampMs, lastTimestampMs: frames.at(-1)!.timestampMs, datasetSha256: historicalHash(frames), cacheSha256: "unit-test-only", stopReason: "Unit fixture" };
}
function pair() {
  const reader = new PublicPaperSource(0);
  return [raw, next].map(r => reader.decodeFrame(r.block, [r.header, r.book, r.vault, r.params, structuredClone(r.logs)]));
}
test("an authentic short recording is disclosed as insufficient, never padded or scored", () => {
  const frames = pair(), result = evaluateRecording(frames, manifest(frames));
  expect(result.status).toBe("insufficient_data"); expect(result.cases).toEqual([]);
  expect(result.observation.blocks).toBe(2);
  expect(result.observation.tradePrints).toBe(raw.logs.length + next.logs.length);
  expect(result.protocol.minimumBlocks).toBe(300);
});
test("recording reports reject corrupted content, boundaries and metadata", () => {
  const frames = pair(), m = manifest(frames);
  expect(() => evaluateRecording(frames, { ...m, datasetSha256: "wrong" })).toThrow("checksum");
  expect(() => evaluateRecording(frames, { ...m, completeBlocks: 3 })).toThrow("count");
  expect(() => evaluateRecording(frames, { ...m, firstTimestampMs: 1 })).toThrow("boundaries");
  expect(() => evaluateRecording(frames, { ...m, chainId: 1 })).toThrow("identity");
  frames[1]!.parentHash = "0x" + "0".repeat(64);
  expect(() => evaluateRecording(frames, manifest(frames))).toThrow("discontinuous");
});
test("fixed base/stress reporting remains deterministic and does not use future scoring windows", () => {
  // Explicit synthetic software fixture; never exported as observed market data.
  const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
  const frames = syntheticFrames(450).map((f, i): ChainFrame => ({ ...f, blockHash: hash(i + 1), parentHash: hash(i), baseFeeWei: "100000000000", makerFeeBps: 0, takerFeeBps: 0 }));
  const before = JSON.stringify(frames), result = evaluateRecording(frames, manifest(frames));
  expect(result).toEqual(evaluateRecording(frames, manifest(frames)));
  expect(JSON.stringify(frames)).toBe(before);
  expect(RECORDING_PROTOCOL).toEqual({ warmup: 150, window: 150 });
  expect(result.cases.map(c => c.name)).toEqual(["base", "higherCosts"]);
  expect(result.cases[0]!.forwardWindows.folds.length).toBe(2);
  expect(result.cases[0]!.continuous.blocks).toBe(300);
  expect(result.cases[1]!.forwardWindows.options.gasMon).toBe(0.0714);
  for (const frame of frames.slice(300)) frame.book.imbalance = -frame.book.imbalance;
  const changed = evaluateRecording(frames, manifest(frames));
  expect(changed.cases[0]!.forwardWindows.folds[0]).toEqual(result.cases[0]!.forwardWindows.folds[0]);
  expect(changed.cases[1]!.forwardWindows.folds[0]).toEqual(result.cases[1]!.forwardWindows.folds[0]);
});
