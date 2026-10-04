const BACKEND = "http://127.0.0.1:8787";
const HOSTS = new Set(["127.0.0.1:3001", "localhost:3001"]);
export const dynamic = "force-dynamic";

async function proxy(req: Request) {
  const url = new URL(req.url);
  if (!HOSTS.has(req.headers.get("host") ?? "")) return Response.json({ error: "local_host_required" }, { status: 403 });
  const path = url.pathname.slice("/api/paper".length) || "/";
  if (!(req.method === "GET" && ["/", "/events"].includes(path) || req.method === "POST" && ["/start", "/stop"].includes(path))) return new Response(null, { status: 404 });
  if (req.method === "POST" && req.headers.get("origin") !== `http://${req.headers.get("host")}`) return Response.json({ error: "same_origin_required" }, { status: 403 });
  const body = req.method === "POST" ? await req.text() : undefined;
  if (body && body.length > 5000) return new Response(null, { status: 413 });
  try {
    const response = await fetch(`${BACKEND}${path}`, { method: req.method, body, cache: "no-store", redirect: "error", signal: req.signal, headers: { "content-type": "application/json", origin: req.headers.get("origin") ?? "", "x-paper-control": req.headers.get("x-paper-control") ?? "" } });
    return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch { return Response.json({ error: "local_paper_server_unavailable" }, { status: 503 }); }
}
export const GET = proxy;
export const POST = proxy;
