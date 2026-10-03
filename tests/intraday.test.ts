import { expect, test } from "bun:test";
import { PaperExecution } from "../src/paper";
import { REPLAY_OPTIONS } from "../src/replay";
import { frame } from "./fixtures";

function buy(p: PaperExecution, size = 200) {
  p.advance(frame(1)); p.place("buy", size, 0.02, frame(1).book);
  const f = frame(2); f.prints = [{ block: 2, side: "sell", price: 0.0199, size: size / p.options.participation }];
  p.advance(f);
}

test("stop exits at observed bid less slippage, never at an unavailable trigger price", () => {
  const p = new PaperExecution(REPLAY_OPTIONS); buy(p);
  const f = frame(3, 0.0188), fills = p.advance(f);
  expect(fills.at(-1)?.reason).toBe("stop_loss");
  expect(fills.at(-1)?.price).toBeCloseTo(f.book.bid * 0.9995, 12);
  expect(fills.at(-1)!.price).toBeLessThan(0.02 * 0.99);
  expect(p.mon).toBe(0); expect(p.place("buy", 200, f.book.bid, f.book)).toBeNull();
});

test("take profit closes paper inventory and records exit costs", () => {
  const p = new PaperExecution(REPLAY_OPTIONS); buy(p);
  const oldFees = p.feesUsd;
  const fills = p.advance(frame(3, 0.0205));
  expect(fills.at(-1)?.reason).toBe("take_profit"); expect(p.mon).toBe(0); expect(p.feesUsd).toBeGreaterThan(oldFees);
});

test("UTC close buffer flattens and disables entries until the next session", () => {
  const p = new PaperExecution(REPLAY_OPTIONS);
  const at = (block: number) => ({ ...frame(block), timestampMs: Date.UTC(2026, 9, 1, 23, 58, 59) + (block - 1) * 300 });
  p.advance(at(1)); p.place("buy", 200, 0.02, at(1).book);
  const f = at(2); f.prints = [{ block: 2, side: "sell", price: 0.0199, size: 800 }]; p.advance(f);
  expect(p.mon).toBe(200);
  for (let b = 3; b <= 204; b++) {
    p.advance(at(b));
    if (b >= 5) { expect(p.mon).toBe(0); expect(p.sizeFor("buy", 200, 0.02, at(b).book)).toBe(0); }
  }
  p.advance(at(205));
  expect(p.mon).toBe(0); expect(p.lastExitReason).toBe("session_close"); expect(p.overnightBreaches).toBe(0);
  expect(p.sizeFor("buy", 200, 0.02, at(205).book)).toBe(200);
});

test("daily loss includes liquidation costs, flattens, and resumes only on a new UTC day", () => {
  const p = new PaperExecution({ ...REPLAY_OPTIONS, closeBufferSeconds: 1, maxDailyLossPct: 1, riskPerTradePct: 100, stopLossPct: 100 });
  const at = (block: number, mid = 0.02) => ({ ...frame(block, mid), timestampMs: Date.UTC(2026, 9, 1, 23, 59, 57, 700) + block * 300 });
  p.advance(at(1)); expect(p.place("buy", 1000, 0.02, at(1).book)).not.toBeNull();
  const f = at(2, 0.0188); f.prints = [{ block: 2, side: "sell", price: 0.0187, size: 4000 }];
  expect(p.advance(f).at(-1)?.reason).toBe("daily_loss"); expect(p.dailyPaused).toBe(true); expect(p.mon).toBe(0);
  expect(p.sizeFor("buy", 200, f.book.bid, f.book)).toBe(0);
  for (let b = 3; b <= 8; b++) p.advance(at(b, 0.0188));
  expect(p.dailyPaused).toBe(false); expect(p.halted).toBe(false);
  expect(p.sizeFor("buy", 200, at(8, 0.0188).book.bid, at(8, 0.0188).book)).toBe(200);
});

test("position sizing uses equity, stop distance, cash, and minimum size", () => {
  const p = new PaperExecution({ ...REPLAY_OPTIONS, riskPerTradePct: 0.1 }); p.advance(frame(1));
  expect(p.sizeFor("buy", 1000, 0.02, frame(1).book)).toBeCloseTo(500, 5);
  const tiny = new PaperExecution({ ...REPLAY_OPTIONS, bankrollUsd: 10 }); tiny.advance(frame(1));
  expect(tiny.sizeFor("buy", 200, 0.02, frame(1).book)).toBe(0);
  expect(p.sizeFor("sell", 200, 0.02, frame(1).book)).toBe(0);
});

test("an outage crossing midnight is disclosed, halted, and closed at first observed price", () => {
  const p = new PaperExecution(REPLAY_OPTIONS); buy(p);
  const nextDay = { ...frame(3, 0.019), timestampMs: Date.UTC(2026, 9, 2) };
  const fills = p.advance(nextDay);
  expect(p.overnightBreaches).toBe(1); expect(p.halted).toBe(true); expect(p.mon).toBe(0);
  expect(fills.at(-1)?.reason).toBe("data_gap");
  expect(fills.at(-1)?.price).toBeCloseTo(nextDay.book.bid * 0.9995, 12);
});
