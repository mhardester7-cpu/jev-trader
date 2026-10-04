import { createHash } from "node:crypto";
import { PAPER_MARKET, PUBLIC_RPC, PublicPaperSource, type ChainFrame } from "./paper-source";

export interface HistoricalQuery { jsonrpc: "2.0"; id: string; method: string; params: unknown[] }
export interface HistoricalCache { version: 1; endpoint: string; chainId: 143; market: string; entries: Record<string, { result: any; sha256: string; retrievedAt: string }> }
export const historicalHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const emptyHistoricalCache = (): HistoricalCache => ({ version: 1, endpoint: PUBLIC_RPC, chainId: 143, market: PAPER_MARKET, entries: {} });
export function validateHistoricalCache(cache: HistoricalCache) {
  if (cache.version !== 1 || cache.endpoint !== PUBLIC_RPC || cache.chainId !== 143 || cache.market !== PAPER_MARKET || !cache.entries) throw new Error("Historical cache identity mismatch");
  for (const entry of Object.values(cache.entries)) if (entry.sha256 !== historicalHash(entry.result)) throw new Error("Historical cache checksum mismatch");
}
const query = (id: string, method: string, params: unknown[]): HistoricalQuery => ({ jsonrpc: "2.0", id, method, params });
const topic = "0xf16924fba1c18c108912fcacaac7450c98eb3f2d8c0a3cdf3df7066c08f21581";

export function planHistory(start: number, count: number, cache: HistoricalCache) {
  if (!Number.isSafeInteger(start) || start <= 0 || !Number.isInteger(count) || count < 1 || count > 600 || start > Number.MAX_SAFE_INTEGER - count) throw new Error("Historical range must be 1..600 positive consecutive blocks");
  validateHistoricalCache(cache);
  const end = start + (count - 1), logs: { id: string; from: number; to: number }[] = [];
  const requests = [query("chain", "eth_chainId", [])];
  for (let from = start; from <= end;) {
    const existing = Object.keys(cache.entries).map(id => ({ id, m: /^logs-(\d+)-(\d+)$/.exec(id) })).find(x => x.m && Number(x.m[1]) === from && Number(x.m[2]) <= end && Number(x.m[2]) >= from && Number(x.m[2]) - from < 100);
    const to = existing ? Number(existing.m![2]) : Math.min(end, from + 99);
    const id = `logs-${from}-${to}`; logs.push({ id, from, to });
    requests.push(query(id, "eth_getLogs", [{ address: PAPER_MARKET, topics: [topic], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]));
    from = to + 1;
  }
  for (let block = start; block <= end; block++) {
    const tag = "0x" + block.toString(16);
    requests.push(query(`${block}-header`, "eth_getBlockByNumber", [tag, false]));
    for (const [name, data] of [["book", "0x46fdfbb1"], ["vault", "0x88bb4f60"], ["params", "0x90c9427c"]]) requests.push(query(`${block}-${name}`, "eth_call", [{ to: PAPER_MARKET, data }, tag]));
  }
  return { start, end, count, logs, requests: requests.filter(r => !cache.entries[r.id]) };
}

/** Decode only the contiguous complete prefix; never fill absent books, logs or timestamps. */
export function decodeHistory(start: number, count: number, cache: HistoricalCache) {
  const plan = planHistory(start, count, cache), reader = new PublicPaperSource(0);
  if (cache.entries.chain && parseInt(cache.entries.chain.result, 16) !== 143) throw new Error("Unexpected historical chain");
  const frames: ChainFrame[] = [];
  for (let block = start; block <= plan.end; block++) {
    const range = plan.logs.find(x => block >= x.from && block <= x.to)!;
    const values = ["header", "book", "vault", "params"].map(name => cache.entries[`${block}-${name}`]?.result);
    const logs = cache.entries[range.id]?.result;
    if (values.some(v => v === undefined) || logs === undefined) break;
    if (!Array.isArray(logs) || logs.some(log => !/^0x[0-9a-f]+$/i.test(log.blockNumber) || !Number.isSafeInteger(parseInt(log.blockNumber, 16)) || parseInt(log.blockNumber, 16) < range.from || parseInt(log.blockNumber, 16) > range.to || String(log.address).toLowerCase() !== PAPER_MARKET.toLowerCase())) throw new Error("Historical logs outside requested market/window");
    const frame = reader.decodeFrame(block, [...values, logs.filter(l => parseInt(l.blockNumber, 16) === block)]);
    const previous = frames.at(-1);
    if (previous && (frame.parentHash !== previous.blockHash || frame.timestampMs < previous.timestampMs)) throw new Error("Historical chain continuity mismatch");
    frames.push(frame);
  }
  return { frames, requestedBlocks: count, completeBlocks: frames.length, missingBlocks: count - frames.length, datasetSha256: historicalHash(frames) };
}

export async function collectHistoricalBatches(requests: HistoricalQuery[], cache: HistoricalCache, io: {
  now: () => number; sleep: (ms: number) => Promise<void>;
  transport: (requests: HistoricalQuery[]) => Promise<any[]>;
  save: (cache: HistoricalCache) => void;
  progress?: (value: { completedMethods: number; remainingMethods: number }) => void;
}) {
  if (requests.length > 2500) throw new Error("Historical method budget exceeds 2500");
  const deadline = io.now() + 900000;
  let completedMethods = 0, nextRequestAt = io.now();
  for (let i = 0; i < requests.length; i += 3) {
    const delay = nextRequestAt - io.now();
    if (delay > 0) await io.sleep(delay);
    // Reserve the transport's eight-second timeout inside the total time budget.
    if (io.now() + 8000 > deadline) return { completedMethods, stopReason: "15-minute collection limit" };
    const batch = requests.slice(i, i + 3);
    nextRequestAt = io.now() + 1100; // at most three methods per 1.1 seconds, one request in flight
    const results = await io.transport(batch); // any HTTP/RPC error ends the invocation; no retry
    if (!Array.isArray(results) || results.length !== batch.length || new Set(results.map(r => r.id)).size !== batch.length) throw new Error("Invalid historical RPC batch");
    const byId = new Map(results.map(r => [r.id, r]));
    for (const q of batch) {
      const r = byId.get(q.id);
      if (!r || r.error || r.result === undefined || r.result === null) throw new Error(`Historical RPC failed (${r?.error?.code ?? "missing result"})`);
      if (q.id === "chain" && parseInt(r.result, 16) !== 143) throw new Error("Unexpected historical chain");
    }
    for (const q of batch) {
      const result = byId.get(q.id).result;
      cache.entries[q.id] = { result, sha256: historicalHash(result), retrievedAt: new Date(io.now()).toISOString() };
    }
    completedMethods += batch.length; io.save(cache);
    if (i === 0 || i % 150 === 0 || i + 3 >= requests.length) io.progress?.({ completedMethods, remainingMethods: requests.length - completedMethods });
  }
  return { completedMethods, stopReason: "Requested history collected" };
}
