import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectHistoricalBatches, decodeHistory, emptyHistoricalCache, historicalHash, planHistory, type HistoricalCache } from "../src/historical";
import { writeJsonAtomic } from "../src/paper-session";
import { PUBLIC_RPC, PAPER_MARKET } from "../src/paper-source";
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]!, value = process.argv[i + 1];
  if (!["--start", "--count", "--dir", "--offline"].includes(key) || value === undefined) throw new Error("Usage: paper:collect --start BLOCK --count 600 --dir data/history [--offline true]");
  args.set(key, value);
}
const start = Number(args.get("--start")), count = Number(args.get("--count") ?? 600), offline = args.get("--offline") === "true";
if (args.has("--offline") && !["true", "false"].includes(args.get("--offline")!)) throw new Error("Invalid offline flag");
const directory = resolve(args.get("--dir") ?? `data/history-${start}-${count}`);
mkdirSync(directory, { recursive: true });
const cachePath = join(directory, "cache.json"), startedAt = new Date().toISOString();
const cache: HistoricalCache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : emptyHistoricalCache();
const plan = planHistory(start, count, cache);
console.log(JSON.stringify({ phase: "planned", endpoint: PUBLIC_RPC, start, count, cachedMethods: Object.keys(cache.entries).length, requestedMethods: plan.requests.length, methodsPerBatch: 3, minimumBatchSpacingMs: 1100, maxSeconds: 900, offline }));
const initialCachedMethods = Object.keys(cache.entries).length;
let stopped: string | null = null, attemptedMethods = 0;
try {
  if (!offline) {
    const result = await collectHistoricalBatches(plan.requests, cache, {
      now: Date.now, sleep: ms => Bun.sleep(ms), save: value => writeJsonAtomic(cachePath, value), progress: value => console.log(JSON.stringify({ phase: "collecting", ...value })),
      transport: async requests => {
        attemptedMethods += requests.length;
        const response = await fetch(PUBLIC_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requests), signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error(`Historical RPC HTTP ${response.status}; stopped without retry`);
        return response.json() as Promise<any[]>;
      },
    });
    stopped = result.stopReason;
  } else stopped = "Offline cache decode only";
} catch (e) { stopped = e instanceof Error ? e.message.replace(/https?:\/\/\S+/g, "[endpoint]").slice(0, 160) : "Historical retrieval stopped"; process.exitCode = 1; }
const decoded = decodeHistory(start, count, cache);
const text = decoded.frames.map(f => JSON.stringify(f)).join("\n") + (decoded.frames.length ? "\n" : "");
writeFileSync(join(directory, "frames.jsonl"), text);
const manifest = { version: 1, endpoint: PUBLIC_RPC, chainId: 143, market: PAPER_MARKET, startedAt, finishedAt: new Date().toISOString(), requestedStart: start, requestedEnd: plan.end, requestedBlocks: count, completeBlocks: decoded.completeBlocks, missingBlocks: decoded.missingBlocks, attemptedMethodsThisInvocation: attemptedMethods, completedMethodsThisInvocation: Object.keys(cache.entries).length - initialCachedMethods, cachedMethods: Object.keys(cache.entries).length, offline, stopReason: stopped, firstTimestampMs: decoded.frames[0]?.timestampMs ?? null, lastTimestampMs: decoded.frames.at(-1)?.timestampMs ?? null, datasetSha256: decoded.datasetSha256, cacheSha256: historicalHash(cache), sourceMode: "historical read-only; no orders, model calls, credentials or paid access", limitations: "Small contiguous sample selected for available cache, not results. Decoder validates every available block and prints; no missing observations fabricated. Not Jev or profitability evidence." };
writeJsonAtomic(join(directory, "manifest.json"), manifest);
appendFileSync(join(directory, "collection-history.jsonl"), JSON.stringify(manifest) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ phase: "finished", ...manifest }, null, 2));
