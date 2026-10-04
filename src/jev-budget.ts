// Published Jev 1.13 bounds checked 2026-10-04. Reserve the entire context for
// EVERY attempt, even after a timeout or a smaller response. Never reuse it.
export const JEV_MODEL = "jev-1.13.0";
export const JEV_INPUT_TOKEN_CEILING = 65536; // conservative interpretation of 64k
export const JEV_NANODOLLARS_PER_TOKEN = 42; // $0.042 per million input tokens
export const JEV_RESERVE_NANODOLLARS = JEV_INPUT_TOKEN_CEILING * JEV_NANODOLLARS_PER_TOKEN;
export interface JevLimits { maxRequests: number; maxUsd: number; maxSeconds: number }
export const INITIAL_JEV_LIMITS: Readonly<JevLimits> = Object.freeze({ maxRequests: 10, maxUsd: 0.03, maxSeconds: 120 });

export class JevRunError extends Error {
  constructor(readonly code: string) { super(code); }
}
export function validateJevLimits(limits: JevLimits) {
  if (!Number.isInteger(limits.maxRequests) || limits.maxRequests < 1 || limits.maxRequests > 449 || !Number.isFinite(limits.maxUsd) || limits.maxUsd < JEV_RESERVE_NANODOLLARS / 1e9 || limits.maxUsd > 1.25 || !Number.isInteger(limits.maxSeconds) || limits.maxSeconds < 5 || limits.maxSeconds > 600) throw new JevRunError("invalid_limits");
}
export class JevBudget {
  readonly deadline: number;
  private attempts = 0;
  private pending = false;
  private reportedNanos = 0;
  private uncertainNanos = 0;
  constructor(readonly limits: Readonly<JevLimits>, private now: () => number = Date.now) {
    validateJevLimits(limits); this.deadline = now() + limits.maxSeconds * 1000;
  }
  reserve() {
    if (this.pending) throw new JevRunError("request_already_in_flight");
    if (this.now() >= this.deadline) throw new JevRunError("time_limit");
    if (this.attempts >= this.limits.maxRequests || (this.attempts + 1) * JEV_RESERVE_NANODOLLARS > Math.floor(this.limits.maxUsd * 1e9)) throw new JevRunError("budget_limit");
    this.attempts++; this.pending = true;
  }
  settle(tokens: number | null) {
    if (!this.pending) throw new JevRunError("no_pending_request");
    this.pending = false;
    if (tokens === null || !Number.isInteger(tokens) || tokens < 0 || tokens > JEV_INPUT_TOKEN_CEILING) this.uncertainNanos += JEV_RESERVE_NANODOLLARS;
    else this.reportedNanos += tokens * JEV_NANODOLLARS_PER_TOKEN;
  }
  snapshot() {
    return { ...this.limits, attempts: this.attempts, inFlight: this.pending, reservedUsd: this.attempts * JEV_RESERVE_NANODOLLARS / 1e9, reportedCostUsd: this.reportedNanos / 1e9, uncertainCostUsd: this.uncertainNanos / 1e9, accountedCostUsd: (this.reportedNanos + this.uncertainNanos) / 1e9, reservePerRequestUsd: JEV_RESERVE_NANODOLLARS / 1e9 };
  }
}
