import { expect, test } from "bun:test";
import { collectHistoricalBatches, decodeHistory, emptyHistoricalCache, historicalHash, planHistory, validateHistoricalCache, type HistoricalCache } from "../src/historical";
import raw from "./fixtures/mon-usdc-rpc-block.json";
import next from "./fixtures/mon-usdc-rpc-next-block.json";

function put(cache: HistoricalCache, id: string, result: unknown) {
  cache.entries[id] = { result: structuredClone(result), sha256: historicalHash(result), retrievedAt: "2026-10-03T16:43:36Z" };
}
function recordedPair() {
  const cache = emptyHistoricalCache();
  put(cache, "chain", "0x8f");
  for (const frame of [raw, next]) for (const part of ["header", "book", "vault", "params"] as const) put(cache, `${frame.block}-${part}`, frame[part]);
  put(cache, `logs-${raw.block}-${next.block}`, [...raw.logs, ...next.logs]);
  return cache;
}
test("historical planning is bounded, pinned and cache-aware", () => {
  const cache = recordedPair(), plan = planHistory(raw.block, 600, cache);
  expect(plan.end).toBe(raw.block + 599);
  expect(plan.requests.length).toBeLessThan(2500);
  expect(plan.requests.every(q => ["eth_getBlockByNumber", "eth_call", "eth_getLogs"].includes(q.method))).toBe(true);
  expect(plan.requests.some(q => q.id === `${raw.block}-book`)).toBe(false);
  expect(plan.logs[0]).toEqual({ id: `logs-${raw.block}-${next.block}`, from: raw.block, to: next.block });
  expect(plan.logs.at(-1)!.to).toBe(plan.end);
  plan.logs.forEach((r, i) => {
    expect(r.to - r.from).toBeLessThan(100);
    if (i) expect(r.from).toBe(plan.logs[i - 1]!.to + 1);
  });
  expect(() => planHistory(raw.block, 601, cache)).toThrow("1..600");
  expect(() => planHistory(Number.MAX_SAFE_INTEGER, 2, cache)).toThrow("1..600");
});
test("historical cache rejects changed identity or content", () => {
  const cache = recordedPair();
  cache.entries.chain!.result = "0x1";
  expect(() => validateHistoricalCache(cache)).toThrow("checksum");
  const wrong = recordedPair(); wrong.endpoint = "https://example.invalid";
  expect(() => validateHistoricalCache(wrong)).toThrow("identity");
});
test("historical decode preserves authentic consecutive observations deterministically", () => {
  const cache = recordedPair(), before = historicalHash(cache);
  const a = decodeHistory(raw.block, 2, cache), b = decodeHistory(raw.block, 2, cache);
  expect(a.completeBlocks).toBe(2); expect(a.missingBlocks).toBe(0);
  expect(a.frames.map(f => f.book.block)).toEqual([raw.block, next.block]);
  expect(a.frames.flatMap(f => f.prints).length).toBe(raw.logs.length + next.logs.length);
  expect(a.datasetSha256).toBe(b.datasetSha256);
  expect(historicalHash(cache)).toBe(before);
});
test("missing historical fields stop the contiguous prefix without fabrication", () => {
  const cache = recordedPair(); delete cache.entries[`${next.block}-params`];
  expect(decodeHistory(raw.block, 2, cache).completeBlocks).toBe(1);
  delete cache.entries[`${raw.block}-header`];
  expect(decodeHistory(raw.block, 2, cache).completeBlocks).toBe(0);
  const noLogs = recordedPair(); delete noLogs.entries[`logs-${raw.block}-${next.block}`];
  expect(decodeHistory(raw.block, 2, noLogs).completeBlocks).toBe(0);
});
test("historical chain breaks and malformed or foreign logs fail closed", () => {
  const cache = recordedPair();
  put(cache, `${next.block}-header`, { ...next.header, parentHash: "0xwrong" });
  expect(() => decodeHistory(raw.block, 2, cache)).toThrow("continuity");
  for (const change of [{ blockNumber: "garbage" }, { blockNumber: "0x1" }, { address: "0xwrong" }]) {
    const bad = recordedPair();
    put(bad, `logs-${raw.block}-${next.block}`, [{ ...raw.logs[0], ...change }]);
    expect(() => decodeHistory(raw.block, 2, bad)).toThrow("market/window");
  }
});
test("collector sends at most three methods per 1.1 seconds and persists complete batches", async () => {
  const cache = emptyHistoricalCache(), requests = planHistory(raw.block, 2, cache).requests;
  let now = 0, saves = 0, active = 0;
  const starts: number[] = [];
  const result = await collectHistoricalBatches(requests, cache, {
    now: () => now, sleep: async ms => { now += ms; }, save: () => { saves++; },
    transport: async batch => {
      expect(++active).toBe(1); expect(batch.length).toBeLessThanOrEqual(3); starts.push(now);
      now += 100; active--;
      return [...batch].reverse().map(q => ({ id: q.id, result: q.id === "chain" ? "0x8f" : [] }));
    },
  });
  expect(result.completedMethods).toBe(requests.length);
  expect(saves).toBe(Math.ceil(requests.length / 3));
  starts.slice(1).forEach((s, i) => expect(s - starts[i]!).toBeGreaterThanOrEqual(1100));
  validateHistoricalCache(cache);
});
test("HTTP 429 stops collection without retry, keeping only previous completed batches", async () => {
  const cache = emptyHistoricalCache(); let calls = 0, now = 0;
  await expect(collectHistoricalBatches(planHistory(raw.block, 2, cache).requests, cache, {
    now: () => now, sleep: async ms => { now += ms; }, save: () => {},
    transport: async batch => {
      if (++calls === 2) throw new Error("HTTP 429");
      return batch.map(q => ({ id: q.id, result: q.id === "chain" ? "0x8f" : [] }));
    },
  })).rejects.toThrow("429");
  expect(calls).toBe(2); expect(Object.keys(cache.entries).length).toBe(3);
});
test("malformed, wrong-chain and RPC-error batches are not partially cached", async () => {
  for (const mode of ["duplicate", "chain", "error"]) {
    const cache = emptyHistoricalCache(); let calls = 0;
    await expect(collectHistoricalBatches(planHistory(raw.block, 1, cache).requests, cache, {
      now: () => 0, sleep: async () => {}, save: () => { throw new Error("Should not save"); },
      transport: async batch => {
        calls++;
        const result: any[] = batch.map(q => ({ id: q.id, result: q.id === "chain" ? "0x8f" : [] }));
        if (mode === "duplicate") result[1] = result[0];
        if (mode === "chain") result[0].result = "0x1";
        if (mode === "error") result[2] = { id: batch[2]!.id, error: { code: -32000 } };
        return result;
      },
    })).rejects.toThrow();
    expect(calls).toBe(1); expect(Object.keys(cache.entries)).toHaveLength(0);
  }
});
test("collection time and method budgets prevent additional requests", async () => {
  const cache = emptyHistoricalCache(), requests = planHistory(raw.block, 2, cache).requests;
  let now = 0, calls = 0;
  const result = await collectHistoricalBatches(requests, cache, {
    now: () => now, sleep: async ms => { now += ms; }, save: () => {},
    transport: async batch => { calls++; now = 895000; return batch.map(q => ({ id: q.id, result: q.id === "chain" ? "0x8f" : [] })); },
  });
  expect(calls).toBe(1); expect(result.stopReason).toContain("15-minute");
  await expect(collectHistoricalBatches(Array.from({ length: 2501 }, () => requests[0]!), cache, {
    now: () => 0, sleep: async () => {}, save: () => {}, transport: async () => { throw new Error("No transport permitted"); },
  })).rejects.toThrow("2500");
});
