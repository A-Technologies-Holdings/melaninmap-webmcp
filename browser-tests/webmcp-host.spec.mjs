/**
 * The consent gate behind Chromium's own WebMCP implementation.
 *
 * Runs only in the `chromium-webmcp` project, which launches Playwright's
 * Chromium with `--enable-features=WebMCP` (the switch behind
 * chrome://flags/#enable-webmcp-testing). The playground registers through
 * the package's real feature detection, and the tests call the tool the way
 * an in-page agent does: `document.modelContext.getTools()` then
 * `executeTool()`. That is the closest a test can get to a browser agent
 * invoking the tool.
 *
 * If a Playwright bump brings a Chromium whose WebMCP surface moved, these
 * fail first; docs/spec-drift.md records what each version is known to do.
 */

import { CODES, consentDialog, expect, openPlayground, test } from "./fixtures.mjs";

const TOOL = "demo_counter_update";

/**
 * Start executeTool() for the playground tool and leave its promise on
 * window.__hostCall. The spec takes an input object; Chromium before the
 * spec's #246 change (including 153) takes a JSON string and rejects an
 * object before the tool runs, so falling back cannot execute anything twice.
 */
async function startHostCall(page, { abortable = false } = {}) {
  return page.evaluate(
    async ({ name, abortable }) => {
      const tools = await document.modelContext.getTools();
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`${name} is not registered with the host`);
      const controller = new AbortController();
      window.__hostAbort = () => controller.abort();
      const options = abortable ? { signal: controller.signal } : {};
      const settle = (promise) =>
        promise.then(
          (value) => ({ value }),
          (error) => ({ error: error?.name ?? String(error), message: error?.message }),
        );
      let inputForm = "object";
      window.__hostCall = settle(document.modelContext.executeTool(tool, {}, options)).then((first) => {
        // Retry only the input-parse rejection, which happens before the tool
        // runs; any other failure is returned as is, never re-executed.
        if (first.error !== "UnknownError" || !/parse input/i.test(first.message ?? "")) {
          return { ...first, inputForm };
        }
        inputForm = "json-string";
        return settle(document.modelContext.executeTool(tool, "{}", options)).then((second) => ({
          ...second,
          inputForm,
        }));
      });
      return { annotations: tool.annotations ?? null };
    },
    { name: TOOL, abortable },
  );
}

/** Parse executeTool's string result down to the package's envelope. */
function envelopeFrom(serialized) {
  const outer = JSON.parse(serialized);
  // The package returns an MCP-style content array, which the host
  // JSON-serializes as a whole (see docs/spec-drift.md, "double encoding").
  if (Array.isArray(outer?.content)) return JSON.parse(outer.content[0].text);
  return outer;
}

test.beforeEach(async ({ page }) => {
  await openPlayground(page);
  const supported = await page.evaluate(() => typeof document.modelContext?.executeTool === "function");
  expect(supported, "document.modelContext with executeTool() is missing behind --enable-features=WebMCP").toBe(true);
  await expect(page.locator("#registration")).toHaveText("Registered with this browser");
});

test("the registered tool reaches the host as not read-only", async ({ page }) => {
  const { annotations } = await startHostCall(page);
  expect(annotations).toMatchObject({ readOnlyHint: false });
  test.info().annotations.push({ type: "host annotations", description: JSON.stringify(annotations) });
  await expect(consentDialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  const call = await page.evaluate(() => window.__hostCall);
  expect(envelopeFrom(call.value)).toMatchObject({ ok: false, code: CODES.dismissed });
});

test("a host-invoked call waits for a real click on Confirm", async ({ page }) => {
  await startHostCall(page);
  const dialog = consentDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Not now" })).toBeFocused();

  // Script cannot confirm on the agent's behalf, even with the host involved.
  await dialog.getByRole("button", { name: "Add one" }).evaluate((button) => button.click());
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Add one" }).click();
  const call = await page.evaluate(() => window.__hostCall);
  test.info().annotations.push({ type: "executeTool input form", description: call.inputForm });
  expect(call.error).toBeUndefined();
  expect(envelopeFrom(call.value)).toEqual({ ok: true, count: 1 });
  await expect(page.locator("#count")).toHaveText("1");
});

test("aborting executeTool() removes the dialog and never runs the action", async ({ page }) => {
  await startHostCall(page, { abortable: true });
  const dialog = consentDialog(page);
  await expect(dialog).toBeVisible();

  await page.evaluate(() => window.__hostAbort());
  await expect(dialog).toHaveCount(0);
  const call = await page.evaluate(() => window.__hostCall);
  expect(call.error).toBe("AbortError");
  await expect(page.locator("#count")).toHaveText("0");
});
