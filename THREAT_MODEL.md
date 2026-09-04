# Countersign security invariants

This document covers the HBAR schedule validator, paid review service, and credentialed
testnet spike. Approval depends on an owner-signed mandate, guard-controlled policy, and
a schedule independently resolved from Hedera consensus.

## Trust boundaries

Trusted inputs and authorities:

- The owner's Ed25519 key is trusted to authorize the mandate. The mandate is not
  trusted until its exact schema has been parsed and its signature has been verified
  over the domain-separated canonical bytes.
- The guard's own key and its custody are trusted. The guard uses that key only after
  the review outcome is approved.
- Consensus-resolved `ScheduleInfo` and network-version results obtained by the
  guard's own Hedera queries are trusted as the source of schedule state. A caller's
  representation of either result is not equivalent.
- The expected agent account and key, treasury account, fixed transaction fee,
  review time, and allowed network versions are guard-controlled policy. The current
  spike constructs this context locally; callers must not control it.

Inputs that are never trusted on their own:

- Anything supplied by a caller, including a ScheduleID, mandate envelope, transaction
  summary, claimed recipient, claimed amount, signer summary, or claimed network
  version. A ScheduleID is only a locator for the guard's own query.
- The agent key. Its presence proves that the expected agent proposed the schedule;
  it cannot complete the nested treasury branch without the guard key.
- Instructions reaching the agent from any external source. They do not replace the
  owner-signed mandate or any validator invariant.

## Invariant table

| Layer | Invariant | Enforcement mechanism | Tests |
| --- | --- | --- | --- |
| Schedule envelope | **INVARIANT:** The guard reviews the requested, pending schedule with no admin key, created and paid for by the expected agent. The schedule and mandate are bound to the configured treasury and mandate digest, the mandate is currently valid, the schedule expires no later than the mandate, the agent key is present, and the guard key is absent. | `reviewSchedule` compares the returned and requested ScheduleIDs; checks creator, payer, and mandate treasury; recomputes the mandate digest for the schedule memo; requires no admin key, `waitForExpiry === false`, and no execution or deletion timestamp; validates the mandate and schedule times; and checks the signer set. | `reviewSchedule refuses a returned ScheduleID different from the request`<br>`reviewSchedule refuses a creator other than the expected agent`<br>`reviewSchedule refuses a payer other than the expected agent`<br>`reviewSchedule refuses a mandate for a different treasury`<br>`reviewSchedule refuses an outer memo not bound to the mandate digest`<br>`reviewSchedule refuses a mutable schedule with an admin key`<br>`reviewSchedule refuses waitForExpiry`<br>`reviewSchedule refuses a missing expiration`<br>`reviewSchedule refuses expiration beyond mandate validity`<br>`reviewSchedule refuses sub-second expiration beyond mandate validity`<br>`reviewSchedule refuses an expired mandate`<br>`reviewSchedule refuses a mandate that is not yet valid`<br>`reviewSchedule refuses an already executed schedule`<br>`reviewSchedule refuses a deleted schedule`<br>`reviewSchedule refuses when the agent signature is absent`<br>`reviewSchedule refuses when the signer list is absent`<br>`reviewSchedule refuses when the guard has already signed` |
| Schedulable body | **INVARIANT:** The schedulable body contains only fields audited by this validator, exactly one transaction variant, and that variant is `cryptoTransfer`; its fee equals the fixed protocol fee, its memo equals the mandate digest, and `maxCustomFees` is empty. | An allowlist rejects additional decoded body fields. The complete installed set of schedulable variants is counted and compared with `cryptoTransfer`. The fee, inner memo, and custom-fee limit list are then checked exactly. | `reviewSchedule approves the installed protobuf decoder representation`<br>`reviewSchedule refuses a missing schedulable body`<br>`reviewSchedule refuses the contractCall transaction variant` (the same generated test covers every non-`cryptoTransfer` variant)<br>`reviewSchedule refuses multiple transaction variants`<br>`reviewSchedule refuses a transaction fee different from the protocol value`<br>`reviewSchedule refuses an inner memo not bound to the mandate digest`<br>`reviewSchedule refuses maximum custom fees`<br>`reviewSchedule refuses additional schedulable-body fields` |
| Crypto transfer | **INVARIANT:** The transaction contains one HBAR transfer list, no token transfer lists, and no additional decoded fields in either the crypto-transfer body or HBAR transfer list. | The crypto-transfer field allowlist permits only `transfers` and `tokenTransfers`; `tokenTransfers` must be empty. The HBAR list must exist, and its field allowlist permits only `accountAmounts`. | `reviewSchedule refuses a missing HBAR transfer list`<br>`reviewSchedule refuses token transfers`<br>`reviewSchedule refuses additional crypto-transfer fields`<br>`reviewSchedule refuses additional transfer-list fields` |
| Balance adjustments | **INVARIANT:** The HBAR transfer has exactly two adjustments: one negative debit from the configured treasury and one positive credit to an allowlisted recipient. The amounts are equal and opposite, and the credit does not exceed the mandate cap. | The validator requires two parsed adjustments, locates the treasury by configured account ID, treats the other entry as the sole recipient, checks signs and zero-sum equality, and applies the mandate allowlist and cap. | `reviewSchedule refuses an extra balance adjustment`<br>`reviewSchedule refuses fewer than two balance adjustments`<br>`reviewSchedule refuses a treasury adjustment that is not the debit`<br>`reviewSchedule refuses a recipient outside the allowlist`<br>`reviewSchedule refuses an amount above the mandate cap`<br>`reviewSchedule refuses a non-positive amount`<br>`reviewSchedule refuses unequal balance adjustments` |
| Per-adjustment flags | **INVARIANT:** Every adjustment contains only audited fields, uses a numeric account ID without an alias or additional decoded fields, has a valid integer amount, sets `isApproval` to `false`, and omits both allowance-hook fields. | Per-object field allowlists reject additional decoded adjustment and account-ID fields. `numericAccountId` requires non-negative shard, realm, and account numbers and rejects aliases. The amount parser requires an integer representation; explicit checks require `isApproval === false` and absent hooks. | `reviewSchedule refuses isApproval on adjustment 1`<br>`reviewSchedule refuses isApproval on adjustment 2`<br>`reviewSchedule refuses preTxAllowanceHook`<br>`reviewSchedule refuses prePostTxAllowanceHook`<br>`reviewSchedule refuses alias account identifiers`<br>`reviewSchedule refuses additional account-identifier fields`<br>`reviewSchedule refuses additional balance-adjustment fields` |
| Network schema version gate | **INVARIANT:** Review proceeds only when both the network protobuf and services `major.minor.patch` triples exactly equal the guard's reviewed allowlist. Any mismatch fails closed before schedule validation. | `formatVersion` accepts only non-negative safe-integer components. `reviewSchedule` compares the formatted protobuf and services versions with their independently configured allowed strings before reading the schedule envelope. | `reviewSchedule refuses a protobuf network-version change`<br>`reviewSchedule refuses a services network-version change` |
| Paid review boundary | **INVARIANT:** Malformed requests and invalid mandates never reach payment; unpaid requests never reach consensus; paid review uses an operational key outside the treasury authorization tree. | The server parses an exact request schema and verifies the owner signature before x402. The x402 gate settles up front, and production startup resolves the operational account from consensus and verifies its single key is distinct. | `POST /review rejects unknown top-level fields before payment`<br>`POST /review rejects an invalid mandate signature before payment`<br>`POST /review returns the payment challenge without resolving consensus`<br>`production server verifies the operational payment account key from consensus` |
| Replay ownership | **INVARIANT:** Exactly the request that atomically reserves a new mandate tuple may submit schedule approval. | A new reservation returns `reserved`. Identical pending retries and conflicting/high-water-mark nonces are refused without submission. | `POST /review refuses a pending retry without submitting approval`<br>`POST /review records a replay refusal without submitting approval` |
| Verdict evidence | **INVARIANT:** Every completed authorization review publishes an approved/refused record to the configured HCS topic before the service returns a successful response. | HCS records bind the review outcome, ScheduleID, mandate digest, settlement ID, tenant, and both HCS-14 participant identifiers. Configured topics must be immutable, submit-key protected, and fee-free. | `VerdictLog records an approved review and returns its mirror-node URL`<br>`VerdictLog records a refused review as evidence`<br>`validateVerdictTopicInfo refuses a topic with an admin key` |

