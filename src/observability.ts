/**
 * Decision observability: metrics, alerts and audit records over `onDecision`.
 *
 * `onDecision` tells you what happened once. Production needs the aggregate:
 * are people timing out because prompts arrive while they are typing, is
 * `busy` climbing because an agent fires parallel calls, did a release turn
 * confirmations into dismissals. This module aggregates decision records
 * without ever seeing arguments or tokens — the same boundary
 * `ConsentDecisionRecord` already draws — and evaluates simple rate alerts
 * over the aggregate. Ship the snapshot to whatever metrics system you run;
 * nothing here phones home.
 */

import type { ConsentDecisionRecord, DecisionObserver } from "./defineTool.js";

export type DecisionKind = ConsentDecisionRecord["decision"];

export type ToolDecisionStats = {
  total: number;
  byDecision: Record<string, number>;
  totalElapsedMs: number;
  maxElapsedMs: number;
};

export type DecisionMetricsSnapshot = {
  total: number;
  byDecision: Record<string, number>;
  /** Share of all decisions per kind, 0 when there are no decisions. */
  rates: Record<string, number>;
  byTool: Record<string, ToolDecisionStats>;
};

export type DecisionMetrics = {
  /** Hand to `defineConsequentialTool({ onDecision })`. Never throws. */
  readonly observer: DecisionObserver;
  /** A plain, JSON-safe copy of the aggregate. Safe to ship to a logger. */
  snapshot(): DecisionMetricsSnapshot;
  /** Drop all counts, e.g. at a route change or a metrics flush. */
  reset(): void;
};

function emptyToolStats(): ToolDecisionStats {
  return { total: 0, byDecision: {}, totalElapsedMs: 0, maxElapsedMs: 0 };
}

export function createDecisionMetrics(): DecisionMetrics {
  let total = 0;
  const byDecision: Record<string, number> = {};
  const byTool = new Map<string, ToolDecisionStats>();
  return {
    observer(record) {
      try {
        const toolName = typeof record?.toolName === "string" ? record.toolName : "unknown";
        const decision = typeof record?.decision === "string" ? record.decision : "closed";
        const elapsed = typeof record?.elapsedMs === "number" && Number.isFinite(record.elapsedMs)
          ? Math.max(0, record.elapsedMs)
          : 0;
        total += 1;
        byDecision[decision] = (byDecision[decision] ?? 0) + 1;
        let stats = byTool.get(toolName);
        if (stats === undefined) { stats = emptyToolStats(); byTool.set(toolName, stats); }
        stats.total += 1;
        stats.byDecision[decision] = (stats.byDecision[decision] ?? 0) + 1;
        stats.totalElapsedMs += elapsed;
        stats.maxElapsedMs = Math.max(stats.maxElapsedMs, elapsed);
      } catch { /* An observer must never break the tool it observes. */ }
    },
    snapshot() {
      const rates: Record<string, number> = {};
      for (const [decision, count] of Object.entries(byDecision)) {
        rates[decision] = total === 0 ? 0 : count / total;
      }
      const tools: Record<string, ToolDecisionStats> = {};
      for (const [name, stats] of byTool) {
        tools[name] = { ...stats, byDecision: { ...stats.byDecision } };
      }
      return { total, byDecision: { ...byDecision }, rates, byTool: tools };
    },
    reset() {
      total = 0;
      for (const key of Object.keys(byDecision)) delete byDecision[key];
      byTool.clear();
    },
  };
}

export type DecisionAlert = {
  kind: "timeout_rate" | "busy_rate" | "decline_rate" | "unverified_rate";
  /** The tool over threshold, or null when the alert is over all tools. */
  toolName: string | null;
  rate: number;
  threshold: number;
  samples: number;
};

export type DecisionAlertThresholds = {
  /** Minimum decisions before any rate is meaningful. Defaults to 20. */
  minSamples?: number;
  timeoutRate?: number;
  busyRate?: number;
  declineRate?: number;
  unverifiedRate?: number;
};

const ALERT_KINDS = [
  ["timeout", "timeout_rate", "timeoutRate"],
  ["busy", "busy_rate", "busyRate"],
  ["declined", "decline_rate", "declineRate"],
  ["unverified", "unverified_rate", "unverifiedRate"],
] as const;

/**
 * Evaluate rate alerts over a snapshot. Pure: no I/O, no throwing on a
 * malformed snapshot. Rates below `minSamples` never alert — three timeouts
 * out of three calls is an anecdote, not a signal. Thresholds left unset do
 * not alert. Suggested starting points: timeoutRate 0.25, busyRate 0.1,
 * unverifiedRate 0.05 (any unverified at volume means the exchange is down).
 */
export function evaluateDecisionAlerts(
  snapshot: DecisionMetricsSnapshot,
  thresholds: DecisionAlertThresholds = {},
): DecisionAlert[] {
  const minSamples = thresholds.minSamples ?? 20;
  const alerts: DecisionAlert[] = [];
  const scopes: Array<{ toolName: string | null; total: number; byDecision: Record<string, number> }> = [
    { toolName: null, total: snapshot?.total ?? 0, byDecision: snapshot?.byDecision ?? {} },
    ...Object.entries(snapshot?.byTool ?? {}).map(([toolName, stats]) => ({
      toolName, total: stats.total, byDecision: stats.byDecision,
    })),
  ];
  for (const scope of scopes) {
    if (scope.total < minSamples) continue;
    for (const [decision, kind, key] of ALERT_KINDS) {
      const threshold = thresholds[key];
      if (typeof threshold !== "number") continue;
      const rate = (scope.byDecision[decision] ?? 0) / scope.total;
      if (rate > threshold) alerts.push({ kind, toolName: scope.toolName, rate, threshold, samples: scope.total });
    }
  }
  return alerts;
}

/**
 * One audit-log record for a decision, as JSON-safe data. Deliberately
 * carries no arguments, no audit token and no proof: an audit trail shipped
 * to a log pipeline must not become a replay source. `v` versions the shape
 * (see schemas/consent-audit-log.schema.json). `at` is injectable so tests
 * and log pipelines can use their own clock.
 */
export function toAuditLogRecord(
  record: ConsentDecisionRecord,
  at: Date = new Date(),
): {
  v: 1;
  type: "webmcp.consent.decision";
  toolName: string;
  decision: string;
  elapsedMs: number;
  at: string;
} {
  return {
    v: 1,
    type: "webmcp.consent.decision",
    toolName: typeof record?.toolName === "string" ? record.toolName : "unknown",
    decision: typeof record?.decision === "string" ? record.decision : "closed",
    elapsedMs: typeof record?.elapsedMs === "number" && Number.isFinite(record.elapsedMs)
      ? Math.max(0, record.elapsedMs)
      : 0,
    at: at.toISOString(),
  };
}
