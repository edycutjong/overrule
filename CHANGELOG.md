# Changelog

All notable changes to `@overrule/core` are recorded here.

From v1.0.0 onward this file is generated automatically by
[release-please](https://github.com/googleapis/release-please) from
[Conventional Commits](https://www.conventionalcommits.org/) — do not edit it by hand.

## [1.0.2](https://github.com/edycutjong/overrule/compare/v1.0.1...v1.0.2) (2026-08-17)


### Bug Fixes

* **ci:** empty release-please package-name so the release actually gets tagged ([6ac87c2](https://github.com/edycutjong/overrule/commit/6ac87c2e24ce8fe442b54395d30b5a4e608bb6ad))
* **ci:** pin release-please to an empty component so releases actually cut ([66b7f11](https://github.com/edycutjong/overrule/commit/66b7f11b73fe23d9ed8d1e3bd6f99e7be29287a4))

## [1.0.1](https://github.com/edycutjong/overrule/compare/v1.0.0...v1.0.1) (2026-08-17)


### Bug Fixes

* **ci:** drop the duplicated scope from dependabot commit prefixes ([276c7df](https://github.com/edycutjong/overrule/commit/276c7df12ec70d4462be1bb621f0d36c9a5b745a))
* **ci:** stop interpolating the release-please PR blob into the shell ([9bd890b](https://github.com/edycutjong/overrule/commit/9bd890b2e6e4f84f9f27b65b8af214f070769f8b))


### Build System

* **deps:** slow dependabot to monthly, grouped, no major bumps ([b4fb217](https://github.com/edycutjong/overrule/commit/b4fb2173216de5d89a3b5123956a682544fa1059))


### CI/CD

* **deploy:** ship the /verify dashboard to Vercel production on main ([7d5c939](https://github.com/edycutjong/overrule/commit/7d5c93993acdae092ce335122a64d6cbf8b152b3))
* **release:** automate versioning with release-please ([fe0b7f4](https://github.com/edycutjong/overrule/commit/fe0b7f401ec9c4cf80f6d0a50945f107846c3302))
* **release:** retry release-please once when the GitHub API 5xxs ([ebdc9c7](https://github.com/edycutjong/overrule/commit/ebdc9c788502e87c19097e14ac4b9919aef83091))
* **security:** scan the full git history for secrets with gitleaks ([7ab9a5a](https://github.com/edycutjong/overrule/commit/7ab9a5a4448082928f1c1a5f9c591c07894df69a))

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
