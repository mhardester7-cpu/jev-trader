import { experimental_evaluate } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { config } from "./config";

/** Models answer buy or sell. `hold` only appears on late blocks (no decision was made). */
export type Action = "buy" | "sell" | "hold";

/** What the model sees. Compact, relative, human-readable. */
export interface TradeState {
  market: "MON-USDC";
  block: number;
  horizonBlocks: number; // the question is about the move over this many blocks
  blockMs: number;
  mid: number;
  spreadBps: number;
  bookImbalance: number; // -1 (all asks) .. 1 (all bids), within 1% of mid
  /** Cumulative resting MON within 10/25/50 bps of mid, per side. */
  depth: { [band: string]: { bid: number; ask: number } };
  /** Top 5 levels each side, best first, as "price x size". */
  book: { bids: string[]; asks: string[] };
  returnsBps: { last1: number; last5: number; last20: number; last100: number };
  recentMids: string; // oldest..newest, sampled every 5 blocks over the horizon, space separated
  /** Taker prints over the last `horizonBlocks`. cvdMon = taker buy volume - taker sell volume. */
  trades: { count: number; buyMon: number; sellMon: number; cvdMon: number; vwap: number | null; lastPrice: number | null; lastSide: "buy" | "sell" | null };
  recentTrades: string[]; // newest last, "block side size @ price"
  allowed: { buy: boolean; sell: boolean };
}

export interface Decision {
  action: Action;
  probabilities: Record<Action, number>;
  upIn10: number;
  latencyMs: number;
  inputTokens: number;
}

export interface Model {
  readonly name: string;
  decide(state: TradeState): Promise<Decision>;
}

export const QUESTIONS = {
  direction: {
    type: "choice",
    instructions: {
      question: "Will MON be higher or lower than the current mid after `horizonBlocks` more blocks?",
      goal: "Evaluate MON-USDC for a paper-only post-only limit order, replaced each block. The horizon is `horizonBlocks`. Direction alone does not establish net profitability after execution costs and adverse selection.",
      timing: "The order may rest in the next block and may never fill. No immediate execution is assumed.",
      inputs: "Consider taker flow: `trades.cvdMon` (taker buys minus taker sells over the horizon), `trades.lastSide` and `recentTrades` show who is hitting the book. `depth` and `book` show resting liquidity per side at several distances from mid; thin depth on one side means price moves easily that way. `returnsBps` and `recentMids` show the path over the horizon. An unavailable side is skipped, never reversed into an unwanted trade.",
    },
    criteria: {
      buy: "Buy MON now: mid more likely to be higher after `horizonBlocks` blocks, relative to the current mid.",
      sell: "Sell MON now: mid more likely to be lower after `horizonBlocks` blocks, relative to the current mid.",
    },
  },
} as const;

/** Real Jev via the AI SDK. Swap-in is the MODEL env var. */
export class JevModel implements Model {
  readonly name = config.jevModelId;
  private model = typeSafeAi.evaluationModel(config.jevModelId);

  async decide(state: TradeState): Promise<Decision> {
    const t0 = performance.now();
    const r = await experimental_evaluate({ model: this.model, state: state as any, questions: QUESTIONS, maxRetries: 0, abortSignal: AbortSignal.timeout(250) });
    const a = r.answers.direction;
    const p = a.probabilities ?? { buy: 0, sell: 0, [a.choice]: 1 };
    const buy = p.buy ?? 0, sell = p.sell ?? 0;
    return {
      action: a.choice as Action,
      probabilities: { buy, sell, hold: 0 },
      upIn10: buy,
      latencyMs: performance.now() - t0,
      inputTokens: r.usage?.inputTokens ?? 0,
    };
  }
}

/** Deterministic stand-in only; not a fitted or validated predictor. */
export class MockModel implements Model {
  readonly name = "mock";

  async decide(state: TradeState): Promise<Decision> {
    const t0 = performance.now();
    // Preserve the existing heuristic; no parameter tuning.
    const { action, probabilities, buy } = mockSignal(state);
    await Bun.sleep(80); // stand in for inference time so the pipeline behaves like production
    return {
      action, probabilities,
      upIn10: buy,
      latencyMs: performance.now() - t0,
      inputTokens: 0,
    };
  }

}

export function mockSignal(state: TradeState) {
  const flow = state.trades.buyMon + state.trades.sellMon ? state.trades.cvdMon / (state.trades.buyMon + state.trades.sellMon) : 0;
  const signal = state.returnsBps.last20 / 8 + state.bookImbalance * 1.5 + flow * 2 + mockNoise(state.block);
  const buy = 1 / (1 + Math.exp(-signal)); // binary softmax
  const probabilities = { buy, sell: 1 - buy, hold: 0 };
  const action: Action = buy >= 0.5 ? "buy" : "sell";
  return { action, probabilities, buy };
}

function mockNoise(block: number) {
  let h = block * 2654435761 >>> 0;
  h ^= h >>> 15; h = (h * 2246822519) >>> 0; h ^= h >>> 13;
  return ((h % 1000) / 1000 - 0.5) * 3;
}

export const createModel = (): Model => (config.model === "jev" ? new JevModel() : new MockModel());
