import type { Book, Fill, Side } from "./market";
import type { TradePrint } from "./trades";

export interface PaperOptions {
  bankrollUsd: number;
  maxPositionMon: number;
  makerFeeBps: number;
  exitFeeBps: number;
  slippageBps: number;
  gasMon: number;
  participation: number;
  maxDrawdownPct: number;
  stopLossPct: number;
  takeProfitPct: number;
  maxDailyLossPct: number;
  maxPositionEquityPct: number;
  riskPerTradePct: number;
  closeBufferSeconds: number;
}
export interface PaperOrder { id: number; block: number; side: Side; price: number; size: number }
export interface PaperFrame { timestampMs: number; book: Book; prints: TradePrint[] }
export type ExitReason = "stop_loss" | "take_profit" | "daily_loss" | "session_close" | "session_rollover" | "data_gap";
export type PaperFill = Fill & { reason?: ExitReason };
const EPS = 1e-9;
const finite = (x: number, name: string, min = 0) => {
  if (!Number.isFinite(x) || x < min) throw new Error(`Invalid ${name}`);
};

/** No I/O, clock, wallet, or model API. Spot accounting; one replacement order at a time. */
export class PaperExecution {
  readonly options: Readonly<PaperOptions>;
  cashUsd: number;
  mon = 0;
  costBasisUsd = 0;
  realizedUsd = 0; // gross trading P&L; costs are separate
  feesUsd = 0;
  gasUsd = 0;
  gasMon = 0;
  inferenceUsd = 0;
  turnoverUsd = 0;
  fills = 0;
  quotes = 0;
  maxDrawdownPct = 0;
  halted = false;
  dailyPaused = false;
  overnightBreaches = 0;
  lastExitReason: ExitReason | null = null;
  order: PaperOrder | null = null;
  private peakUsd: number;
  private block = 0;
  private nextId = -1;
  private timestampMs = 0;
  private day = "";
  private dailyStartUsd: number;
  private entryBlocked = false;

  constructor(options: PaperOptions) {
    this.options = Object.freeze({ ...options });
    for (const key of ["bankrollUsd", "maxPositionMon", "makerFeeBps", "exitFeeBps", "slippageBps", "gasMon", "participation", "maxDrawdownPct", "stopLossPct", "takeProfitPct", "maxDailyLossPct", "maxPositionEquityPct", "riskPerTradePct", "closeBufferSeconds"] as const) finite(options[key], key);
    if (options.bankrollUsd <= 0 || options.maxPositionMon <= 0 || options.participation <= 0 || options.participation > 1 || options.maxDrawdownPct <= 0 || options.maxDrawdownPct > 100 || [options.makerFeeBps, options.exitFeeBps, options.slippageBps].some(x => x >= 10000)) throw new Error("Invalid paper limits");
    this.cashUsd = this.peakUsd = options.bankrollUsd;
    this.dailyStartUsd = options.bankrollUsd;
    if ([options.stopLossPct, options.takeProfitPct, options.maxDailyLossPct, options.maxPositionEquityPct, options.riskPerTradePct].some(x => x <= 0 || x > 100) || options.closeBufferSeconds < 1 || options.closeBufferSeconds >= 86400) throw new Error("Invalid intraday limits");
  }

