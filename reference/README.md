# Reference implementation

This is the **pre-deployment application implementation prepared for
[melaninmap.app](https://melaninmap.app)**, copied here with its
monorepo-internal imports flattened so the directory stands alone. It is
provided as a worked example, not as proof that the release-gated handoff is
live and not as a library — the reusable pattern lives in [`../src`](../src).

| File | What it is |
| --- | --- |
| `registerAgentTools.ts` | The five pre-deployment tools and the feature-detected registration. |
| `retryOnce.ts` | The bounded transient retry used to recover a dropped idempotent handoff response. |
| `consentBridge.ts` | Non-React ↔ React bridge: the registrar awaits a human answer. One pending request at a time, 60-second auto-decline. |
| `HandoffConsentCard.tsx` | The confirmation card itself. Holds the consent token constant. |
| `agentGatewayApi.ts` | Fetch client for the `/api/agent/*` endpoints. |
| `installation.ts` | Anonymous session-scoped installation id. |
| `modelContext.ts` | Structural types for the WebMCP proposal. |

**This directory is excluded from the package's typecheck.** `HandoffConsentCard.tsx`
needs React, `react-dom`, and Tailwind utility classes from the host site; the
library in `../src` has no dependencies and we are not adding any to keep a
reference file compiling. Read it, copy from it, restyle it.

## Three details that matter more than they look

**The consent token constant never leaves the card module.** It is not exported.
Tool code receives it only as the resolution value of a confirmation the person
actually clicked. That is a *structural* guarantee inside the page — a bug in
tool code cannot fabricate a confirmation, because it has no way to name the
value. It is emphatically **not** a server-side authorization credential; see
[`../SECURITY.md`](../SECURITY.md), which is blunt about the difference.

**Focus starts on Decline.** Enter must never be an accidental consent. Escape
and a backdrop click both decline. The safe answer is the easy one.

**The idempotency key is minted once per card open**, not per network attempt,
and travels with the confirmation. The server derives the journey identity from
it, so a retry replays one identity instead of creating a second journey and
burning the create budget. Getting this wrong is subtle and expensive: it looks
fine until someone's network blips.
