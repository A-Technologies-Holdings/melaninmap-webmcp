# WebMCP consent gate

A small, dependency-free TypeScript package for the part of the
[Web Model Context API](https://github.com/webmachinelearning/webmcp) proposal
that is easy to get wrong: **what happens when an agent wants to do something
with a consequence.**

WebMCP lets a page hand tools to whatever agent is driving the browser. A
search tool is easy — the worst case is a bad answer. A tool that spends money,
sends a message, or hands a person to a third party is not easy, because the
model calls it and the person never clicked anything.

This package encodes one rule:

> A consequential tool never performs its action itself. It suspends, renders a
> confirmation in the page's own DOM, and resolves only when a human answers.

You cannot forget the gate, because `defineConsequentialTool` has no code path
to the action that does not go through it. There is no bypass flag and no
trusted-caller escape hatch.

It is extracted from the agent layer on [melaninmap.app](https://melaninmap.app),
where it gates ticket handoffs for Black-owned businesses, events, and tours in
Clarksville, Tennessee.

## Install

No runtime dependencies. TypeScript is the only devDependency, for the build.

```bash
npm install @melaninmap/webmcp-consent
```

```ts
import {
  defineReadTool,
  defineConsequentialTool,
  registerAgentTools,
} from "@melaninmap/webmcp-consent";
```

`npm run check` runs the whole gate: typecheck, the published-contract drift
check, the build, and a behavioral smoke test that asserts the gate actually
holds — the action does not run on decline, timeout, or dismissal, a consent
surface that *throws* fails closed rather than open, and registration prefers
the incremental style so a caller's `AbortSignal` is not silently dropped.

`npm run build` emits ESM plus declarations to `dist/`, which is what `main`,
`types` and `exports` point at — importing the package gets you compiled
JavaScript, not raw TypeScript that a consumer's runtime or bundler would have
to strip for itself.

Or skip the dependency entirely: it is about 350 lines with nothing to
configure, so copying `src/` into your project is a perfectly good answer.

## Use

A read tool needs no gate. Reads have no consequence to confirm.

```ts
const search = defineReadTool({
  name: "search_directory",
  description:
    "Search the published directory. Returns records with an externalId and a " +
    "recommendationId; request_handoff requires the recommendationId.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: [],
  },
  parseArgs: (raw) =>
    typeof raw.query === "string" ? { query: raw.query.trim() } : { query: "" },
  execute: (args) => api.search(args),
});
```

A consequential tool requires a `ConsentSurface` and a description of what the
person is agreeing to. Both are mandatory arguments.

```ts
import { domConsentSurface } from "./examples/domConsentSurface";

const handoff = defineConsequentialTool({
  name: "request_handoff",
  description:
    "Request a handoff to the ticketing destination for an event. Suspends " +
    "until the person confirms in the page; returns a refusal if they decline.",
  inputSchema: {
    type: "object",
    properties: {
      recommendationId: { type: "string" },
      targetId: { type: "string" },
    },
    required: ["recommendationId", "targetId"],
  },
  parseArgs: (raw) => {
    const recommendationId = String(raw.recommendationId ?? "").trim();
    const targetId = String(raw.targetId ?? "").trim();
    return recommendationId && targetId ? { recommendationId, targetId } : null;
  },
  consent: domConsentSurface,
  describeConsent: (args) => ({
    title: `Hold your place at ${names.get(args.targetId) ?? "this event"}?`,
    detail:
      "We'll open the ticket page and tell the organizer Melanin Map sent you. " +
      "Nothing is charged here.",
    confirmLabel: "Open tickets",
  }),
  execute: (args) => api.handoff(args),
});

registerAgentTools([search, handoff]);
```

`registerAgentTools` is fully feature-detected. In every browser shipping today
it is a silent no-op that costs one property read. Load it lazily after your app
mounts: a registrar that can break the host page is worse than no registrar.

## Writing tool descriptions

The description is the interface. A model that has never seen your site reads it
once and gets one attempt.

- **State the ordering dependency.** "`recommendationId` comes from a prior
  `search_directory` call" saves a failed call and a confused retry.
- **Say what comes back**, not what the tool does internally.
- **Name the consequence in the tool that has one.** A model that knows a tool
  will prompt a human will not fire it speculatively.
- **Write refusals as instructions.** `"The person declined. Do not retry it.
  Ask what they would prefer instead."` beats `"consent_declined"` — the model
  is going to act on this string.

Descriptions are also the honest place to look for prompt injection risk in the
other direction: anything you interpolate into a tool result is text a model
will read as context. Treat directory content as data, not instruction.

## What the consent gate proves

It makes it impossible for **the agent** to take the action through the tool
surface without a human in the loop. That is its whole job and it does that job
completely.

It does **not** authenticate the human to your server. Any endpoint your page
can call, a script can also call — including with whatever consent field your
page sends. A consent token is an audit record and a UX contract. It is not an
authorization credential, and a package that told you otherwise would be
selling you a feeling.

Your server still needs its own defenses. [SECURITY.md](./SECURITY.md) has the
threat model and the specific controls we run behind this.

## The deployed contract

- [`schemas/melaninmap.tools.json`](./schemas/melaninmap.tools.json) — the five
  tools as registered: descriptions, input schemas, which gate on consent and
  why, and the result envelopes.
- [`schemas/openapi.yaml`](./schemas/openapi.yaml) — the HTTP surface behind
  them. Each tool's `outputSchema` points into this file by JSON pointer rather
  than duplicating the shapes, so the two cannot drift apart.
- [`reference/`](./reference) — the actual code running on the site, with its
  internal imports flattened. A worked example, not a library.

## The trust contract

If an agent is going to speak for this data, the terms should be legible to
whoever is listening.

- **Results are published directory records.** What comes back is what a
  business published, nothing inferred and nothing scraped. Missing fields were
  never published; they are not hidden.
- **The top verification tier requires source-verified third-party
  certification, and is never purchasable.** No amount of money moves a listing
  from `not_listed` to `verified`. An agent quoting our verification status is
  quoting a check somebody actually did — that promise is the entire value of
  the signal, and it is why we will not sell it.
- **Unverified is not a judgement.** Most businesses have not been through
  certification. Absence of a badge means absence of a completed check.
- **Consequential actions require a visible human confirmation.** The agent
  cannot hand a person to a ticketing destination on its own. It proposes; a
  human confirms in the page or it does not happen.
- **Attributed actions carry an anonymous, installation-scoped token.** No
  account, no name, no contact information, no cross-site identifier. The token
  says "this journey came from Melanin Map," which is what lets a business see
  that our referral was real. It does not say who you are, because we do not
  know.

## How to try it

WebMCP is a browser proposal, not a shipped standard, so this needs a client
that implements it. Two work today:

**Chrome, behind a flag.** Open `chrome://flags`, enable the Prompt API / Web
Model Context flags (names move between versions — search "model context"),
restart, then visit [melaninmap.app](https://melaninmap.app) and ask the
built-in assistant for Black-owned businesses in Clarksville.

**ChatGPT desktop.** Open melaninmap.app in its browser surface and ask the same
question. The tools register on page load and the model picks them up.

Then watch for the part worth watching: ask it to get you tickets to an event.
The tool call suspends, a confirmation card appears in the page, and nothing
happens until you answer it. Decline, and the model is told you declined and
told not to retry.

In any other browser the registrar is a silent no-op — the site works normally
and pays one property read for the feature detection.

## How it's built

The tool surface is a thin, deliberately boring layer over infrastructure that
already existed: an attribution ledger that records a journey and a signed
receipt whether the tap came from the mobile app, a voice concierge, or an
agent. One contract, three callers.

Built in the private application monorepo
(`A-Technologies-Holdings/rork-melanin-map-342`) across four pull requests:
#1713 (the installation-keyed backend lane and the recommendation mint), #1712
(the HTTP gateway, the registrar, and the consent card), and #1716 (the
open-source carve-out plus the per-IP rate-limit hardening that the security
review in `SECURITY.md` describes).

## License

MIT. See [LICENSE](./LICENSE).
