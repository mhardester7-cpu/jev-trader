import { describe, expect, test } from "bun:test";
import { PaperExecution, validateFrame } from "../src/paper";
import { REPLAY_OPTIONS, evaluate, replay } from "../src/replay";
import { frame, syntheticFrames } from "./fixtures";

const options = { ...REPLAY_OPTIONS, gasMon: 0, makerFeeBps: 0, exitFeeBps: 0, slippageBps: 0, participation: 1, maxDrawdownPct: 100, stopLossPct: 100, takeProfitPct: 100, maxDailyLossPct: 100, maxPositionEquityPct: 100, riskPerTradePct: 100 };
const engine = () => new PaperExecution(options);

describe("paper order timing and execution", () => {
  test("an order cannot fill on information from its placement block", () => {
    const p = engine(), f = frame(1);
    f.prints = [{ block: 1, side: "sell", price: 0.019, size: 200 }];
    expect(p.advance(f)).toEqual([]);
    expect(p.place("buy", 200, 0.02, f.book)).not.toBeNull();
    expect(p.mon).toBe(0);
    expect(() => p.advance(f)).toThrow("increase strictly");
  });
  test("touch does not fill; unfilled order expires before the following block", () => {
    const p = engine(); p.advance(frame(1)); p.place("buy", 200, 0.02, frame(1).book);
    const f = frame(2); f.prints = [{ block: 2, side: "sell", price: 0.02, size: 1000 }];
    expect(p.advance(f)).toEqual([]);
    const next = frame(3); next.prints = [{ block: 3, side: "sell", price: 0.019, size: 1000 }];
    expect(p.advance(next)).toEqual([]);
  });
  test("partial fills share one order and never exceed eligible participation", () => {
    const p = new PaperExecution({ ...options, participation: 0.25 });
    p.advance(frame(1)); p.place("buy", 200, 0.02, frame(1).book);
    const f = frame(2); f.prints = [{ block: 2, side: "sell", price: 0.019, size: 100 }, { block: 2, side: "buy", price: 0.021, size: 10000 }, { block: 2, side: "sell", price: 0.019, size: 1000 }];
    const fills = p.advance(f);
    expect(fills.map(f => f.size)).toEqual([25, 175]);
    expect(p.mon).toBe(200); expect(p.cashUsd).toBeCloseTo(96, 10);
    expect(p.order).toBeNull();
  });
  test("missing data halts and cancels; future or invalid prints reject atomically", () => {
    const p = engine(); p.advance(frame(1)); p.place("buy", 200, 0.02, frame(1).book);
    const bad = frame(2); bad.prints = [{ block: 3, side: "sell", price: 0.01, size: 1 }];
    expect(() => p.advance(bad)).toThrow("completed block");
    expect(p.mon).toBe(0);
    expect(p.advance(frame(3))).toEqual([]); expect(p.halted).toBe(true); expect(p.order).toBeNull();
  });
});

