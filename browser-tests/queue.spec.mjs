/**
 * Queue and deadline behavior of domConsentSurface in a real browser.
 *
 * The playground's five-second deadline would make these slow, so they use
 * browser-tests/harness.html, which loads the same built modules with
 * per-request deadlines. No test sleeps: each waits on a result, a dialog, or
 * a barrier request that can only mount after the queue has moved on.
 */

import { CODES, consentDialog, dialogProbe, expect, openHarness, test } from "./fixtures.mjs";

const LONG = 30_000;

function dialogTitled(page, id) {
  return page.getByRole("dialog", { name: id, exact: true });
}

function result(page, id) {
  return page
    .waitForFunction((key) => window.harness.results[key], id)
    .then((handle) => handle.jsonValue());
}

test.beforeEach(async ({ page }) => {
  await openHarness(page);
});

test("an unanswered prompt resolves as consent_timeout and unmounts", async ({ page }) => {
  await page.evaluate(() => window.harness.call("A", { timeoutMs: 400 }));
  const a = await result(page, "A");
  expect(a.envelope).toMatchObject({ ok: false, code: CODES.timeout });
  // On a loaded machine 400ms can pass before a visibility check would run,
  // so ask the probe whether the prompt mounted rather than racing it.
  expect((await dialogProbe(page)).shown).toEqual(["A"]);
  await expect(consentDialog(page)).toHaveCount(0);
});

test("expiry includes queue time: a queued request can expire without ever showing", async ({ page }) => {
  await page.evaluate((ms) => window.harness.call("A", { timeoutMs: ms }), LONG);
  await expect(dialogTitled(page, "A")).toBeVisible();

  await page.evaluate(() => window.harness.call("B", { timeoutMs: 300 }));
  const b = await result(page, "B");
  expect(b.envelope).toMatchObject({ ok: false, code: CODES.timeout });
  // A still holds the screen; B expired behind it.
  await expect(consentDialog(page)).toHaveCount(1);
  await expect(dialogTitled(page, "A")).toBeVisible();

  await dialogTitled(page, "A").getByRole("button", { name: "Not now" }).click();
  expect((await result(page, "A")).envelope).toMatchObject({ code: CODES.declined });

  // Barrier: C queues behind B's (dead) slot, so once C is on screen the
  // queue has already passed B. B must never have mounted.
  await page.evaluate((ms) => window.harness.call("C", { timeoutMs: ms }), LONG);
  await expect(dialogTitled(page, "C")).toBeVisible();
  const probe = await dialogProbe(page);
  expect(probe.shown).toEqual(["A", "C"]);
  expect(probe.maxOpen).toBe(1);
});

test("expiry includes queue time: a queued prompt shows only what is left", async ({ page }) => {
  const budget = 20_000;
  await page.evaluate((ms) => window.harness.surface("A", { timeoutMs: ms }), LONG);
  await expect(dialogTitled(page, "A")).toBeVisible();
  await page.evaluate((ms) => window.harness.surface("B", { timeoutMs: ms }), budget);

  await dialogTitled(page, "A").getByRole("button", { name: "Not now" }).click();
  await expect(dialogTitled(page, "B")).toBeVisible();

  const { queuedMs, durationMs } = await page.evaluate(() => {
    const fill = document.querySelector(".mm-consent__meter-fill");
    return {
      queuedMs: window.harness.results.A.at - window.harness.started.B,
      durationMs: Number.parseFloat(fill.style.getPropertyValue("--mm-consent-duration")),
    };
  });
  expect(queuedMs).toBeGreaterThan(0);
  // The countdown starts from the time remaining, not from the full budget.
  // (+5ms absorbs Date.now/performance.now rounding.)
  expect(durationMs).toBeLessThan(budget);
  expect(durationMs).toBeLessThanOrEqual(budget - queuedMs + 5);
});

test("cancelling the active request removes its dialog and the next one shows", async ({ page }) => {
  await page.evaluate((ms) => {
    window.harness.call("A", { timeoutMs: ms });
    window.harness.call("B", { timeoutMs: ms });
  }, LONG);
  await expect(dialogTitled(page, "A")).toBeVisible();

  await page.evaluate(() => window.harness.abort("A"));
  expect((await result(page, "A")).envelope).toMatchObject({ ok: false, code: CODES.cancelled });
  await expect(dialogTitled(page, "A")).toHaveCount(0);
  await expect(dialogTitled(page, "B")).toBeVisible();
  await expect(dialogTitled(page, "B").getByRole("button", { name: "Not now" })).toBeFocused();
  expect((await dialogProbe(page)).maxOpen).toBe(1);
});

test("a request beyond the queue's capacity is refused at once, without a dialog", async ({ page }) => {
  // Capacity is three unanswered requests: one on screen, two waiting.
  await page.evaluate((ms) => {
    for (const id of ["A", "B", "C"]) window.harness.call(id, { timeoutMs: ms });
  }, LONG);
  await expect(dialogTitled(page, "A")).toBeVisible();

  await page.evaluate((ms) => window.harness.call("D", { timeoutMs: ms }), LONG);
  const d = await result(page, "D");
  expect(d.envelope).toMatchObject({ ok: false, code: CODES.overCapacity });
  await expect(consentDialog(page)).toHaveCount(1);
  expect((await dialogProbe(page)).shown).toEqual(["A"]);
});
