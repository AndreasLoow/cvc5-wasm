# Task: cvc5 as a WebAssembly *library*, keeping the solver alive between queries

## Goal in one paragraph

Build cvc5 1.3.4 to WebAssembly with emscripten, not as the command-line
binary but as a library behind a tiny C++ wrapper, and publish the result as
a **downloadable release on this repository** so that a browser page or a
node script can do

```js
const M = await createCvc5();          // once per session: instantiate the module
M.solve("(set-logic ALL)\n(check-sat)\n");   // "sat\n", synchronous, many times
```

The module (wasm instance, C++ runtime, heap) stays alive for the whole
session.  Every `solve` call starts from a clean solver: default options, no
declarations, no assertions.  The consumer is the web verifier in
`AndreasLoow/cse-exe` (`web/` directory), which today downloads cvc5's own
`cvc5-Wasm.zip` and drives it as a process.  This repository replaces that
artefact.

## Why

cvc5 attaches `cvc5-Wasm.zip` to every release.  It is the *command-line
binary* compiled with emscripten (`cvc5.js`, 106 kB of glue, and
`cvc5.wasm`, 19 MB).  Its only entry point is `main`, so every query means:
write the script into the emscripten virtual filesystem, call `callMain`
with an argv, let cvc5 start up, parse, solve, shut down, and capture
stdout.  Measured with 1.3.4:

| where                       | trivial query `(set-logic ALL)(check-sat)` | 87 real queries (`bench/swap/`) |
|-----------------------------|--------------------------------------------|---------------------------------|
| native cvc5 1.3.4 (macOS)   | ~8 ms including process start              | 0.7 s total                     |
| `cvc5-Wasm.zip` under node 26 | ~20 ms                                    | ~1.8 s                          |
| `cvc5-Wasm.zip` in Chromium | ~120 ms                                    | ~13 s                           |
| z3 (npm `z3-solver`) in Chromium, same 87 queries | n/a                  | 0.5 s                           |

The Chromium number is the one that matters and it is almost entirely
per-call overhead, not solving: the trivial query costs the same 120 ms as a
real one.  Re-entering `main` re-runs cvc5's whole startup and teardown per
query, and Chromium runs that path in its baseline wasm tier.  On top of the
cost, driving `main` needs three workarounds the consumer currently carries
(the glue is not `MODULARIZE`d and rejects `wasmBinary`/`instantiateWasm`;
`callMain` leaks wasm stack and dies after ~137 calls; `--early-exit`
skips destructors and leaks ~7 MB of heap per call).  A library build with a
real entry point removes the overhead and all three workarounds.

**Target:** the 87 queries in `bench/swap/` in under 2 s in Chromium, and a
trivial query under 10 ms in Chromium and under 3 ms in node.  Report the
numbers you actually get; if a target is missed, say why.

## Versions

| component     | requirement                                                                                          |
|---------------|------------------------------------------------------------------------------------------------------|
| cvc5          | **1.3.4**, git tag `cvc5-1.3.4` (`https://github.com/cvc5/cvc5`).  Build from that tag, unmodified.  |
| emscripten    | emsdk **3.1.70 or later**, as cvc5's `INSTALL.rst` requires.  Pin one exact version in the build script and record it in the release. |
| node (tests)  | 22 or later.  The consumer runs node 26.7.                                                            |
| browsers      | current Chromium and Firefox, loaded inside a **classic** (non-module) Web Worker via `importScripts`, on a page **without** cross-origin isolation (no COOP/COEP headers). |

cvc5's own build already knows how to target wasm: `configure.sh` has
`--wasm=JS|WASM|HTML` and `--wasm-flags=...`, and its GitHub Actions CI
builds `cvc5-Wasm.zip` with them (see `.github/workflows/` in the cvc5
repository, and the WebAssembly section of `INSTALL.rst`).  The intended
configure line is

```sh
source ./emsdk_env.sh
./configure.sh production --static --static-binary --auto-download --wasm=JS ...
```

