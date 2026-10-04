import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const WORKER_PATH = resolve(import.meta.dir, "../scripts/paper-worker.ts");
export interface ProcessIdentity { pid: number; runId: string }

/** PID reuse must never cause status/stop to target another program. No shell or env inspection. */
export function isPaperProcess(value: ProcessIdentity): boolean {
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || !/^[a-f0-9-]{36}$/.test(value.runId)) return false;
  const result = Bun.spawnSync(["/bin/ps", "-p", String(value.pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" });
  const command = result.stdout.toString();
  return result.exitCode === 0 && command.includes(WORKER_PATH) && command.includes(`--run-id ${value.runId}`);
}

export function acquireRunLock(directory: string, identity: ProcessIdentity): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, "run.lock");
  if (existsSync(file)) {
    const prior = JSON.parse(readFileSync(file, "utf8")) as ProcessIdentity;
    if (isPaperProcess(prior)) throw new Error("This paper account is already running");
    unlinkSync(file); // stale identity verified; account files remain intact
  }
  writeFileSync(file, JSON.stringify(identity), { flag: "wx", mode: 0o600 });
  return () => {
    if (!existsSync(file)) return;
    const current = JSON.parse(readFileSync(file, "utf8"));
    if (current.pid === identity.pid && current.runId === identity.runId) unlinkSync(file);
  };
}
