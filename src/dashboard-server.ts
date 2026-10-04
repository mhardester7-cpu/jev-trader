import { randomBytes } from "node:crypto";
import { JevRunError, INITIAL_JEV_LIMITS } from "./jev-budget";
import type { RecordedJevSession } from "./jev-session";

const hosts = new Set(["127.0.0.1:8787", "localhost:8787"]);
const origins = new Set(["http://127.0.0.1:3001", "http://localhost:3001"]);
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });

export function dashboardChannel() {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>(), encoder = new TextEncoder();
  const controlToken = randomBytes(32).toString("hex");
  const send = (client: ReadableStreamDefaultController<Uint8Array>, type: string, value: unknown) => {
    try { client.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`)); } catch { clients.delete(client); }
  };
  const decorate = (value: unknown) => ({ ...(value as object), controlToken, defaults: INITIAL_JEV_LIMITS });
  const publish = (type: string, value: unknown) => clients.forEach(c => send(c, type, type === "snapshot" || type === "status" ? decorate(value) : value));
  const ping = setInterval(() => clients.forEach(c => send(c, "ping", Date.now())), 15000);
  return {
    publish,
    close: () => { clearInterval(ping); clients.forEach(c => { try { c.close(); } catch {} }); clients.clear(); },
    handler: (session: RecordedJevSession) => async (req: Request): Promise<Response> => {
      if (!hosts.has(req.headers.get("host") ?? "")) return json({ error: "local_host_required" }, 403);
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/") return json(decorate(session.snapshot()));
      if (req.method === "GET" && path === "/events") {
        let client: ReadableStreamDefaultController<Uint8Array>;
        return new Response(new ReadableStream<Uint8Array>({
          start(c) { client = c; clients.add(c); send(c, "snapshot", decorate(session.snapshot())); req.signal.addEventListener("abort", () => { clients.delete(c); try { c.close(); } catch {} }, { once: true }); },
          cancel() { clients.delete(client); },
        }), { headers: { ...headers, "content-type": "text/event-stream", connection: "keep-alive" } });
      }
      if (req.method !== "POST" || !["/start", "/stop"].includes(path)) return json({ error: "not_found" }, 404);
      if (!origins.has(req.headers.get("origin") ?? "") || req.headers.get("x-paper-control") !== controlToken || req.headers.get("content-type")?.split(";")[0] !== "application/json") return json({ error: "local_control_required" }, 403);
      try {
        if (path === "/stop") { session.stop(); return json({ stopped: true }); }
        const text = await req.text(); if (text.length > 5000) return json({ error: "request_too_large" }, 413);
        const body = JSON.parse(text);
        const runId = session.start(body.apiKey, { maxRequests: body.maxRequests, maxUsd: body.maxUsd, maxSeconds: body.maxSeconds }, body.approved);
        body.apiKey = "";
        return json({ runId }, 202);
      } catch (error) { return json({ error: error instanceof JevRunError ? error.code : "invalid_start_request" }, 400); }
    },
  };
}
