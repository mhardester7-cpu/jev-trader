"use client";

import { useState, type FormEvent } from "react";
import type { BlockEvent, ConnectionState, Meta } from "@/lib/types";
import styles from "./PaperControls.module.css";

const LABELS: Record<string, string> = { ready: "Ready for your Jev key", running: "Jev test running", stopping: "Stopping", completed: "Recording completed", stopped: "Stopped", time_limit: "Time limit reached", budget_limit: "Request or spend limit reached", paper_risk_limit: "Paper risk limit reached", error: "Stopped after an error" };
const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(6)}`;
export default function PaperControls({ meta, latest, connection }: { meta: Meta | null; latest: BlockEvent | null; connection: ConnectionState }) {
  const [apiKey, setApiKey] = useState("");
  const [maxRequests, setMaxRequests] = useState(10), [maxUsd, setMaxUsd] = useState(0.03), [approved, setApproved] = useState(false);
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null);
  const active = meta?.phase === "running" || meta?.phase === "stopping";
  const connected = connection === "live" && !!meta?.controlToken;
  const reserve = maxRequests * 0.002752512;
  async function control(path: string, body: object) {
    const response = await fetch(`/api/paper/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-paper-control": meta?.controlToken ?? "" }, body: JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? "Request failed");
  }
  async function start(event: FormEvent) {
    event.preventDefault(); setPending(true); setError(null);
    const key = apiKey; setApiKey(""); setApproved(false);
    try { await control("start", { apiKey: key, approved, maxRequests, maxUsd, maxSeconds: 120 }); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not start"); }
    finally { setPending(false); }
  }
  async function stop() {
    setPending(true); setError(null);
    try { await control("stop", {}); } catch { setError("Could not stop. Close the local dashboard process on the Mac."); }
    finally { setPending(false); }
  }
  const source = meta?.source, budget = meta?.budget;
  return <section className={styles.panel} aria-label="Jev paper session controls">
    <div className={styles.heading}>
      <div><h1>Jev paper trading</h1><p>Recorded market data. Real Jev decisions when you start. All orders simulated.</p></div>
      <strong className={styles.status} role="status">{connected ? LABELS[meta?.phase ?? "ready"] ?? meta?.phase : "Connecting to your Mac"}</strong>
    </div>
    <p className={styles.source}>{source ? `${source.blocks} saved MON-USDC blocks | ${new Date(source.firstTimestampMs).toISOString().slice(0, 19).replace("T", " ")} UTC | 150-block warmup` : "Waiting for the local paper server. Start it with bun run paper:dashboard on your Mac."}</p>
    <div className={styles.summary}>
      <div><span>Paper net P&L</span><strong>{latest ? usd(latest.totals.netLiquidationPnlUsd ?? 0) : "No run yet"}</strong></div>
      <div><span>Jev requests</span><strong>{budget ? `${budget.attempts} / ${budget.maxRequests}` : "0"}</strong></div>
      <div><span>Reported Jev cost</span><strong>{usd(budget?.reportedCostUsd ?? 0)}</strong></div>
      <div><span>Reserved / approved</span><strong>{budget ? `${usd(budget.reservedUsd)} / $${budget.maxUsd.toFixed(2)}` : "Not authorized"}</strong></div>
    </div>
    {active ? <div className={styles.actions}><button type="button" onClick={stop} disabled={pending || meta?.phase === "stopping"}>Stop Jev test</button><p>Closing this browser tab does not stop the run. The request, dollar and two-minute limits still apply.</p></div> :
      <form onSubmit={start} className={styles.form} autoComplete="off">
        <label className={styles.key}>Jev API key<input name="jev-key" type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} autoComplete="off" spellCheck={false} placeholder="Enter privately on this Mac" required minLength={8} maxLength={2048} /></label>
        <label>Maximum requests<input aria-label="Maximum requests" type="number" min={1} max={449} step={1} value={maxRequests} onChange={e => { setMaxRequests(Number(e.target.value)); setApproved(false); }} required /></label>
        <label>Maximum Jev spend<input aria-label="Maximum Jev spend" type="number" min={0.003} max={1.25} step={0.001} value={maxUsd} onChange={e => { setMaxUsd(Number(e.target.value)); setApproved(false); }} required /></label>
        <label className={styles.consent}><input type="checkbox" checked={approved} onChange={e => setApproved(e.target.checked)} />I authorize up to ${Number.isFinite(maxUsd) ? maxUsd.toFixed(3) : "0"} for this new $100 paper test.</label>
        <button disabled={!connected || pending || !apiKey || !approved || !Number.isFinite(reserve) || maxRequests < 1 || maxUsd < 0.003} type="submit">{pending ? "Starting..." : "Start new Jev test"}</button>
        <p className={styles.detail}>Key stays in memory for this run, then is discarded. Never paste it into chat. Each attempted call reserves $0.002753 at the published Jev price; no retries. {reserve > maxUsd ? "The dollar cap will stop this test before the requested call count." : ""}</p>
      </form>}
    {(error || meta?.reason) && <p className={styles.error} role="alert">{error ?? meta?.reason?.replaceAll("_", " ")}</p>}
    {!!budget?.uncertainCostUsd && <p className={styles.error}>Usage was unavailable for at least one call. ${budget.uncertainCostUsd.toFixed(6)} is conservatively accounted for; check the provider bill.</p>}
    <p className={styles.detail}>This is historical playback, not a live market feed or a profitability claim. The key and cap are required before any model call.</p>
  </section>;
}
