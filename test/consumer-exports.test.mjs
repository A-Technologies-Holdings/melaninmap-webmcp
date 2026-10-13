import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('private consumers resolve supported schemas, reference sources and a built DOM surface', async () => {
  const { domConsentSurface } = await import('@melaninmap/webmcp-consent/dom-consent-surface');
  assert.equal(typeof domConsentSurface, 'function');
  for (const suffix of ['schemas/tools']) {
    assert.ok(readFileSync(new URL(import.meta.resolve(`@melaninmap/webmcp-consent/${suffix}`)), 'utf8').length > 0);
  }
  const { default: openapi } = await import('@melaninmap/webmcp-consent/schemas/openapi');
  assert.equal(openapi, readFileSync(new URL('../schemas/openapi.yaml', import.meta.url), 'utf8'));
  const { default: reference } = await import('@melaninmap/webmcp-consent/reference/source', { with: { type: 'json' } });
  for (const file of ['HandoffConsentCard.tsx', 'consentBridge.ts']) {
    assert.equal(reference[file], readFileSync(new URL(`../reference/${file}`, import.meta.url), 'utf8'));
  }
});
