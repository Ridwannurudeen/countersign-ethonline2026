# Countersign refusal invariants

Each row maps one fail-closed invariant to the mechanism that enforces it and one exact
test title in the current suite. The roadmap's eight adversarial cases are labeled
explicitly. These are offline proofs: the repository has no Hedera credentials, and none
of these controls has been exercised against the live network.

## Mandate

| Invariant | Enforcement mechanism | Exact proving test |
| --- | --- | --- |
| The mandate has exactly the reviewed fields; extra policy data cannot be smuggled into the signed object. | `parseMandateEnvelope` applies an exact field allowlist to the mandate object. | `parseMandateEnvelope rejects unknown mandate fields` |
| The transfer cap is positive. | The parser accepts minimal unsigned decimal strings and rejects `maxAmountTinybars === "0"`. | `parseMandateEnvelope rejects a zero cap` |
| At least one recipient is authorized. | The parser requires a non-empty `recipientAllowlist` array. | `parseMandateEnvelope rejects an empty recipient allowlist` |
| A recipient cannot appear twice through alternate numeric spellings. | Every numeric account ID is normalized before a set-based duplicate check. | `parseMandateEnvelope rejects duplicate recipients after normalization` |
| The owner signature must use a canonical Ed25519 scalar. | The signature parser requires canonical unpadded base64url for exactly 64 bytes, and Ed25519 verification rejects non-canonical scalars. | `verifyMandateSignature refuses a non-canonical Ed25519 signature scalar` |
| Only the configured owner's key can authenticate the mandate. | `verifyMandateSignature` verifies the domain-separated canonical mandate bytes against the supplied owner Ed25519 public key. | `verifyMandateSignature refuses a signature from a different key` |
| A new mandate names exactly one asset. | Schema v2 requires `schemaVersion: "2"` plus a discriminated `asset`: either `{ kind: "hbar" }` or `{ kind: "hts", tokenId }`. There is no schema-v2 default. | `mandate schema v2 requires an explicit asset`<br>`mandate schema v2 refuses an ambiguous asset` |
| Existing signed HBAR mandates retain their meaning. | The original exact field set remains schema v1 and its domain-separated preimage remains unchanged. Schema v1 is HBAR-only by definition; schema v2 uses domain version 2. | `canonicalMandateBytes uses the domain-separated RFC 8785 preimage`<br>`reviewSchedule approves a complete in-policy HBAR schedule` |

## Schedule envelope

| Invariant | Enforcement mechanism | Exact proving test |
| --- | --- | --- |
| The consensus result must be the ScheduleID the caller requested. | `reviewSchedule` compares the returned `ScheduleInfo.scheduleId` with the requested ScheduleID. | `reviewSchedule refuses a returned ScheduleID different from the request` |
| Only the configured agent may create the schedule. | The consensus-resolved creator account must equal `expectedAgentAccountId`. | `reviewSchedule refuses a creator other than the expected agent` |
| Only the configured agent may be the scheduled payer. | The consensus-resolved payer account must equal `expectedAgentAccountId`. | `reviewSchedule refuses a payer other than the expected agent` |
| **Roadmap — unknown treasury:** a mandate for another treasury cannot authorize this guard's treasury. | The mandate's normalized treasury ID must equal the guard-controlled treasury ID. | `reviewSchedule refuses a mandate for a different treasury` |
| **Roadmap — altered body:** the outer schedule envelope is bound to the signed mandate. | The outer schedule memo must exactly equal the recomputed mandate digest. | `reviewSchedule refuses an outer memo not bound to the mandate digest` |
| A schedule cannot retain an admin mutation authority. | `reviewSchedule` requires the consensus-resolved admin key to be absent. | `reviewSchedule refuses a mutable schedule with an admin key` |
| Execution cannot be deferred until expiry. | `reviewSchedule` requires `waitForExpiry === false`. | `reviewSchedule refuses waitForExpiry` |
| The schedule must have a concrete expiration. | Missing or invalid expiration is refused before approval. | `reviewSchedule refuses a missing expiration` |
| The schedule cannot outlive the mandate. | Its expiration is compared with the mandate's expiry and must be no later. | `reviewSchedule refuses expiration beyond mandate validity` |
| Sub-second precision cannot bypass the mandate expiry. | The full schedule timestamp, including nanoseconds, must remain within the second-granularity mandate boundary. | `reviewSchedule refuses sub-second expiration beyond mandate validity` |
| **Roadmap — expired:** an expired mandate authorizes nothing. | Review time must be strictly before `expiresAtEpochSeconds`. | `reviewSchedule refuses an expired mandate` |
| An early request authorizes nothing. | Review time must be at or after `validFromEpochSeconds`. | `reviewSchedule refuses a mandate that is not yet valid` |
| A completed schedule cannot be reviewed again as pending. | A non-null execution timestamp is refused. | `reviewSchedule refuses an already executed schedule` |
| A deleted schedule cannot be approved. | A non-null deletion timestamp is refused. | `reviewSchedule refuses a deleted schedule` |
| **Roadmap — agent-only:** the expected agent must already have signed before the guard considers completing the nested branch. | The signer list must contain the configured agent public key. | `reviewSchedule refuses when the agent signature is absent` |
| The signer list itself must be present. | A missing consensus signer collection is refused rather than interpreted as empty or valid. | `reviewSchedule refuses when the signer list is absent` |
| The guard cannot approve a schedule it has already signed. | The signer list must not contain the configured guard public key. | `reviewSchedule refuses when the guard has already signed` |
| Decoder assumptions cannot survive a protobuf network-version change. | The observed protobuf `major.minor.patch` must equal the guard's reviewed allowlist; mismatch fails closed. | `reviewSchedule refuses a protobuf network-version change` |

