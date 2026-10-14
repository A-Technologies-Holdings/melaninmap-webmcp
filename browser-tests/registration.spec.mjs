import { expect, openPlayground, test } from './fixtures.mjs';

test('an unavailable API keeps the text/button path and advertises no registration', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, 'modelContext', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'modelContext', { value: undefined, configurable: true });
  });
  await openPlayground(page);
  await expect(page.locator('#registration')).toHaveText('Page-only: unsupported');
  await page.getByRole('button', { name: 'Request counter update' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(page.locator('#count')).toHaveText('0');
});

test('a rejecting host in a real browser reports no registration', async ({ page }) => {
  await openPlayground(page);
  const result = await page.evaluate(async () => {
    // Synthetic host in a browser realm; this is not native host evidence.
    Object.defineProperty(document, 'modelContext', { value: { registerTool: () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) }, configurable: true });
    const { defineReadTool, registerAgentToolsAsync } = await import('/dist/index.js');
    return registerAgentToolsAsync([defineReadTool({ name: 'rejected_fixture', description: 'fixture', inputSchema: {}, parseArgs: value => value, execute: async () => ({ ok: true }) })]);
  });
  expect(result.registered).toBe(false);
});
