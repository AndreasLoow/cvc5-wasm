// Classic (non-module) Web Worker: loads the library with importScripts and
// runs tests 1-4 and 6 from task.md.  Results go back to the page as messages.
"use strict";

// The directory holding cvc5.js/cvc5.wasm, "/dist" unless the page passes
// ?dist=... through to the worker's URL.
const DIST = new URLSearchParams(location.search).get("dist") || "/dist";

importScripts(DIST + "/cvc5.js");

const TRIVIAL = "(set-logic ALL)\n(check-sat)\n";

let failures = 0;

function log(text) {
  postMessage({ type: "log", text });
}

function check(name, ok, detail) {
  if (!ok) failures++;
  postMessage({ type: "check", name, ok, detail });
}

function firstWord(s) {
  return s.trim().split(/\s+/)[0] || "";
}

async function corpus() {
  const tsv = await (await fetch("/bench/swap/expected.tsv")).text();
  const rows = tsv.split("\n").filter((l) => l.trim() !== "");
  const out = [];
  for (const row of rows) {
    const [name, verdict] = row.split(/\s+/);
    out.push({ name, verdict, script: await (await fetch(`/bench/swap/${name}.smt2`)).text() });
  }
  return out;
}

async function main() {
  const t0 = performance.now();
  const M = await createCvc5({ locateFile: (f) => DIST + "/" + f });
  log(`cvc5 ${M.version()} instantiated in ${(performance.now() - t0).toFixed(0)} ms`);

  const queries = await corpus();

  // 1. trivial
  const trivial = M.solve(TRIVIAL);
  check("1. trivial query is sat", trivial.trim() === "sat", JSON.stringify(trivial));

  // 2. swap corpus
  let wrong = 0;
  for (const q of queries) if (firstWord(M.solve(q.script)) !== q.verdict) wrong++;
  check(`2. all ${queries.length} swap queries match expected.tsv`, wrong === 0, `${wrong} mismatch(es)`);

  // 3. isolation
  const declared = M.solve("(set-logic ALL)(declare-const x Int)(assert (> x 0))(check-sat)");
  check("3a. first script answers sat", declared.trim() === "sat", JSON.stringify(declared));
  const leaked = M.solve("(set-logic ALL)(assert (> x 0))(check-sat)");
  check("3b. second script cannot see x", /error/i.test(leaked) && !/^sat/.test(leaked.trim()), JSON.stringify(leaked.slice(0, 120)));
  const withSuccess = M.solve("(set-option :print-success true)(set-logic ALL)(check-sat)");
  check("3c. print-success prints success", /success/.test(withSuccess), JSON.stringify(withSuccess));
  check("3d. print-success does not leak", !/success/.test(M.solve(TRIVIAL)), "");

  // 4. errors do not kill
  let badError = null;
  let badRecovery = null;
  for (let i = 0; i < 300; i++) {
    const err = M.solve("(assert (foo))");
    if (badError === null && !/error/i.test(err)) badError = `round ${i}: ${JSON.stringify(err)}`;
    const ok = M.solve(TRIVIAL);
    if (badRecovery === null && ok.trim() !== "sat") badRecovery = `round ${i}: ${JSON.stringify(ok)}`;
  }
  check("4a. (assert (foo)) reports an error", badError === null, badError);
  check("4b. still sat after 300 errors", badRecovery === null, badRecovery);

  // 6. timing
  for (let i = 0; i < 20; i++) M.solve(TRIVIAL);
  const t1 = performance.now();
  for (let i = 0; i < 100; i++) M.solve(TRIVIAL);
  const perTrivial = (performance.now() - t1) / 100;
  const t2 = performance.now();
  for (const q of queries) M.solve(q.script);
  const corpusTotal = (performance.now() - t2) / 1000;
  log(`6. trivial query: ${perTrivial.toFixed(2)} ms per call (mean of 100, target < 10 ms)`);
  log(`6. swap corpus: ${corpusTotal.toFixed(2)} s for ${queries.length} queries (target < 2 s)`);

  postMessage({
    type: "done",
    failures,
    timing: { perTrivialMs: perTrivial, corpusSeconds: corpusTotal },
  });
}

main().catch((e) => postMessage({ type: "done", failures: failures + 1, error: String(e && e.stack || e) }));
