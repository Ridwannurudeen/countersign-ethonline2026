# AI Usage Disclosure

## OpenAI Codex

OpenAI Codex (`codex-cli` 0.153.2) authored 100% of the source, tests, and scripts in this repository:

- Source: every module under `src/`, including the mandate, replay store, schedule
  validator, x402 gate, HCS-14 identity generator, HCS verdict log, and review server.
- Tests: every file under `test/`.
- Script: `scripts/spike-nested-key.ts`.

## Anthropic Claude

Anthropic Claude (Claude Code, Opus 5) acted as briefing, verification, and release engineer. It wrote the task briefs; independently ran the TypeScript typecheck and full test suite; and performed a mutation check by temporarily removing the allowlist and amount-cap invariants and confirming that exactly two tests failed. Claude owns all git-history operations for this repository and authored its commit messages. It did not author source code.

## Design review

A Day-1 design consultation with Codex overturned the project's original validation design. The initial plan was to byte-compare the scheduled transaction body. The review established that this would be unsound: `ScheduleInfo` exposes an already-decoded schedulable body, the protobuf decoder discards unknown fields, and `ScheduleSignTransaction` signs a transaction body containing only the `ScheduleID`. The field-complete validator in `src/review-schedule.ts` replaced that plan.

## Dependency verification

All direct dependency versions are exact pins. The paid service uses
`@hiero-ledger/sdk@2.85.0`, `@x402/core@2.25.0`, and `@x402/hedera@2.25.0` so npm resolves
one shared SDK instance across the application and the Hedera x402 mechanism.

## Verification limit

No AI system has verified live Hedera schedule approval, x402 facilitator settlement,
or HCS topic submission for this repository. The offline suite verifies orchestration
and wire construction with controlled adapters; credentialed testnet execution remains
required.
