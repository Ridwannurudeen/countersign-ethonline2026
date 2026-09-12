# Countersign

Countersign resolves each proposed ScheduleID from Hedera consensus and validates every decoded field in the supported HBAR transfer and schedule envelope against an owner-signed mandate. Only an exact policy match receives the guard key; caller-supplied transaction summaries are never trusted.

The testnet treasury uses this authorization tree:

```text
1-of[
  ownerKey,
  2-of[agentKey, guardKey]
]
```

The owner can recover funds directly. The agent can publish a scheduled transfer, but the nested branch remains incomplete until the guard independently resolves that ScheduleID and approves every invariant. Hedera executes the schedule only after the authorization tree is satisfied.

## Live evidence

Countersign ran end to end on Hedera testnet on 2026-09-12. Every link below is served by
the public mirror node, so each claim is checkable without running this code. The refusal
is provable by absence: the schedule exists, the guard's key prefix is missing from
`signatures[]`, and `executed_timestamp` is null.

| | Guard approved | Guard refused |
| --- | --- | --- |
| Schedule | [`0.0.10499731`](https://testnet.mirrornode.hedera.com/api/v1/schedules/0.0.10499731) | [`0.0.10499755`](https://testnet.mirrornode.hedera.com/api/v1/schedules/0.0.10499755) |
| `executed_timestamp` | `1789212148.179991105` | `null` |
| Signer prefixes | agent **and** guard | agent only |
| Treasury delta | exactly the mandated `25000000` tinybars | unchanged |
| x402 settlement | [`0.0.7162784@1789212138.066299970`](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789212138-066299970) | [`0.0.7162784@1789212178.512467549`](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789212178-512467549) |
| HCS verdict | [topic `0.0.10499735`](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10499735/messages/1) | [topic `0.0.10499757`](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10499757/messages/1) |

The caller pays the same review price either way — a refusal is a delivered service, not a
failed request. Both settlements were completed by the Blocky402 facilitator on
`hedera:testnet`.

The table above is one representative approved/refused pair. `web/evidence.json` is
regenerated from every recorded run by `npm run build-evidence` and is the complete record.

These are **operator-run reliability exercises, not users**, and testnet payments are
**paid protocol trials, not revenue**. The manifest labels every record `operator` and
reports zero external reviews and zero distinct external payer accounts.

## Current scope

Treasury schedules remain HBAR-only. The `POST /review` boundary charges one
configured HBAR check-unit through x402 on Hedera testnet before resolving consensus
state. Production verifies that the configured single-key payment destination is
separate from the treasury, expected agent, guard operator, and their authorization
keys. The narrated flow also pays from a separately keyed account, so none of the
treasury authorization keys enters its decoded x402 payload.

**There is no public endpoint.** The guard is a service the treasury owner runs, and
`npm run demo` starts it on `127.0.0.1` for the duration of a run. One guard process
authorizes exactly one treasury: the owner, agent and guard keys, the treasury account and
the expected agent account are all fixed in its configuration and checked against consensus
at startup. It is not a multi-tenant service, and nothing in this repository was deployed to
a public host. What is live is the evidence — every payment, verdict and schedule above was
settled on Hedera testnet and is readable from the public mirror node.

The guard requires all of the following:

- The requested and returned ScheduleID are identical.
- The creator and scheduled payer are the expected agent account.
- The outer schedule memo and inner transaction memo both equal the mandate digest.
- The schedule has no admin key, does not wait for expiry, has not executed, has not been deleted, and expires no later than the mandate.
- The signer set contains the agent key and does not contain the guard key.
- The live protobuf and services `major.minor.patch` versions equal the reviewed allowlist.
- The schedulable body has exactly one transaction variant, and it is `cryptoTransfer`.
- The transaction fee is exactly `100000000` tinybars and `maxCustomFees` is empty.
- The transfer contains HBAR only and exactly two adjustments: the configured treasury debit and one allowlisted recipient credit.
- The amount is positive, equal and opposite, and no greater than the mandate cap.
- Both adjustments use canonical numeric account IDs, set `isApproval` to false, omit allowance hooks, and contain no unsupported fields from the audited schema.

## Paid review service

`createProductionReviewServer` composes the offline-tested HTTP handler with the live
Hedera adapters. A request is parsed with an exact schema, the owner mandate signature
is verified, and x402 settlement completes before the service performs consensus work.
At startup, the service resolves the treasury and agent accounts, verifies the exact
`1-of[owner, 2-of[agent, guard]]` tree, and requires the three authorization keys to be
distinct. For each review it selects one consensus node, reads that node's versions,
resolves `ScheduleInfo` from the same node, and reads the same node's versions again.
Both complete version triples must match the audited allowlist. The service then calls
the pure `reviewSchedule` validator and atomically reserves the mandate nonce. Only the
request that obtains the reservation may submit `ScheduleSignTransaction`.

Every completed authorization review, approved or refused, is published as a compact
HCS record containing the ScheduleID, mandate digest, x402 settlement ID, tenant ID,
and deterministic HCS-14 identifiers for the agent and guard. Configured verdict topics
must be immutable, submit-key protected, and free of custom fees. The HTTP response links
directly to the resulting mirror-node topic message.

The validator inspects `ScheduleInfo.schedulableTransactionBody` directly. Approval authorizes the immutable ScheduleID that the guard resolved from consensus.

## Mandates

A legacy HBAR v1 mandate has exactly these fields (no `schemaVersion` or `asset`):

| Field | Format |
| --- | --- |
| `tenantId` | ASCII `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` |
| `nonce` | Minimal unsigned decimal string |
| `treasuryAccountId` | Canonical numeric `shard.realm.num` |
| `recipientAllowlist` | Non-empty, canonically sorted numeric account IDs with no duplicates |
| `maxAmountTinybars` | Positive minimal unsigned decimal string |
| `validFromEpochSeconds` | Minimal unsigned Unix-seconds string |
| `expiresAtEpochSeconds` | Minimal unsigned Unix-seconds string greater than `validFromEpochSeconds` |

The signature is stored outside the mandate object as an unpadded base64url string encoding exactly 64 bytes. It is produced by the same Ed25519 owner key used in the treasury's direct branch.

The legacy HBAR v1 signing preimage is:

```text
UTF8("COUNTERSIGN-MANDATE") || 0x00 || UTF8("1") || 0x00 || UTF8(JCS(mandate))
```

Schema v2 requires all the fields above plus `schemaVersion: "2"` and an explicit
`asset`. Use `{ "kind": "hbar" }` for HBAR or
`{ "kind": "hts", "tokenId": "0.0.7001" }` for one fungible HTS token. The token
ID is normalized to numeric `shard.realm.num`; there is no default asset in v2.
The retained `maxAmountTinybars` field caps tinybars for HBAR and the token's smallest
integer units for HTS. Both additional fields are included in the canonical object.
The v2 signing preimage uses domain version `"2"`:

```text
UTF8("COUNTERSIGN-MANDATE") || 0x00 || UTF8("2") || 0x00 || UTF8(JCS(mandate))
```

**HTS approval is currently disabled.** Every token proposal is refused: invalid
proposals fail their relevant invariant, and every otherwise valid HTS proposal
is refused at the custom-fee check because consensus token fee state is not verified.
Parsing and signing an HTS mandate does not enable token approval.

`JCS` is RFC 8785 JSON Canonicalization Scheme via the pinned `json-canonicalize@3.0.0` package. `mandateDigest` is the lowercase SHA-256 hex digest of that complete domain-separated preimage. The digest is 64 ASCII characters, so it fits Hedera's 100-byte memo limit.

Mandates are single-use per tenant. Before approval, the guard atomically reserves
`(tenantId, nonce, mandateDigest, scheduleId)` in the file-backed
`var/countersign.sqlite`; in-memory databases are refused. A nonce must exceed the
tenant's prior high-water mark. An identical completed retry returns the stored
approved response before pending-only schedule validation. An identical pending retry,
or the same nonce bound to another digest or ScheduleID, is refused. SQLite lock
contention is bounded and returns retryable HTTP 503.

## Run the offline proof

```bash
npm ci --omit=peer
npm run typecheck
npm test
```

The lockfile keeps the required direct SDK and x402 pins plus reviewed transitive security
overrides. Omitting peer packages keeps the React Native peer tree out of this Node.js
service. A production install and audit use:

```bash
npm ci --omit=dev --omit=peer
npm audit --omit=dev --omit=peer
```

The test suite uses no network access. It covers mandate parsing and signatures, replay
reservation, every schedule-envelope invariant, all 49 transaction variants through an
exact `cryptoTransfer` oneof check, HBAR-only transfer structure, both approval and hook
fields, numeric IDs, amount policy, same-node before/after network-version gates,
strict HTTP boundaries, real worker-thread replay contention, decoded x402 payment
identity separation, HCS-14 known answers, and HCS verdict records.

## Run the narrated testnet flows

Copy `.env.example` to `.env` and fill in the funded Hedera testnet operator and
both reviewed network versions. The scripts validate all four values before they
create a client, so a missing value fails immediately by name without submitting a
network request.

On Windows, run the Make targets from WSL with Node.js and GNU Make installed, or
from Git Bash after installing GNU Make. PowerShell does not include `make` by
default. The direct npm commands shown below are equivalent on every supported
shell.

Run the allowed path first:

```bash
make demo
# Equivalent: npm run demo
```

The command creates fresh owner, agent, guard, and payment-payer keys plus treasury,
agent, guard, and payment-payer accounts; prints the owner-signed mandate; publishes an in-policy schedule; and waits
for the mirror node to show it unexecuted with only the agent signature. It then
shows the HTTP 402 challenge and exact HBAR price, pays through the live x402
facilitator, and sends the paid request to the guard. The output lists
the consensus fields evaluated by `reviewSchedule`, then prints guard-approval status,
the execution timestamp, mirror evidence with signer key prefixes, the exact treasury
balance delta, the HCS verdict link, and schedule and account evidence links.

Then run the refused path:

```bash
make attack
# Equivalent: npm run refusal
```

This command builds the same authorization topology but proposes a transfer to the
separately keyed payment-payer account, which is outside the mandate allowlist. It
still pays for the review. The final checks require the mirror schedule to have a
null `executed_timestamp`, `deleted: false`, the agent's `public_key_prefix`, and no
guard `public_key_prefix`. The command also proves the treasury balance is unchanged
and prints the refused HCS verdict evidence link.

Every run creates real testnet accounts and submits real transactions. Neither path
has a simulated fallback. Whether the narrated review succeeds or fails, cleanup runs
before the clients close and uses each created account's key to return its remaining
HBAR to the funded operator; the operator pays those cleanup transaction fees. Cleanup
failures are reported separately without replacing the original failure. Every touched schedule is printed as
`https://testnet.mirrornode.hedera.com/api/v1/schedules/{id}`; account evidence uses
the matching `/accounts/{id}` endpoint.

## Run the Hedera testnet spike

Copy `.env.example` to `.env` and provide a funded testnet operator. Keep `.env` uncommitted.

On the first credentialed run, leave the two version variables empty:

```bash
npm run spike
# Equivalent: make spike
```

The script queries and prints the live HAPI protobuf and services versions before creating accounts. Record those exact values in `.env`, review them against the installed schema, then rerun `npm run spike`.

The complete run:

1. Generates Ed25519 owner, agent, and guard keys and creates the nested-key treasury plus funded agent and guard accounts.
2. Queries `AccountInfo` and verifies the stored authorization tree.
3. Publishes an in-policy HBAR schedule from the agent, prints its mirror-node URL, and proves agent-only authorization did not execute it.
4. Runs the production mandate and schedule validators, submits `ScheduleSign` from the guard account, proves `executed` is present, and checks the exact treasury balance delta.
5. Publishes a recipient-mismatch schedule, prints its mirror-node URL, refuses it without adding the guard key, and proves it remains unexecuted.
6. In `finally`, uses each created account's key to return its complete remaining balance to the operator before closing the clients.

The spike creates testnet accounts and submits real testnet transactions. Each printed mirror-node URL is an independent evidence surface for execution state and signer prefixes.

## Repository layout

```text
src/mandate.ts          Mandate parsing, canonicalization, signature verification, digest
src/review-schedule.ts  Pure fail-closed schedule review
src/evidence-links.ts   Mirror-node links and independently checkable schedule evidence
src/replay-store.ts     Durable single-use nonce reservation
src/payment-gate.ts     Up-front Hedera x402 review payment
src/hcs14.ts            Deterministic HCS-14 AID generation
src/verdict-log.ts      Immutable HCS verdict topic and record submission
src/server.ts           Offline-testable HTTP handler and production adapter composition
scripts/demo.ts         Allowed narrated testnet flow
scripts/refusal.ts      Refused narrated testnet flow
scripts/live-flow.ts    Shared production flow orchestration
scripts/spike-nested-key.ts
test/
var/                    Runtime SQLite data; ignored by git
```
