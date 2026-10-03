// Real-browser consent suite. Run with `npm run test:browser`, which builds
// dist/ and .test-build/ first. Not part of `npm run check`: it needs a
// browser binary (`npx playwright install chromium`) and runs in the
// full/nightly regression lane, not the focused PR gate.
import { defineConfig, devices } from "@playwright/test";

const ci = Boolean(process.env.CI || process.env.BUILDKITE);

export default defineConfig({
  testDir: "browser-tests",
  testMatch: "**/*.spec.mjs",
  outputDir: "test-results/browser",
  fullyParallel: true,
  forbidOnly: ci,
  // No retries: a flaky consent test is a bug to fix, not to paper over.
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: ci
    ? [["list"], ["junit", { outputFile: "test-results/browser/junit.xml" }]]
    : [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      // No WebMCP: the page-only path most visitors get today.
      name: "chromium",
      testIgnore: "**/webmcp-host.spec.mjs",
      use: browser(),
    },
    {
      // Chromium's own WebMCP implementation, as behind
      // chrome://flags/#enable-webmcp-testing.
      name: "chromium-webmcp",
      testMatch: "**/webmcp-host.spec.mjs",
      use: browser(["--enable-features=WebMCP"]),
    },
  ],
});

function browser(args = []) {
  return {
    ...devices["Desktop Chrome"],
    // Local escape hatch only (e.g. PLAYWRIGHT_CHANNEL=chrome when the
    // Playwright download is blocked). CI always uses Playwright's Chromium.
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    launchOptions: { args },
  };
}
