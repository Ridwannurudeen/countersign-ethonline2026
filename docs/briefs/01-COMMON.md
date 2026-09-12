# Countersign — common brief (prepend this to every task brief)

## What this is
Countersign is an authorization boundary for funded AI agents on Hedera testnet. A treasury
is keyed `1-of[ owner, 2-of[ agent, guard ] ]`. An agent can PROPOSE a transfer by publishing
it as a Scheduled Transaction, but its key alone satisfies neither branch, so the network
will not execute it. An independent guard resolves the schedule from consensus, validates
every value-relevant field against an owner-signed mandate, and adds the second signature
only on an exact policy match. Callers pay the guard per review over x402.

**The guard approves a ScheduleID. It does NOT sign the scheduled transaction bytes.**
`ScheduleSignTransaction`'s body contains only the ScheduleID, and `ScheduleInfo` returns an
already-decoded body whose decoder discards unknown fields. **No file in this repository may
ever claim the guard signs, byte-compares, or cryptographically attests those bytes.**

Event: ETHOnline 2026, Hedera "AI & Agentic Payments". Submission **Sat 2026-09-13 12:00 EDT**.

## Directory scope — STRICT
Work ONLY inside `C:\Users\gudma\OneDrive\Desktop\GITHUB-FILES\countersign-ethonline2026`.
Do not read or write anything outside it — in particular nothing under `C:\Users\gudma\.claude\`
or any other project. If you need context that is not in the repo or the brief, say so and
stop rather than going to find it.

**Never create a venv, download a wheel, or extract a package inside the repository.** Two
earlier runs left 6,700+ junk files. If you need scratch space use the system temp directory,
never the repo.

## Git custody
The owner owns git history. Write files; do not commit, push, checkout, reset or stash.
Reading git state (`status`, `diff`, `log`) is fine and encouraged.
**Never add AI or assistant attribution to anything.**

## Environment — verified, pinned, do not change
- `@hiero-ledger/sdk` **2.85.0** — exactly this. It is pinned to match `@x402/hedera`, which
  requires 2.85.0 exactly; at 2.87.0 npm installs **two** SDK copies and `instanceof` breaks
  across the boundary. `@hashgraph/sdk` is the stale pre-rename package — never use it.
- `@x402/core` and `@x402/hedera` **2.25.0**; `json-canonicalize` **3.0.0**
- TypeScript **5.9.3**, `@types/node` **24.7.0**, Node **v24.15.0**, Python **3.12.10**
- `hiero_sdk_python` **0.2.10** is already installed system-wide — just import it.
Do not add a dependency without saying why. Do not change a pinned version; report it instead.

## Verified external facts — use these, do not browse for them
- Blocky402 testnet facilitator `https://api.testnet.blocky402.com`. `GET /supported` returns
  `{"x402Version":2,"scheme":"exact","network":"hedera:testnet","extra":{"feePayer":"0.0.7162784"}}`.
  No API key. Network id is the CAIP-2 form **`hedera:testnet`**; protocol is **x402Version 2**.
- Mirror node `https://testnet.mirrornode.hedera.com/api/v1/schedules/{id}` returns
  `executed_timestamp`, `deleted`, `expiration_time`, `creator_account_id`,
  `payer_account_id`, `memo`, and `signatures[]` each with `public_key_prefix`.
  **A refusal is provable by absence**: schedule exists, guard prefix absent from
  `signatures[]`, `executed_timestamp` null.
- `@x402/hedera` exports `inspectHederaTransaction(base64)` →
  `{transactionType, transactionId, transactionIdAccountId, hasNonTransferOperations,
  hbarTransfers, tokenTransfers}`, plus `extractTransactionFromPayload`,
  `hederaAccountIdsEqual`, `HEDERA_TESTNET_CAIP2`.
  ⚠️ **`transactionIdAccountId` is the FEE PAYER, not the sender.** The facilitator pays gas,
  so the transaction id belongs to it. The **sender** is the account with the **negative**
  entry in `hbarTransfers`. Verified against the real TS client.

## Repo state
Branch `build/day1-foundation`, HEAD `62d8697`. **236 tests pass**, typecheck clean.
```
src/    mandate.ts review-schedule.ts replay-store.ts server.ts
        payment-gate.ts verdict-log.ts hcs14.ts evidence-links.ts
scripts/ spike-nested-key.ts demo.ts refusal.ts live-flow.ts parity-check.py
web/    evidence.html evidence.json
docs/   INVARIANTS.md
        README.md ONBOARDING.md THREAT_MODEL.md AI_USAGE.md Makefile
```
**There is no `.env`. Nothing in this repository has ever been run against the live network.**
Do not write anything that assumes live behaviour you have not observed.

🔴 **Do NOT read `src/server.ts` (892 lines) or `test/server.test.ts` (1300+ lines) in full.**
Reading large files has terminated runs on this machine. Use `rg -n` to locate, then a narrow
`sed -n 'A,Bp'`. Use `tail -60` on a big test file to copy its style.

🔴 **Do NOT run `npm test`** — it prints ~1400 lines into your context. Run only your own new
test file: `node --test --experimental-strip-types test/<yours>.test.ts`. The owner runs the
full suite.

**Run single-threaded. Do not spawn sub-agents.**

## House style — mandatory
Write in **authorization and invariant language**, not intrusion language. This is a
defensive product and its own author must be able to read it.

Use: `refusal`, `denialCase`, `unauthorizedProposal`, `mandateViolation`, `outOfPolicy`,
`reviewOutcome`, `untrustedInstruction`. Avoid in code, comments, identifiers and filenames:
"attack", "attacker", "exploit", "malicious", "rogue", "steal", "compromise", and
step-by-step descriptions of how to subvert something.

State each security property as an invariant that must hold — "INVARIANT: a proposal whose
recipient is not on the mandate allowlist must never receive a guard signature" — never as an
adversarial narrative. Name tests for the invariant they defend. Console narration in demo
scripts and prose in `README`/`ONBOARDING` may use plain language a judge understands.

## Engineering rules
1. Read a file before editing it; read the surrounding code before adding to it.
2. Verify every signature against the actual `.d.ts` or source. Never write against a
   remembered API.
3. Simplest correct solution. No premature abstraction, no speculative generality, no
   configuration for things that will not change.
4. **No placeholder code.** No `TODO`, no stubs, no `throw new Error("not implemented")`.
   If you cannot complete something, say so explicitly rather than leave it broken.
5. No bloat. Every line must trace to something the brief asked for.
6. No dead code. Delete what your change orphans.
7. Validate at boundaries (HTTP input, mandate parsing, chain responses). Trust internal
   calls. No secrets in code or committed files.
8. No `any` in TypeScript.
9. **Write the failing test first for every refusal path.** A refusal with no test is not done.
10. **Never weaken, skip or delete a test to make it pass.** If a test asserts the wrong
    thing, leave it failing and say so — red and argued beats green and wrong.

## Reporting
End with: what you built; what you verified, with the command and its result; what you could
NOT verify; and **anything in this brief that turned out to be wrong**. Be specific about the
last one — a wrong brief is the main failure mode and the owner wants to hear about it.