  /** Process completed block N before creating any order using information from N. */
  advance({ timestampMs, book, prints }: PaperFrame): PaperFill[] {
    validateFrame({ timestampMs, book, prints });
    if (book.block <= this.block) throw new Error("Blocks must increase strictly");
    if (this.timestampMs && timestampMs <= this.timestampMs) throw new Error("Timestamps must increase strictly");
    const day = new Date(timestampMs).toISOString().slice(0, 10);
    const rollover = this.day !== "" && this.day !== day;
    const gap = this.block > 0 && (book.block !== this.block + 1 || timestampMs - this.timestampMs > 1000);
    if (rollover) {
      if (this.mon > EPS) this.overnightBreaches++;
      this.dailyStartUsd = this.snapshot(book).liquidationUsd;
      this.dailyPaused = false;
    }
    this.day = day;
    this.timestampMs = timestampMs;
    this.entryBlocked = false;
    // Missing blocks make a one-block order unknowable. Cancel and halt instead of inventing fills.
    if (gap) this.halt();
    this.block = book.block;
    const out: PaperFill[] = [];
    const order = this.order;
    if (order && !this.halted && book.block === order.block + 1) {
      for (const print of prints) {
        // A touch cannot prove queue priority. Only strict trade-through is eligible.
        const hit = order.side === "buy" ? print.side === "sell" && print.price < order.price : print.side === "buy" && print.price > order.price;
        if (!hit || order.size <= EPS) continue;
        const size = Math.min(order.size, print.size * this.options.participation);
        if (size <= EPS) continue;
        const notional = size * order.price;
        const fee = notional * this.options.makerFeeBps / 10000;
        if (order.side === "buy") {
          this.cashUsd -= notional + fee;
          this.mon += size;
          this.costBasisUsd += notional;
        } else {
          const entry = this.costBasisUsd / this.mon;
          this.realizedUsd += size * (order.price - entry);
          this.costBasisUsd -= size * entry;
          this.mon -= size;
          this.cashUsd += notional - fee;
          if (this.mon < EPS) { this.mon = 0; this.costBasisUsd = 0; }
        }
        this.feesUsd += fee;
        this.turnoverUsd += notional;
        this.fills++;
        order.size -= size;
        out.push({ side: order.side, size, price: order.price, txHash: null, orderId: order.id, simulated: true });
      }
    }
    // Explicit one-block local expiry. This is an assumption, not an on-chain TTL.
    this.order = null;
    const secondsLeft = (86400000 - timestampMs % 86400000) / 1000;
    const dailyLoss = (this.dailyStartUsd - this.snapshot(book).liquidationUsd) / this.dailyStartUsd * 100;
    if (dailyLoss >= this.options.maxDailyLossPct) this.dailyPaused = true;
    let reason: ExitReason | null = gap ? "data_gap" : rollover && this.mon > EPS ? "session_rollover" : secondsLeft <= this.options.closeBufferSeconds ? "session_close" : this.dailyPaused ? "daily_loss" : null;
    if (!reason && this.mon > EPS) {
      const entry = this.costBasisUsd / this.mon;
      const move = (book.bid / entry - 1) * 100;
      if (move <= -this.options.stopLossPct) reason = "stop_loss";
      else if (move >= this.options.takeProfitPct) reason = "take_profit";
    }
    if (reason) {
      this.entryBlocked = true;
      if (this.mon > EPS) out.push(this.liquidate(book, reason));
    }
    this.mark(book);
    return out;
  }

  allowed(side: Side, size: number, price: number, book: Book): boolean {
    finite(size, "size", Number.MIN_VALUE); finite(price, "price", Number.MIN_VALUE);
    if (side !== "buy" && side !== "sell") throw new Error("Invalid side");
    if (this.halted || this.dailyPaused || this.entryBlocked || this.order || book.block !== this.block) return false;
    const gas = this.options.gasMon * book.mid;
    if (side === "sell") return price > book.bid && this.mon + EPS >= size && this.cashUsd + EPS >= gas;
    const equity = this.snapshot(book).equityUsd;
    const cap = Math.min(this.options.maxPositionMon, equity * this.options.maxPositionEquityPct / 100 / price);
    const riskSize = equity * this.options.riskPerTradePct / 100 / (price * this.options.stopLossPct / 100);
    return price < book.ask && size <= riskSize + EPS && this.mon + size <= cap + EPS && this.cashUsd + EPS >= size * price * (1 + this.options.makerFeeBps / 10000) + gas;
  }

  /** Requested MON is an upper bound; size down to cash, portfolio allocation and stop risk. */
  sizeFor(side: Side, requested: number, price: number, book: Book, minimum = 200): number {
    finite(requested, "requested size", Number.MIN_VALUE); finite(price, "price", Number.MIN_VALUE);
    const equity = this.snapshot(book).equityUsd;
    const cap = Math.min(this.options.maxPositionMon, equity * this.options.maxPositionEquityPct / 100 / price);
    const risk = equity * this.options.riskPerTradePct / 100 / (price * this.options.stopLossPct / 100);
    const cashSize = (this.cashUsd - this.options.gasMon * book.mid) / (price * (1 + this.options.makerFeeBps / 10000));
    const size = Math.floor(Math.min(requested, side === "sell" ? this.mon : Math.min(cap - this.mon, risk, cashSize)) * 1e6) / 1e6;
    return size >= minimum && this.allowed(side, size, price, book) ? size : 0;
  }

  place(side: Side, size: number, price: number, book: Book): PaperOrder | null {
    if (!this.allowed(side, size, price, book)) return null;
    const gas = this.options.gasMon * book.mid;
    this.cashUsd -= gas;
    this.gasUsd += gas; // historical USD cost, never revalue old gas at today's mid
    this.gasMon += this.options.gasMon;
    this.quotes++;
    this.mark(book);
    if (this.halted) return null;
    return this.order = { id: this.nextId--, block: book.block, side, size, price };
  }

