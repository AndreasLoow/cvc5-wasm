The 87 queries the cse-exe verifier sends cvc5 while verifying its `swap`
example, captured 2026-09-04 with all options the consumer sets already in
the script (`:rlimit`, `:strings-alpha-card 256`, `:dt-nested-rec true`,
`(set-logic ALL)`).  `expected.tsv` is the first word of native cvc5
1.3.4's answer to each (82 `unsat`, 5 `unknown`; native total 0.7 s).
