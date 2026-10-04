import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardChannel } from "../src/dashboard-server";
import { RecordedJevSession } from "../src/jev-session";
import { loadRecording } from "../src/recording";

test("dashboard idle is inert and requires local origin, token and explicit cost approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "jev-dashboard-test-")), channel = dashboardChannel(); let calls = 0;
  const session = new RecordedJevSession(loadRecording(join(import.meta.dir, "../research/mon-usdc-20260917")), root, channel.publish, async () => { calls++; throw new Error("Unit fixture"); });
  const handle = channel.handler(session);
  const req = (path: string, init: RequestInit = {}) => new Request(`http://127.0.0.1:8787${path}`, { ...init, headers: { host: "127.0.0.1:8787", ...init.headers } });
  try {
    const snapshot = await (await handle(req("/"))).json() as any;
    expect(snapshot.phase).toBe("ready"); expect(snapshot.history).toEqual([]); expect(calls).toBe(0);
    const body = JSON.stringify({ apiKey: "unit-fixture-not-real", maxRequests: 1, maxUsd: 0.03, maxSeconds: 10, approved: false });
    const attempts: Record<string, string>[] = [{}, { origin: "https://foreign.invalid", "x-paper-control": snapshot.controlToken }, { origin: "http://127.0.0.1:3001", "x-paper-control": "wrong" }];
    for (const headers of attempts) {
      expect((await handle(req("/start", { method: "POST", headers: { "content-type": "application/json", ...headers }, body }))).status).toBe(403);
    }
    const denied = await handle(req("/start", { method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:3001", "x-paper-control": snapshot.controlToken }, body }));
    expect((await denied.json() as any).error).toBe("budget_approval_required"); expect(calls).toBe(0);
    expect((await handle(req("/", { headers: { host: "foreign.invalid:8787" } }))).status).toBe(403);
    expect((await handle(req("/unknown"))).status).toBe(404);
  } finally { channel.close(); rmSync(root, { recursive: true }); }
});
