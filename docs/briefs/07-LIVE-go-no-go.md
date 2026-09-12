# 07 — The live go/no-go 🔴 THE MOST IMPORTANT ITEM IN THIS FOLDER

**This one is yours to run, not Codex's** — it needs credentials and it spends real testnet
HBAR. Read it before running anything.

## Why it outranks every other brief
Your roadmap's Day-1 gate is:
> *prove the nested-key schedule executes after the guard signature. If not, all ambition
> stays off.*

**That has never happened.** 236 tests prove the logic offline; **nothing has ever touched
Hedera.** Until this passes, T0 is code, not proof — and T1's evidence page, T2's manifest
and replay view are all *about* real on-chain activity. Building more on top of an unproven
foundation is the main risk left in this project.

## Step 1 — credentials
portal.hedera.com → Testnet → copy into `.env` at the repo root:
```
HEDERA_OPERATOR_ACCOUNT_ID=0.0.xxxxx
HEDERA_OPERATOR_PRIVATE_KEY=302e0201...          # the DER Encoded Private Key string
COUNTERSIGN_ALLOWED_PROTOBUF_VERSION=            # leave blank on the first run
COUNTERSIGN_ALLOWED_SERVICES_VERSION=            # leave blank on the first run
```
Either key type works — I verified `PrivateKey.fromStringDer` parses **both ED25519 and
ECDSA** with the type preserved, so the portal's default is fine.

`.env` is gitignored. Never commit it.

## Step 2 — two-phase version pin
```bash
npm run spike
```
With the two version variables blank, the spike **queries the live HAPI/services versions,
prints them, and stops before creating anything**. Copy the printed values into the two
`COUNTERSIGN_ALLOWED_*` variables, then run `npm run spike` again for the full proof.

This exists because the guard's field-completeness claim is only honest for a schema it has
audited — the decoder cannot reveal fields unknown to `@hiero-ledger/proto` 2.31.0, so the
validator refuses after a network version change rather than guessing.

## Step 3 — what the full run must prove, in order
1. The treasury stores exactly `1-of[ owner, 2-of[ agent, guard ] ]`.
2. An **agent-only** transfer is rejected by the network.
3. An agent-created schedule exists on the mirror node, **unexecuted**.
4. The guard's review approves, `ScheduleSign` is submitted, and `executed !== null`.
5. The treasury balance moved by exactly the expected amount.
6. An **out-of-policy** schedule is refused: no guard signature, `executed === null`.
7. The **owner-only recovery** branch executes a direct transfer.

**Step 4 is the gate.** If the nested-key schedule does not execute after the guard
signature, stop and report — the roadmap says all ambition stays off until it does.

## Cost and safety
About **27 HBAR per run** (20 treasury / 5 agent / 2 guard) plus fees. A 1000-HBAR faucet
account survives 30+ runs. Temporary accounts are recovered in a `finally` block — that was a
review finding; before it was fixed, any failure after funding stranded every balance with
the keys gone at process exit.

## Step 4 — then the two narrated flows
```bash
npm run demo      # or: make demo    — the allowed path
npm run refusal   # or: make attack  — the refused path
```
Each prints a mirror-node URL at every on-chain step so the outcome is checkable without
running anything.

## Step 5 — after it passes, tell Codex
Several things were written but never exercised. Once you have real ScheduleIDs, a Codex
brief should:
- Record the live HAPI/services versions in `.env.example` as the audited defaults.
- Populate `web/evidence.json` from the real run via the brief-05 manifest, **labelled
  `operator`** — these are operator reliability runs, not users.
- Update `ONBOARDING.md`, which currently states honestly that nothing has been run live.
  That sentence must be replaced with what actually happened, not quietly deleted.
- Add the mirror-node links to `README.md` as the first real evidence.

## What to expect to break first
From the Day-1 review, in priority order:
1. Consensus-returned default-field presence may differ from the synthetic test fixtures —
   the validator is strict, so a refusal here is a **fixture** problem, not a chain problem.
2. Blocky402's real settlement flow versus the permissive offline substitute in tests.
3. Mirror-node indexing lag — evidence retries only 404; a 429/5xx or an indexed-but-
   incomplete signer list aborts the flow.
4. HCS topic creation, submission and indexing.

None of these mean the design is wrong. Report the exact error and hand it to Codex with the
failing output — that is a much better brief than a guess.
