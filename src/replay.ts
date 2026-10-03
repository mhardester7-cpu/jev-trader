import { createHash } from "node:crypto";
import { PaperExecution, validateFrame, type PaperFrame, type PaperOptions } from "./paper";
import { mockSignal } from "./model";
import { buildTradeState } from "./state";
import type { Book, Side } from "./market";

// Explicit research assumptions, independent of environment variables and credentials.
export const REPLAY_OPTIONS: Readonly<PaperOptions> = Object.freeze({ bankrollUsd: 100, maxPositionMon: 1000, makerFeeBps: 2, exitFeeBps: 5, slippageBps: 5, gasMon: 0.0357, participation: 0.25, maxDrawdownPct: 5, stopLossPct: 1, takeProfitPct: 2, maxDailyLossPct: 2, maxPositionEquityPct: 25, riskPerTradePct: 0.5, closeBufferSeconds: 60 });
export const REPLAY_POLICY = Object.freeze({ tradeSizeMon: 200, tick: 0.000001, insideTicks: 1, horizonBlocks: 100 });

export function quotePrice(side: Side, book: Book) {
  const { tick, insideTicks } = REPLAY_POLICY;
  const bid = Math.round(book.bid / tick), ask = Math.round(book.ask / tick);
  return (side === "buy" ? (bid + insideTicks < ask ? bid + insideTicks : bid) : (ask - insideTicks > bid ? ask - insideTicks : ask)) * tick;
}

export function replay(frames: readonly PaperFrame[], options: PaperOptions = REPLAY_OPTIONS, start = 0, end = frames.length) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end || end > frames.length) throw new Error("Invalid replay interval");
  // Validate warmup too: a malformed historical prefix must not leak future state into features.
  validateChronology(frames.slice(Math.max(0, start - 400), end));
  const paper = new PaperExecution(options);
  const history: PaperFrame[] = frames.slice(Math.max(0, start - 400), start);
  const equity: { block: number; pnlUsd: number; netLiquidationPnlUsd: number }[] = [];
  const orders: { block: number; side: Side; price: number }[] = [];
  for (let i = start; i < end; i++) {
    const frame = frames[i]!, book = frame.book;
    paper.advance(frame);
    history.push(frame);
    if (history.length > 401) history.shift();
    const price = { buy: quotePrice("buy", book), sell: quotePrice("sell", book) };
    const size = { buy: paper.sizeFor("buy", REPLAY_POLICY.tradeSizeMon, price.buy, book), sell: paper.sizeFor("sell", REPLAY_POLICY.tradeSizeMon, price.sell, book) };
    const allowed = { buy: size.buy > 0, sell: size.sell > 0 };
    const decision = mockSignal(buildTradeState(history, allowed, REPLAY_POLICY.horizonBlocks));
    // The last decision cannot execute within the interval; omit its unobservable order.
    if (i < end - 1) {
      const side = decision.action;
      const order = size[side] > 0 ? paper.place(side, size[side], price[side], book) : null;
      if (order) orders.push({ block: book.block, side, price: order.price });
    }
    const s = paper.snapshot(book);
    equity.push({ block: book.block, pnlUsd: s.pnlUsd, netLiquidationPnlUsd: s.netLiquidationPnlUsd });
  }
  const first = frames[start]!.book, last = frames[end - 1]!.book;
  return {
    startBlock: first.block, endBlock: last.block, blocks: end - start,
    ...paper.snapshot(last),
    returnPct: paper.snapshot(last).netLiquidationPnlUsd / options.bankrollUsd * 100,
    benchmark: { cashPnlUsd: 0, buyHoldPnlUsd: buyHold(first, last, options) },
    equity, orders,
  };
}

function buyHold(first: Book, last: Book, o: PaperOptions) {
  const entry = first.ask * (1 + o.slippageBps / 10000);
  const entryGas = o.gasMon * first.mid;
  const size = Math.max(0, Math.min(o.maxPositionMon, o.bankrollUsd * o.maxPositionEquityPct / 100 / entry, (o.bankrollUsd - entryGas) / (entry * (1 + o.exitFeeBps / 10000))));
  if (!size) return 0;
  const cash = o.bankrollUsd - entryGas - size * entry * (1 + o.exitFeeBps / 10000);
  return cash + size * last.bid * (1 - o.slippageBps / 10000) * (1 - o.exitFeeBps / 10000) - o.gasMon * last.mid - o.bankrollUsd;
}

/** Expanding historical context, disjoint forward scoring windows; fixed policy, no fitting. */
export function evaluate(frames: readonly PaperFrame[], options: PaperOptions = REPLAY_OPTIONS, warmup = 150, window = 150) {
  if (!Number.isInteger(warmup) || warmup < REPLAY_POLICY.horizonBlocks || !Number.isInteger(window) || window < 2 || frames.length < warmup + window) throw new Error("Need a full warmup and forward window");
  validateChronology(frames);
  const folds = [];
  for (let start = warmup; start + window <= frames.length; start += window) {
    const { equity, orders, ...metrics } = replay(frames, options, start, start + window);
    folds.push(metrics);
  }
  return {
    schemaVersion: 1,
    model: "mock heuristic (not Jev)",
    datasetSha256: createHash("sha256").update(JSON.stringify(frames)).digest("hex"),
    options, policy: REPLAY_POLICY, warmup, window,
    omittedTailBlocks: (frames.length - warmup) % window,
    method: "Fixed policy, chronological forward windows; fresh cash per fold, past-only feature warmup. No parameter selection. Not a fitted walk-forward strategy.",
    folds,
  };
}

export function validateChronology(frames: readonly PaperFrame[]) {
  frames.forEach((frame, i) => {
    validateFrame(frame);
    if (i && frame.book.block !== frames[i - 1]!.book.block + 1) throw new Error("Replay data must have consecutive, unique blocks");
    if (i && frame.timestampMs < frames[i - 1]!.timestampMs) throw new Error("Replay timestamps must not decrease");
  });
}