## Residual limitations

- The guard approves a ScheduleID; it does not sign the scheduled body bytes.
  `ScheduleSignTransaction` builds a `scheduleSign` operation containing only the
  ScheduleID. Safety therefore depends on independently resolving and completely
  validating the consensus schedule before submitting that approval.
- The protobuf `ScheduleInfo` message contains `ledgerId`, but the installed SDK's
  `ScheduleInfo` mapping does not retain or expose it. This validator cannot validate
  `ledgerId` through `ScheduleInfo`.
- The protobuf `SemanticVersion` message contains `pre` and `build`, but the installed
  SDK's `SemanticVersion` retains only `major`, `minor`, and `patch`. The version gate
  can compare only that triple.
- The installed `@hiero-ledger/proto` 2.31.0 decoder skips fields it does not know, so
  such fields cannot be recovered from the decoded body. This is why both network
  version triples are gated and any triple mismatch fails closed.
- The validator supports HBAR only. Token transfers are refused and token custom fees,
  which can introduce additional value movements, are outside the validated model.
- The outer `1-of` treasury key has a direct owner branch. The owner key alone can
  always move funds; this is deliberate recovery authority. The guard constrains the
  agent branch, not the owner branch.
- Schedule approval and HCS publication are separate consensus operations. A process
  exit after schedule approval but before HCS submission can leave an approved schedule
  without its verdict record. The handler returns no successful review response when
  HCS publication fails, but durable outbox reconciliation is not implemented.
- The required `@hiero-ledger/sdk@2.85.0` alignment currently resolves transitive
  packages in published high-severity advisory ranges. This build must not be deployed
  until a compatible dependency set or verified override resolves those advisories.
