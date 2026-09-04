# cvc5-wasm

[cvc5](https://cvc5.github.io/) 1.3.4 compiled to WebAssembly as a **library**:
one persistent module, one synchronous `solve(script)` call, no per-query
process startup.  Built by
[AndreasLoow/cvc5-wasm](https://github.com/AndreasLoow/cvc5-wasm); see
`VERSION.json` for the exact cvc5 commit, emsdk version, link flags, and the
one patch applied to cvc5 (it makes cvc5 seed GMP's random state on first use
instead of twice per query, which is 79% of the wall clock of a small query in
WebAssembly; nothing else about cvc5 is changed, and the repository's README
explains it in full).

## Files

| file | what it is |
|---|---|
| `cvc5.js` | emscripten glue: a `MODULARIZE`d factory in classic-script form, named `createCvc5` |
| `cvc5.wasm` | the solver; serve it as `application/wasm` next to `cvc5.js` |
| `VERSION.json` | versions, build date and the link line |
| `LICENSE` | cvc5's licence (BSD-3-Clause) |
| `THIRD-PARTY-LICENSES` | licences of the statically linked dependencies |

## Loading

```js
// classic Web Worker
importScripts("cvc5.js");
const M = await createCvc5({ locateFile: (f) => base + f });

// node
const createCvc5 = require("./cvc5.js");
const M = await createCvc5();

// page
// <script src="cvc5.js"></script>
createCvc5().then((M) => ...);
```

No cross-origin isolation is needed: the build uses no threads and no
`SharedArrayBuffer`, so it works on a page served with plain static headers
(no `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`).

## API

```js
M.solve(script: string): string   // run one whole SMT-LIB 2.6 script
M.reset(): void                   // throw away solver state
M.version(): string               // "1.3.4"
M.heapSize(): number              // current wasm heap size in bytes
```

`solve` is synchronous and may be called as often as you like; the module
stays alive for the whole session.  On a 4-core Linux machine a trivial query
costs about 2.6 ms in Chromium and 2.4 ms under node, and one pass of the 87
real queries this was built for takes about 1 s -- against about 46 ms and
4.6 s for cvc5's own `cvc5-Wasm.zip` driven through `callMain` in the same
browser.

### Output contract

* The returned string is **only** what the script's commands print: `sat`,
  `unsat`, `unknown`, `success` (when `:print-success` is on), the results of
  `(get-model)`, `(get-value ...)`, `(get-info ...)`, and so on.  For a script
  whose only printing command is `(check-sat)`, the trimmed result is exactly
  `sat`, exactly `unsat`, or begins with `unknown`.
* Every C++ exception -- API exceptions, parser errors, option errors,
  `std::bad_alloc` -- is caught and rendered as `(error "message")` in the
  returned string, with the same quoting cvc5 itself uses.  A rejected script
  leaves the module able to answer the next one.  A successful run never
  contains the substring `error`.
* Warnings, the explanation printed after `unknown`, and `--verbose` chatter go
  to emscripten's `printErr` (stderr under node), never into the returned
  string.

### State between calls

No query can observe an earlier one: each `solve` starts from a clean solver
with default options, no declarations and no assertions.  Put every option the
query needs into the script itself.

`M.reset()` throws away any solver state the module is holding.  It is not
needed for isolation -- `solve` already guarantees that -- and it cannot
recover from a crash (see below).

### Crashes

A genuine cvc5 crash (an internal error that would be a signal natively) is a
wasm trap: it kills the instance for good, and `solve` then throws a
`RuntimeError`.  That is deliberate -- the instance is dead and the host has to
know.  Recover by calling `createCvc5()` again for a fresh instance.

Very deeply nested input (thousands of nesting levels) can exhaust the
engine's call stack instead.  That surfaces as `RangeError: Maximum call stack
size exceeded`, and unlike a trap the module survives it and answers the next
query normally.  The build reserves an 8 MB wasm stack, matching what cvc5 gets
natively, so this happens before anything can overflow inside wasm.

Timers cannot fire while a synchronous wasm call owns the only thread, so
`(set-option :tlimit N)` and `--tlimit` never trigger.  Use
`(set-option :rlimit N)`, cvc5's deterministic resource limit, instead.
