// Measures cvc5's own cvc5-Wasm.zip (the CLI build, driven through callMain) in
// the same browser on the same machine as the library build, so the release
// notes can compare like with like.  Not part of npm test.
//
//   curl -L -o .build/cvc5-Wasm.zip \
//     https://github.com/cvc5/cvc5/releases/download/cvc5-1.3.4/cvc5-Wasm.zip
//   unzip -o .build/cvc5-Wasm.zip -d .build/cli
//   node test/compare/compare.mjs
import { serve } from "../browser/serve.mjs";

const wanted = (process.env.BROWSERS || "chromium").split(",").map((s) => s.trim());
const playwright = await import("playwright");
const { server, port } = await serve();

for (const name of wanted) {
  let browser;
  try {
    browser = await playwright[name].launch();
  } catch (e) {
    console.log(`== ${name}: not installed, skipped`);
    continue;
  }
  console.log(`== ${name} ${browser.version()}`);
  for (const mode of ["trivial", "corpus"]) {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.log(`   [pageerror] ${e.message}`));
    await page.goto(`http://localhost:${port}/test/compare/index.html?mode=${mode}`);
    try {
      await page.waitForFunction(() => window.__cliResult !== undefined, null, { timeout: 900000 });
    } catch {
      console.log(`   ${mode}: timed out`);
      await page.close();
      continue;
    }
    console.log(
      "   " + (await page.evaluate(() => document.getElementById("out").textContent)).split("\n").join("\n   ")
    );
    await page.close();
  }
  await browser.close();
}

server.close();
