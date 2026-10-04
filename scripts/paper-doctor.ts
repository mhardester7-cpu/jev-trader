import { resolve } from "node:path";
import { accountReadiness, fastCapacity } from "../src/paper-readiness";
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]!, value = process.argv[i + 1];
  if (!["--source", "--data-dir", "--seconds", "--input-tokens"].includes(key) || value === undefined) throw new Error("Unknown/missing doctor option");
  args.set(key, value);
}
const source = args.get("--source") ?? "public";
if (!["public", "fixture"].includes(source)) throw new Error("Doctor source must be public or fixture");
const directory = resolve(args.get("--data-dir") ?? resolve(import.meta.dir, `../data/paper-${source}`));
const account = accountReadiness(directory), blockers: string[] = [];
if (!account.valid) blockers.push("Account integrity requires diagnosis; do not reset it");
else if (account.halted) blockers.push("Persisted account halt; no automatic restart/reset");
if (source === "public") blockers.push("Current public feed has an observed HTTP 429/freshness limitation; a supported endpoint and measured latency are required");
console.log(JSON.stringify({ strategy: "original fast post-only market making", paperOnly: true, managedModel: "mock", managedRunnerAcceptsCredentials: false, networkRequestsMade: 0, credentialValuesRead: false, dataDirectory: directory, account, processState: "Not inspected; use paper:status for verified PID and freshness", blockers, capacity: fastCapacity(Number(args.get("--seconds") ?? 900), Number(args.get("--input-tokens") ?? 2000)), jevReadiness: "Not connected to managed runner; requires secure handoff, explicit spend/request cap and budgeted adapter integration", nextStep: "See docs/FAST_SETUP.md; no endpoint calls or account writes were made" }, null, 2));
