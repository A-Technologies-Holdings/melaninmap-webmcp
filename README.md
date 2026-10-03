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

It is extracted from the pre-deployment agent layer prepared for
[melaninmap.app](https://melaninmap.app). The private application keeps ticket
handoffs disabled until the exact production path is deployed and verified
with an approved Clarksville event or tour and its authority-backed Passport.

## Use from source

No npm-registry release is claimed yet. Install directly from the public
repository, or clone it and run `npm run check` before linking it locally. The
runtime has no dependencies; devDependencies are only for the build and the
check suite.

```bash
npm install github:A-Technologies-Holdings/melaninmap-webmcp
```

```ts
import {
  defineReadTool,
  defineConsequentialTool,
  registerAgentToolsAsync,
} from "@melaninmap/webmcp-consent";
```

`npm run check` runs the whole gate: typecheck, the published-contract drift
checks, the build, a `node:test` behavioral suite asserting the gate actually
holds — the action does not run on decline, timeout, or dismissal, a consent
surface that *throws* fails closed rather than open, and registration prefers
the incremental style so a caller's `AbortSignal` is not silently dropped —
and a pack lint (`publint` + `attw`) proving the published artifact resolves
the way consumers will import it. `npm test` builds and runs the suite alone.

`npm run build` emits ESM plus declarations to `dist/`, which is what `main`,
`types` and `exports` point at — importing the package gets you compiled
JavaScript, not raw TypeScript that a consumer's runtime or bundler would have
to strip for itself.

The package is **ESM-only**. There is no CommonJS build: a CommonJS consumer
loads it with a dynamic `import()`. The runtime targets browsers; Node 22 or
newer is needed only for the build and the check suite.

Or skip the dependency entirely: it is about 380 lines of code (700 with the
comments that explain why) with nothing to configure, so copying `src/` into
your project is a perfectly good answer.

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

await registerAgentToolsAsync([search, handoff]);
```

The example surface ships with a default look in
[`examples/consent-surface.css`](./examples/consent-surface.css): load it once per
page. Every element carries an `mm-consent__*` class and every color, radius and
font is a custom property on `.mm-consent`, so rebranding is an override, not a
fork. It follows the light/dark preference and honors reduced motion and forced
colors.

`registerAgentTools` is fully feature-detected. In any browser without either
proposed registrar API it is a silent no-op that costs one property read. Load
it lazily after your app mounts: a registrar that can break the host page is
worse than no registrar.

Registration is idempotent per tool set — re-registering the same tools is a
no-op, while a different set on the same page registers independently. Pass
`{ scope }` to name a registration explicitly, and `{ signal }` to release the
scope when an owning controller aborts.

Both of those assume the incremental `registerTool` style. A host that offers
only the bulk `provideContext` style *replaces* the page's tool set on every
call, so scopes there cannot be independent: the first scope to register owns
the page, and a different scope gets `{ registered: false, reason:
"bulk_conflict" }` instead of silently erasing the first scope's tools. The bulk
style takes no `{ signal }`, so its tools live for the page.

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
can call, a script controlling the same valid session can also call. A consent
token is an audit record and a UX contract, not a credential. Our server
exchanges it for a short-lived, single-use proof bound to one exact handoff and
keeps the ledger writer internal behind signed-session, IP, and installation
ceilings. That authorizes one bounded operation; it still is not
cryptographic proof that a human finger performed the tap.

Your server still needs its own defenses. [SECURITY.md](./SECURITY.md) has the
threat model and the specific controls we run behind this.

## The pre-deployment contract

- [`schemas/melaninmap.tools.json`](./schemas/melaninmap.tools.json) — the five
  tools as registered: descriptions, input schemas, which gate on consent and
  why, and the result envelopes.
- [`schemas/openapi.yaml`](./schemas/openapi.yaml) — the HTTP surface behind
  them. Each tool's `outputSchema` points into this file by JSON pointer rather
  than duplicating the shapes, so the two cannot drift apart.
- [`reference/`](./reference) — the application implementation prepared for
  deployment, with its internal imports flattened. A worked example, not a
  claim that the gated production route is live.

## The trust contract

If an agent is going to speak for this data, the terms should be legible to
whoever is listening.

- **Results are Melanin Map-published directory records.** A record may come
  from a business submission, an administrator, or an editorial seed. Preserve
  its published source and freshness fields; do not present publication as
  proof that the business supplied the data or that ownership was verified.
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

## How to try it after deployment

The live Melanin Map handoff remains release-gated. Once the production
deployment and authority evidence are explicitly marked ready, open
[melaninmap.app](https://melaninmap.app) in a client that implements the WebMCP
proposal and ask for Black-owned businesses in Clarksville. This repository
does not claim that a particular browser or assistant currently ships the
proposal; check the client's own documentation.

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
(`A-Technologies-Holdings/rork-melanin-map-342`) across #1713 (the
installation-keyed backend lane and recommendation mint), #1712 (the first HTTP
gateway, registrar, and consent card), and #1724 (the signed-session boundary,
bounded redemption, public carve-out, and security-review corrections).

## License

MIT. See [LICENSE](./LICENSE). Contributions use the Developer Certificate of
Origin described in [CONTRIBUTING.md](./CONTRIBUTING.md). The code license does
not license the Melanin Map or Big Mama names and brand assets; see
[TRADEMARKS.md](./TRADEMARKS.md).

## Cancellation and consent lifetime

Pass the browser invocation's execution options to `tool.execute(args, { signal })`.
Read handlers receive those options as their second argument; consequential handlers
receive them as their third argument, after the consent confirmation. Forward the
signal to `fetch` and other cancellable work. Registration signals control tool
availability; execution signals control individual calls.

The gate enforces the prompt deadline even if a custom consent surface never settles.
Surfaces receive a separate cancellation signal to close their UI when the deadline
or caller cancellation wins. A late confirmation cannot execute the action.
The DOM example allows at most three active or queued prompts, and its timeout starts
when the request enters the queue. Cancelled tool calls return `tool_cancelled`.

Registration bookkeeping is isolated by browser host and tool name. Overlapping
scopes return `tool_conflict` before touching the host. Browser getter failures are
optional-feature failures and cannot break the page.

For promise-based browser registration, use `await registerAgentToolsAsync(tools)`.
It waits for acceptance and reports partial failures without retrying rejected host calls.
`registerAgentTools` remains the synchronous compatibility API for older prototypes.

To try the local consent playground, run `npm run build && npm run build:test`,
then `python3 -m http.server 8080` from this repository. Open
`http://localhost:8080/examples/playground.html`. Its counter is local to the page;
it exercises human confirmation, five-second expiration, cancellation and the
bounded queue without provider credentials.