## Schedulable body

| Invariant | Enforcement mechanism | Exact proving test |
| --- | --- | --- |
| The schedule must expose a schedulable transaction body. | A missing `schedulableTransactionBody` is refused before transaction inspection. | `reviewSchedule refuses a missing schedulable body` |
| The body must select exactly one transaction variant. | The validator counts installed transaction oneof variants and requires the sole selected variant to be `cryptoTransfer`. | `reviewSchedule refuses multiple transaction variants` |
| **Roadmap — altered body:** the inner transaction is bound to the same signed mandate as the outer envelope. | The inner transaction memo must exactly equal the recomputed mandate digest. | `reviewSchedule refuses an inner memo not bound to the mandate digest` |
| The schedule cannot add custom-fee limits outside the reviewed model. | `maxCustomFees` must be absent or empty. | `reviewSchedule refuses maximum custom fees` |

## Transfer

| Invariant | Enforcement mechanism | Exact proving test |
| --- | --- | --- |
| **Roadmap — wrong asset:** the scheduled transfer must match the one asset named by the mandate. | HBAR mandates require an empty token list. HTS mandates require an empty HBAR list and exactly one fungible token list whose canonical token ID matches the mandate. | `reviewSchedule refuses a token transfer when the mandate says HBAR`<br>`reviewSchedule refuses an HBAR transfer when the mandate says HTS`<br>`reviewSchedule refuses a token id different from the mandate asset` |
| An HBAR transfer list must be present. | Missing `transfers` is refused rather than treated as a zero-value transfer. | `reviewSchedule refuses a missing HBAR transfer list` |
| **Roadmap — altered body:** the transfer has exactly one treasury debit and one recipient credit. | The validator requires exactly two balance adjustments. | `reviewSchedule refuses an extra balance adjustment` |
| **Roadmap — altered body:** neither required side of the transfer can be omitted. | Fewer than two balance adjustments are refused. | `reviewSchedule refuses fewer than two balance adjustments` |
| **Roadmap — altered body:** the debit and credit must conserve HBAR exactly. | Treasury debit and recipient credit must be equal and opposite. | `reviewSchedule refuses unequal balance adjustments` |
| Transfer value must be strictly positive. | The recipient credit must be positive and the treasury side must be a negative debit. | `reviewSchedule refuses a non-positive amount` |
| Account identities must be canonical numeric Hedera IDs. | The account-ID decoder rejects aliases instead of resolving or comparing them ambiguously. | `reviewSchedule refuses alias account identifiers` |
| **Roadmap — wrong recipient:** the sole recipient must be owner-authorized. | The normalized recipient account ID must occur in `recipientAllowlist`. | `reviewSchedule refuses a recipient outside the allowlist` |
| **Roadmap — over-cap:** an allowed recipient still cannot receive more than authorized. | The positive recipient adjustment must be no greater than `maxAmountTinybars`. | `reviewSchedule refuses an amount above the mandate cap` |
| HTS cannot be approved without independent custom-fee proof. | The current resolver has no consensus-resolved token fee state, so even a structurally valid HTS transfer is refused after all shape, account, flag, conservation, allowlist, and cap checks. `maxCustomFees` must also remain empty. | `reviewSchedule refuses structurally valid HTS until custom fees can be verified`<br>`reviewSchedule refuses maxCustomFees for an HTS transfer` |

## Payment

