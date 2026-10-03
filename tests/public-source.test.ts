import { expect, test } from "bun:test";
import { captureBlocks, PublicPaperSource } from "../src/paper-source";
import raw from "./fixtures/mon-usdc-rpc-block.json";
import next from "./fixtures/mon-usdc-rpc-next-block.json";

const responses = () => structuredClone([raw.header, raw.book, raw.vault, raw.params, raw.logs]);
test("public source decodes an authentic RPC fixture using read-only methods", async () => {
  const source = new PublicPaperSource(10, async queries => {
    expect(queries.map(q => q.method)).toEqual(["eth_getBlockByNumber", "eth_call", "eth_call", "eth_call", "eth_getLogs"]);
    expect(queries.filter(q => q.method === "eth_call").every(q => (q.params[0] as any).to === "0x065C9d28E428A0db40191a54d33d5b7c71a9C394")).toBe(true);
    return responses();
  });
  const f = await source.frame(raw.block);
  expect(f.book.block).toBe(raw.block); expect(f.blockHash).toBe(raw.header.hash);
  expect(f.timestampMs).toBe(parseInt(raw.header.timestamp, 16) * 1000);
  expect(f.prints.length).toBe(raw.logs.length); expect(f.makerFeeBps).toBe(0); expect(f.takerFeeBps).toBe(0);
  expect(source.queries).toBe(5);
});
test("duplicate/future logs and wrong blocks cannot enter the paper source", async () => {
  const duplicate = responses() as any[]; duplicate[4].push(duplicate[4][0]);
  await expect(new PublicPaperSource(10, async () => duplicate).frame(raw.block)).rejects.toThrow("Duplicate");
  const wrong = responses() as any[]; wrong[4][0].blockNumber = "0x1";
  await expect(new PublicPaperSource(10, async () => wrong).frame(raw.block)).rejects.toThrow("mismatched");
});
test("chain and request budgets fail closed before extra transport calls", async () => {
  await expect(new PublicPaperSource(1, async () => ["0x1"]).verifyChain()).rejects.toThrow("Unexpected chain");
  let called = false;
  await expect(new PublicPaperSource(4, async () => { called = true; return []; }).frame(raw.block)).rejects.toThrow("budget");
  expect(called).toBe(false);
});

test("two-block capture uses one bounded batch with complete ordered trade windows", async () => {
  let calls = 0;
  const source = new PublicPaperSource(10, async queries => {
    calls++;
    expect(queries.length).toBe(10);
    expect((queries[4]!.params[0] as any).fromBlock).toBe("0x" + raw.block.toString(16));
    expect((queries[9]!.params[0] as any).fromBlock).toBe("0x" + next.block.toString(16));
    return [...responses(), next.header, next.book, next.vault, next.params, next.logs];
  });
  const frames = await source.frames([raw.block, next.block]);
  expect(calls).toBe(1); expect(source.queries).toBe(10);
  expect(frames.map(f => f.book.block)).toEqual([raw.block, next.block]);
  expect(frames[1]!.parentHash).toBe(frames[0]!.blockHash);
  expect(frames.flatMap(f => f.prints).length).toBe(raw.logs.length + next.logs.length);
  await expect(source.frames([1, 3])).rejects.toThrow("consecutive");
  await expect(source.frames([1, 2, 3])).rejects.toThrow("one or two");
  expect(calls).toBe(1);
});

test("bounded catch-up never skips an intermediate block inside its limit", () => {
  expect(captureBlocks(0, 100)).toEqual([100]);
  expect(captureBlocks(100, 100)).toEqual([]);
  expect(captureBlocks(100, 101)).toEqual([101]);
  expect(captureBlocks(100, 120)).toEqual([101, 102]);
  const captured: number[] = [];
  let last = 100;
  while (last < 120) { const batch = captureBlocks(last, 120); captured.push(...batch); last = batch.at(-1)!; }
  expect(captured).toEqual(Array.from({ length: 20 }, (_, i) => 101 + i));
  // Intentionally discontinuous: the ledger observes the too-large gap and halts.
  expect(captureBlocks(100, 121)).toEqual([121]);
});
