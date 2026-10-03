/**
 * Real-browser tests of the consent playground (examples/playground.html).
 *
 * The node:test suite drives domConsentSurface through a fake DOM. These run
 * the same built modules in Chromium, where focus, keyboard activation,
 * `isTrusted`, <dialog> semantics, media queries and the accessibility tree
 * are the browser's, not a stand-in's.
 *
 * Run: npm run test:browser
 */

import {
  CODES,
  consentDialog,
  dialogProbe,
  expect,
  openPlayground,
  playgroundResults,
  test,
} from "./fixtures.mjs";

const TITLE = "Add one to the demonstration counter?";
const DETAIL = "Only this local page changes. Nothing is sent anywhere.";

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function dialogParts(page) {
  const dialog = page.getByRole("dialog", { name: TITLE });
  return {
    dialog,
    confirm: dialog.getByRole("button", { name: "Add one" }),
    decline: dialog.getByRole("button", { name: "Not now" }),
  };
}

async function requestOnce(page) {
  await page.locator("#start").click();
  const parts = dialogParts(page);
  await expect(parts.dialog).toBeVisible();
  return parts;
}

/**
 * Wait for a consent dialog other than `previousId` to be open, and return
 * its title id. Each prompt carries a document-unique id, so this tells a
 * freshly mounted dialog from the one just answered without any delay.
 */
async function nextDialogId(page, previousId = null) {
  const handle = await page.waitForFunction((previous) => {
    const dialogs = document.querySelectorAll("dialog.mm-consent");
    if (dialogs.length !== 1 || !dialogs[0].open) return null;
    const id = dialogs[0].getAttribute("aria-labelledby");
    return id !== previous ? id : null;
  }, previousId);
  return handle.jsonValue();
}

test.describe("consent playground in a real browser", () => {
  test.beforeEach(async ({ page }) => {
    await openPlayground(page);
  });

  test("initial focus lands on Decline, never Confirm", async ({ page }) => {
    const { confirm, decline } = await requestOnce(page);
    await expect(decline).toBeFocused();
    await expect(confirm).not.toBeFocused();
  });

  test("Enter on the initial focus declines; it never confirms", async ({ page }) => {
    const { dialog } = await requestOnce(page);
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    const [result] = await playgroundResults(page, 1);
    expect(result.envelope).toMatchObject({ ok: false, code: CODES.declined });
    await expect(page.locator("#count")).toHaveText("0");
  });

  test("Escape dismisses as consent_closed, never as consent", async ({ page }) => {
    const { dialog } = await requestOnce(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    const [result] = await playgroundResults(page, 1);
    expect(result.envelope).toMatchObject({ ok: false, code: CODES.dismissed });
    await expect(page.locator("#count")).toHaveText("0");
  });

  test("a click on the backdrop dismisses as consent_closed", async ({ page }) => {
    const { dialog } = await requestOnce(page);
    await page.mouse.click(4, 4);
    await expect(dialog).toHaveCount(0);
    const [result] = await playgroundResults(page, 1);
    expect(result.envelope).toMatchObject({ ok: false, code: CODES.dismissed });
  });

  test("a real click on Confirm runs the action and returns ok", async ({ page }) => {
    const { dialog, confirm } = await requestOnce(page);
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    const [result] = await playgroundResults(page, 1);
    expect(result.envelope).toEqual({ ok: true, count: 1 });
    await expect(page.locator("#count")).toHaveText("1");
  });

  test("script-dispatched Confirm clicks are ignored as untrusted", async ({ page }) => {
    const { dialog, confirm, decline } = await requestOnce(page);

    // Three ways page script can fake a click. None carries isTrusted.
    await confirm.evaluate((button) => button.click());
    await confirm.evaluate((button) =>
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
    );
    await confirm.dispatchEvent("click");

    // A confirming click settles synchronously inside its own dispatch and
    // removes the dialog, so these checks are not racing anything.
    await expect(dialog).toBeVisible();
    await expect(page.locator("#log li")).toHaveCount(0);
    await expect(page.locator("#count")).toHaveText("0");

    // Refusing stays callable from script: declining is always safe.
    await decline.evaluate((button) => button.click());
    await expect(dialog).toHaveCount(0);
    const [result] = await playgroundResults(page, 1);
    expect(result.envelope).toMatchObject({ ok: false, code: CODES.declined });
    await expect(page.locator("#count")).toHaveText("0");
    expect((await dialogProbe(page)).shown).toEqual([TITLE]);
  });

  test("a burst of three shows one dialog at a time and resolves in order", async ({ page }) => {
    await page.locator("#burst").click();

    const first = await nextDialogId(page);
    await expect(consentDialog(page)).toHaveCount(1);
    await dialogParts(page).confirm.click();

    const second = await nextDialogId(page, first);
    await expect(consentDialog(page)).toHaveCount(1);
    await dialogParts(page).decline.click();

    const third = await nextDialogId(page, second);
    expect(new Set([first, second, third]).size).toBe(3);
    await expect(consentDialog(page)).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(consentDialog(page)).toHaveCount(0);

    const results = await playgroundResults(page, 3);
    expect(results.map(({ call }) => call)).toEqual(["Call 1", "Call 2", "Call 3"]);
    expect(results[0].envelope).toEqual({ ok: true, count: 1 });
    expect(results[1].envelope).toMatchObject({ ok: false, code: CODES.declined });
    expect(results[2].envelope).toMatchObject({ ok: false, code: CODES.dismissed });
    await expect(page.locator("#count")).toHaveText("1");

    const probe = await dialogProbe(page);
    expect(probe.maxOpen).toBe(1);
    expect(probe.shown).toHaveLength(3);
  });

  test("an unanswered prompt expires as consent_timeout at its deadline", async ({ page }) => {
    const { dialog } = await requestOnce(page);
    await page.clock.runFor(4_900);
    await expect(dialog).toBeVisible();
    await page.clock.runFor(200);
    await expect(dialog).toHaveCount(0);
    const [result] = await playgroundResults(page, 1);
    expect(result.envelope).toMatchObject({ ok: false, code: CODES.timeout });
    await expect(page.locator("#count")).toHaveText("0");
  });

  test("cancelling mid-prompt returns tool_cancelled and removes the dialog", async ({ page }) => {
    await page.locator("#cancel").click();
    const { dialog } = dialogParts(page);
    await expect(dialog).toBeVisible();
    // The playground aborts after one second of page time.
    await page.clock.runFor(1_000);
    await expect(dialog).toHaveCount(0);
    const [result] = await playgroundResults(page, 1);
    expect(result.envelope).toMatchObject({ ok: false, code: CODES.cancelled });
    await expect(page.locator("#count")).toHaveText("0");
  });

  test("the dialog is labelled and described by ids that exist", async ({ page }) => {
    const { dialog } = await requestOnce(page);
    await expect(dialog).toHaveAccessibleName(TITLE);
    await expect(dialog).toHaveAccessibleDescription(new RegExp(`^${escapeRegExp(DETAIL)} Expires in \\d+ seconds?\\.`));

    const refs = await consentDialog(page).evaluate((node) => {
      const ids = [
        node.getAttribute("aria-labelledby"),
        ...(node.getAttribute("aria-describedby") ?? "").split(/\s+/),
      ].filter(Boolean);
      return ids.map((id) => ({
        id,
        matches: document.querySelectorAll(`[id="${CSS.escape(id)}"]`).length,
        inside: node.contains(document.getElementById(id)),
        text: document.getElementById(id)?.textContent ?? null,
      }));
    });
    expect(refs).toHaveLength(3);
    for (const ref of refs) {
      expect(ref.matches, `#${ref.id} must exist exactly once`).toBe(1);
      expect(ref.inside, `#${ref.id} must belong to this dialog`).toBe(true);
    }
    expect(refs[0].text).toBe(TITLE);
    expect(refs[1].text).toBe(DETAIL);
    expect(refs[2].text).toMatch(/^Expires in \d+ seconds?\./);
  });
});

test.describe("motion", () => {
  test("the meter animates by default", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await openPlayground(page);
    const { dialog } = await requestOnce(page);
    await expect(dialog.locator(".mm-consent__meter")).toBeVisible();
    await expect(dialog.locator(".mm-consent__meter-fill")).toHaveCSS("animation-name", "mm-consent-drain");
  });

  test("prefers-reduced-motion hides the meter but keeps the written expiry", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openPlayground(page);
    const { dialog } = await requestOnce(page);
    // Assert the computed style of a meter that is still in the dialog:
    // toBeHidden() alone would also pass once the prompt expired and unmounted.
    const meter = dialog.locator(".mm-consent__meter");
    await expect(meter).toHaveCount(1);
    await expect(meter).toHaveCSS("display", "none", { timeout: 2_000 });
    await expect(dialog).toHaveCSS("animation-name", "none");
    await expect(dialog.locator(".mm-consent__expiry")).toBeVisible();
  });
});

