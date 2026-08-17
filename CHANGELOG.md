# Changelog

All notable changes to `@overrule/core` are recorded here.

From v1.0.0 onward this file is generated automatically by
[release-please](https://github.com/googleapis/release-please) from
[Conventional Commits](https://www.conventionalcommits.org/) — do not edit it by hand.

## 1.0.0 (2026-08-18)

Initial public release: the offline Overrule core as submitted.

### Features

* appeals pipeline — case state machine, mandate middleware, docket engine, redaction, agent pipeline
* signed, hash-chained decision ledger with an independently re-verifiable export
* `/verify` judge dashboard rendering the real outputs of the offline pipeline
* deterministic seed fixtures + 22-invariant end-to-end self-test

### CI/CD

* multi-stage CI: typecheck, 121 vitest tests on Node 18/20/22, autonomy proof, secret scan, npm audit
* CodeQL SAST on push, PR and a weekly schedule