describe("cash, limits and costs", () => {
  test("cash and inventory bound orders, including fees, gas, and outstanding reservations", () => {
    const p = new PaperExecution({ ...options, bankrollUsd: 4, makerFeeBps: 10, gasMon: 0.1 });
    const b = frame(1).book; p.advance(frame(1));
    expect(p.place("sell", 200, 0.02, b)).toBeNull();
    expect(p.place("buy", 200, 0.02, b)).toBeNull();
    expect(p.place("buy", 100, 0.02, b)).not.toBeNull();
    expect(p.place("buy", 100, 0.02, b)).toBeNull();
    const cap = new PaperExecution({ ...options, maxPositionMon: 100 }); cap.advance(frame(1));
    expect(cap.place("buy", 101, 0.02, b)).toBeNull();
  });
  test("maker limit must not cross and invalid side/size cannot enter ledger", () => {
    const p = engine(), b = frame(1).book; p.advance(frame(1));
    expect(p.place("buy", 200, b.ask, b)).toBeNull();
    expect(() => p.place("buy", NaN, b.bid, b)).toThrow();
    expect(() => p.place("wrong" as any, 1, b.bid, b)).toThrow();
  });
  test("known round trip reconciles realized P&L, fees, gas and inference to cash", () => {
    const p = new PaperExecution({ ...options, makerFeeBps: 10, gasMon: 0.1 });
    p.advance(frame(1)); p.place("buy", 200, 0.02, frame(1).book);
    const f2 = frame(2); f2.prints = [{ block: 2, side: "sell", price: 0.019, size: 200 }]; p.advance(f2);
    p.advance(frame(3, 0.03)); p.chargeInference(0.001, frame(3, 0.03).book); p.place("sell", 200, 0.03, frame(3, 0.03).book);
    const f4 = frame(4, 0.03); f4.prints = [{ block: 4, side: "buy", price: 0.031, size: 200 }]; p.advance(f4);
    const s = p.snapshot(f4.book);
    expect(s.realizedUsd).toBeCloseTo(2, 10); expect(s.feesUsd).toBeCloseTo(0.01, 10);
    expect(s.gasUsd).toBeCloseTo(0.005, 10); expect(s.mon).toBe(0);
    expect(s.pnlUsd).toBeCloseTo(1.984, 10); expect(s.cashUsd).toBeCloseTo(101.984, 10);
  });
  test("gas stays valued at execution time and is charged even without a fill", () => {
    const p = new PaperExecution({ ...options, gasMon: 1 }); p.advance(frame(1)); p.place("buy", 200, 0.02, frame(1).book);
    p.advance(frame(2, 0.04));
    expect(p.snapshot(frame(2, 0.04).book).gasUsd).toBeCloseTo(0.02, 10);
    expect(p.snapshot(frame(2, 0.04).book).pnlUsd).toBeCloseTo(-0.02, 10);
  });
  test("liquidation value includes bid, slippage, exit fee and gas", () => {
    const p = new PaperExecution({ ...options, slippageBps: 100, exitFeeBps: 50, gasMon: 1 });
    p.advance(frame(1)); p.place("buy", 200, 0.02, frame(1).book);
    const f = frame(2); f.prints = [{ block: 2, side: "sell", price: 0.019, size: 200 }]; p.advance(f);
    expect(p.snapshot(f.book).liquidationUsd).toBeCloseTo(95.98 + 200 * f.book.bid * 0.99 * 0.995 - 0.02, 10);
  });
  test("drawdown latches, cancels orders, and does not fabricate liquidation", () => {
    const p = new PaperExecution({ ...options, maxDrawdownPct: 1 });
    p.advance(frame(1)); p.place("buy", 1000, 0.02, frame(1).book);
    const f = frame(2, 0.01); f.prints = [{ block: 2, side: "sell", price: 0.009, size: 1000 }]; p.advance(f);
    expect(p.halted).toBe(true); expect(p.mon).toBe(1000); expect(p.order).toBeNull();
    p.advance(frame(3, 0.03)); expect(p.place("sell", 200, 0.03, frame(3, 0.03).book)).toBeNull();
  });
  test.each([NaN, Infinity, -1])("invalid limits fail closed: %s", value => {
    expect(() => new PaperExecution({ ...options, makerFeeBps: value })).toThrow();
  });
});

describe("deterministic forward evaluation", () => {
  test("repeat runs match exactly and future changes cannot alter earlier actions/equity", () => {
    const frames = syntheticFrames();
    expect(evaluate(frames)).toEqual(evaluate(frames));
    const a = replay(frames, REPLAY_OPTIONS, 150, 450);
    const changed = structuredClone(frames);
    for (let i = 350; i < changed.length; i++) changed[i] = frame(i + 1, 0.1);
    const b = replay(changed, REPLAY_OPTIONS, 150, 450);
    expect(a.orders.filter(x => x.block < 351)).toEqual(b.orders.filter(x => x.block < 351));
    expect(a.equity.filter(x => x.block < 351)).toEqual(b.equity.filter(x => x.block < 351));
  });
  test("forward folds are disjoint with an explicit warmup and no tail leakage", () => {
    const r = evaluate(syntheticFrames(601));
    expect(r.folds.map(f => [f.startBlock, f.endBlock])).toEqual([[151, 300], [301, 450], [451, 600]]);
    expect(r.omittedTailBlocks).toBe(1);
  });
  test("cash/position and accounting invariants hold across seeded replay", () => {
    for (const f of evaluate(syntheticFrames()).folds) {
      expect(f.cashUsd).toBeGreaterThanOrEqual(-1e-9); expect(f.mon).toBeGreaterThanOrEqual(0); expect(f.mon).toBeLessThanOrEqual(1000);
      expect(f.pnlUsd).toBeCloseTo(f.realizedUsd + f.unrealizedUsd - f.feesUsd - f.gasUsd - f.inferenceUsd, 9);
      expect(f.netLiquidationPnlUsd).toBeLessThanOrEqual(f.pnlUsd);
    }
  });
  test("no-print flat market cannot earn a synthetic spread; costs lose to cash", () => {
    const r = replay(Array.from({ length: 300 }, (_, i) => frame(i + 1)));
    expect(r.fills).toBe(0); expect(r.pnlUsd).toBeLessThan(0); expect(r.benchmark.cashPnlUsd).toBe(0); expect(r.benchmark.buyHoldPnlUsd).toBeLessThan(0);
  });
  test("malformed books and gaps are rejected", () => {
    const bad = frame(1); bad.book.ask = bad.book.bid; expect(() => validateFrame(bad)).toThrow();
    const fs = syntheticFrames(); fs[200] = frame(200); expect(() => evaluate(fs)).toThrow("consecutive");
  });
});
