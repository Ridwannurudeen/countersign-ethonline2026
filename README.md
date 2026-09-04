# Countersign

Countersign resolves each proposed ScheduleID from Hedera consensus and validates the complete stored HBAR transfer and schedule envelope against an owner-signed mandate. Only an exact policy match receives the guard key; caller-supplied transaction summaries are never trusted.

The testnet treasury uses this authorization tree:

```text
1-of[
  ownerKey,
  2-of[agentKey, guardKey]
]
```

The owner can recover funds directly. The agent can publish a scheduled transfer, but the nested branch remains incomplete until the guard independently resolves that ScheduleID and approves every invariant. Hedera executes the schedule only after the authorization tree is satisfied.

## Day-1 scope

Day 1 supports HBAR transfers only. HTS transfers and x402 are intentionally deferred.

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

The validator inspects `ScheduleInfo.schedulableTransactionBody` directly. Approval authorizes the immutable ScheduleID that the guard resolved from consensus.

## Mandates

A mandate has exactly these fields:

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

The signing preimage is:

```text
UTF8("COUNTERSIGN-MANDATE") || 0x00 || UTF8("1") || 0x00 || UTF8(JCS(mandate))
```

`JCS` is RFC 8785 JSON Canonicalization Scheme via the pinned `json-canonicalize@3.0.0` package. `mandateDigest` is the lowercase SHA-256 hex digest of that complete domain-separated preimage. The digest is 64 ASCII characters, so it fits Hedera's 100-byte memo limit.

Mandates are single-use per tenant. Before approval, the guard atomically reserves `(tenantId, nonce, mandateDigest, scheduleId)` in `var/countersign.sqlite`. A nonce must exceed the tenant's prior high-water mark. An identical retry returns the stored state; the same nonce bound to another digest or ScheduleID is refused.

## Run the offline proof

```bash
npm install
npm run typecheck
npm test
```

The test suite uses no network access. It covers mandate parsing and signatures, replay reservation, every schedule-envelope invariant, all 49 transaction variants through an exact `cryptoTransfer` oneof check, HBAR-only transfer structure, both approval and hook fields, numeric IDs, amount policy, and both network-version gates.

## Run the Hedera testnet spike

Copy `.env.example` to `.env` and provide a funded testnet operator. Keep `.env` uncommitted.

On the first credentialed run, leave the two version variables empty:

```bash
npm run spike
```

The script queries and prints the live HAPI protobuf and services versions before creating accounts. Record those exact values in `.env`, review them against the installed schema, then rerun `npm run spike`.

The complete run:

1. Generates Ed25519 owner, agent, and guard keys and creates the nested-key treasury plus funded agent and guard accounts.
2. Queries `AccountInfo` and verifies the stored authorization tree.
3. Publishes an in-policy HBAR schedule from the agent, prints its mirror-node URL, and proves agent-only authorization did not execute it.
4. Runs the production mandate and schedule validators, atomically reserves the nonce, submits `ScheduleSign` from the guard account, proves `executed` is present, and checks the exact treasury balance delta.
5. Publishes a recipient-mismatch schedule, prints its mirror-node URL, refuses it without adding the guard key, and proves it remains unexecuted.
6. Uses the owner branch in one direct transfer to return the treasury's complete remaining balance to the operator and verifies the delta.

The spike creates testnet accounts and submits real testnet transactions. Each printed mirror-node URL is an independent evidence surface for execution state and signer prefixes.

## Repository layout

```text
src/mandate.ts          Mandate parsing, canonicalization, signature verification, digest
src/review-schedule.ts  Pure fail-closed schedule review
src/replay-store.ts     Durable single-use nonce reservation
scripts/spike-nested-key.ts
test/
var/                    Runtime SQLite data; ignored by git
```
