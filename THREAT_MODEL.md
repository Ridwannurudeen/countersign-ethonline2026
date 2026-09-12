# Countersign security invariants

This document covers the HBAR schedule validator, its explicit HTS refusal boundary,
the frozen-transfer countersign core, paid review service, and credentialed testnet spike.
Approval depends on an owner-signed mandate and guard-controlled policy. Schedule
approval also requires a schedule independently resolved from Hedera consensus.

## Trust boundaries

Trusted inputs and authorities:

- The owner's Ed25519 key is trusted to authorize the mandate. The mandate is not
  trusted until its exact schema has been parsed and its signature has been verified
  over the domain-separated canonical bytes.
- The guard's own key and its custody are trusted. The guard account pays for consensus
  queries and signs HCS verdict submissions. A refusal never submits
  `ScheduleSignTransaction` and never adds the guard key to the schedule.
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
| Crypto transfer | **INVARIANT:** A legacy schema-v1 mandate authorizes HBAR only. Schema v2 names exactly one asset. An HBAR mandate permits one HBAR transfer list and no token list; an HTS mandate permits one matching fungible-token list and no HBAR movements. | `parseMandateEnvelope` accepts the original field set as schema v1 and requires both `schemaVersion: "2"` and a discriminated `asset` for schema v2. `reviewSchedule` selects one transfer path from that signed asset and rejects mixed or mismatched lists. | `mandate schema v2 requires an explicit asset`<br>`reviewSchedule accepts an explicit schema-v2 HBAR mandate`<br>`reviewSchedule refuses a token id different from the mandate asset`<br>`reviewSchedule refuses a token transfer when the mandate says HBAR`<br>`reviewSchedule refuses both HBAR and token transfer lists populated` |
| HTS custom fees | **INVARIANT:** A structurally valid HTS transfer never receives the guard signature until the token's consensus-resolved custom-fee state is proven empty and immutable. | The current schedule resolver does not obtain `TokenInfo.customFees` or `TokenInfo.feeScheduleKey`, so the validator fails closed after all transfer-shape checks. `maxCustomFees` remains required to be empty for every asset. | `reviewSchedule refuses maxCustomFees for an HTS transfer`<br>`reviewSchedule refuses structurally valid HTS until custom fees can be verified` |
| Balance adjustments | **INVARIANT:** The selected fungible transfer has exactly two adjustments: one negative debit from the configured treasury and one positive credit to an allowlisted recipient. The amounts are equal and opposite, and the credit does not exceed the mandate cap. | The validator requires two parsed adjustments, locates the treasury by configured account ID, treats the other entry as the sole recipient, checks signs and zero-sum equality, and applies the mandate allowlist and cap before either HBAR approval or the final HTS custom-fee refusal. | `reviewSchedule refuses an extra balance adjustment`<br>`reviewSchedule refuses a third token balance adjustment`<br>`reviewSchedule refuses a treasury adjustment that is not the debit`<br>`reviewSchedule refuses a token recipient outside the allowlist`<br>`reviewSchedule refuses an over-cap token amount`<br>`reviewSchedule refuses a non-positive amount`<br>`reviewSchedule refuses unequal balance adjustments` |
| Per-adjustment flags | **INVARIANT:** Every adjustment contains only audited fields, uses a numeric account ID without an alias or additional decoded fields, has a valid integer amount, sets `isApproval` to `false`, and omits both allowance-hook fields. | Per-object field allowlists reject additional decoded adjustment and account-ID fields. `numericAccountId` requires non-negative shard, realm, and account numbers and rejects aliases. The amount parser requires an integer representation; explicit checks require `isApproval === false` and absent hooks. | `reviewSchedule refuses isApproval on adjustment 1`<br>`reviewSchedule refuses isApproval on adjustment 2`<br>`reviewSchedule refuses preTxAllowanceHook`<br>`reviewSchedule refuses prePostTxAllowanceHook`<br>`reviewSchedule refuses alias account identifiers`<br>`reviewSchedule refuses additional account-identifier fields`<br>`reviewSchedule refuses additional balance-adjustment fields` |
| Network schema version gate | **INVARIANT:** Review proceeds only when both the network protobuf and services `major.minor.patch` triples exactly equal the guard's reviewed allowlist immediately before and after the schedule read. | Production selects one consensus node, pins both version queries and the intervening `ScheduleInfoQuery` to that node with `setNodeAccountIds`, and performs the three reads sequentially. `formatVersion` accepts only non-negative safe-integer components, and any before/after mismatch is refused. | `reviewSchedule refuses a protobuf network-version change`<br>`reviewSchedule refuses a services network-version change`<br>`production schedule resolution pins both version reads and the schedule read to one node` |
| Treasury topology | **INVARIANT:** Production starts only when the configured treasury has exactly `1-of[owner, 2-of[agent, guard]]`, the configured agent account has the agent key, and all three authorization keys are distinct. | Startup resolves the treasury and agent accounts from consensus, validates the exact nested thresholds and memberships, binds the agent account ID to its single key, and checks pairwise key inequality. | `production server requires pairwise-distinct authorization keys`<br>`production server requires the exact nested treasury authorization tree`<br>`production server binds the configured agent account to the agent key` |
| Paid review boundary | **INVARIANT:** Malformed requests and invalid mandates never reach payment; unpaid requests never reach consensus; configured payment identities do not intersect the treasury, expected agent, guard operator, or their authorization keys in HBAR or token debits. | The server parses an exact request schema and verifies the owner signature before x402. The x402 gate settles up front only after inspecting the transaction fee payer, every negative HBAR and token transfer, and every signature. Production startup resolves the payment destination account from consensus and verifies its single key and account ID are separate. | `POST /review rejects unknown top-level fields before payment`<br>`POST /review rejects an invalid mandate signature before payment`<br>`POST /review returns the payment challenge without resolving consensus`<br>`production server verifies the operational payment account key from consensus`<br>`INVARIANT: a payment whose token sender is the treasury account must be refused before settlement` |
| Replay ownership | **INVARIANT:** Exactly the request that atomically reserves a new mandate tuple may submit schedule approval. | A file-backed SQLite database uses `BEGIN IMMEDIATE`, a primary key, and a bounded busy timeout. A new reservation returns `reserved`; contention returns retryable HTTP 503; identical completed tuples replay their stored approved response before pending-only schedule validation. | `concurrent workers reserve one tuple exactly once`<br>`write contention waits for a bounded interval and returns a retryable error`<br>`POST /review returns a retryable response for replay-store contention`<br>`POST /review replays a completed approval before pending schedule validation` |
| Verdict evidence | **INVARIANT:** Every completed authorization review publishes an approved/refused record to the configured HCS topic before the service returns a successful response. | HCS records bind the review outcome, ScheduleID, mandate digest, settlement ID, tenant, and both HCS-14 participant identifiers. Configured topics must be immutable, submit-key protected, and fee-free. | `VerdictLog records an approved review and returns its mirror-node URL`<br>`VerdictLog records a refused review as evidence`<br>`validateVerdictTopicInfo refuses a topic with an admin key` |

