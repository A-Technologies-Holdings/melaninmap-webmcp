import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test as nodeTest } from 'node:test';
// TypeScript 7 supplies the CLI; the compatibility package supplies transpileModule.
import ts from '@typescript/typescript6';

// Host cancellation in the reference registrar and consent bridge. The real
// reference modules run; only the gateway transport, installation id and the
// React card are stubbed, so every code below comes from reference branches.
// The stub transport settles only on abort, so a registrar that ignores the
// host signal hangs; the timeout turns that into a failure, not a stall.
const test = (name, fn) => nodeTest(name, { timeout: 2_000 }, fn);

function loadModule(file, modules, globals = {}) {
  const source = readFileSync(new URL(`../reference/${file}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  });
  const exports = {};
  runInNewContext(outputText, {
    exports,
    require(name) {
      if (!(name in modules)) throw new Error(`Missing test dependency: ${name}`);
      return modules[name];
    },
    AbortController, AbortSignal, console, Promise, Date, Math, JSON,
    ...globals,
  });
  return exports;
}

/** A transport stub that settles only when the caller's signal aborts. */
function abortableTransport(calls) {
  const hang = (name) => (args, signal) => {
    calls.push({ name, signal });
    return new Promise((_, reject) => {
      if (!signal) return; // A call with no signal can never be cancelled.
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  };
  return {
    AgentGatewayApiError: class AgentGatewayApiError extends Error {},
    requestAgentSearch: hang('search'),
    requestAgentBusiness: hang('business'),
    requestAgentVerification: hang('verification'),
    recordAgentAction: hang('action'),
    requestAgentHandoffConsent: hang('handoff-consent'),
    requestAgentHandoff: hang('handoff'),
    openAgentHandoff: hang('handoff-open'),
  };
}

function registerTools({ api, bridge, window = {} }) {
  const tools = [];
  const host = { registerTool(tool) { tools.push(tool); } };
  const retryOnce = loadModule('retryOnce.ts', {});
  const registrar = loadModule('registerAgentTools.ts', {
    './agentGatewayApi': api,
    './consentBridge': bridge,
    './HandoffConsentCard': { ensureHandoffConsentCardMounted() {} },
    './installation': { getAgentInstallationId: () => 'installation-test' },
    './retryOnce': retryOnce,
  }, { document: { modelContext: host }, window, globalThis: {} });
  registrar.registerAgentTools();
  assert.equal(tools.length, 5);
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

const VALID_ARGS = {
  search_black_owned_directory: { query: 'jazz' },
  get_business_details: { externalId: 'biz-1' },
  check_ownership_verification: { externalId: 'biz-1' },
  record_interest: { recommendationId: 'rec-1', action: 'save', targetType: 'event', targetId: 'event-1' },
  request_event_handoff: { recommendationId: 'rec-1', targetExternalId: 'event-1', channel: 'event_detail' },
};

const codeOf = (result) => JSON.parse(result.content[0].text).code;
// Values built inside the VM realm carry its Object prototype; compare data only.
const plain = (value) => JSON.parse(JSON.stringify(value));

test('every reference tool answers tool_cancelled without a gateway call when the host already aborted', async () => {
  const calls = [];
  let prompts = 0;
  const tools = registerTools({
    api: abortableTransport(calls),
    bridge: { requestHandoffConsent: async () => { prompts++; return { status: 'declined' }; } },
  });
  for (const [name, args] of Object.entries(VALID_ARGS)) {
    assert.equal(codeOf(await tools[name].execute(args, { signal: AbortSignal.abort() })), 'tool_cancelled', name);
  }
  assert.deepEqual(calls, []);
  assert.equal(prompts, 0);
});

for (const name of ['search_black_owned_directory', 'get_business_details', 'check_ownership_verification', 'record_interest']) {
  test(`${name}: an abort during the gateway call is tool_cancelled, and the host signal reaches the transport`, async () => {
    const calls = [];
    const tools = registerTools({ api: abortableTransport(calls), bridge: { requestHandoffConsent: async () => ({ status: 'declined' }) } });
    const controller = new AbortController();
    const pending = tools[name].execute(VALID_ARGS[name], { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal, controller.signal);
    controller.abort();
    assert.equal(codeOf(await pending), 'tool_cancelled');
  });
}

test('a failure that is not a cancellation keeps its public code', async () => {
  const api = abortableTransport([]);
  api.requestAgentBusiness = async () => { throw new Error('offline'); };
  const tools = registerTools({ api, bridge: { requestHandoffConsent: async () => ({ status: 'declined' }) } });
  assert.equal(codeOf(await tools.get_business_details.execute(VALID_ARGS.get_business_details, { signal: new AbortController().signal })), 'network_error');
});

test('hand-off: cancellation while the card is open is tool_cancelled and never reaches the hand-off endpoints', async () => {
  const calls = [];
  const api = abortableTransport(calls);
  api.requestAgentBusiness = async () => ({ ok: true, business: { name: 'Event One' } });
  let seenSignal;
  const bridge = {
    requestHandoffConsent: (request, options = {}) => {
      seenSignal = options.signal;
      return new Promise((resolve) => options.signal?.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true }));
    },
  };
  const tools = registerTools({ api, bridge });
  const controller = new AbortController();
  const pending = tools.request_event_handoff.execute(VALID_ARGS.request_event_handoff, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seenSignal, controller.signal);
  controller.abort();
  assert.equal(codeOf(await pending), 'tool_cancelled');
  assert.deepEqual(calls.map((call) => call.name), []);
});

test('hand-off: a confirmation that loses the race with cancellation closes its placeholder tab', async () => {
  const calls = [];
  const api = abortableTransport(calls);
  api.requestAgentBusiness = async () => ({ ok: true, business: { name: 'Event One' } });
  const controller = new AbortController();
  const handle = { closed: false, close() { this.closed = true; } };
  const bridge = {
    requestHandoffConsent: async () => {
      controller.abort(); // The host cancels as the person confirms.
      return { status: 'confirmed', consentToken: 't', idempotencyKey: 'k', navigationHandle: handle };
    },
  };
  const tools = registerTools({ api, bridge });
  assert.equal(codeOf(await tools.request_event_handoff.execute(VALID_ARGS.request_event_handoff, { signal: controller.signal })), 'tool_cancelled');
  assert.equal(handle.closed, true);
  assert.deepEqual(calls, []);
});

test('hand-off: an abort after redemption reports navigated:false and does not steer the tab', async () => {
  const controller = new AbortController();
  const handle = { closed: false, location: { href: 'about:blank' }, close() { this.closed = true; } };
  const api = {
    ...abortableTransport([]),
    requestAgentBusiness: async () => ({ ok: true, business: { name: 'Event One' } }),
    requestAgentHandoffConsent: async () => ({ ok: true, targetType: 'event', consentProof: 'p' }),
    requestAgentHandoff: async () => ({ ok: true, token: 'tok' }),
    openAgentHandoff: async () => { controller.abort(); return { ok: true, destinationUrl: 'https://tickets.example/e1' }; },
  };
  const bridge = { requestHandoffConsent: async () => ({ status: 'confirmed', consentToken: 't', idempotencyKey: 'k', navigationHandle: handle }) };
  const tools = registerTools({ api, bridge, window: { open() { throw new Error('must not open'); } } });
  const result = JSON.parse((await tools.request_event_handoff.execute(VALID_ARGS.request_event_handoff, { signal: controller.signal })).content[0].text);
  assert.equal(result.ok, true);
  assert.equal(result.navigated, false);
  assert.equal(handle.location.href, 'about:blank');
  assert.equal(handle.closed, true);
});

function loadBridge() {
  const timers = new Map();
  let nextTimer = 0;
  const bridge = loadModule('consentBridge.ts', {}, {
    crypto: { randomUUID: () => `id-${nextTimer}` },
    setTimeout: (callback, ms) => { timers.set(++nextTimer, { callback, ms }); return nextTimer; },
    clearTimeout: (id) => { timers.delete(id); },
  });
  return { bridge, timers };
}

test('bridge: an already-aborted signal resolves cancelled without opening a card', async () => {
  const { bridge, timers } = loadBridge();
  let notified = 0;
  bridge.subscribeToConsentRequests(() => notified++);
  assert.deepEqual(plain(await bridge.requestHandoffConsent({ targetName: 'A' }, { signal: AbortSignal.abort() })), { status: 'cancelled' });
  assert.equal(bridge.getPendingConsentRequest(), null);
  assert.equal(notified, 0);
  assert.equal(timers.size, 0);
});

test('bridge: an abort while the card is open closes it, clears its deadline and rejects a late answer', async () => {
  const { bridge, timers } = loadBridge();
  let notified = 0;
  bridge.subscribeToConsentRequests(() => notified++);
  const request = { targetName: 'A' };
  const controller = new AbortController();
  const pending = bridge.requestHandoffConsent(request, { signal: controller.signal });
  assert.equal(bridge.getPendingConsentRequest(), request);
  assert.equal(timers.size, 1);
  controller.abort();
  assert.deepEqual(plain(await pending), { status: 'cancelled' });
  assert.equal(bridge.getPendingConsentRequest(), null);
  assert.equal(timers.size, 0);
  assert.equal(notified, 2);
  assert.equal(bridge.resolvePendingConsentRequest({ status: 'confirmed', consentToken: 't', navigationHandle: null }, request), false);
});

test('bridge: an earlier prompt\'s signal cannot cancel a later prompt', async () => {
  const { bridge } = loadBridge();
  const first = { targetName: 'A' };
  const earlier = new AbortController();
  const answered = bridge.requestHandoffConsent(first, { signal: earlier.signal });
  assert.equal(bridge.resolvePendingConsentRequest({ status: 'declined' }, first), true);
  assert.deepEqual(plain(await answered), { status: 'declined' });
  const second = { targetName: 'B' };
  const later = bridge.requestHandoffConsent(second, { signal: new AbortController().signal });
  earlier.abort();
  assert.equal(bridge.getPendingConsentRequest(), second);
  assert.equal(bridge.resolvePendingConsentRequest({ status: 'declined' }, second), true);
  assert.deepEqual(plain(await later), { status: 'declined' });
});

test('bridge: a prompt without a signal still answers and times out as before', async () => {
  const { bridge, timers } = loadBridge();
  const request = { targetName: 'A' };
  const pending = bridge.requestHandoffConsent(request);
  [...timers.values()][0].callback();
  assert.deepEqual(plain(await pending), { status: 'declined' });
  assert.equal(bridge.getPendingConsentRequest(), null);
});
