import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { config } from "./config";
import type { Market, Book, Fill, Quote } from "./market";
import type { Action, Decision, Model } from "./model";
import { TradeFeed } from "./trades";
import { PaperExecution, type PaperFrame, type PaperOptions, type PaperFill } from "./paper";
import { buildTradeState } from "./state";

export interface BlockEvent {
  block: number;
  ts: number;
  mid: number;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;
  decision: { action: Action; probabilities: Record<Action, number>; upIn10: number; latencyMs: number; late: boolean } | null;
  /** The order this block put on the book. */
  quote: Quote | null;
  /** Maker fills that landed in this block (aggregated), attached when the trade logs for it arrive. */
  fill: Fill | null;
  fills: PaperFill[];
  /** Our size known to be resting on the book after this block's order. */
  resting: { bidMon: number; askMon: number };
  position: { side: "long" | "short" | "flat"; size: number; entryPrice: number | null; unrealizedUsd: number; unrealizedMon: number };
  totals: Totals;
}

/** Per-block latency: the book read, and read + decide + send end to end. */
export interface Timing { readMs: number; loopMs: number }

export interface Totals {
  blocks: number;
  decisions: number;
  quotes: number;
  fills: number;
  reverted: number;
  lateBlocks: number;
  jevUsd: number;
  gasMon: number;
  gasUsd: number;
  realizedUsd: number;
  pnlUsd: number;
  pnlMon: number;
  pnlPct: number;
  feesUsd: number;
  cashUsd: number;
  netLiquidationPnlUsd: number;
  maxDrawdownPct: number;
  halted: boolean;
  dailyPaused: boolean;
  dailyPnlUsd: number;
  overnightBreaches: number;
}

export const paperOptions = (): PaperOptions => ({
  bankrollUsd: config.bankrollUsd, maxPositionMon: config.maxPositionMon,
  makerFeeBps: config.paperMakerFeeBps, exitFeeBps: config.paperExitFeeBps,
  slippageBps: config.paperSlippageBps, gasMon: config.paperGasMon,
  participation: config.paperParticipation, maxDrawdownPct: config.maxDrawdownPct,
  stopLossPct: config.stopLossPct, takeProfitPct: config.takeProfitPct,
  maxDailyLossPct: config.maxDailyLossPct, maxPositionEquityPct: config.maxPositionEquityPct,
  riskPerTradePct: config.riskPerTradePct, closeBufferSeconds: config.closeBufferSeconds,
});

/** Sequential, paper-only loop. Market supplies read-only book data and tick prices. */
export class Trader {
  readonly history: BlockEvent[] = [];
  readonly paper = new PaperExecution(paperOptions());
  private frames: PaperFrame[] = [];
  private busy = false;
  private newestBlock = 0;
  private session = randomUUID();
  private trades: Pick<TradeFeed, "poll" | "drainPrints" | "lastBlock"> | null = null;
  private blocks = 0;
  private decisions = 0;
  private lateBlocks = 0;

  constructor(
    private market: Pick<Market, "readBook" | "quotePrice">,
    private model: Model,
    private onEvent: (e: BlockEvent, timing?: Timing) => void,
    private onFill: (block: number, fill: Fill) => void = () => {},
    // Kept for the dashboard caller's existing interface. Paper has no receipts.
    _onQuote: (block: number, quote: Quote) => void = () => {},
    private record = true,
    private now: () => number = Date.now,
  ) {
    if (!Number.isFinite(config.tradeSizeMon) || config.tradeSizeMon <= 0 || !Number.isInteger(config.quoteInsideTicks) || config.quoteInsideTicks < 0 || !Number.isInteger(config.horizonBlocks) || config.horizonBlocks < 1 || config.horizonBlocks > 400) throw new Error("Invalid trade size, ticks, or horizon (1..400)");
    if (record) mkdirSync("data", { recursive: true });
  }

  attachTradeFeed(sizeDec: number) {
    this.setTradeFeed(new TradeFeed({ market: config.market, url: config.readRpcUrl, sizeDec }));
  }

  /** Dependency injection for offline regression tests. */
  setTradeFeed(feed: Pick<TradeFeed, "poll" | "drainPrints" | "lastBlock">) { this.trades = feed; }