Use that to get the static libraries (`libcvc5.a`, `libcvc5parser.a`, and
the `--auto-download`ed dependencies: GMP, CaDiCaL, SymFPU, ...), then link
the wrapper against them with `em++`.  Whether you add the wrapper as an
extra CMake target or link it by hand is your call.  **Do not patch cvc5
sources.**  If a patch turns out to be unavoidable, keep it as a `.patch`
file in this repository, applied by the build script, and explain it in the
README.

## Deliverable 1: the wrapper

A single C++ file, on the order of 50 lines, against cvc5's public C++ API
(`<cvc5/cvc5.h>`, `<cvc5/cvc5_parser.h>`).  The shape:

```cpp
extern "C" {
  // Runs one whole SMT-LIB 2.6 script and returns everything the commands
  // print, exactly as the cvc5 binary would print it on stdout.  The
  // returned pointer is valid until the next call into the module.
  const char* cvc5_solve(const char* script);
  // Throw away all solver state (see "State between calls").
  void cvc5_reset(void);
  // "1.3.4"
  const char* cvc5_version(void);
}
```

`cvc5_solve` parses with `cvc5::parser::InputParser::setStringInput(
modes::InputLanguage::SMT_LIB_2_6, script, "query")`, then loops
`Command cmd = parser.nextCommand(); if (cmd.isNull()) break;
cmd.invoke(&solver, parser.getSymbolManager(), out);` into a
`std::ostringstream out`, and returns `out.str()`.  cvc5 ships this exact
loop as `examples/api/cpp/parser.cpp`.

### Output contract

* The returned string is **only** what the SMT-LIB commands print: `sat`,
  `unsat`, `unknown`, `success` (only if `:print-success` is on), the
  results of `(get-model)`, `(get-value ...)`, `(get-info ...)`, and so on.
  For a script whose only printing command is `(check-sat)`, the result
  trimmed of whitespace is exactly `sat`, exactly `unsat`, or begins with
  `unknown`.
* **Every** C++ exception (`CVC5ApiException`, parser errors, option
  errors, `std::bad_alloc`, anything) is caught inside `cvc5_solve` and
  rendered as `(error "message")` in the returned string.  Nothing may
  escape into JavaScript as a thrown value, and a rejected script must
  leave the module able to answer the next one.  The consumer treats any
  output containing the substring `error` (case-insensitive) as
  "unknown", so a *successful* run must never contain that substring.
* Anything cvc5 writes to its stderr (warnings, the `(INCOMPLETE)`
  explanation after `unknown`, `--verbose` chatter) goes to emscripten's
  `printErr`, never into the returned string.

### State between calls

The consumer requires that no query can observe an earlier one: not its
declarations, not its options, not its assertions, not its `set-logic`.
Two acceptable designs, and you should **measure both** and ship the faster
one that passes the isolation test:

1. Fresh `TermManager`, `Solver` and `SymbolManager` per call, destroyed at
   the end of the call.  Isolation is automatic.  This is the design to
   make work first.
2. One `Solver` for the session, reset between calls (SMT-LIB `(reset)`,
   or its API equivalent), keeping term-manager caches warm.  Only ship
   this if the isolation test in Deliverable 3 passes and it is measurably
   faster than 1.

`cvc5_reset()` exists for the host: after a wasm-level crash it cannot
help (see below), but after an `(error ...)` the host may want a
guaranteed-clean slate without paying for a new module.  Under design 1 it
may be a no-op.

### Things learned the hard way, so you don't relearn them

* **Nested-recursive datatypes.**  Every query the consumer generates
  declares a datatype `Val` that recurses through `(Seq Val)`.  cvc5
  refuses it (`Cannot handle nested-recursive datatype Val`) unless
  `(set-option :dt-nested-rec true)` is set, which the scripts do.  The
  wrapper must let scripts set options before `set-logic`, which a fresh
  solver per call does naturally.  Do not bake options into the wrapper;
  everything is in the script.
