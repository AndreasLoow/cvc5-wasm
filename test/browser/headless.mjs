// Drives test/browser/index.html in headless Chromium (and Firefox, if the
// browser is installed) with playwright, and prints what the page prints.
//
//   npm run test:browser              both browsers, whichever are installed
//   BROWSERS=chromium npm run test:browser
import { serve } from "./serve.mjs";

const wanted = (process.env.BROWSERS || "chromium,firefox").split(",").map((s) => s.trim());

let playwright;
try {
  playwright = await import("playwright");
} catch {
  console.error("playwright is not installed: npm i -D playwright && npx playwright install chromium firefox");
  process.exit(2);
}

const { server, port } = await serve();
let failures = 0;

for (const name of wanted) {
  const type = playwright[name];
  if (!type) {
    console.log(`\n== ${name}: unknown browser, skipped`);
    continue;
  }
  let browser;
  try {
    browser = await type.launch();
  } catch (e) {
    console.log(`\n== ${name}: not installed, skipped (${String(e).split("\n")[0]})`);
    continue;
  }
  console.log(`\n== ${name} ${browser.version()}`);
  const page = await browser.newPage();
  // cvc5's warnings reach printErr and so console.error; show a few.
  let consoleLines = 0;
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (++consoleLines <= 10) console.log(`   [console] ${m.text()}`);
    else if (consoleLines === 11) console.log("   [console] ...");
  });
  page.on("pageerror", (e) => console.log(`   [pageerror] ${e.message}`));
  const dist = process.env.DIST_URL ? `?dist=${encodeURIComponent(process.env.DIST_URL)}` : "";
  await page.goto(`http://localhost:${port}/test/browser/index.html${dist}`);
  const isolated = await page.evaluate(() => self.crossOriginIsolated);
  console.log(`   crossOriginIsolated: ${isolated}`);
  if (isolated) {
    console.log("   FAIL the page is cross-origin isolated; it must pass without COOP/COEP");
    failures++;
  }
  try {
    await page.waitForFunction(() => window.__cvc5TestResult !== undefined, null, { timeout: 600000 });
  } catch {
    console.log("   FAIL timed out waiting for the worker");
    failures++;
    await browser.close();
    continue;
  }
  const text = await page.evaluate(() => document.getElementById("out").innerText);
  for (const line of text.split("\n")) console.log("   " + line);
  const result = await page.evaluate(() => window.__cvc5TestResult);
  console.log(`   ${result.failures === 0 ? "all checks passed" : result.failures + " check(s) failed"}`);
  failures += result.failures;
  await browser.close();
}

server.close();
console.log(failures === 0 ? "\nbrowser tests passed" : `\n${failures} browser check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
