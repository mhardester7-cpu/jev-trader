import { mkdirSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PaperExecution, type PaperFill } from "./paper";
import { REPLAY_OPTIONS, REPLAY_POLICY, quotePrice } from "./replay";
import { buildTradeState } from "./state";
import { writeJsonAtomic } from "./paper-session";
import { JEV_MODEL, JevBudget, JevRunError, validateJevLimits, type JevLimits } from "./jev-budget";
import { requestJev, type JevTransport } from "./jev-request";
import type { loadRecording } from "./recording";
import type { BlockEvent } from "./trader";
import type { Decision } from "./model";
import type { Quote } from "./market";

export class RecordedJevSession {
  readonly history: BlockEvent[] = [];
  phase = "ready";
  reason: string | null = null;
  runId: string | null = null;
  startedAt: number | null = null;
  endedAt: number | null = null;
  private budget: JevBudget | null = null;
  private paper: PaperExecution | null = null;
  private abort: AbortController | null = null;
  private active: Promise<void> | null = null;
  private directory: string | null = null;
  private cursor = 149;
  private decisions = 0;
  constructor(readonly recording: ReturnType<typeof loadRecording>, private root: string, private publish: (event: "snapshot" | "block" | "status", value: unknown) => void, private transport?: JevTransport, private pause: () => Promise<void> = () => Bun.sleep(300)) {}

