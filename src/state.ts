import type { PaperFrame } from "./paper";
import type { TradeState } from "./model";

/** Only completed frames at or before the decision block. No future labels enter features. */
export function buildTradeState(frames: readonly PaperFrame[], allowed: { buy: boolean; sell: boolean }, horizonBlocks = 100): TradeState {
  const book = frames.at(-1)!.book;
  const ret = (k: number) => {
    const past = frames.find(f => f.book.block === book.block - k)?.book.mid;
    return past ? (book.mid / past - 1) * 10000 : 0;
  };
  const recent = frames.filter(f => f.book.block > book.block - horizonBlocks);
  const prints = recent.flatMap(f => f.prints);
  const buyMon = prints.filter(t => t.side === "buy").reduce((sum, t) => sum + t.size, 0);
  const sellMon = prints.filter(t => t.side === "sell").reduce((sum, t) => sum + t.size, 0);
  const last = prints.at(-1);
  const lvl = (l: [number, number]) => `${l[0].toFixed(6)} x ${round(l[1], 1)}`;
  return {
    market: "MON-USDC", block: book.block, horizonBlocks, blockMs: 300,
    mid: book.mid, spreadBps: round(book.spreadBps, 2), bookImbalance: round(book.imbalance, 3),
    depth: Object.fromEntries(Object.entries(book.depthBps).map(([band, d]) => [band + "bps", { bid: round(d.bid, 1), ask: round(d.ask, 1) }])),
    book: { bids: book.levels.bids.map(lvl), asks: book.levels.asks.map(lvl) },
    returnsBps: { last1: round(ret(1), 2), last5: round(ret(5), 2), last20: round(ret(20), 2), last100: round(ret(100), 2) },
    recentMids: recent.filter(f => (book.block - f.book.block) % 5 === 0).map(f => f.book.mid.toFixed(6)).join(" "),
    trades: { count: prints.length, buyMon, sellMon, cvdMon: buyMon - sellMon, vwap: buyMon + sellMon ? prints.reduce((sum, t) => sum + t.size * t.price, 0) / (buyMon + sellMon) : null, lastPrice: last?.price ?? null, lastSide: last?.side ?? null },
    recentTrades: prints.slice(-10).map(t => `${t.block} ${t.side} ${round(t.size, 1)} @ ${t.price.toFixed(6)}`),
    allowed,
  };
}
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
