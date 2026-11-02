# Observability: decisions, metrics, alerts, audit records

`onDecision` reports one decision. Production needs the aggregate: whether
prompts time out because they arrive mid-keystroke, whether `busy` climbs
because an agent fires parallel consequential calls, whether a release
turned confirmations into dismissals. This page wires the pieces exported
from the package root.

## Collect

```ts
import {
  createDecisionMetrics,
  defineConsequentialTool,
} from "@melaninmap/webmcp-consent";

export const decisionMetrics = createDecisionMetrics();

const handoff = defineConsequentialTool({
  // ...
  onDecision: decisionMetrics.observer,
});
```

One metrics instance can observe every consequential tool on the page; the
snapshot breaks counts down per tool. Flush on your own cadence, then
`reset()`:

```ts
setInterval(() => {
  ship("webmcp.consent.metrics", decisionMetrics.snapshot());
  decisionMetrics.reset();
}, 60_000);
```

The snapshot carries counts, rates, and elapsed-time totals/maxima only.
It never contains arguments, audit tokens or proofs — the same boundary
`ConsentDecisionRecord` draws — so it is safe to send to an analytics
pipeline.

## Alert

`evaluateDecisionAlerts` is pure: feed it a snapshot and thresholds, get
back the rates that crossed. Suggested starting points:

| Alert | Threshold | What it usually means |
| --- | --- | --- |
| `timeout_rate` | 0.25 | Prompts arrive at bad moments, or the deadline is too short for the decision. |
| `busy_rate` | 0.10 | An agent fires parallel consequential calls; serialize upstream or raise queue capacity deliberately. |
| `decline_rate` | — (watch trend) | Tool descriptions over-promise; the model asks for things people do not want. |
| `unverified_rate` | 0.05 | The consent exchange is failing: endpoint down, misconfigured secret, or clock skew. At volume this is an outage, not user behavior. |

Rates need at least 20 samples by default (`minSamples`) before they can
alert. Three timeouts out of three calls is an anecdote, not a signal.
Alerts are evaluated per tool and across all tools.

## Audit

For a durable per-decision trail, map records with `toAuditLogRecord` and
append them to your log store:

```ts
onDecision: (record) => auditLog.append(toAuditLogRecord(record)),
```

The shape is versioned (`v: 1`) and described by
[`schemas/consent-audit-log.schema.json`](../schemas/consent-audit-log.schema.json).
It names the tool, the decision, the elapsed time and a timestamp — never
arguments, tokens or proofs, so the audit pipeline cannot become a replay
source. Server-side action records belong with the gateway; see
[production-readiness.md](./production-readiness.md).

## What to watch after launch

- Confirmation rate by tool, week over week. A falling rate after a
  description change means the model is asking for the wrong thing.
- `elapsedMs` maxima. Decisions near the deadline mean people are reading
  under time pressure; consider a longer timeout before blaming users.
- `cancelled` spikes after a deploy: hosts aborting calls usually means a
  lifecycle bug in registration, not user behavior.
