# Live guarded HTS authorization

On 2026-09-13, the public guard at `https://countersign.gudman.xyz/countersign`
approved a frozen transfer of **10 raw units of HTS token
[0.0.10522249](https://testnet.mirrornode.hedera.com/api/v1/tokens/0.0.10522249)**.
The existing co-signer verified the guard signature on unchanged transaction bodies,
and Hedera returned `SUCCESS`. The mirror record confirms the exact token debit and credit.
The guard also refused a proposal outside the owner's recipient allowlist and returned
no countersigned bytes.

**This proves HTS in the guarded transfer path. The x402 review settlement asset
remains HBAR.** Each authorization review quoted `asset: "0.0.0"` and
`amount: "1000000"` tinybars. The HTS transfer was submitted directly through the
SDK after authorization; it was not an HTS x402 settlement. These were operator-run
testnet exercises, with an operator-created token and operator-controlled accounts.

## Run

From the repository root, with the existing `.env` and `var/hosted-caller.env`:

```powershell
$env:COUNTERSIGN_GUARD_ORIGIN = 'https://countersign.gudman.xyz'
$env:COUNTERSIGN_GUARD_UAID = 'uaid:aid:9Us31TEAEQZrKAuN9XKiaVCEHE59my6uoPfUH8aAXFVQUVz4AAxxKf4bjv8mreGAHz;uid=0;registry=countersign;proto=hcs-10;nativeId=hedera:testnet:0.0.10502369'
npm run hts-purchase
```

The script reads existing keys without writing configuration files. It verifies the
hosted treasury's `1-of[owner, 2-of[agent, guard]]` key against the mirror before
creating a token. It uses `createCosignedClientHederaSigner`, the same HBAR review
payment construction as `guarded-purchase.ts`, and that script's HBAR mirror verifier.
It never calls the hosted provisioning script or changes the schedule `/review` path.

The operator is also the configured allowed recipient. Token creation makes the
operator the token's initial treasury, associating it automatically. The guarded
treasury is then associated using the owner signature and receives the initial supply.
The token has zero decimals, initial supply `1000`, no custom fees, and no fee schedule
key. The owner-signed version-two mandate names this token, allows only the operator
recipient, and caps the transfer at `10` raw token units. The schema field
`maxAmountTinybars` carries that raw token-unit cap for HTS mandates.

The script prints public token, account, proposal, transaction and authorization-event
URLs. It checks the token adjustments on the mirror, verifies both HBAR review
settlements, and checks the refused proposal's absence after its validity window plus
30 seconds for indexing.

## Observed execution and recovery

The first execution created the token successfully, then the association returned
`INVALID_SIGNATURE`. The new submission helper had called SDK `freezeWith()` on an
already signed transaction. In installed SDK `2.85.0`, that rebuilt the signed
transactions and discarded the owner's signature. A regression test reproduced the
loss before the helper was fixed to preserve already frozen transactions.

The run then resumed with the same token, without creating another account or token:

```powershell
npm run hts-purchase -- 0.0.10522249
```

The optional token argument resumes **only after token creation and before successful
treasury association**. It is not a general replay or retry mode. Inspect the printed
transaction evidence before resuming an interrupted run. The completed evidence below
comes from the initial creation and the resumed execution together.

## Public accounts

No accounts were created or re-provisioned during this work. These existing accounts
were used:

| Role | Account |
| --- | --- |
| Operator, initial token treasury, allowed recipient | [0.0.10499022](https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.10499022?transactions=false) |
| Guarded treasury | [0.0.10502365](https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.10502365?transactions=false) |
| Agent identity | [0.0.10502367](https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.10502367?transactions=false) |
| Live guard | [0.0.10502369](https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.10502369?transactions=false) |
| HBAR review payer, HTS network fee payer, out-of-policy recipient | [0.0.10502370](https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.10502370?transactions=false) |
| HBAR review fee recipient | [0.0.10502371](https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.10502371?transactions=false) |
| Blocky402 review-settlement network fee payer | [0.0.7162784](https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.7162784?transactions=false) |

## Transaction evidence

Every `SUCCESS` below was personally observed in the mirror response during the run
or the subsequent read-only verification. The failed association was also observed on
the mirror and is retained here explicitly. The refused proposal was never submitted
by the script.

| Operation | Transaction ID and mirror URL | Observed result |
| --- | --- | --- |
| Create token `0.0.10522249` | [0.0.10499022@1789298558.003505592](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10499022-1789298558-003505592) | `SUCCESS` |
| Initial association attempt | [0.0.10499022@1789298564.781307930](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10499022-1789298564-781307930) | `INVALID_SIGNATURE` |
| Owner-authorized association after correction | [0.0.10499022@1789298650.562290644](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10499022-1789298650-562290644) | `SUCCESS` |
| Move initial HTS supply to guarded treasury | [0.0.10499022@1789298656.658027046](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10499022-1789298656-658027046) | `SUCCESS`, `1000` raw units |
| HBAR x402 settlement for approval | [0.0.7162784@1789298665.351944790](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789298665-351944790) | `SUCCESS`, `1000000` tinybars to review recipient |
| Guard's approval HCS publication | [0.0.10502369@1789298667.649669434](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10502369-1789298667-649669434) | `SUCCESS` |
| Guarded HTS transfer | [0.0.10502370@1789298664.120630881](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10502370-1789298664-120630881) | `SUCCESS`, `10` raw units |
| HBAR x402 settlement for refusal | [0.0.7162784@1789298677.691976604](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789298677-691976604) | `SUCCESS`, `1000000` tinybars to review recipient |
| Guard's refusal HCS publication | [0.0.10502369@1789298683.373907914](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10502369-1789298683-373907914) | `SUCCESS` |
| Refused HTS proposal | [0.0.10502370@1789298677.894350153](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10502370-1789298677-894350153) | Not submitted; HTTP `404` on all post-expiry checks below |

The live guard published [approval message 7](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10511981/messages/7)
and [refusal message 8](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10511981/messages/8).
Both were fetched and decoded during verification. Each binds its proposal transaction
ID, transaction digest, mandate digest and HBAR review settlement ID. The refusal names
`recipient is on the mandate allowlist` as the deciding invariant.

The observed token balances after the approved transfer were
[treasury `990`](https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.10502365/tokens?token.id=0.0.10522249)
and [recipient `10`](https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.10499022/tokens?token.id=0.0.10522249).

## Completed live output

Actual terminal excerpts from the resumed run, which exited successfully:

```text
Owner-authorized guarded treasury association receipt: SUCCESS
Initial HTS supply to guarded treasury receipt: SUCCESS
Existing client verified the guard signature on unchanged frozen HTS bodies.
Guarded HTS transfer (network fee paid by caller) receipt: SUCCESS
Verified in-policy: HTS authorization approved; x402 review settlement in HBAR.
Live guard withheld its signature: Countersign refused: recipient is on the mandate allowlist
Refused HTS proposal absence 2026-09-13T11:28:08.526Z: HTTP 404 {"_status":{"messages":[{"message":"Not found"}]}}
Refused HTS proposal absence 2026-09-13T11:28:10.198Z: HTTP 404 {"_status":{"messages":[{"message":"Not found"}]}}
Refused HTS proposal absence 2026-09-13T11:28:11.892Z: HTTP 404 {"_status":{"messages":[{"message":"Not found"}]}}
Verified out-of-policy: HTS authorization refused; x402 review settlement in HBAR.
PASS: live guarded HTS transfer and allowlist refusal verified. The x402 review settlement asset remained HBAR.
```

The complete live objective was finished within the one-hour timebox. No merge, push,
deployment or submission was performed. No required live step remains unfinished.

## Validation output

`npm run typecheck` exited successfully:

```text
> countersign@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
```

Actual final `npm test` and `python -m pytest python/ -q` output:

```text
ℹ tests 579
ℹ suites 0
ℹ pass 579
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 11440.9239
.............                                                            [100%]
13 passed in 2.74s
```

The additional tests cover preserving an owner's association signature, preserving
deserialized agent/guard signatures, exact HTS mirror adjustments, and rejecting failed,
unrelated, misdirected or inexact evidence.
