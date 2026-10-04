import { QUESTIONS, type Decision, type TradeState } from "./model";
import { historicalHash } from "./historical";
import { JEV_INPUT_TOKEN_CEILING, JEV_MODEL, JevBudget, JevRunError } from "./jev-budget";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export type JevTransport = (body: string, key: string, signal: AbortSignal) => Promise<unknown>;
/** Fixed HTTPS endpoint, no redirect, no retry, and no provider errors/body in logs. */
export const jevHttpTransport: JevTransport = async (body, key, signal) => {
  let response: Response;
  try { response = await fetch(JEV_ENDPOINT, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body, signal, redirect: "error" }); }
  catch { throw new JevRunError(signal.aborted ? "request_cancelled_or_timed_out" : "provider_unavailable"); }
  if (!response.ok) throw new JevRunError(`provider_http_${response.status}`);
  try { const text = await response.text(); if (text.length > 100000) throw new Error(); return JSON.parse(text); }
  catch { throw new JevRunError("invalid_provider_response"); }
};

export async function requestJev(state: TradeState, key: string, budget: JevBudget, signal: AbortSignal, beforeSend: () => void, transport: JevTransport = jevHttpTransport): Promise<Decision & { requestSha256: string }> {
  const body = JSON.stringify({ model: JEV_MODEL, state, questions: QUESTIONS });
  if (new TextEncoder().encode(body).length > 32768) throw new JevRunError("request_too_large");
  if (signal.aborted) throw new JevRunError("stopped");
  budget.reserve();
  let receivedTokens: number | null = null;
  const started = performance.now();
  try {
    beforeSend(); // persist the reservation BEFORE any potentially billable operation
    const raw: any = await transport(body, key, AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(5000, budget.deadline - Date.now())))]));
    const tokens = raw?.usage?.input_tokens;
    if (Number.isInteger(tokens) && tokens >= 0 && tokens <= JEV_INPUT_TOKEN_CEILING) receivedTokens = tokens;
    const answer = raw?.answers?.direction, p = answer?.probabilities;
    if (raw?.model !== JEV_MODEL || receivedTokens === null || answer?.type !== "choice" || !["buy", "sell"].includes(answer.choice) || !p || Object.keys(p).sort().join(",") !== "buy,sell" || ![p.buy, p.sell].every(v => Number.isFinite(v) && v >= 0 && v <= 1) || Math.abs(p.buy + p.sell - 1) > 1e-5 || p[answer.choice] + 1e-9 < Math.max(p.buy, p.sell)) throw new JevRunError("invalid_provider_response");
    return { action: answer.choice, probabilities: { buy: p.buy, sell: p.sell, hold: 0 }, upIn10: p.buy, latencyMs: Math.round(performance.now() - started), inputTokens: receivedTokens, requestSha256: historicalHash(JSON.parse(body)) };
  } catch (error) {
    throw error instanceof JevRunError ? error : new JevRunError("request_failed");
  } finally { budget.settle(receivedTokens); }
}
