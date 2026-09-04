# AI Usage Disclosure

## OpenAI Codex

OpenAI Codex (`codex-cli` 0.153.2) authored 100% of the source, tests, and scripts in this repository:

- Source: `src/mandate.ts`, `src/replay-store.ts`, and `src/review-schedule.ts`.
- Tests: `test/mandate.test.ts`, `test/replay-store.test.ts`, and `test/review-schedule.test.ts`.
- Script: `scripts/spike-nested-key.ts`.

## Anthropic Claude

Anthropic Claude (Claude Code, Opus 5) acted as briefing, verification, and release engineer. It wrote the task briefs; independently ran the TypeScript typecheck and full test suite; and performed a mutation check by temporarily removing the allowlist and amount-cap invariants and confirming that exactly two tests failed. Claude owns all git-history operations for this repository and authored its commit messages. It did not author source code.

## Design review

A Day-1 design consultation with Codex overturned the project's original validation design. The initial plan was to byte-compare the scheduled transaction body. The review established that this would be unsound: `ScheduleInfo` exposes an already-decoded schedulable body, the protobuf decoder discards unknown fields, and `ScheduleSignTransaction` signs a transaction body containing only the `ScheduleID`. The field-complete validator in `src/review-schedule.ts` replaced that plan.

## Dependency verification

All pinned dependency versions were verified against the live npm registry instead of accepted from model recall. This matters because models can misremember package names and versions: `@hashgraph/sdk` is stale at 2.81.0, while `@hiero-ledger/sdk` 2.87.0 is the maintained package used here.

## Verification limit

No AI system has verified live Hedera network behavior for this repository. `scripts/spike-nested-key.ts` is the live testnet check intended to perform that verification.
