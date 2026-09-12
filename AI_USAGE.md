# AI Usage Disclosure

## OpenAI Codex

OpenAI Codex (`codex-cli` 0.153.2) authored the original source, tests, and scripts in this repository:

- Source: every module under `src/`, including the mandate, replay store, schedule
  validator, x402 gate, HCS-14 identity generator, HCS verdict log, and review server.
- Tests: every file under `test/`.
- Scripts: the testnet spike and narrated allowed/refused flows under `scripts/`.

## Anthropic Claude

Anthropic Claude (Claude Code, Opus 5) acted as briefing, verification, and release engineer for
the work above. It wrote the task briefs; independently ran the TypeScript typecheck and full test
suite; and performed mutation checks by temporarily removing invariants and confirming that the
suite failed.

Claude also authored the following directly, during the 2026-09-12 live testnet session, when a
defect had to be diagnosed and fixed from live network behaviour:

- `decodeMirrorPublicKeyPrefix` in `src/evidence-links.ts`, and the equivalent decoder in
  `web/evidence.html` and `web/replay.html`.
- The evidence-event emitter and the signer-prefix output change in `scripts/live-flow.ts`.
- `scripts/build-evidence.ts` in full.
- The base64 fixtures, the strict-encoding test, and the two live mirror-node invariants in
  `test/`, plus the rewrite of two tests that had asserted the empty-manifest placeholder.
- The live-evidence sections of `README.md` and `ONBOARDING.md`, and the pinned schema versions
  in `.env.example`.

Claude owns all git-history operations for this repository and authored its commit messages.

## Design review

A Day-1 design consultation with Codex overturned the project's original validation design. The initial plan was to byte-compare the scheduled transaction body. The review established that this would be unsound: `ScheduleInfo` exposes an already-decoded schedulable body, the protobuf decoder discards unknown fields, and `ScheduleSignTransaction` signs a transaction body containing only the `ScheduleID`. The field-complete validator in `src/review-schedule.ts` replaced that plan.

## Dependency verification

All direct dependency versions are exact pins. The paid service uses
`@hiero-ledger/sdk@2.85.0`, `@x402/core@2.25.0`, and `@x402/hedera@2.25.0` so npm resolves
one shared SDK instance across the application and the Hedera x402 mechanism.

## Live verification

On 2026-09-12 the full flow was executed against Hedera testnet, and live Hedera schedule
approval, x402 facilitator settlement, and HCS topic submission were each confirmed on the
public mirror node independently of this repository's code. The mirror-node links are in
`README.md`.

That run exposed a defect the offline suite could not have caught: the mirror node returns
`signatures[].public_key_prefix` as base64, and three code paths required hexadecimal. The
test fixtures used `"a".repeat(16)`, which is itself valid base64, so they passed while
asserting nothing about the real encoding. The regression tests added afterwards run against
verbatim mirror-node responses captured from that run.

All recorded reviews are operator-run reliability exercises, not external usage, and testnet
payments are paid protocol trials, not revenue. `web/evidence.json` labels them accordingly
and reports zero external reviews.