/** WCAG relative luminance contrast between two `rgb(...)` strings. */
function contrast(a, b) {
  const luminance = (css) => {
    const [r, g, bl] = css.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SCHEMES = {
  dark: { surface: "rgb(23, 17, 13)", text: "rgb(243, 233, 220)" },
  light: { surface: "rgb(255, 250, 243)", text: "rgb(36, 24, 15)" },
};

for (const [scheme, expected] of Object.entries(SCHEMES)) {
  test(`renders legibly in the ${scheme} color scheme`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await openPlayground(page);
    const { dialog, confirm } = await requestOnce(page);

    await expect(dialog).toHaveCSS("background-color", expected.surface);
    await expect(dialog).toHaveCSS("color", expected.text);

    const colors = await confirm.evaluate((button) => {
      const style = getComputedStyle(button);
      return { fg: style.color, bg: style.backgroundColor };
    });
    expect(contrast(expected.text, expected.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.fg, colors.bg), "Confirm label on its accent").toBeGreaterThanOrEqual(4.5);

    await testInfo.attach(`consent-dialog-${scheme}.png`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
}

test("a host that passes a client object as execute's second argument still gets the gate", async ({ page }) => {
  // WebMCP drafts from February to June 2026 specified execute(input, client)
  // with a ModelContextClient instead of today's { signal } bag, and
  // polyfills may still pass one (see docs/spec-drift.md). Install a minimal
  // navigator.modelContext so the playground registers through the real
  // detection path, then invoke the registered tool the way that host would.
  // The real-host path is covered by webmcp-host.spec.mjs.
  await page.addInitScript(() => {
    const tools = [];
    Object.defineProperty(window, "__hostTools", { value: tools });
    Object.defineProperty(navigator, "modelContext", {
      configurable: true,
      value: { registerTool(tool) { tools.push(tool); } },
    });
  });
  await openPlayground(page);
  await expect(page.locator("#registration")).toHaveText("Registered with this browser");

  await page.evaluate(() => {
    const client = { requestUserInteraction: async (callback) => callback() };
    window.__hostCall = window.__hostTools[0].execute({}, client)
      .then((result) => JSON.parse(result.content[0].text));
  });
  const { dialog, confirm, decline } = dialogParts(page);
  await expect(dialog).toBeVisible();
  await expect(decline).toBeFocused();
  await confirm.click();
  expect(await page.evaluate(() => window.__hostCall)).toEqual({ ok: true, count: 1 });
  await expect(page.locator("#count")).toHaveText("1");
});
