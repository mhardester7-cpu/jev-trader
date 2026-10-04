import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { PaperExecution, validateFrame, type PaperCheckpoint, type PaperFrame } from "./paper";
import { REPLAY_OPTIONS, REPLAY_POLICY, quotePrice } from "./replay";
import { mockSignal } from "./model";
import { buildTradeState } from "./state";

interface SavedSession { version: 1; source: string; paper: PaperCheckpoint; lastFrame: PaperFrame | null }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function writeJsonAtomic(path: string, value: unknown) {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

/** One durable account. Read-only source identity prevents mixing fixture and public sessions. */
export class PaperSession {
  readonly paper: PaperExecution;
  private frames: PaperFrame[] = [];
  lastFrame: PaperFrame | null = null;
  private checkpointPath: string;
  readonly journalPath: string;

  constructor(readonly directory: string, readonly source: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.checkpointPath = join(directory, "account.json");
    this.journalPath = join(directory, "frames.jsonl");
    if (existsSync(this.checkpointPath)) {
      const envelope = JSON.parse(readFileSync(this.checkpointPath, "utf8"));
      const saved = envelope.data as SavedSession;
      if (!saved || saved.version !== 1 || saved.source !== source || envelope.sha256 !== digest(saved)) throw new Error("Paper account identity/checksum mismatch");
      if (JSON.stringify(saved.paper.options) !== JSON.stringify(REPLAY_OPTIONS)) throw new Error("Existing paper account uses different risk settings");
      this.paper = PaperExecution.restore(saved.paper);
      this.lastFrame = saved.lastFrame;
      if (this.lastFrame) {
        validateFrame(this.lastFrame);
        if (this.lastFrame.book.block !== this.paper.lastBlock) throw new Error("Checkpoint frame does not match ledger");
        this.frames = [this.lastFrame];
      } else if (this.paper.lastBlock) throw new Error("Missing checkpoint frame");
    } else {
      if (existsSync(this.journalPath)) throw new Error("Paper journal exists without its account; refusing to reset balances");
      this.paper = new PaperExecution(REPLAY_OPTIONS);
    }
  }

  step(frame: PaperFrame, allowEntry = true) {
    const fills = this.paper.advance(frame);
    this.lastFrame = frame;
    this.frames.push(frame);
    if (this.frames.length > 401) this.frames.shift();
    const price = { buy: quotePrice("buy", frame.book), sell: quotePrice("sell", frame.book) };
    const size = { buy: this.paper.sizeFor("buy", REPLAY_POLICY.tradeSizeMon, price.buy, frame.book), sell: this.paper.sizeFor("sell", REPLAY_POLICY.tradeSizeMon, price.sell, frame.book) };
    const decision = mockSignal(buildTradeState(this.frames, { buy: size.buy > 0, sell: size.sell > 0 }));
    const side = decision.action;
    // Warm up after a restart; never invent missing pre-restart feature history.
    const warmedUp = this.frames.length >= REPLAY_POLICY.horizonBlocks;
    const order = allowEntry && warmedUp && size[side] > 0 ? this.paper.place(side, size[side], price[side], frame.book) : null;
    const result = { block: frame.book.block, timestampMs: frame.timestampMs, model: "mock", warmedUp, entryAllowedByFreshness: allowEntry, decision: decision.action, order, fills, totals: this.paper.snapshot(frame.book) };
    this.save();
    appendFileSync(this.journalPath, JSON.stringify({ ...frame, result }) + "\n", { mode: 0o600 });
    return result;
  }

  save() {
    const data: SavedSession = { version: 1, source: this.source, paper: this.paper.checkpoint(), lastFrame: this.lastFrame };
    writeJsonAtomic(this.checkpointPath, { sha256: digest(data), data });
  }

  stop() { this.paper.cancelOrders(); this.save(); }
  fail() { this.paper.halt(); this.save(); }
  summary() { return this.lastFrame ? this.paper.snapshot(this.lastFrame.book) : null; }
}