| Invariant | Enforcement mechanism | Exact proving test |
| --- | --- | --- |
| No treasury authorization signer may pay for review. | The decoded payment payer is compared with the owner, agent, and guard authorization identities before facilitator verification or settlement. | `payment gate refuses every treasury authorization signer before settlement` |
| The treasury account itself may not be the payment payer. | The decoded payer account ID is compared with the treasury account before settlement. | `payment gate refuses the treasury account as payer before settlement` |
| The treasury account may not fund review through an HTS debit. | Every negative entry in every decoded token transfer list is compared with the treasury account before settlement. | `INVARIANT: a payment whose token sender is the treasury account must be refused before settlement` |
| A valid payment payload contains no treasury authorization identity. | The narrated payer uses a separate key and account; decoded payload inspection checks that no treasury account or authorization key appears. | `invariant: the decoded payment payload contains no treasury authorization identity` |
| The 402 challenge exposes only the operational payment destination. | Payment requirements contain the operational `payTo` account and omit treasury authorization keys and operational key material. | `invariant: the challenge exposes only the operational payment account` |

## Replay

| Invariant | Enforcement mechanism | Exact proving test |
| --- | --- | --- |
| **Roadmap — replay:** a tenant nonce cannot be rebound to another mandate digest. | The SQLite primary key is `(tenant_id, nonce)`; an existing row must match both digest and ScheduleID. | `reserveMandateReview refuses the same nonce with a different digest` |
| **Roadmap — replay:** a tenant nonce cannot be rebound to another ScheduleID. | The same atomic reservation check compares the proposed ScheduleID with the stored tuple. | `reserveMandateReview refuses the same nonce with a different ScheduleID` |
| Nonces must advance monotonically within a tenant. | Before insertion, the store finds the tenant's numeric high-water mark and requires a strictly greater nonce. | `reserveMandateReview refuses a nonce below the tenant high-water mark` |
| Replay state must be durable. | Replay-store initialization rejects every supported SQLite in-memory path. | `initializeReplayStore rejects every supported in-memory database path` |

## Tenant

| Invariant | Enforcement mechanism | Exact proving test |
| --- | --- | --- |
| A mandate issued for one tenant cannot authorize a schedule handled for another tenant. | The request tenant must match the mandate tenant, and that tenant must match the guard's configured tenant before review. | `INVARIANT: a mandate issued for one tenant must never authorize a schedule bound to another tenant` |
| Nonce uniqueness and ordering are tenant-local. | The replay primary key and high-water query both include `tenant_id`, allowing the same nonce in distinct tenants without cross-tenant rebinding. | `INVARIANT: nonces must be scoped per tenant` |

## Verdict log

| Invariant | Enforcement mechanism | Exact proving test |
| --- | --- | --- |
| Tenant owner and agent private keys never enter server configuration or persisted review state. | Production configuration accepts their public keys; the replay schema stores tenant, nonce, digest, ScheduleID, outcome, and completion evidence without owner, agent, or private-key columns. Verdict records identify participants by HCS-14 identifiers rather than private keys. | `INVARIANT: tenant owner and agent private key material must never enter server configuration or persisted state` |

## Identity

| Invariant | Enforcement mechanism | Exact proving test |
| --- | --- | --- |
| Public guard discovery reveals only the guard public key and HCS-14 identifier. | Unpaid `GET /guard` returns exactly `guardPublicKey` and `guardIdentifier`; it excludes guard private material and tenant data. | `INVARIANT: the public guard identity response never contains private key material or tenant data` |

## Limits

- The guard approves a ScheduleID; it does not sign the scheduled transaction bytes.
  `ScheduleSignTransaction` contains the ScheduleID, so safety depends on resolving that
  immutable consensus object and validating every supported field before approval.
- Protobuf `ScheduleInfo` contains `ledgerId`, but the installed SDK's `ScheduleInfo`
  mapping drops it. The validator therefore cannot check `ledgerId` through that object.
- Protobuf `SemanticVersion` contains `pre` and `build`, but the installed SDK mapping
  drops them. The version gate can compare only `major.minor.patch`.
- The installed decoder cannot reveal fields unknown to its schema. That is why the
  network-version allowlist fails closed: a version change invalidates the reviewed
  decoder assumptions instead of silently approving.
- HTS transfer structure is validated, but approval remains disabled. Token custom-fee
  state is outside the current schedule-resolution context and every otherwise valid HTS
  transfer is refused until empty, immutable fees can be verified from consensus.
- These invariants are covered by the offline Node test suite, but none has been exercised against
  the live Hedera network. The repository has no Hedera credentials.
