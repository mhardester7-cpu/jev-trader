import type { PaperFrame } from "../src/paper";

export function frame(block: number, mid = 0.02): PaperFrame {
  const bid = mid - 0.00001, ask = mid + 0.00001;
  return { timestampMs: Date.UTC(2026, 9, 1, 12) + block * 300, book: { block, bid, ask, mid, spreadBps: (ask - bid) / mid * 10000, imbalance: 0, levels: { bids: [[bid, 1000]], asks: [[ask, 1000]] }, depthBps: { 10: { bid: 1000, ask: 1000 } } }, prints: [] };
}

/** Synthetic data only. Seed fixed before any evaluation; no market-history claim. */
export function syntheticFrames(count = 600): PaperFrame[] {
  let seed = 123456789, units = 20000;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  return Array.from({ length: count }, (_, i) => {
    const drift = i < count / 3 ? 1 : i < 2 * count / 3 ? -1 : 0;
    units += Math.round((rand() - 0.5) * 10 + drift);
    const f = frame(i + 1, units * 0.000001);
    const side = rand() < 0.5 ? "buy" : "sell";
    f.book.imbalance = Math.round((rand() - 0.5) * 160) / 100;
    f.prints.push({ block: i + 1, side, size: 400 + Math.floor(rand() * 800), price: side === "buy" ? f.book.ask : f.book.bid });
    return f;
  });
}
