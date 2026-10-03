import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { PaperSession, writeJsonAtomic } from "../src/paper-session";
import { acquireRunLock } from "../src/paper-process";
import { PublicPaperSource, captureBlocks, PUBLIC_SOURCE_ID, PUBLIC_RPC, type ChainFrame } from "../src/paper-source";
import type { PaperFrame } from "../src/paper";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!, process.argv[i + 1]!);
const source = args.get("--source"), directory = args.get("--data-dir"), runId = args.get("--run-id");
const seconds = Number(args.get("--seconds") ?? 900), interval = Number(args.get("--interval-ms") ?? 300);
if (!["fixture", "public"].includes(source ?? "") || !directory || !/^[a-f0-9-]{36}$/.test(runId ?? "") || !Number.isInteger(seconds) || seconds < 1 || seconds > 3600 || !Number.isInteger(interval) || interval < 1 || interval > 1000) throw new Error("Invalid paper worker options");
const identity = { pid: process.pid, runId: runId! };
const release = acquireRunLock(directory, identity);
let stopped = false;
process.on("SIGTERM", () => { stopped = true; });
process.on("SIGINT", () => { stopped = true; });
const startedAt = Date.now(), expiresAt = startedAt + seconds * 1000;
let phase = "starting", lastResult: unknown = null, error: string | null = null, haltReason: string | null = null;
let session: PaperSession | undefined;
const reader = source === "public" ? new PublicPaperSource(seconds * 25 + 50) : null;
const state = () => {
  const value = { ...identity, phase, source, model: "mock", paperOnly: true, paidInferenceUsd: 0, startedAt, expiresAt, updatedAt: Date.now(), endpoint: reader ? PUBLIC_RPC : null, readQueries: reader?.queries ?? 0, lastBlock: session?.paper.lastBlock ?? 0, lastMarketTimestampMs: session?.lastFrame?.timestampMs ?? null, totals: session?.summary() ?? null, latest: lastResult, haltReason, error };
  writeJsonAtomic(join(directory, "status.json"), value);
  return value;
};

try {
  let frames: PaperFrame[] = [];
  let sourceId = PUBLIC_SOURCE_ID;
  if (!reader) {
    const path = resolve(args.get("--fixture") ?? resolve(import.meta.dir, "../tests/fixtures/mon-usdc-24-blocks.jsonl"));
    const contents = readFileSync(path, "utf8");
    sourceId = "fixture:" + createHash("sha256").update(contents).digest("hex");
    frames = contents.trim().split(/\r?\n/).map(line => JSON.parse(line));
  }
  session = new PaperSession(directory, sourceId);
  state();
  if (reader) await reader.verifyChain();
  let index = 0, knownHead = reader ? await reader.head() : 0;
  while (!stopped && Date.now() < expiresAt) {
    let batch: PaperFrame[], latestHead = 0, readMs = 0;
    if (reader) {
      if (knownHead <= session.paper.lastBlock) {
        await Bun.sleep(100);
        knownHead = await reader.head();
        continue;
      }
      const t0 = performance.now();
      batch = await reader.frames(captureBlocks(session.paper.lastBlock, knownHead));
      // Reuse this confirmation as the next iteration's head, avoiding a redundant round trip.
      latestHead = knownHead = await reader.head();
      readMs = performance.now() - t0;
    } else {
      while (index < frames.length && frames[index]!.book.block <= session.paper.lastBlock) index++;
      if (index >= frames.length) { phase = "completed"; break; }
      batch = [frames[index++]!];
    }
    for (const frame of batch) {
      if (stopped) break;
      const previousFrame = session.lastFrame as ChainFrame | null, alreadyHalted = session.paper.halted;
      const current = frame as ChainFrame;
      if (reader && previousFrame?.blockHash && current.book.block === previousFrame.book.block + 1 && current.parentHash !== previousFrame.blockHash) throw new Error("Chain continuity changed; paper account halted");
      const allowEntry = !reader || latestHead === frame.book.block && readMs < 300;
      lastResult = session.step(frame, allowEntry);
      phase = session.paper.halted ? "halted" : "running";
      if (session.paper.halted) {
        haltReason = alreadyHalted ? "Persisted account halt; review before further use" : previousFrame && (frame.book.block !== previousFrame.book.block + 1 || frame.timestampMs - previousFrame.timestampMs > 1000)
          ? `Observation gap: blocks ${previousFrame.book.block} to ${frame.book.block}, ${frame.timestampMs - previousFrame.timestampMs} ms`
          : "Paper risk limit reached; inspect totals and ledger";
      }
      state();
      if (session.paper.halted) break;
    }
    if (session.paper.halted) break;
    if (!reader) await Bun.sleep(interval);
  }
  session.stop(); // cancel local resting orders; retain inventory and loss history, no fictitious exit
  if (phase !== "halted" && phase !== "completed") phase = stopped ? "stopped" : "time_limit";
  state();
  console.log(JSON.stringify({ phase, lastBlock: session.paper.lastBlock, totals: session.summary() }));
} catch (e) {
  phase = "error";
  // Only fixed local/HTTP status error labels; never arbitrary provider response bodies or keys.
  error = e instanceof Error ? e.message.replace(/https?:\/\/\S+/g, "[endpoint]").slice(0, 160) : "Paper worker failed";
  if (session?.paper.lastBlock) session.fail();
  state();
  console.error(JSON.stringify({ phase, error }));
  process.exitCode = 1;
} finally { release(); }
