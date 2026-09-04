# cvc5-wasm

cvc5 compiled to WebAssembly as a **library**: one persistent module, one
synchronous `solve(script)` call, no per-query process startup.  Intended as
a downloadable release that the web verifier in
[AndreasLoow/cse-exe](https://github.com/AndreasLoow/cse-exe) depends on.

Work in progress.  **[task.md](task.md)** is the specification: what to
build, which versions, the output contract, tests, and how releases are
cut.  `bench/swap/` holds 87 real SMT-LIB queries from the consumer with
their expected verdicts, used by the tests and as the timing benchmark.
