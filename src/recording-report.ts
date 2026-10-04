import { historicalHash } from "./historical";
import { PAPER_MARKET, PUBLIC_RPC, type ChainFrame } from "./paper-source";
import { evaluate, replay, REPLAY_OPTIONS, validateChronology } from "./replay";

export interface RecordingManifest {
  version: number; endpoint: string; chainId: number; market: string;
  requestedStart: number; requestedEnd: number; requestedBlocks: number;
  completeBlocks: number; missingBlocks: number;
  firstTimestampMs: number | null; lastTimestampMs: number | null;
  datasetSha256: string; cacheSha256: string; stopReason: string;
}
// Chosen before downloading/scoring the extended recording. No parameter search.
export const RECORDING_PROTOCOL = Object.freeze({ warmup: 150, window: 150 });
export const RECORDING_STRESS = Object.freeze({ ...REPLAY_OPTIONS, makerFeeBps: 10, exitFeeBps: 10, slippageBps: 10, gasMon: 0.0714 });

export function validateRecording(frames: readonly ChainFrame[], manifest: RecordingManifest) {
  if (manifest.version !== 1 || manifest.endpoint !== PUBLIC_RPC || manifest.chainId !== 143 || manifest.market !== PAPER_MARKET) throw new Error("Recording source identity mismatch");
  if (!Number.isSafeInteger(manifest.requestedStart) || !Number.isSafeInteger(manifest.requestedEnd) || !Number.isSafeInteger(manifest.requestedBlocks) || manifest.requestedBlocks < 1 || manifest.requestedBlocks > 600 || manifest.requestedEnd - manifest.requestedStart + 1 !== manifest.requestedBlocks || manifest.completeBlocks !== frames.length || manifest.missingBlocks !== manifest.requestedBlocks - frames.length || manifest.missingBlocks < 0) throw new Error("Recording range/count mismatch");
  if (manifest.datasetSha256 !== historicalHash(frames)) throw new Error("Recording dataset checksum mismatch");
  validateChronology(frames);
  if ((frames[0]?.timestampMs ?? null) !== manifest.firstTimestampMs || (frames.at(-1)?.timestampMs ?? null) !== manifest.lastTimestampMs || frames.length && frames[0]!.book.block !== manifest.requestedStart) throw new Error("Recording boundaries mismatch");
  frames.forEach((frame, i) => {
    if (!/^0x[0-9a-f]{64}$/i.test(frame.blockHash) || !/^0x[0-9a-f]{64}$/i.test(frame.parentHash) || i && frame.parentHash !== frames[i - 1]!.blockHash) throw new Error("Recording block hashes are discontinuous");
  });
}

export function evaluateRecording(frames: readonly ChainFrame[], manifest: RecordingManifest) {
  validateRecording(frames, manifest);
  const { warmup, window } = RECORDING_PROTOCOL;
  const sufficient = frames.length >= warmup + window;
  const cases = sufficient ? [{ name: "base", options: REPLAY_OPTIONS }, { name: "higherCosts", options: RECORDING_STRESS }].map(({ name, options }) => {
    const { equity, orders, ...continuous } = replay(frames, options, warmup);
    return { name, forwardWindows: evaluate(frames, options, warmup, window), continuous: { ...continuous, durationSeconds: (frames.at(-1)!.timestampMs - frames[warmup]!.timestampMs) / 1000, method: "One funded paper account after warmup; no fold resets. End inventory valued at estimated liquidation cost, not an invented terminal fill." } };
  }) : [];
  const spreads = frames.map(f => f.book.spreadBps), prints = frames.flatMap(f => f.prints);
  return {
    schemaVersion: 1, status: sufficient ? "small_sample_evaluated" : "insufficient_data",
    model: "frozen mock heuristic (not Jev)", source: manifest,
    observation: {
      firstUtc: frames.length ? new Date(frames[0]!.timestampMs).toISOString() : null,
      lastUtc: frames.length ? new Date(frames.at(-1)!.timestampMs).toISOString() : null,
      durationSeconds: frames.length ? (frames.at(-1)!.timestampMs - frames[0]!.timestampMs) / 1000 : 0,
      blocks: frames.length, tradePrints: prints.length,
      observedVolumeMon: prints.reduce((sum, p) => sum + p.size, 0),
      spreadBps: spreads.length ? { min: Math.min(...spreads), mean: spreads.reduce((a, b) => a + b, 0) / spreads.length, max: Math.max(...spreads) } : null,
      observedMakerFeeBps: [...new Set(frames.map(f => f.makerFeeBps))],
      observedTakerFeeBps: [...new Set(frames.map(f => f.takerFeeBps))],
      observedBaseFeeWei: [...new Set(frames.map(f => f.baseFeeWei))],
    },
    protocol: { ...RECORDING_PROTOCOL, minimumBlocks: warmup + window, strategyFitted: false, selectedFor: "Continuation of a previously cached block range; no result-based sample selection", timing: "Completed block N only informs an order eligible in N+1. Offline replay assumes timely next-block placement and does not simulate RPC/inference latency." },
    cases,
    limitations: [
      "One short contiguous historical interval is an operational replay, not evidence of statistically reliable profitability. No annualization or significance claim.",
      "Chronological forward windows use past-only features and a frozen policy, with fresh cash per window. Adjacent windows are not independent market regimes or fitted walk-forward training.",
      "Paper fills require strict opposite-side trade-through and 25% participation; they do not establish actual queue priority, placement/cancel success, market impact or available forced-exit liquidity.",
      "Maker/exit fees and gas are assumptions, not measured strategy transaction bills. Gas is charged per quote including unfilled quotes; omitted standalone cancellation costs can increase actual costs.",
      "Public RPC previously failed the fast live loop's freshness/rate requirements. Historical replay does not establish real-time feasibility. Mock inference costs zero; Jev has not been tested.",
      "Source hashes detect corruption and make the recording reproducible; a single RPC provider is not an independently authenticated completeness proof.",
    ],
  };
}
