import { expect, test } from "bun:test";
import { Trader, type BlockEvent } from "../src/trader";
import { Market } from "../src/market";
import { MockModel, type Decision, type Model } from "../src/model";
import { frame } from "./fixtures";
import type { TradePrint } from "../src/trades";
import { quotePrice } from "../src/replay";

const decision = (action: "buy" | "sell" | "hold" = "buy"): Decision => ({ action, probabilities: { buy: action === "buy" ? 1 : 0, sell: action === "sell" ? 1 : 0, hold: action === "hold" ? 1 : 0 }, upIn10: 1, latencyMs: 0, inputTokens: 0 });
function setup(model: Model = { name: "fixture", decide: async () => decision() }) {
  const events: BlockEvent[] = [];
  let prints: TradePrint[] = [];
  let currentBlock = 0;
  const feed = { lastBlock: 0, poll: async (block: number) => { feed.lastBlock = block; }, drainPrints: () => { const out = prints; prints = []; return out; } };
  const trader = new Trader({ readBook: async block => { currentBlock = block!; return frame(block!).book; }, quotePrice }, model, e => events.push(e), undefined, undefined, false, () => frame(currentBlock).timestampMs);
  trader.setTradeFeed(feed);
  return { trader, events, feed, setPrints: (p: TradePrint[]) => { prints = p; } };
}

test("Market cannot create a wallet or send a transaction", async () => {
  const m = new Market(); expect(m.wallet).toBeNull(); expect(m.address).toBeNull();
  m.params = { pricePrecision: { toString: () => "100000000" }, tickSize: { toString: () => "100" } } as any;
  const q = await m.send(1, "buy", 200, frame(1).book, [], false);
  expect(q.status).toBe("sim"); expect(q.txHash).toBeNull();
});

test("PRIVATE_KEY presence cannot enable live mode; explicit live config fails", () => {
  const run = (dryRun: string) => Bun.spawnSync([process.execPath, "--no-env-file", "-e", 'import {config} from "./src/config"; console.log(config.dryRun);'], { cwd: process.cwd(), env: { DRY_RUN: dryRun, PRIVATE_KEY: "dummy-not-a-key" }, stdout: "pipe", stderr: "pipe" });
  expect(run("true").stdout.toString().trim()).toBe("true");
  const denied = run("false"); expect(denied.exitCode).not.toBe(0); expect(denied.stderr.toString()).toContain("Live trading is disabled");
});

test("loop harvests prior order before placing the next, with no ghost inventory", async () => {
  const { trader, events, setPrints } = setup();
  await trader.onBlock(1);
  const bid = events[0]!.quote!.price;
  setPrints([{ block: 2, side: "sell", price: bid - 0.000001, size: 800 }]);
  await trader.onBlock(2);
  expect(events[1]!.position.size).toBe(200); expect(events[1]!.fill?.size).toBe(200);
  expect(events[1]!.totals.gasUsd).toBeCloseTo(2 * 0.0357 * 0.02, 10);
  expect(events[1]!.totals.jevUsd).toBe(0);
});

test("unavailable model side is skipped, not reversed", async () => {
  const { trader, events } = setup({ name: "fixture", decide: async () => decision("sell") });
  await trader.onBlock(1);
  expect(events[0]!.decision!.action).toBe("sell"); expect(events[0]!.quote).toBeNull(); expect(trader.paper.mon).toBe(0);
});

test("hold is honored and duplicate block notifications do not place twice", async () => {
  const { trader, events } = setup({ name: "fixture", decide: async () => decision("hold") });
  await trader.onBlock(1); await trader.onBlock(1);
  expect(events.length).toBe(1); expect(events[0]!.quote).toBeNull();
});

test("late inference is discarded when a newer block arrives", async () => {
  let resolve!: (d: Decision) => void;
  const { trader, events } = setup({ name: "fixture", decide: () => new Promise(r => { resolve = r; }) });
  const pending = trader.onBlock(1);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  await trader.onBlock(2); resolve(decision()); await pending;
  expect(events[0]!.decision!.late).toBe(true); expect(events[0]!.quote).toBeNull();
  await trader.onBlock(3); expect(trader.paper.halted).toBe(true);
});

test("incomplete trade feed halts and cancels existing paper orders", async () => {
  const { trader, feed, events } = setup(); await trader.onBlock(1);
  feed.poll = async () => {};
  await trader.onBlock(2);
  expect(trader.paper.halted).toBe(true); expect(trader.paper.order).toBeNull();
  expect(events.at(-1)!.totals.halted).toBe(true);
});

test("invalid model response fails closed", async () => {
  const { trader } = setup({ name: "fixture", decide: async () => ({ ...decision(), inputTokens: NaN }) });
  await trader.onBlock(1); expect(trader.paper.halted).toBe(true); expect(trader.paper.quotes).toBe(0);
});

test("mock model incurs no fictitious inference bill", async () => {
  const model = new MockModel();
  const { trader, events } = setup(model); await trader.onBlock(1);
  expect(events[0]!.totals.jevUsd).toBe(0);
});
