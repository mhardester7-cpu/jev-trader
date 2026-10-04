import { dirname, join, resolve } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { dashboardChannel } from "../src/dashboard-server";
import { RecordedJevSession } from "../src/jev-session";
import { loadRecording } from "../src/recording";
import { writeJsonAtomic } from "../src/paper-session";

if (process.argv.length !== 2) throw new Error("Usage: bun run paper:dashboard (localhost only; no automatic model calls)");
const root = resolve(import.meta.dir, ".."), web = join(root, "web");
const nextBin = join(web, "node_modules/next/dist/bin/next");
if (!existsSync(nextBin)) throw new Error("Install web dependencies with the frozen lockfile and --ignore-scripts first");
const recording = loadRecording(join(root, "research/mon-usdc-20260917"));
const channel = dashboardChannel();
const session = new RecordedJevSession(recording, join(root, "data/jev-recorded"), channel.publish);
let api: ReturnType<typeof Bun.serve>;
try { api = Bun.serve({ hostname: "127.0.0.1", port: 8787, maxRequestBodySize: 5000, idleTimeout: 0, fetch: channel.handler(session) }); }
catch { channel.close(); throw new Error("Local API port 8787 unavailable; no process was replaced"); }
const child = Bun.spawn([process.execPath, "--no-env-file", nextBin, "dev", "--webpack", "--hostname", "127.0.0.1", "--port", "3001"], {
  cwd: web, env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`, NEXT_TELEMETRY_DISABLED: "1", DRY_RUN: "true", MODEL: "mock" }, stdin: "ignore", stdout: "inherit", stderr: "inherit",
});
mkdirSync(join(root, "data"), { recursive: true });
const startedAt = new Date().toISOString();
const receipt = (phase: string) => writeJsonAtomic(join(root, "data/dashboard-process.json"), { phase, pid: process.pid, webPid: child.pid, startedAt, url: "http://127.0.0.1:3001", binding: "127.0.0.1", mode: "recorded-jev", modelCallsAutomatic: false });
receipt("listening");
console.log(JSON.stringify({ url: "http://127.0.0.1:3001", phase: "awaiting_private_key_and_budget_approval", modelCalls: 0, recordedBlocks: recording.frames.length }));
let closing = false;
async function close() {
  if (closing) return; closing = true; session.stop(); await session.settled(); channel.close(); api.stop(true); child.kill("SIGTERM");
}
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
try { await child.exited; } finally { await close(); receipt("stopped"); }
