import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { isPaperProcess, WORKER_PATH, type ProcessIdentity } from "../src/paper-process";

const command = process.argv[2];
const options = new Map<string, string>();
for (let i = 3; i < process.argv.length; i += 2) {
  const key = process.argv[i]!, value = process.argv[i + 1];
  if (!["--source", "--data-dir", "--seconds", "--fixture", "--interval-ms"].includes(key) || value === undefined) throw new Error("Unknown/missing paper option");
  options.set(key, value);
}
const source = options.get("--source");
if (!["start", "status", "stop"].includes(command ?? "") || !["fixture", "public"].includes(source ?? "")) throw new Error("Usage: paper-{start,status,stop} --source fixture|public [--seconds 900] [--data-dir path]. Public mode is read-only/mock, no Jev.");
if (source === "public" && (options.has("--fixture") || options.has("--interval-ms"))) throw new Error("Fixture options cannot alter public mode");
const seconds = Number(options.get("--seconds") ?? 900);
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error("Runtime must be 1..3600 seconds");
const directory = resolve(options.get("--data-dir") ?? resolve(import.meta.dir, `../data/paper-${source}`));
const statusPath = join(directory, "status.json"), lockPath = join(directory, "run.lock");
const load = (path: string) => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
const status = () => {
  const saved = load(statusPath), lock = load(lockPath) as ProcessIdentity | null;
  const identity = lock ?? saved;
  const running = !!identity && isPaperProcess(identity);
  return { ...(saved ?? { phase: "not_started", model: "mock", paperOnly: true, source }), running, processVerified: running, dataDirectory: directory, marketDataAgeSeconds: saved?.lastMarketTimestampMs ? Math.max(0, (Date.now() - saved.lastMarketTimestampMs) / 1000) : null, observationAgeSeconds: saved?.updatedAt ? (Date.now() - saved.updatedAt) / 1000 : null };
};

if (command === "status") console.log(JSON.stringify(status(), null, 2));
if (command === "stop") {
  const identity = load(lockPath) as ProcessIdentity | null;
  if (identity && isPaperProcess(identity)) {
    process.kill(identity.pid, "SIGTERM");
    const deadline = Date.now() + 6000;
    while (isPaperProcess(identity) && Date.now() < deadline) await Bun.sleep(100);
  }
  console.log(JSON.stringify(status(), null, 2));
}
if (command === "start") {
  if (status().running) throw new Error("This paper account is already running");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const runId = randomUUID();
  const args = [process.execPath, "--no-env-file", WORKER_PATH, "--source", source!, "--data-dir", directory, "--run-id", runId, "--seconds", String(seconds)];
  for (const flag of ["--fixture", "--interval-ms"]) if (options.has(flag)) args.push(flag, options.get(flag)!);
  const log = openSync(join(directory, "worker.log"), "a", 0o600);
  const child = Bun.spawn(args, { cwd: resolve(import.meta.dir, ".."), env: { PATH: "/usr/bin:/bin", MODEL: "mock", DRY_RUN: "true", TZ: "UTC" }, stdin: "ignore", stdout: log, stderr: log, detached: true });
  child.unref(); closeSync(log);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const saved = load(statusPath);
    if (saved?.runId === runId) break;
    if (child.exitCode !== null) throw new Error("Paper worker did not start; inspect worker.log");
    await Bun.sleep(50);
  }
  const current = status();
  if ((current as any).runId !== runId) throw new Error("Paper startup unconfirmed; inspect local status and worker.log");
  console.log(JSON.stringify(current, null, 2));
}
