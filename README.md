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
teardown every time.  [task.md](task.md) is the specification this
implements.

Releases carry the built artefacts: fetch
`cvc5-wasm-<tag>.zip` (or `.tar.gz`) from the
[releases page](https://github.com/AndreasLoow/cvc5-wasm/releases) and serve
`cvc5.js` and `cvc5.wasm` side by side.

## What is in a release

| file | what it is |
|---|---|
| `cvc5.js` | emscripten glue: a `MODULARIZE`d factory in classic-script form, named `createCvc5` |
| `cvc5.wasm` | the solver, a separate file so it can be served as `application/wasm` and streamed |
| `VERSION.json` | cvc5 version and commit, emsdk version, build date, the link line |
| `LICENSE`, `THIRD-PARTY-LICENSES` | cvc5 is BSD-3-Clause; the statically linked dependencies are listed with their licences |
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
no `Cross-Origin-Opener-Policy` or `Cross-Origin-Embedder-Policy`.

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
implements design 2 -- one solver kept for the session and reset between calls
(SMT-LIB `(reset)`, which is what cvc5's own `ResetCommand` does: it resets the
symbol manager and rebuilds the solver with its original options) -- behind
`-DCVC5_WASM_PERSISTENT_SOLVER`, and `DESIGN=2 ./build.sh` links it.  Both pass
the isolation test.  Measured with the same `npm test` harness:

MEASUREMENTS_DESIGN

Design 2 keeps nothing worth keeping warm here: `(reset)` throws away the term
manager's caches anyway, so it only adds a second solver teardown per call.
Design 1 ships.

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

MEASUREMENTS_MAIN

## Tests

`npm test` runs the six tests from task.md against `dist/` under node:

1. **trivial** -- `(set-logic ALL)(check-sat)` is `sat`.
2. **swap corpus** -- each of the 87 real queries in `bench/swap/` gives the
   verdict native cvc5 1.3.4 gives (`bench/swap/expected.tsv`).
3. **isolation** -- a declaration, an option and a `set-logic` from one call
   cannot be seen by the next.
4. **errors do not kill** -- 300 rounds of a rejected script followed by a good
   one.
5. **leak** -- 20 passes of the corpus (1740 calls): identical answers, and the
   heap stays within 2x of its size after the first pass.
6. **timing** -- per-call milliseconds for the trivial query and the total for
   one pass of the corpus.

`npm run test:browser` runs tests 1-4 and 6 in headless Chromium and Firefox
via playwright (`npm i -D playwright && npx playwright install chromium
firefox`), inside a **classic** worker that loads `cvc5.js` with
`importScripts`, served without COOP/COEP.  `npm run serve` serves the same
page at <http://localhost:8080/> for a manual run.

Both run against `dist/`; pass a different directory as the first argument
(`node test/run.cjs path/to/dist`).

## Rebuilding

```sh
./build.sh          # ~1 h on 4 cores; writes dist/
npm test
npm run test:browser
```

`build.sh` is self-contained: it clones emsdk (pinned to **3.1.70**, the version
cvc5 1.3.4's `INSTALL.rst` and CI require) into `.build/emsdk`, clones cvc5 at
tag **cvc5-1.3.4** into `.build/cvc5`, configures it the way cvc5's own wasm CI
does

```sh
./configure.sh production --static --static-binary --auto-download --wasm=JS \
    -DCMAKE_CXX_FLAGS=-fexceptions
```

builds only `libcvc5.a` and `libcvc5parser.a` (the command-line binary is not
needed), links `src/cvc5_wasm.cpp` against them with `em++`, and writes
`dist/`.  cvc5's sources are not patched.  Two things are worth knowing about
that line:

* `-DCMAKE_CXX_FLAGS=-fexceptions` -- cvc5 reports errors by throwing, and
  emscripten drops `catch` handlers unless exceptions are compiled in.  cvc5's
  own build only adds `-fexceptions` for C.
* no `--ninja` -- LibPoly's CMake declares two rules for `libpoly.a` when the
  target has no shared libraries, which Ninja rejects and Make tolerates.

`tools/prefetch-deps.sh` fills cvc5's dependency download directory before the
build.  It is a no-op on an unrestricted network; where github.com's tarball
endpoints are blocked but git is not, it rebuilds each tarball from a git
mirror (GitHub's `/archive/` tarballs are exactly
`git archive --format=tar --prefix=<name>/ <ref> | gzip -n`) and checks it
against the SHA256 cvc5 pins.  `.build/dlcache` keeps the tarballs across
rebuilds.

Releases come from CI, not a laptop: pushing a tag `v*` runs
[`.github/workflows/release.yml`](.github/workflows/release.yml), which builds
on `ubuntu-latest`, runs the node and browser tests, and attaches
`cvc5-wasm-<tag>.tar.gz` and `cvc5-wasm-<tag>.zip` (the `dist/` files at top
level) to the release.  Tags are `v<cvc5 version>-<build number>`:
`v1.3.4-1`, `v1.3.4-2`, ...

### Bumping the cvc5 version

1. Edit the three pinned versions at the top of `build.sh`: `CVC5_TAG`,
   `CVC5_COMMIT` (`git ls-remote --tags https://github.com/cvc5/cvc5`) and, if
   the new cvc5's `INSTALL.rst` asks for a newer emscripten, `EMSDK_VERSION`.
2. Update the hard-coded `"cvc5"` version string in `write_metadata` in
   `build.sh`, and the version in `package.json`.
3. `rm -rf .build/cvc5 dist && ./build.sh && npm test && npm run test:browser`.
   The wrapper only uses cvc5's public C++ API (`<cvc5/cvc5.h>`,
   `<cvc5/cvc5_parser.h>`), so it usually needs no changes.
4. Regenerate `bench/swap/expected.tsv` with the new native cvc5 if its
   verdicts move, and say so in the release notes.
5. Tag `v<new version>-1`.
