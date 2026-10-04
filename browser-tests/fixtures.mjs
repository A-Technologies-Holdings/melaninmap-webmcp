/**
 * Shared fixtures for the real-browser consent suite.
 *
 * - `server`: one loopback static server per worker, serving the repo root.
 * - `baseURL`: points page.goto("/...") at that server.
 * - `pageErrors`: auto fixture; any uncaught page error or console error
 *   fails the test that caused it.
 * - Every page gets a probe installed before its own scripts run. It counts
 *   consent dialogs from the DOM mutation records themselves, so "never more
 *   than one dialog at a time" is checked across the whole test, not only at
 *   the moments the test happens to look.
 */

import { test as base, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { startStaticServer } from "./server.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * The envelope code each outcome produces today. Tests assert against this
 * table rather than literals so a deliberate contract change is one edit.
 */
export const CODES = {
  declined: "consent_declined",
  dismissed: "consent_closed",
  timeout: "consent_timeout",
  cancelled: "tool_cancelled",
  overCapacity: "consent_busy",
};

function installDialogProbe() {
  const probe = { open: 0, maxOpen: 0, shown: [] };
  Object.defineProperty(window, "__consentProbe", { value: probe });
  const isConsentDialog = (node) =>
    node instanceof HTMLDialogElement && node.classList.contains("mm-consent");
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!isConsentDialog(node)) continue;
        probe.open += 1;
        probe.maxOpen = Math.max(probe.maxOpen, probe.open);
        probe.shown.push(node.querySelector(".mm-consent__title")?.textContent ?? "");
      }
      for (const node of record.removedNodes) {
        if (isConsentDialog(node)) probe.open -= 1;
      }
    }
  }).observe(document, { childList: true, subtree: true });
}

export const test = base.extend({
  server: [
    async ({}, use) => {
      const server = await startStaticServer(repoRoot);
      await use(server);
      await server.close();
    },
    { scope: "worker" },
  ],
  baseURL: async ({ server }, use) => {
    await use(server.url);
  },
  page: async ({ page }, use) => {
    await page.addInitScript(installDialogProbe);
    await use(page);
  },
  pageErrors: [
    async ({ page }, use) => {
      const errors = [];
      page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
      });
      await use(errors);
      expect(errors, "the page logged errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** The consent dialog currently on screen. */
export function consentDialog(page) {
  return page.locator("dialog.mm-consent");
}

/** What the dialog-counting probe has seen so far. */
export function dialogProbe(page) {
  return page.evaluate(() => ({ ...window.__consentProbe, shown: [...window.__consentProbe.shown] }));
}

const CLOCK_START = Date.parse("2026-01-01T00:00:00Z");
const CLOCK_PAUSED = CLOCK_START + 60_000;

/**
 * Open the playground and wait until its module has finished loading. The
 * registration chip changes from "Checking browser…" only after every control
 * is wired, so it is a real readiness signal rather than a delay.
 *
 * The playground hard-codes a five-second consent deadline, and a loaded CI
 * machine can spend that long on a handful of actions. So page time is
 * paused once the page is ready: deadlines elapse only when a test calls
 * `page.clock.runFor()`, which also makes expiry and the playground's
 * one-second cancel exact instead of waited for. Real-time deadlines are
 * covered separately by queue.spec.mjs.
 */
export async function openPlayground(page) {
  await page.clock.install({ time: CLOCK_START });
  await page.goto("/examples/playground.html");
  await expect(page.locator("#registration")).not.toHaveText("Checking browser…");
  await page.clock.pauseAt(CLOCK_PAUSED);
}

/** Wait for `count` results in the playground log, then return them oldest first. */
export async function playgroundResults(page, count) {
  await expect(page.locator("#log li")).toHaveCount(count);
  return page.locator("#log li").evaluateAll((items) =>
    items.reverse().map((item) => ({
      call: item.children[1]?.textContent,
      envelope: JSON.parse(item.querySelector("pre")?.textContent ?? "null"),
    })),
  );
}

/** Open the minimal harness page used for short, configurable deadlines. */
export async function openHarness(page) {
  await page.goto("/browser-tests/harness.html");
  await page.waitForFunction(() => window.harness?.ready === true);
}
