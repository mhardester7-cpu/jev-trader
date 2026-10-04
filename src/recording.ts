import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { decodeHistory, historicalHash, type HistoricalCache } from "./historical";
import { validateRecording, type RecordingManifest } from "./recording-report";
import type { ChainFrame } from "./paper-source";

/** Validates the saved source only. Does not execute any strategy or model. */
export function loadRecording(dir: string) {
  const manifest: RecordingManifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const raw = readFileSync(join(dir, "frames.jsonl"), "utf8").trim();
  const frames: ChainFrame[] = raw ? raw.split(/\r?\n/).map(line => JSON.parse(line)) : [];
  const cache: HistoricalCache = JSON.parse(existsSync(join(dir, "cache.json.gz"))
    ? gunzipSync(readFileSync(join(dir, "cache.json.gz")), { maxOutputLength: 32 * 1024 * 1024 }).toString("utf8")
    : readFileSync(join(dir, "cache.json"), "utf8"));
  if (historicalHash(cache) !== manifest.cacheSha256) throw new Error("Recording raw cache checksum mismatch");
  if (!cache.entries.chain || parseInt(cache.entries.chain.result, 16) !== 143) throw new Error("Recording requires a successful chain identity read");
  const decoded = decodeHistory(manifest.requestedStart, manifest.requestedBlocks, cache);
  if (decoded.datasetSha256 !== historicalHash(frames)) throw new Error("Recording frames do not match raw RPC cache");
  validateRecording(frames, manifest);
  return { frames, manifest };
}
