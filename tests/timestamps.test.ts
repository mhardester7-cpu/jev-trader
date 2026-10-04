import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PaperExecution, type PaperFrame } from "../src/paper";
import { REPLAY_OPTIONS, evaluate, replay } from "../src/replay";
import { syntheticFrames } from "./fixtures";
import provenance from "./fixtures/mon-usdc-24-blocks.provenance.json";

const authentic: PaperFrame[] = (await Bun.file(`${import.meta.dir}/fixtures/mon-usdc-24-blocks.jsonl`).text()).trim().split("\n").map(line => JSON.parse(line));

test("authentic 24-block sample replays without inventing finer timestamps", () => {
  const before = JSON.stringify(authentic);
  expect(createHash("sha256").update(before).digest("hex")).toBe(provenance.normalizedFramesSha256);
  expect(authentic.filter((f, i) => i > 0 && f.timestampMs === authentic[i - 1]!.timestampMs).length).toBe(16);
  const result = replay(authentic);
  expect(result.blocks).toBe(24);
  expect(result.startBlock).toBe(105488246); expect(result.endBlock).toBe(105488269);
  expect(result.halted).toBe(false);
  expect(JSON.stringify(authentic)).toBe(before);
  expect(replay(authentic)).toEqual(result);
});

test("equal timestamps still require unique increasing block identifiers", () => {
  const p = new PaperExecution(REPLAY_OPTIONS);
  p.advance(authentic[0]!);
  expect(() => p.advance(authentic[0]!)).toThrow("increase strictly");
  const duplicate = structuredClone(authentic); duplicate[1] = structuredClone(duplicate[0]!);
  expect(() => replay(duplicate)).toThrow("consecutive, unique");
  const reversed = structuredClone(authentic); [reversed[0], reversed[1]] = [reversed[1]!, reversed[0]!];
  expect(() => replay(reversed)).toThrow("consecutive, unique");
});

test("decreasing timestamps reject even if block numbers increase", () => {
  const frames = structuredClone(authentic); frames[1]!.timestampMs = frames[0]!.timestampMs - 1000;
  expect(() => replay(frames)).toThrow("must not decrease");
  const p = new PaperExecution(REPLAY_OPTIONS); p.advance(frames[0]!);
  expect(() => p.advance(frames[1]!)).toThrow("must not decrease");
});

test("future trade prints and malformed warmup cannot enter scored features", () => {
  const future = structuredClone(authentic);
  future[0]!.prints.push({ block: future[0]!.book.block + 1, price: future[0]!.book.mid, side: "buy", size: 1 });
  expect(() => replay(future, REPLAY_OPTIONS, 10)).toThrow("completed block");
  const wrongPrefix = syntheticFrames(); wrongPrefix[149] = structuredClone(wrongPrefix[160]!);
  expect(() => replay(wrongPrefix, REPLAY_OPTIONS, 150, 300)).toThrow("consecutive, unique");
});

test("forward evaluation accepts second-resolution chronology and rejects reversals", () => {
  const frames = syntheticFrames(); frames.forEach(f => { f.timestampMs = Math.floor(f.timestampMs / 1000) * 1000; });
  expect(evaluate(frames).folds.length).toBe(3);
  frames[200]!.timestampMs = frames[199]!.timestampMs - 1000;
  expect(() => evaluate(frames)).toThrow("must not decrease");
});

test("future data cannot change earlier actions with duplicate second timestamps", () => {
  const original = replay(authentic);
  const changed = structuredClone(authentic);
  for (let i = 16; i < changed.length; i++) changed[i]!.book.imbalance = -changed[i]!.book.imbalance;
  const result = replay(changed);
  const boundary = authentic[16]!.book.block;
  expect(result.orders.filter(o => o.block < boundary)).toEqual(original.orders.filter(o => o.block < boundary));
  expect(result.equity.filter(e => e.block < boundary)).toEqual(original.equity.filter(e => e.block < boundary));
});