## Residual limitations

The frozen-transfer core permits a schema-v2 HTS mandate only after validating the
exact signed bytes and querying the mandate's token with `TokenInfoQuery` during
that review. The guard controls the injected query service; caller-supplied token
metadata cannot authorize a transfer. The returned token ID must match the mandate.
`HTS custom fee list is empty` requires `TokenInfo.customFees.length === 0`;
`HTS fee schedule is immutable` requires `TokenInfo.feeScheduleKey === null`.
Missing or failed lookups refuse authorization. Every review reads again, without
caching. The mandate cap applies to token base units; the existing
`maxAmountTinybars` field name is retained. Token approval retains the same byte
re-encode equality, fixed HBAR transaction fee, validity, signature, allowlist,
balanced treasury debit, and transfer-field checks as HBAR approval.

- Token fee state is read at review time, while the transfer executes seconds later.
  This leaves a narrow time-of-check-to-time-of-use window. A token whose fee schedule
  is immutable cannot change that schedule, but the guard's guarantee for any token
  is **"as read at review time"**. The guard does not read token state atomically with
  execution or attest to its state at execution. This is testnet authorization only;
  no live USDC purchase or mainnet behavior is established by the offline tests.
- On the `/review` schedule path, the guard approves a ScheduleID; it does not sign
  the scheduled body bytes.
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
  version triples are checked on one node before and after the schedule read and any
  triple mismatch fails closed. This is node-local provenance; it does not prove that
  every node in the network is running the same software.
- On `/review`, schema v2 can name one HTS token and the validator checks its decoded
  fungible-transfer structure, but HTS schedule approval remains disabled. The schedule
  resolver does not yet bind the review to consensus-resolved `TokenInfo.customFees`
  and `TokenInfo.feeScheduleKey`; without proof
  that fees are empty and immutable, token custom fees could introduce additional value
  movements outside the scheduled transfer list.
- The outer `1-of` treasury key has a direct owner branch. The owner key alone can
  always move funds; this is deliberate recovery authority. The guard constrains the
  agent branch, not the owner branch.
- Schedule approval and HCS publication are separate consensus operations. A process
  exit after schedule approval but before HCS submission can leave an approved schedule
  without its verdict record. The handler returns no successful review response when
  HCS publication fails, but durable outbox reconciliation is not implemented.
- The x402 fee is a non-refundable review attempt. Settlement occurs before consensus
  resolution, replay-store access, schedule approval, completion persistence, and HCS
  publication. Failure in any later step can therefore return an error after the fee
  has settled; refund and retry-credit handling are not implemented.
- A process exit after nonce reservation can leave the exact tuple permanently pending.
  There is no automatic lease expiry. Recovery requires stopping the guard, reconciling
  the ScheduleID and HCS topic against consensus, and backing up the replay database. If
  neither a guard approval nor a verdict exists, the operator deletes only that exact
  pending row before restarting. If approval or a verdict exists, the operator must first
  publish any missing verdict and populate that row's completed response fields from the
  verified consensus records. No automated recovery command or durable outbox exists.
- An identical completed retry is recognized before pending-only schedule validation
  and returns the stored approved outcome, original settlement ID, and original verdict
  link without publishing refusal evidence. Because x402 settlement precedes this
  lookup, the retry itself is another non-refundable review attempt.
- Production verifies the treasury topology and agent-account binding at startup, not
  before every review. A key change after startup is not detected until the service is
  restarted.
- SQLite contention waits up to 100 milliseconds and then returns retryable HTTP 503.
  This bounds lock waiting but does not provide high availability across a database or
  filesystem outage.
- The required direct pins remain `@hiero-ledger/sdk@2.85.0`, `@x402/core@2.25.0`, and
  `@x402/hedera@2.25.0`. Exact-version overrides select `@grpc/grpc-js@1.12.7`,
  `protobufjs@8.6.6` for both the SDK and proto runtime, and `ws@8.21.3` under
  `ethers`; the first two match the dependency versions published by SDK 2.87.0.
  Production must install with `npm ci --omit=dev --omit=peer` so the unused React Native
  peer tree is not present, and `npm audit --omit=dev --omit=peer` must remain clean.
  Any override change requires the full invariant suite and network-version review again.
