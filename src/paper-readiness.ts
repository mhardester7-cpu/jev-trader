import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { PaperExecution } from "./paper";

/** Offline arithmetic for the current fast collector; not a measured provider guarantee. */
export function fastCapacity(seconds = 900, inputTokensPerDecision = 2000) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600 || !Number.isInteger(inputTokensPerDecision) || inputTokensPerDecision < 1 || inputTokensPerDecision > 64000) throw new Error("Invalid capacity assumptions");
  const blocksPerSecond = 1000 / 300, decisions = Math.ceil(seconds * blocksPerSecond);
  // Each block: header + three contract reads + logs; head confirmation per one/two blocks.
  const steadyMethodsPerSecond = { pairedCatchup: blocksPerSecond * 5.5, currentSingleBlock: blocksPerSecond * 6 };
  const alchemyCuPerSecond = { pairedCatchup: blocksPerSecond * (20 + 3 * 26 + 60 + 5), currentSingleBlock: blocksPerSecond * (20 + 3 * 26 + 60 + 10) };
  return { seconds, blockMs: 300, decisionsAtEveryBlock: decisions, steadyMethodsPerSecond, configuredMethodRateCeiling: 25, recommendedProviderRpsWithHeadroom: 50, maximumBatchMethods: 10, hardRpcMethodBudget: seconds * 25 + 50, alchemyCuPerSecond, quicknodeCreditsAtEveryBlock: { low: Math.ceil(seconds * 1000 * 5.5 * 30 / 300), high: Math.ceil(seconds * 1000 * 6 * 30 / 300) }, jev: { model: "jev-1.13.0", assumedInputTokensPerDecision: inputTokensPerDecision, usdPerMillionInputTokens: 0.042, estimatedUsdAtEveryBlock: decisions * inputTokensPerDecision * 0.042 / 1e6, note: "Scenario only, not an approved spend cap. Actual token use and accepted decisions are unmeasured." } };
}

/** Reads only a named paper ledger, never .env, a key store, arbitrary environment values, or network. */
export function accountReadiness(directory: string) {
  const path = join(directory, "account.json"), journal = join(directory, "frames.jsonl");
  if (!existsSync(path)) return { state: existsSync(journal) ? "missing_checkpoint" : "not_started", valid: !existsSync(journal), halted: false };
  try {
    const envelope = JSON.parse(readFileSync(path, "utf8")), saved = envelope.data;
    if (!saved || saved.version !== 1 || envelope.sha256 !== createHash("sha256").update(JSON.stringify(saved)).digest("hex")) throw new Error("Invalid checksum");
    const paper = PaperExecution.restore(saved.paper);
    if ((saved.lastFrame?.book?.block ?? 0) !== paper.lastBlock) throw new Error("Frame mismatch");
    return { state: paper.halted ? "halted" : "saved", valid: true, halted: paper.halted, lastBlock: paper.lastBlock, cashUsd: paper.cashUsd, mon: paper.mon, dailyPaused: paper.dailyPaused };
  } catch { return { state: "invalid_checkpoint", valid: false, halted: true }; }
}
