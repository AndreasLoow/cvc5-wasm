// npm test: the six tests from task.md, against dist/ under node.
//
//   node test/run.cjs [dist-dir]
//
// Everything runs against one module instance, which is the point of the
// library build: the wasm instance, the C++ runtime and the heap stay alive
// for the whole session.
"use strict";

const fs = require("fs");
const path = require("path");

const distDir = path.resolve(process.argv[2] || process.env.DIST || path.join(__dirname, "..", "dist"));
const benchDir = path.join(__dirname, "..", "bench", "swap");

const createCvc5 = require(path.join(distDir, "cvc5.js"));

const TRIVIAL = "(set-logic ALL)\n(check-sat)\n";

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail === undefined ? "" : ": " + detail}`);
  }
  return ok;
}

function firstWord(s) {
  return s.trim().split(/\s+/)[0] || "";
}

function loadCorpus() {
  const expected = fs
    .readFileSync(path.join(benchDir, "expected.tsv"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const [name, verdict] = l.split(/\s+/);
      return { name, verdict, script: fs.readFileSync(path.join(benchDir, name + ".smt2"), "utf8") };
    });
  return expected;
}

function heapSize(M) {
  return M.heapSize ? M.heapSize() : M.HEAPU8.length;
}

async function main() {
  const M = await createCvc5();
  console.log(`cvc5 ${M.version()} from ${distDir}`);
  const corpus = loadCorpus();

  // 1. trivial ---------------------------------------------------------------
  console.log("\n1. trivial");
  const trivial = M.solve(TRIVIAL);
  check("(set-logic ALL)(check-sat) is sat", trivial.trim() === "sat", JSON.stringify(trivial));
  check("version() is 1.3.4", M.version() === "1.3.4", JSON.stringify(M.version()));

  // 2. swap corpus -----------------------------------------------------------
  console.log(`\n2. swap corpus (${corpus.length} queries)`);
  let wrong = 0;
  for (const q of corpus) {
    const out = M.solve(q.script);
    if (firstWord(out) !== q.verdict) {
      wrong++;
      if (wrong <= 5) console.log(`        ${q.name}: expected ${q.verdict}, got ${JSON.stringify(out.slice(0, 120))}`);
    }
  }
  check(`every query matches expected.tsv`, wrong === 0, `${wrong} mismatch(es)`);

  // 3. isolation -------------------------------------------------------------
  console.log("\n3. isolation");
  const declared = M.solve("(set-logic ALL)(declare-const x Int)(assert (> x 0))(check-sat)");
  check("first script answers sat", declared.trim() === "sat", JSON.stringify(declared));
  const leaked = M.solve("(set-logic ALL)(assert (> x 0))(check-sat)");
  check(
    "second script cannot see x",
    /error/i.test(leaked) && !/^sat/.test(leaked.trim()),
    JSON.stringify(leaked.slice(0, 160))
  );
  const withSuccess = M.solve("(set-option :print-success true)(set-logic ALL)(check-sat)");
  check("print-success prints success", /success/.test(withSuccess), JSON.stringify(withSuccess));
  const withoutSuccess = M.solve(TRIVIAL);
  check("print-success does not leak", !/success/.test(withoutSuccess), JSON.stringify(withoutSuccess));

  // 4. errors do not kill ----------------------------------------------------
  console.log("\n4. errors do not kill (300 rounds)");
  let badError = null;
  let badRecovery = null;
  for (let i = 0; i < 300; i++) {
    const err = M.solve("(assert (foo))");
    if (badError === null && !/error/i.test(err)) badError = `round ${i}: ${JSON.stringify(err)}`;
    const ok = M.solve(TRIVIAL);
    if (badRecovery === null && ok.trim() !== "sat") badRecovery = `round ${i}: ${JSON.stringify(ok)}`;
  }
  check("(assert (foo)) reports an error", badError === null, badError);
  check("the query after an error still answers sat", badRecovery === null, badRecovery);

  // 5. leak ------------------------------------------------------------------
  const passes = Number(process.env.LEAK_PASSES || 20);
  console.log(`\n5. leak (${passes} passes of the corpus, ${passes * corpus.length} calls)`);
  let heapAfterFirstPass = 0;
  let drift = null;
  const answers = [];
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < corpus.length; i++) {
      const out = M.solve(corpus[i].script);
      if (pass === 0) answers.push(out);
      else if (drift === null && out !== answers[i]) {
        drift = `pass ${pass + 1}, ${corpus[i].name}: ${JSON.stringify(out.slice(0, 120))} != ${JSON.stringify(
          answers[i].slice(0, 120)
        )}`;
      }
    }
    if (pass === 0) heapAfterFirstPass = heapSize(M);
  }
  const heapAtEnd = heapSize(M);
  console.log(`        heap after pass 1: ${heapAfterFirstPass} bytes`);
  console.log(`        heap at the end:   ${heapAtEnd} bytes (${(heapAtEnd / heapAfterFirstPass).toFixed(2)}x)`);
  check(`every answer identical across ${passes} passes`, drift === null, drift);
  check("heap within 2x of its size after the first pass", heapAtEnd <= 2 * heapAfterFirstPass);

  // 6. timing ----------------------------------------------------------------
  console.log("\n6. timing");
  for (let i = 0; i < 20; i++) M.solve(TRIVIAL);
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) M.solve(TRIVIAL);
  const perTrivial = (performance.now() - t0) / 100;
  const t1 = performance.now();
  for (const q of corpus) M.solve(q.script);
  const corpusTotal = (performance.now() - t1) / 1000;
  console.log(`        trivial query: ${perTrivial.toFixed(2)} ms per call (mean of 100, target < 3 ms)`);
  console.log(`        swap corpus:   ${corpusTotal.toFixed(2)} s for ${corpus.length} queries`);

  console.log(`\n${failures === 0 ? "all tests passed" : failures + " check(s) failed"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
