import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

// Evaluate the actual reference handlers with host dependencies stubbed.
// This proves their behavior without introducing React into the runtime package.
function loadReference(file, exportName, modules, globals = {}) {
  const source = readFileSync(new URL(`../reference/${file}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(`${source}\nexport { ${exportName} };`, {
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
    ...globals,
  });
  return exports[exportName];
}

test('React reference rejects synthetic Confirm before opening a tab', () => {
  let opened = 0;
  const resolved = [];
  const request = { targetName: "Displayed" };
  const handle = { opener: 'original' };
  const confirm = loadReference('HandoffConsentCard.tsx', 'confirm', {
    react: {}, 'react-dom/client': {}, 'react/jsx-runtime': {},
    './consentBridge': { getPendingConsentRequest: () => request, resolvePendingConsentRequest: (answer) => { resolved.push(answer); return true; } },
  }, { window: { open: () => { opened++; return handle; } } });
  confirm(request, { nativeEvent: { isTrusted: false } });
  assert.equal(opened, 0);
  assert.equal(resolved.length, 0);
  confirm(request, { nativeEvent: { isTrusted: true } });
  assert.equal(opened, 1);
  assert.equal(resolved[0].status, 'confirmed');
  assert.equal(resolved[0].navigationHandle, handle);
  assert.equal(handle.opener, null);
});

for (const status of ['busy', 'declined']) {
  test(`reference ${status} returns no-retry guidance without creating a handoff`, async () => {
    let requests = 0;
    const tool = loadReference('registerAgentTools.ts', 'handoffTool', {
      './agentGatewayApi': {
        requestAgentBusiness: async () => ({ ok: false }),
        requestAgentHandoffConsent: async () => { requests++; throw new Error('must not run'); },
        requestAgentHandoff: async () => { requests++; throw new Error('must not run'); },
      },
      './consentBridge': { requestHandoffConsent: async () => ({ status }) },
      './HandoffConsentCard': {}, './installation': {}, './retryOnce': {},
    });
    const result = await tool.execute({ recommendationId: 'rec', targetExternalId: 'event', channel: 'event_detail' });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, status === 'busy' ? 'busy' : 'user_declined');
    assert.match(payload.message, /do not retry/i);
    assert.equal(requests, 0);
  });
}