* **No wall clock.**  `(set-option :tlimit N)` and `--tlimit` are armed
  with a timer, and a timer cannot fire while a synchronous wasm call is
  on the only thread there is.  The consumer uses `(set-option :rlimit N)`
  (a deterministic count of cvc5's internal resource units) instead.  The
  wrapper must not depend on timers, signals, or `setjmp`-style unwinding.
  Do not build with Asyncify or pthreads.
* **Byte alphabet.**  Scripts set `(set-option :strings-alpha-card 256)`.
  Nothing for the wrapper to do; just don't reject it.
* **Crashes.**  cvc5 1.3.4 can be made to hit a real crash (an unguarded
  `seq.nth` under nested quantifiers over `Val` does it; natively it is a
  SIGILL).  In wasm that is a trap that kills the instance for good; every
  later call throws `RuntimeError: memory access out of bounds` or
  similar.  The wrapper cannot recover from this.  The JS side must let it
  surface as a thrown `RuntimeError` (do **not** swallow it into an
  `(error ...)` string, because the instance is dead and the host has to
  know to build a new one), and `createCvc5()` must be callable again to
  get a fresh instance.
* **`--early-exit`** only matters for the CLI's `main`; with the API,
  destructors run.  Confirm with the leak test below.

## Deliverable 2: the JavaScript surface and link flags

Two files, `cvc5.js` and `cvc5.wasm`, side by side.  `cvc5.js` is an
emscripten **`MODULARIZE`d factory in classic-script form** (not ES6
modules), so that all three of these work:

```js
importScripts("cvc5.js");  const M = await createCvc5({ locateFile: f => base + f });  // classic worker
const createCvc5 = require("./cvc5.js");  const M = await createCvc5();                // node
<script src="cvc5.js"></script>  createCvc5().then(...)                                 // page
```

Required emscripten settings (spellings as of emsdk 3.1.x):

```
-sMODULARIZE=1 -sEXPORT_NAME=createCvc5
-sENVIRONMENT=web,worker,node
-sALLOW_MEMORY_GROWTH=1
-sEXPORTED_FUNCTIONS=_cvc5_solve,_cvc5_reset,_cvc5_version,_malloc,_free
-sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString,stringToUTF8,lengthBytesUTF8
-sINCOMING_MODULE_JS_API=locateFile,wasmBinary,instantiateWasm,print,printErr,onAbort
-fexceptions   (C++ exceptions must work; cvc5 reports errors by throwing)
-O2
```

No `-sUSE_PTHREADS`, no `-sASYNCIFY`, no `-sSINGLE_FILE` (the .wasm stays a
separate file so it can be served with `Content-Type: application/wasm`
and streamed).  Keep the default initial memory unless the leak test says
otherwise.

Add a small `--post-js` (or `--pre-js`) so the instantiated module carries
convenience methods; the consumer will call these and not `ccall`:

```js
M.solve(script: string): string     // wraps _cvc5_solve; copies the string in and out
M.reset(): void
M.version(): string                 // "1.3.4"
```

`M.solve` may throw only when the wasm instance itself has trapped (see
"Crashes").  Every other failure is an `(error ...)` string.

Ship a `VERSION.json` next to the two files:

```json
{ "cvc5": "1.3.4", "cvc5_commit": "<sha of tag cvc5-1.3.4>",
  "emsdk": "<exact version>", "cvc5_wasm": "<this repo's tag>",
  "built": "<ISO date>", "flags": "<the emcc link line>" }
```

## Deliverable 3: tests, in this repository, run by `npm test` (node)

1. **trivial** `(set-logic ALL)\n(check-sat)\n` → trimmed output `sat`.
2. **swap corpus** each `bench/swap/qNNN.smt2` → first word of the output
   equals the second column of `bench/swap/expected.tsv` (82 `unsat`,
   5 `unknown`; produced with native cvc5 1.3.4).  These are real queries
   from the consumer, options included.
3. **isolation** run `(set-logic ALL)(declare-const x Int)(assert (> x 0))(check-sat)`
   then `(set-logic ALL)(assert (> x 0))(check-sat)`.  The second must
   return an `(error ...)` about `x` being undeclared, not `sat`.  Then
   `(set-option :print-success true)(set-logic ALL)(check-sat)` followed by
   `(set-logic ALL)(check-sat)`: the second output must not contain
   `success`.
4. **errors do not kill** `(assert (foo))` → output contains `error`;
   the trivial query right after still answers `sat`.  Repeat 300 times.
5. **leak** run the swap corpus 20 times in a row (1740 calls).  Every
   answer identical to the first pass; `M.HEAPU8.length` (or
   `wasmMemory.buffer.byteLength`) at the end within 2× of its value after
   the first pass.  Print the two numbers.
6. **timing** print per-call milliseconds for the trivial query (mean of
   100 after 20 warm-up calls) and total for one pass of the swap corpus.

Also a `test/browser/index.html` plus a worker script that loads `cvc5.js`
via `importScripts` inside a classic worker, runs tests 1–4 and 6, and
prints results into the page.  Run it in Chromium (headless via
puppeteer/playwright in CI is ideal; a manual run with the numbers pasted
into the release notes is acceptable) and confirm it works served with
plain static headers, i.e. without `Cross-Origin-Opener-Policy` /
`Cross-Origin-Embedder-Policy`.

## Deliverable 4: distribution

* `build.sh` at the root: installs/activates the pinned emsdk (into a
  local directory, not system-wide), clones cvc5 at `cvc5-1.3.4`,
  configures, builds, links the wrapper, writes `dist/` with `cvc5.js`,
  `cvc5.wasm`, `VERSION.json`, `LICENSE` (cvc5 is BSD-3-Clause) and
  `THIRD-PARTY-LICENSES` (GMP is LGPL-3, CaDiCaL MIT, SymFPU BSD; list
  whatever `--auto-download` actually pulled in, taken from the build
  tree), and `README.md` (the API above).
* `.github/workflows/release.yml`: on pushing a tag `v*`, runs `build.sh`
  on `ubuntu-latest`, runs `npm test` against `dist/`, and attaches
  `cvc5-wasm-<tag>.tar.gz` and `cvc5-wasm-<tag>.zip` (both containing the
  `dist/` files at top level) to a GitHub Release for the tag.  Releases
  must come from CI, not from a laptop, so they are reproducible.
* Tag scheme: `v1.3.4-1`, `v1.3.4-2`, ... (cvc5 version, then this repo's
  build number).  Cut `v1.3.4-1` when everything above passes.
* Report the sizes of `cvc5.wasm` raw and gzipped in the release notes.
  The consumer expects roughly 19 MB raw like the CLI build; a big
  difference either way deserves a sentence.
* No npm publishing is needed.  The consumer fetches the release asset
  by URL, the way its `web/fetch_cvc5.sh` fetches `cvc5-Wasm.zip` today:

  ```
  https://github.com/AndreasLoow/cvc5-wasm/releases/download/v1.3.4-1/cvc5-wasm-v1.3.4-1.zip
  ```

## What the consumer will do with it (for orientation, not for you to do)

In `cse-exe/web/`: `fetch_cvc5.sh` switches to the URL above;
`cvc5_loader.js` shrinks to `importScripts("cvc5.js")` +
`createCvc5({locateFile})` + `globalThis.__cvc5_solve = s => M.solve(s)`,
with a `RuntimeError` from `solve` triggering a fresh `createCvc5()`;
`run_smt_tests.js` and `verify_worker.js` follow.  The OCaml side
(`cvc5_backend.ml`, `smtlib_print.ml`) does not change: it already puts
every option into the script and already reads the output by the contract
above.

## Definition of done

- [ ] `build.sh` produces `dist/` from a clean checkout on Linux and on macOS (arm64), with the emsdk version pinned and recorded.
- [ ] `npm test` passes all six tests against `dist/` under node.
- [ ] The browser test page passes in Chromium in a classic worker with no COOP/COEP headers; Firefox at least loads and answers the trivial query.
- [ ] Timings for node and Chromium are in the release notes, next to the targets above.
- [ ] Release `v1.3.4-1` exists with the `.tar.gz` and `.zip` assets, built by the workflow.
- [ ] README documents: the JS API, the output contract, the state-between-calls design actually shipped (1 or 2) and the measurements that decided it, the crash caveat, how to rebuild, and how to bump the cvc5 version.