  chargeInference(usd: number, book: Book) {
    finite(usd, "inference cost");
    this.cashUsd -= usd;
    this.inferenceUsd += usd;
    this.mark(book);
  }

  snapshot(book: Book) {
    const unrealizedUsd = this.mon * book.mid - this.costBasisUsd;
    const equityUsd = this.cashUsd + this.mon * book.mid;
    // Exit at bid, less slippage, fee, and one gas charge. No artificial end-of-test fill.
    const liquidationUsd = this.cashUsd + this.mon * book.bid * (1 - this.options.slippageBps / 10000) * (1 - this.options.exitFeeBps / 10000) - (this.mon > EPS ? this.options.gasMon * book.mid : 0);
    return { cashUsd: this.cashUsd, mon: this.mon, equityUsd, liquidationUsd, unrealizedUsd, pnlUsd: equityUsd - this.options.bankrollUsd, netLiquidationPnlUsd: liquidationUsd - this.options.bankrollUsd, realizedUsd: this.realizedUsd, feesUsd: this.feesUsd, gasUsd: this.gasUsd, gasMon: this.gasMon, inferenceUsd: this.inferenceUsd, turnoverUsd: this.turnoverUsd, fills: this.fills, quotes: this.quotes, maxDrawdownPct: this.maxDrawdownPct, halted: this.halted, dailyPaused: this.dailyPaused, sessionUtc: this.day, dailyPnlUsd: liquidationUsd - this.dailyStartUsd, overnightBreaches: this.overnightBreaches, lastExitReason: this.lastExitReason };
  }

  private liquidate(book: Book, reason: ExitReason): PaperFill {
    const size = this.mon;
    // Stop is a trigger, not a guaranteed fill price. Exit at the next observed bid, less slippage.
    const price = book.bid * (1 - this.options.slippageBps / 10000);
    const notional = size * price, fee = notional * this.options.exitFeeBps / 10000;
    const gas = this.options.gasMon * book.mid;
    this.realizedUsd += notional - this.costBasisUsd;
    this.cashUsd += notional - fee - gas;
    this.feesUsd += fee; this.gasUsd += gas; this.gasMon += this.options.gasMon;
    this.turnoverUsd += notional; this.fills++;
    this.mon = 0; this.costBasisUsd = 0; this.order = null;
    this.lastExitReason = reason;
    return { side: "sell", size, price, txHash: null, orderId: this.nextId--, simulated: true, reason };
  }

  halt() { this.halted = true; this.order = null; }
  private mark(book: Book) {
    const equity = this.snapshot(book).liquidationUsd;
    this.peakUsd = Math.max(this.peakUsd, equity);
    this.maxDrawdownPct = Math.max(this.maxDrawdownPct, (this.peakUsd - equity) / this.peakUsd * 100);
    if (this.maxDrawdownPct >= this.options.maxDrawdownPct || this.cashUsd < -EPS) this.halt();
    if ((this.dailyStartUsd - equity) / this.dailyStartUsd * 100 >= this.options.maxDailyLossPct) { this.dailyPaused = true; this.order = null; }
  }
}

export function validateFrame({ timestampMs, book, prints }: PaperFrame) {
  if (!Number.isSafeInteger(timestampMs) || timestampMs <= 0 || !Number.isFinite(new Date(timestampMs).getTime())) throw new Error("Invalid timestampMs");
  if (!Number.isSafeInteger(book.block) || book.block <= 0) throw new Error("Invalid block");
  for (const key of ["bid", "ask", "mid"] as const) finite(book[key], key, Number.MIN_VALUE);
  if (book.bid >= book.ask || Math.abs(book.mid - (book.bid + book.ask) / 2) > book.mid * 1e-8) throw new Error("Invalid/crossed book");
  finite(book.spreadBps, "spread");
  if (Math.abs(book.spreadBps - (book.ask - book.bid) / book.mid * 10000) > 1e-6) throw new Error("Inconsistent spread");
  if (!Number.isFinite(book.imbalance) || Math.abs(book.imbalance) > 1) throw new Error("Invalid imbalance");
  for (const side of ["bids", "asks"] as const) for (const [price, size] of book.levels[side]) { finite(price, "level price", Number.MIN_VALUE); finite(size, "level size"); }
  for (const depth of Object.values(book.depthBps)) { finite(depth.bid, "bid depth"); finite(depth.ask, "ask depth"); }
  for (const p of prints) {
    if (p.block !== book.block || !["buy", "sell"].includes(p.side)) throw new Error("Print must belong to the completed block");
    finite(p.price, "print price", Number.MIN_VALUE); finite(p.size, "print size", Number.MIN_VALUE);
  }
}
