import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { decodeHistory, historicalHash, type HistoricalCache } from "../src/historical";
import type { ChainFrame } from "../src/paper-source";
import { evaluateRecording, type RecordingManifest } from "../src/recording-report";

if (process.argv.length > 3) throw new Error("Usage: bun run paper:free-replay [recording-directory]");
const dir = resolve(process.argv[2] ?? "research/mon-usdc-20260917");
const manifest: RecordingManifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const raw = readFileSync(join(dir, "frames.jsonl"), "utf8").trim();
const frames: ChainFrame[] = raw ? raw.split(/\r?\n/).map(line => JSON.parse(line)) : [];
// Reconstruct normalized frames from the original cached RPC values on every run.
const cache: HistoricalCache = JSON.parse(existsSync(join(dir, "cache.json.gz"))
  ? gunzipSync(readFileSync(join(dir, "cache.json.gz")), { maxOutputLength: 32 * 1024 * 1024 }).toString("utf8")
  : readFileSync(join(dir, "cache.json"), "utf8"));
if (historicalHash(cache) !== manifest.cacheSha256) throw new Error("Recording raw cache checksum mismatch");
if (!cache.entries.chain || parseInt(cache.entries.chain.result, 16) !== 143) throw new Error("Recording requires a successful chain identity read");
const decoded = decodeHistory(manifest.requestedStart, manifest.requestedBlocks, cache);
if (decoded.datasetSha256 !== historicalHash(frames)) throw new Error("Recording frames do not match raw RPC cache");
console.log(JSON.stringify(evaluateRecording(frames, manifest), null, 2));
