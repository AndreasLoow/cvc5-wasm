# cvc5-wasm

[cvc5](https://cvc5.github.io/) 1.3.4 compiled to WebAssembly as a **library**:
one persistent module, one synchronous `solve(script)` call, no per-query
process startup.

```js
const M = await createCvc5();                 // once per session
M.solve("(set-logic ALL)\n(check-sat)\n");    // "sat\n", synchronous, many times
```

The wasm instance, the C++ runtime and the heap stay alive for the whole
session; every `solve` call starts from a clean solver.  This replaces driving
cvc5's own `cvc5-Wasm.zip` -- the command-line binary compiled with emscripten
-- through `callMain` once per query, which pays cvc5's whole startup and
teardown every time.  In the same headless Chromium, on the same machine, one
pass of the 87 queries in `bench/swap/` takes **1.03 s** here against **4.58 s**
that way, and a trivial query costs **2.4 ms** against **46 ms**.

[task.md](task.md) is the specification this implements.  Releases carry the
built artefacts: fetch `cvc5-wasm-<tag>.zip` (or `.tar.gz`) from the
[releases page](https://github.com/AndreasLoow/cvc5-wasm/releases) and serve
`cvc5.js` and `cvc5.wasm` side by side.

## What is in a release

| file | what it is |
|---|---|
| `cvc5.js` | emscripten glue: a `MODULARIZE`d factory in classic-script form, named `createCvc5` |
| `cvc5.wasm` | the solver, a separate file so it can be served as `application/wasm` and streamed |
| `VERSION.json` | cvc5 version and commit, emsdk version, patches applied, build date, the link line |
| `LICENSE`, `THIRD-PARTY-LICENSES` | cvc5 is BSD-3-Clause; every licence file the statically linked dependencies ship, in full |
| `README.md` | the API, as below |

## Loading

`cvc5.js` is a classic script (not an ES module), so all three of these work:

```js
importScripts("cvc5.js");                                       // classic worker
const M = await createCvc5({ locateFile: (f) => base + f });

const createCvc5 = require("./cvc5.js");                        // node
const M = await createCvc5();

// <script src="cvc5.js"></script>                              // page
createCvc5().then((M) => ...);
```

No cross-origin isolation is required: the build uses no threads and no
`SharedArrayBuffer`, so it runs on a page served with plain static headers, with
no `Cross-Origin-Opener-Policy` or `Cross-Origin-Embedder-Policy`.  Cold
instantiation from a local server costs about 200 ms in Chromium and about
1.6 s in Firefox, once per session.

## API

```js
M.solve(script: string): string   // run one whole SMT-LIB 2.6 script
M.reset(): void                   // throw away solver state
M.version(): string               // "1.3.4"
M.heapSize(): number              // current wasm heap size in bytes
```

Underneath, the module exports three C functions -- `cvc5_solve`, `cvc5_reset`,
`cvc5_version` -- plus `malloc` and `free`; the JavaScript methods above copy
the strings in and out for you.

### Output contract

* The returned string is **only** what the script's commands print: `sat`,
  `unsat`, `unknown`, `success` (when `:print-success` is on), the results of
  `(get-model)`, `(get-value ...)`, `(get-info ...)`, and so on -- exactly what
  the cvc5 binary would print on stdout.  For a script whose only printing
  command is `(check-sat)`, the trimmed result is exactly `sat`, exactly
  `unsat`, or begins with `unknown`.
* Every C++ exception -- `CVC5ApiException`, parser errors, option errors,
  `std::bad_alloc`, anything -- is caught inside `cvc5_solve` and rendered as
  `(error "message")` in the returned string, with the same quoting cvc5 itself
  uses.  Nothing escapes into JavaScript as a thrown value, and a rejected
  script leaves the module able to answer the next one.  A successful run never
  contains the substring `error`.
* Warnings, the explanation cvc5 prints after `unknown`, and `--verbose`
  chatter go to emscripten's `printErr` (stderr under node), never into the
  returned string.

### State between calls

**The shipped design is design 1: a fresh `TermManager`, `Solver` and
`SymbolManager` per call**, destroyed when the call returns, so isolation is
structural rather than something the wrapper has to maintain.  Put every option
a query needs into the script itself.

task.md asks for both designs to be measured.  `src/cvc5_wasm.cpp` also
implements design 2 -- one `TermManager` kept for the session, with a fresh
`Solver` and `SymbolManager` per call, which is exactly what cvc5's own
`ResetCommand` does for SMT-LIB `(reset)` (`Cmd::resetSolver` destroys the
solver and reconstructs it on the same term manager with its original options)
-- behind `-DCVC5_WASM_PERSISTENT_SOLVER`, and `DESIGN=2 ./build.sh` links it.
Measured with the same `npm test` harness under node:

| design | trivial query | swap corpus | heap after 20 corpus passes |
|---|---|---|---|
| 1 -- fresh solver per call (**shipped**) | 2.44 ms | 0.92 s | 1.00x |
| 2 -- session `TermManager`, `(reset)` per call | 2.52 ms | 1.08 s | **3.60x** |

Design 2 keeps nothing worth keeping warm: what it holds on to is a term
manager whose caches the reset invalidates anyway, so it is slightly slower
*and* it accumulates nodes across queries -- 17 MB grows to 63 MB over 1740
calls, which fails the leak test.  Design 1 ships.

Note that plain SMT-LIB `(reset)` is not enough on its own for design 2:
cvc5's `SymManager::reset()` resets the symbol table but leaves its logic flag
set, so the next script's `(set-logic ...)` fails with `Only one set-logic is
allowed`.  Hence the fresh `SymbolManager`.

`M.reset()` throws away whatever solver state the module holds (under design 1
there is none between calls, so it only drops the cached result string).  It is
not needed for isolation, and it cannot recover from a crash.

### Crashes

A genuine cvc5 crash -- an internal error that would be a signal natively, such
as an unguarded `seq.nth` under nested quantifiers -- is a wasm trap.  It kills
the instance for good: `solve` then throws a `RuntimeError` and every later call
does too.  That is deliberate, and the JavaScript side does not swallow it into
an `(error ...)` string, because the instance is dead and the host has to know
to build a new one.  Call `createCvc5()` again for a fresh instance.

Timers cannot fire while a synchronous wasm call owns the only thread, so
`(set-option :tlimit N)` and `--tlimit` never trigger.  Use
`(set-option :rlimit N)`, cvc5's deterministic resource limit, instead.  The
build has no Asyncify and no pthreads.

## Measurements

All numbers below are from one machine: a 4-core x86-64 Linux container, node
22.22.2, headless Chromium 151 and Firefox 153 driven by playwright, the page
served over `http://localhost` with plain static headers.  Native cvc5 1.3.4
(the official Linux static binary) does the corpus in 0.74 s and a trivial
query in 5 ms per process on this machine, against the 0.7 s and ~8 ms task.md
reports for macOS, so these numbers are comparable with the ones there.

Trivial query is `(set-logic ALL)\n(check-sat)\n`, the mean of 100 calls after
20 warm-up calls.  Swap corpus is one pass of the 87 queries in `bench/swap/`.

| where | trivial query | swap corpus | target |
|---|---|---|---|
| native cvc5 1.3.4, one process per query | 5 ms | 0.74 s | -- |
| **this build, node 22** | **2.44 ms** | **0.92 s** | trivial < 3 ms |
| **this build, Chromium 151** | **2.43 ms** | **1.03 s** | trivial < 10 ms, corpus < 2 s |
| this build, Firefox 153 | 8.06 ms | 2.88 s | -- |
| `cvc5-Wasm.zip` 1.3.4 via `callMain`, Chromium 151 | 45.96 ms | 4.58 s | -- |

Every target in task.md is met.  A query now costs less than a native process
does, because the module is already up: the remaining per-call cost is building
and tearing down one solver.  Firefox runs the same code about 3x slower than
Chromium; it is still inside the browser target for a single query, and 2.88 s
for a whole corpus pass is the one number a Firefox user would notice.

The `cvc5-Wasm.zip` row is cvc5's own artefact measured the way the consumer
drives it today, in the same browser on the same machine
(`node test/compare/compare.mjs`); it is the thing this repository replaces.

### Sizes

| file | raw | gzip -9 |
|---|---|---|
| `cvc5.wasm` | 30,842,612 | 5,733,838 |
| `cvc5.js` | 94,846 | 22,061 |
| (`cvc5-Wasm.zip`'s `cvc5.wasm`, for comparison) | 18,882,345 | 3,953,989 |

The wasm is 1.6x the size of cvc5's CLI build -- 30.8 MB against the ~19 MB
task.md expects -- and the difference is almost entirely working C++
exceptions.  cvc5's own wasm build passes `-s NO_DISABLE_EXCEPTION_CATCHING=1`
at link time only, so its objects are compiled with catch handlers dropped;
this build compiles cvc5 and the wrapper with `-fexceptions`, which the output
contract needs, and that adds landing pads and `invoke_*` thunks throughout.
The same build with `-fwasm-exceptions` instead is 21.9 MB (see below), which
puts the rest of the gap at about 3 MB of larger `-O2` output and LibPoly.

### Exceptions: `-fexceptions` versus `-fwasm-exceptions`

The shipped build uses `-fexceptions`, emscripten's JavaScript-based
exceptions, as task.md requires.  `EXCEPTIONS=wasm ./build.sh` builds the same
thing with `-fwasm-exceptions`, the wasm exception-handling proposal, which is
measurably better on every axis:

| build | `cvc5.wasm` | node trivial | node corpus | Chromium trivial | Chromium corpus | Firefox trivial | Firefox corpus |
|---|---|---|---|---|---|---|---|
| `-fexceptions` (shipped) | 30.8 MB | 2.44 ms | 0.92 s | 2.43 ms | 1.03 s | 8.06 ms | 2.88 s |
| `-fwasm-exceptions` | 21.9 MB | 1.34 ms | 0.40 s | 1.50 ms | 0.49 s | 6.20 ms | 2.06 s |

Roughly twice as fast and 9 MB smaller, with all six node tests passing and
both browser test pages green.  It is not shipped because task.md prescribes
`-fexceptions`, and because it needs wasm exception handling in the runtime:
Chrome 95+, Firefox 131+, Safari 15.2+, node 16+.  Every browser and node
version this repository targets qualifies, so switching is a reasonable call
for the consumer to make -- it is one environment variable at build time and no
change to the API.

### The patch to cvc5

`patches/0001-seed-gmp-random-state-lazily.patch` is the one patch this
repository applies to cvc5, and it is why the targets are met.  Without it the
trivial query costs 38 ms under node and 43 ms in Chromium, and the corpus
4.1 s and 4.4 s -- about 4x over target, with nothing to show for it.

Profiling with `node --cpu-prof` said 79% of a trivial query was GMP bignum
arithmetic under `gmp_randseed_ui`.  GMP seeds its Mersenne-Twister state by
"mangling by powering": a modular exponentiation with a 19937-bit modulus.
With GMP's assembly routines that is a millisecond or two; in WebAssembly,
where GMP is built from generic C, it is about 15 ms.  cvc5 pays it twice per
query when driven as a library -- once for the `Random` that `Solver::Solver`
constructs, once when `SolverEngine::finishInit` re-seeds the process-wide
`Random` singleton -- and nothing in a normal solve ever reads that state:
it is reachable only through `Random::getGMPRandstate()`, whose only callers
are `Integer::mkRandom` and `BitVector::mkRandom`.

The patch initializes and seeds the state on first access instead of in the
constructor and in `setSeed`.  Callers see exactly what they saw before -- a
state seeded with the current seed, re-seeded after every `setSeed` -- and the
per-query cost disappears.  `std::mt19937_64`, which cvc5 actually uses for
random decisions, is still seeded eagerly on every `setSeed`, so a query's
random decisions do not depend on what earlier queries drew.  It is worth
sending upstream.

`build.sh` applies the patch and commits it in the cvc5 checkout, because cvc5
appends `-modified` to the version it reports for a dirty worktree, and the
contract above says `M.version()` is `"1.3.4"`.  `VERSION.json` names the
patch.

## Tests

`npm test` runs the six tests from task.md against `dist/` under node:

1. **trivial** -- `(set-logic ALL)(check-sat)` is `sat`, and `version()` is `1.3.4`.
2. **swap corpus** -- each of the 87 real queries in `bench/swap/` gives the
   verdict native cvc5 1.3.4 gives (`bench/swap/expected.tsv`).
3. **isolation** -- a declaration, an option and a `set-logic` from one call
   cannot be seen by the next.
4. **errors do not kill** -- 300 rounds of a rejected script followed by a good
   one.
5. **leak** -- 20 passes of the corpus (1740 calls): identical answers, and the
   heap stays within 2x of its size after the first pass (it does not move:
   17,367,040 bytes both times).
6. **timing** -- per-call milliseconds for the trivial query and the total for
   one pass of the corpus.

`npm run test:browser` runs tests 1-4 and 6 in headless Chromium and Firefox
via playwright (`npm i -D playwright && npx playwright install chromium
firefox`), inside a **classic** worker that loads `cvc5.js` with
`importScripts`, served without COOP/COEP.  `npm run serve` serves the same
page at <http://localhost:8080/> for a manual run.

Both run against `dist/`; point them elsewhere with an argument
(`node test/run.cjs path/to/dist`) or `DIST_URL` (`DIST_URL=/.build/dist-wasmeh
npm run test:browser`).

`node test/compare/compare.mjs` measures cvc5's own `cvc5-Wasm.zip` through
`callMain` in the same browser, for the comparison row above; it needs that zip
unpacked into `.build/cli/` first (the file says how).

## Rebuilding

```sh
./build.sh          # ~1 h on 4 cores; writes dist/
npm test
npm run test:browser
```

`build.sh` is self-contained: it clones emsdk (pinned to **3.1.70**, the version
cvc5 1.3.4's `INSTALL.rst` and CI require) into `.build/emsdk`, clones cvc5 at
tag **cvc5-1.3.4** into `.build/cvc5`, applies `patches/`, configures it the way
cvc5's own wasm CI does

```sh
./configure.sh production --static --static-binary --auto-download --wasm=JS \
    -DCMAKE_CXX_FLAGS=-fexceptions
```

builds only `libcvc5.a` and `libcvc5parser.a` (the command-line binary is not
needed), links `src/cvc5_wasm.cpp` against them with `em++`, and writes `dist/`.
Two things are worth knowing about that configure line:

* `-DCMAKE_CXX_FLAGS=-fexceptions` -- cvc5 reports errors by throwing, and
  emscripten drops `catch` handlers unless exceptions are compiled in.  cvc5's
  own build only adds `-fexceptions` for C.
* no `--ninja` -- LibPoly's CMake declares two rules for `libpoly.a` when the
  target has no shared libraries, which Ninja rejects and Make tolerates.

Knobs: `DESIGN=1|2`, `EXCEPTIONS=js|wasm`, `JOBS=n`, `BUILD_ROOT=...`,
`DIST_DIR=...`.

`tools/prefetch-deps.sh` fills cvc5's dependency download directory before the
build.  It is a no-op on an unrestricted network; where github.com's tarball
endpoints are blocked but git is not, it rebuilds each tarball from a git
mirror (GitHub's `/archive/` tarballs are exactly
`git archive --format=tar --prefix=<name>/ <ref> | gzip -n`) and checks it
against the SHA256 cvc5 pins, so a wrong guess fails the build instead of
quietly compiling different sources.  `.build/dlcache` keeps the tarballs
across rebuilds.

Releases come from CI, not a laptop: pushing a tag `v*` runs
[`.github/workflows/release.yml`](.github/workflows/release.yml), which builds
on `ubuntu-latest`, runs the node and browser tests, and attaches
`cvc5-wasm-<tag>.tar.gz` and `cvc5-wasm-<tag>.zip` (the `dist/` files at top
level) to the release.  Tags are `v<cvc5 version>-<build number>`:
`v1.3.4-1`, `v1.3.4-2`, ...

### Bumping the cvc5 version

1. Edit the pinned versions at the top of `build.sh`: `CVC5_TAG`,
   `CVC5_COMMIT` (`git ls-remote --tags https://github.com/cvc5/cvc5`) and, if
   the new cvc5's `INSTALL.rst` asks for a newer emscripten, `EMSDK_VERSION`.
2. Update the hard-coded `"cvc5"` version string in `write_metadata` in
   `build.sh`, the version in `package.json`, and the `version() is 1.3.4`
   check in `test/run.cjs`.
3. Re-check `patches/`: if cvc5 has fixed the GMP seeding upstream, drop the
   patch (`git -C .build/cvc5 log --oneline src/util/random.cpp` and the
   measurements above will tell you).  If a patch no longer applies, rebase it
   by hand and record why it is still needed.
4. `rm -rf .build/cvc5 dist && ./build.sh && npm test && npm run test:browser`.
   The wrapper only uses cvc5's public C++ API (`<cvc5/cvc5.h>`,
   `<cvc5/cvc5_parser.h>`), so it usually needs no changes.
5. Regenerate `bench/swap/expected.tsv` with the new native cvc5 if its
   verdicts move, and say so in the release notes.
6. Tag `v<new version>-1`.