  async onBlock(block: number) {
    if (block <= this.newestBlock) return;
    this.newestBlock = block;
    this.blocks++;
    if (this.busy) { this.lateBlocks++; return; }
    this.busy = true;
    const t0 = performance.now();
    try {
      if (!this.trades) throw new Error("Trade feed is required for paper fills");
      const book = await this.market.readBook(block);
      if (book.block !== block) throw new Error("Book block does not match requested block");
      const readMs = performance.now() - t0;
      // Wait for complete logs before expiring/replacing the old order. A partial poll is unsafe.
      await this.trades.poll(block);
      if (this.trades.lastBlock !== block) throw new Error("Incomplete trade-log poll");
      const fresh = this.trades.drainPrints();
      const prints = fresh.filter(p => p.block === block);
      const frame = { timestampMs: this.now(), book, prints };
      const fills = this.paper.advance(frame);
      this.frames.push(frame);
      if (this.frames.length > 401) this.frames.shift();
      for (const fill of fills) this.onFill(block, fill);
      let decision: Decision | null = null;
      let quote: Quote | null = null;
      let late = false;
      if (!this.paper.halted && !this.paper.dailyPaused) {
        const price = { buy: this.market.quotePrice("buy", book), sell: this.market.quotePrice("sell", book) };
        const size = { buy: this.paper.sizeFor("buy", config.tradeSizeMon, price.buy, book), sell: this.paper.sizeFor("sell", config.tradeSizeMon, price.sell, book) };
        const allowed = { buy: size.buy > 0, sell: size.sell > 0 };
        if (allowed.buy || allowed.sell) {
          decision = await this.model.decide(buildTradeState(this.frames, allowed, config.horizonBlocks));
          this.decisions++;
          if (!["buy", "sell", "hold"].includes(decision.action) || !Number.isFinite(decision.inputTokens) || decision.inputTokens < 0 || Object.values(decision.probabilities).some(p => !Number.isFinite(p) || p < 0 || p > 1)) throw new Error("Invalid model decision");
          this.paper.chargeInference(decision.inputTokens / 1e6 * config.jevUsdPerMTok, book);
          late = this.newestBlock !== block || performance.now() - t0 >= 300;
          if (late) this.lateBlocks++;
          if (!late && decision.action !== "hold") {
            const side = decision.action;
            const order = size[side] > 0 ? this.paper.place(side, size[side], price[side], book) : null;
            if (order) quote = { side, price: order.price, size: order.size, txHash: null, gasMon: config.paperGasMon, cancel: [], status: "sim", orderId: order.id, capped: false };
          }
        }
      }
      this.emit(book, decision, quote, fills, late, { readMs: Math.round(readMs), loopMs: Math.round(performance.now() - t0) });
      if (this.record) appendFileSync(`data/${this.session}-frames.jsonl`, JSON.stringify({ ...frame, decision, late, model: this.model.name, options: this.paper.options }) + "\n");
    } catch {
      // Do not log arbitrary provider error bodies, which can contain credentials/URLs.
      this.paper.halt();
      const last = this.history.at(-1);
      if (last) {
        last.totals.halted = true;
        last.resting = { bidMon: 0, askMon: 0 };
        this.onEvent(last);
      }
      console.error(`Paper trading halted at block ${block}: invalid, incomplete, or unavailable input. Restart with a new session after diagnosis.`);
    } finally { this.busy = false; }
  }

  private emit(book: Book, decision: Decision | null, quote: Quote | null, fills: PaperFill[], late: boolean, timing: Timing) {
    const p = this.paper, s = p.snapshot(book);
    const sameSide = fills.length > 0 && fills.every(f => f.side === fills[0]!.side);
    const size = fills.reduce((sum, f) => sum + f.size, 0);
    const fill = sameSide ? { ...fills[0]!, size, price: fills.reduce((sum, f) => sum + f.price * f.size, 0) / size } : null;
    const event: BlockEvent = {
      block: book.block, ts: Date.now(), mid: book.mid, bestBid: book.bid, bestAsk: book.ask, spreadBps: book.spreadBps,
      decision: late ? { action: "hold", probabilities: { buy: 0, sell: 0, hold: 1 }, upIn10: 0.5, latencyMs: decision?.latencyMs ?? 0, late: true } : decision && { ...decision, late: false },
      quote, fill, fills,
      resting: { bidMon: p.order?.side === "buy" ? p.order.size : 0, askMon: p.order?.side === "sell" ? p.order.size : 0 },
      position: { side: p.mon ? "long" : "flat", size: p.mon, entryPrice: p.mon ? p.costBasisUsd / p.mon : null, unrealizedUsd: s.unrealizedUsd, unrealizedMon: s.unrealizedUsd / book.mid },
      totals: { blocks: this.blocks, decisions: this.decisions, quotes: p.quotes, fills: p.fills, reverted: 0, lateBlocks: this.lateBlocks, jevUsd: p.inferenceUsd, gasMon: p.gasMon, gasUsd: p.gasUsd, feesUsd: p.feesUsd, cashUsd: p.cashUsd, realizedUsd: p.realizedUsd, pnlUsd: s.pnlUsd, pnlMon: s.pnlUsd / book.mid, pnlPct: s.pnlUsd / config.bankrollUsd * 100, netLiquidationPnlUsd: s.netLiquidationPnlUsd, maxDrawdownPct: p.maxDrawdownPct, halted: p.halted, dailyPaused: p.dailyPaused, dailyPnlUsd: s.dailyPnlUsd, overnightBreaches: p.overnightBreaches },
    };
    this.history.push(event);
    if (this.history.length > config.historySize) this.history.shift();
    if (this.record) appendFileSync(`data/${this.session}-events.jsonl`, JSON.stringify(event) + "\n");
    this.onEvent(event, timing);
  }
}