  metadata() {
    return { model: JEV_MODEL, wallet: null, dryRun: true, market: "MON-USDC", mode: "recorded-jev", startedAt: this.startedAt, endedAt: this.endedAt, phase: this.phase, reason: this.reason, runId: this.runId, budget: this.budget?.snapshot() ?? null,
      source: { blocks: this.recording.frames.length, firstTimestampMs: this.recording.manifest.firstTimestampMs, lastTimestampMs: this.recording.manifest.lastTimestampMs, datasetSha256: this.recording.manifest.datasetSha256, warmupBlocks: 150 },
      latest: this.history.at(-1) ?? null };
  }
  snapshot() { return { ...this.metadata(), history: this.history }; }
  start(key: string, limits: JevLimits, approved: boolean) {
    if (this.active) throw new JevRunError("already_running");
    if (approved !== true) throw new JevRunError("budget_approval_required");
    if (typeof key !== "string" || key.length < 8 || key.length > 2048 || /[\s\x00-\x1f\x7f]/.test(key)) throw new JevRunError("invalid_key_format");
    validateJevLimits(limits);
    if (this.recording.frames.length < 152) throw new JevRunError("insufficient_recording");
    this.budget = new JevBudget(Object.freeze({ ...limits }));
    this.paper = new PaperExecution(REPLAY_OPTIONS);
    this.abort = new AbortController(); this.history.length = 0; this.decisions = 0; this.cursor = 149;
    this.runId = randomUUID(); this.startedAt = Date.now(); this.endedAt = null; this.phase = "running"; this.reason = null;
    this.directory = join(this.root, this.runId); mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.persist(); this.publish("snapshot", this.snapshot());
    this.active = this.execute(key).finally(() => { this.active = null; });
    return this.runId;
  }
  stop() { if (this.active) { this.phase = "stopping"; this.abort!.abort(); this.publish("status", this.metadata()); } }
  async settled() { await this.active; }
  private persist() {
    if (this.directory) writeJsonAtomic(join(this.directory, "account.json"), { ...this.metadata(), cursor: this.cursor, paper: this.paper?.checkpoint() });
  }
  private async execute(key: string) {
    const paper = this.paper!, budget = this.budget!, signal = this.abort!.signal;
    const frames = this.recording.frames;
    try {
      for (let index = 150; index < frames.length; index++) {
        if (signal.aborted) throw new JevRunError("stopped");
        if (Date.now() >= budget.deadline) throw new JevRunError("time_limit");
        this.cursor = index;
        const frame = frames[index]!, book = frame.book, fills = paper.advance(frame);
        let decision: (Decision & { requestSha256: string }) | null = null, quote: Quote | null = null;
        let failure: unknown = null;
        try {
          if (index < frames.length - 1 && !paper.halted && !paper.dailyPaused) {
            const price = { buy: quotePrice("buy", book), sell: quotePrice("sell", book) };
            const size = { buy: paper.sizeFor("buy", REPLAY_POLICY.tradeSizeMon, price.buy, book), sell: paper.sizeFor("sell", REPLAY_POLICY.tradeSizeMon, price.sell, book) };
            if (size.buy || size.sell) {
              const before = budget.snapshot().accountedCostUsd;
              try {
                decision = await requestJev(buildTradeState(frames.slice(Math.max(0, index - 400), index + 1), { buy: size.buy > 0, sell: size.sell > 0 }, REPLAY_POLICY.horizonBlocks), key, budget, signal, () => { this.persist(); this.publish("status", this.metadata()); }, this.transport);
                this.decisions++;
              } finally { paper.chargeInference(budget.snapshot().accountedCostUsd - before, book); }
              // A stop while a response was in flight must never place another order.
              if (signal.aborted) throw new JevRunError("stopped");
              const side = decision.action;
              if (side !== "hold") {
                const order = size[side] ? paper.place(side, size[side], price[side], book) : null;
                if (order) quote = { side, price: order.price, size: order.size, txHash: null, gasMon: REPLAY_OPTIONS.gasMon, cancel: [], status: "sim", orderId: order.id, capped: false };
              }
            }
          }
        } catch (error) { failure = error; }
        const event = this.event(index, decision, quote, fills);
        this.history.push(event); this.persist();
        appendFileSync(join(this.directory!, "events.jsonl"), JSON.stringify({ ...event, inputTokens: decision?.inputTokens ?? null, requestSha256: decision?.requestSha256 ?? null, budget: budget.snapshot() }) + "\n", { mode: 0o600 });
        this.publish("block", event); this.publish("status", this.metadata());
        if (failure) throw failure;
        if (paper.halted || paper.dailyPaused) throw new JevRunError("paper_risk_limit");
        await this.pause();
      }
      this.phase = "completed";
    } catch (error) {
      this.reason = signal.aborted ? "stopped" : error instanceof JevRunError ? error.code : "session_failed";
      this.phase = ["stopped", "time_limit", "budget_limit", "paper_risk_limit"].includes(this.reason) ? this.reason : "error";
    } finally {
      key = ""; // no disk/env storage or automatic restart; release this closure's reference
      paper.cancelOrders(); this.endedAt = Date.now();
      const last = this.history.at(-1); if (last) last.resting = { bidMon: 0, askMon: 0 };
      try { this.persist(); } catch { this.phase = "error"; this.reason = "recording_write_failed"; }
      this.publish("status", this.metadata());
    }
  }
  private event(index: number, decision: Decision | null, quote: Quote | null, fills: PaperFill[]): BlockEvent {
    const { book, timestampMs } = this.recording.frames[index]!, paper = this.paper!, s = paper.snapshot(book);
    const sameSide = fills.length > 0 && fills.every(f => f.side === fills[0]!.side), size = fills.reduce((n, f) => n + f.size, 0);
    return { block: book.block, ts: timestampMs, mid: book.mid, bestBid: book.bid, bestAsk: book.ask, spreadBps: book.spreadBps,
      decision: decision && { action: decision.action, probabilities: decision.probabilities, upIn10: decision.upIn10, latencyMs: decision.latencyMs, late: false }, quote, fills,
      fill: sameSide ? { ...fills[0]!, size, price: fills.reduce((n, f) => n + f.price * f.size, 0) / size } : null,
      resting: { bidMon: paper.order?.side === "buy" ? paper.order.size : 0, askMon: paper.order?.side === "sell" ? paper.order.size : 0 },
      position: { side: paper.mon ? "long" : "flat", size: paper.mon, entryPrice: paper.mon ? paper.costBasisUsd / paper.mon : null, unrealizedUsd: s.unrealizedUsd, unrealizedMon: s.unrealizedUsd / book.mid },
      totals: { blocks: index - 149, decisions: this.decisions, quotes: paper.quotes, fills: paper.fills, reverted: 0, lateBlocks: 0, jevUsd: paper.inferenceUsd, gasMon: paper.gasMon, gasUsd: paper.gasUsd, feesUsd: paper.feesUsd, cashUsd: paper.cashUsd, realizedUsd: paper.realizedUsd, pnlUsd: s.pnlUsd, pnlMon: s.pnlUsd / book.mid, pnlPct: s.pnlUsd / REPLAY_OPTIONS.bankrollUsd * 100, netLiquidationPnlUsd: s.netLiquidationPnlUsd, maxDrawdownPct: paper.maxDrawdownPct, halted: paper.halted, dailyPaused: paper.dailyPaused, dailyPnlUsd: s.dailyPnlUsd, overnightBreaches: paper.overnightBreaches } };
  }
}
