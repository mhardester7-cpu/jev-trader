import { ethers } from "ethers";
import abi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";
import { buildBook, decodeVaultParams, toFloat } from "./book";
import { validateFrame, type PaperFrame } from "./paper";
import { REPLAY_OPTIONS } from "./replay";

export const PUBLIC_RPC = "https://rpc2.monad.xyz";
export const PAPER_MARKET = "0x065C9d28E428A0db40191a54d33d5b7c71a9C394";
export const PUBLIC_SOURCE_ID = `public:143:${PAPER_MARKET.toLowerCase()}`;
const TRADE_TOPIC = "0xf16924fba1c18c108912fcacaac7450c98eb3f2d8c0a3cdf3df7066c08f21581";
interface Query { method: "eth_chainId" | "eth_blockNumber" | "eth_getBlockByNumber" | "eth_call" | "eth_getLogs"; params: unknown[] }
type Transport = (queries: Query[]) => Promise<any[]>;
export type ChainFrame = PaperFrame & { blockHash: string; parentHash: string; baseFeeWei: string; makerFeeBps: number; takerFeeBps: number };

export function captureBlocks(lastBlock: number, head: number): number[] {
  if (head <= lastBlock) return [];
  // Larger gaps are surfaced to the ledger; never silently sample away missing prints.
  if (!lastBlock || head - lastBlock > 20) return [head];
  return Array.from({ length: Math.min(2, head - lastBlock) }, (_, i) => lastBlock + i + 1);
}

/** Fixed public endpoint and read methods only. No wallet, API key, or configurable paid provider. */
export class PublicPaperSource {
  queries = 0;
  private nextRequestAt = 0;
  private iface = new ethers.utils.Interface(abi.abi);
  constructor(private maxQueries = 22550, private transport?: Transport) {}

  private async batch(queries: Query[]): Promise<any[]> {
    if (this.queries + queries.length > this.maxQueries) throw new Error("Public read request budget exhausted");
    this.queries += queries.length;
    if (this.transport) return this.transport(queries);
    const delay = this.nextRequestAt - Date.now();
    if (delay > 0) await Bun.sleep(delay);
    this.nextRequestAt = Date.now() + queries.length * 40; // <=25 RPC methods/sec, below published 30/sec average
    const response = await fetch(PUBLIC_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(queries.map((q, id) => ({ jsonrpc: "2.0", id, ...q }))), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Public RPC HTTP ${response.status}`);
    const raw: any = await response.json();
    if (!Array.isArray(raw)) throw new Error("Invalid public RPC batch response");
    const byId = new Map(raw.map((r: any) => [r.id, r]));
    return queries.map((_, id) => {
      const r: any = byId.get(id);
      if (!r || r.error || r.result === null || r.result === undefined) throw new Error(`Public RPC read failed (${r?.error?.code ?? "missing result"})`);
      return r.result;
    });
  }

  async verifyChain() {
    const [chain] = await this.batch([{ method: "eth_chainId", params: [] }]);
    if (parseInt(chain, 16) !== 143) throw new Error("Unexpected chain; paper source stopped");
  }
  async head(): Promise<number> {
    const [value] = await this.batch([{ method: "eth_blockNumber", params: [] }]);
    const block = parseInt(value, 16);
    if (!Number.isSafeInteger(block) || block <= 0) throw new Error("Invalid public head");
    return block;
  }
  async frame(block: number): Promise<ChainFrame> {
    return (await this.frames([block]))[0]!;
  }
  /** At most two consecutive blocks fit the provider's ten-method batch maximum. */
  async frames(blocks: number[]): Promise<ChainFrame[]> {
    if (!blocks.length || blocks.length > 2 || blocks.some((block, i) => !Number.isSafeInteger(block) || block <= 0 || i > 0 && block !== blocks[i - 1]! + 1)) throw new Error("Public batch needs one or two consecutive blocks");
    const raw = await this.batch(blocks.flatMap(block => this.frameQueries(block)));
    return blocks.map((block, i) => this.decodeFrame(block, raw.slice(i * 5, i * 5 + 5)));
  }
  private frameQueries(block: number): Query[] {
    const tag = "0x" + block.toString(16);
    const call = (data: string): Query => ({ method: "eth_call", params: [{ to: PAPER_MARKET, data }, tag] });
    return [
      { method: "eth_getBlockByNumber", params: [tag, false] },
      call("0x46fdfbb1"), call("0x88bb4f60"), call("0x90c9427c"),
      { method: "eth_getLogs", params: [{ address: PAPER_MARKET, topics: [TRADE_TOPIC], fromBlock: tag, toBlock: tag }] },
    ];
  }
  private decodeFrame(block: number, raw: any[]): ChainFrame {
    const [header, l2, vault, rawParams, logs] = raw;
    const p = this.iface.decodeFunctionResult("getMarketParams", rawParams);
    if (String(p[0]) !== "100000000" || String(p[1]) !== "10000000000" || String(p[6]) !== "100" || String(p[7]) !== "2000000000000" || String(p[2]).toLowerCase() !== ethers.constants.AddressZero || String(p[4]).toLowerCase() !== "0x754704bc059f8c67012fed69bc8a327a5aafb603") throw new Error("Market parameters changed; review paper sizing/price assumptions");
    const makerFeeBps = Number(p[10]), takerFeeBps = Number(p[9]);
    if (makerFeeBps > REPLAY_OPTIONS.makerFeeBps || takerFeeBps > REPLAY_OPTIONS.exitFeeBps) throw new Error("Observed fees exceed paper cost assumptions");
    const book = buildBook(l2, { pricePrecision: p[0], sizePrecision: p[1], tickSize: p[6] }, decodeVaultParams(vault));
    if (parseInt(header.number, 16) !== block || book.block !== block) throw new Error("Public book/header block mismatch");
    const seen = new Set<string>();
    const prints = logs.sort((a: any, b: any) => parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16)).map((log: any) => {
      const id = `${log.transactionHash}:${log.logIndex}`;
      if (seen.has(id) || log.removed || log.blockHash !== header.hash || parseInt(log.blockNumber, 16) !== block) throw new Error("Duplicate, removed, or mismatched trade log");
      seen.add(id);
      const trade = this.iface.parseLog(log).args;
      return { block, side: trade.isBuy ? "buy" as const : "sell" as const, price: toFloat(BigInt(trade.price.toString()), 18), size: toFloat(BigInt(trade.filledSize.toString()), 10) };
    });
    const frame = { timestampMs: parseInt(header.timestamp, 16) * 1000, book, prints, blockHash: header.hash, parentHash: header.parentHash, baseFeeWei: String(BigInt(header.baseFeePerGas)), makerFeeBps, takerFeeBps };
    validateFrame(frame);
    return frame;
  }
}
