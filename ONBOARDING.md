# Countersign onboarding

This is a Hedera **testnet-only** walkthrough. It creates real testnet accounts,
submits real testnet transactions, and pays testnet fees. It does not support mainnet.

> **Live-status disclosure:** these steps were executed end to end against Hedera testnet
> on 2026-09-12. `npm run spike`, `npm run demo` and `npm run refusal` all completed, and
> every outcome below is checkable on the mirror node without running this code:
>
> | Run | ScheduleID | Mirror-node evidence |
> | --- | --- | --- |
> | Guard approved, schedule executed | `0.0.10499731` | [schedules/0.0.10499731](https://testnet.mirrornode.hedera.com/api/v1/schedules/0.0.10499731) — `executed_timestamp` set, two signer prefixes |
> | Guard refused, schedule never executed | `0.0.10499755` | [schedules/0.0.10499755](https://testnet.mirrornode.hedera.com/api/v1/schedules/0.0.10499755) — `executed_timestamp` null, guard prefix absent |
>
> Both reviews were paid for over x402 and settled by the Blocky402 facilitator, and both
> verdicts were written to HCS. These are **operator-run reliability exercises, not users**,
> and testnet payments are **paid protocol trials, not revenue**; `web/evidence.json`
> labels them `operator` and reports zero external reviews.

The fastest path to a first paid review is the narrated `demo` script. It provisions the
keys and accounts, signs the mandate, starts the guard, pays the x402 challenge, requests
the review, verifies mirror-node evidence, and recovers temporary balances. The numbered
steps below expose each boundary so you know what the script is doing.

## 1. Install the prerequisites

You need:

- Node.js 24.15.0 or newer in the Node 24 line;
- a funded Hedera **testnet** account created through
  [portal.hedera.com](https://portal.hedera.com/); and
- the account's canonical numeric ID and DER-encoded private key.

From the repository root:

```powershell
node --version
npm install
```

Expected:

```text
v24.15.0
```

A later Node 24 patch is also valid. `npm install` should finish without an installation
error.

## 2. Configure `.env` and pin the live network versions

Create the local file:

```powershell
Copy-Item .env.example .env
notepad .env
```

Set these values:

```dotenv
HEDERA_OPERATOR_ACCOUNT_ID=0.0.YOUR_ACCOUNT
HEDERA_OPERATOR_PRIVATE_KEY=YOUR_DER_ENCODED_PRIVATE_KEY
COUNTERSIGN_ALLOWED_PROTOBUF_VERSION=
COUNTERSIGN_ALLOWED_SERVICES_VERSION=
```

- `HEDERA_OPERATOR_ACCOUNT_ID` is the funded testnet operator's canonical numeric ID.
- `HEDERA_OPERATOR_PRIVATE_KEY` must be that operator's DER-encoded private key. A raw
  key or a key for another account will fail.
- `COUNTERSIGN_ALLOWED_PROTOBUF_VERSION` is the exact reviewed HAPI protobuf
  `major.minor.patch` version.
- `COUNTERSIGN_ALLOWED_SERVICES_VERSION` is the exact reviewed Hedera services
  `major.minor.patch` version.

Leave the two version values blank for the first credentialed spike:

```powershell
npm run spike
# Equivalent when GNU Make is installed: make spike
```

Expected first-run output has the two live values, followed by an intentional stop:

```text
HAPI protobuf version: <major.minor.patch>
Services version: <major.minor.patch>
Countersign Day-1 spike failed: missing required environment variable: COUNTERSIGN_ALLOWED_PROTOBUF_VERSION
```

Record the two printed triples in `.env`, review them against the installed schema, then
rerun:

```powershell
npm run spike
```

Expected milestones from the complete spike include:

```text
Treasury key tree verified for <treasury-account-id>
Agent-only direct transfer rejected with INVALID_SIGNATURE
Approved schedule executed: <schedule-id>
Refused schedule remained unexecuted: <schedule-id>
Owner-only recovery branch executed successfully
```

This second run is a live testnet proof and incurs testnet fees. A version mismatch fails
closed.

## 3. Fetch the guard identity

The public discovery endpoint is unpaid and unauthenticated:

```powershell
curl.exe -s http://127.0.0.1:4020/guard
```

Expected shape:

```json
{
  "guardPublicKey": "<Hedera Ed25519 public key>",
  "guardIdentifier": "<HCS-14 identifier>"
}
```

For a deployed guard, replace `http://127.0.0.1:4020` with its origin. In this repository,
there is no standalone server command: `npm run demo` and `npm run refusal` start the
guard on that local address only for the duration of each run. To observe `/guard`, leave
this polling command in a second PowerShell terminal before starting step 6:

```powershell
do {
  try {
    Invoke-RestMethod http://127.0.0.1:4020/guard | ConvertTo-Json
    break
  } catch {
    Start-Sleep -Milliseconds 250
  }
} while ($true)
```

Use `guardPublicKey` for the treasury guard branch. Store `guardIdentifier` as the
public HCS-14 identity used in verdict evidence. The response contains neither private
key material nor tenant data.

## 4. Build the nested treasury

Install the fetched guard public key in exactly this authorization tree:

```text
1-of[
  owner,
  2-of[agent, guard]
]
```

With the installed Hedera SDK, the key construction is:

```ts
const treasuryKey = new KeyList(
  [ownerPublicKey, new KeyList([agentPublicKey, guardPublicKey], 2)],
  1,
);
```

Create the treasury with `treasuryKey`, then query the account and compare the stored
tree before accepting reviews. The owner is the direct recovery branch. The agent cannot
move treasury funds through the nested branch unless the guard also signs.

The narrated scripts perform this automatically. Expected output:

```text
Authorization: 1-of[owner, 2-of[agent, guard]]
Agent public key: <hex>
Guard public key: <hex>
```

## 5. Sign the mandate

Construct the exact mandate object, canonicalize it through the repository function, and
sign with the same Ed25519 owner key installed in the direct treasury branch:

```ts
const mandate = {
  tenantId: "demo-approved",
  nonce: Date.now().toString(),
  treasuryAccountId: treasuryAccountId.toString(),
  recipientAllowlist: [allowedRecipientAccountId.toString()],
  maxAmountTinybars: "50000000",
  validFromEpochSeconds: (nowEpochSeconds - 60).toString(),
  expiresAtEpochSeconds: (nowEpochSeconds + 3600).toString(),
};

const signature = Buffer.from(
  ownerPrivateKey.sign(canonicalMandateBytes(mandate)),
).toString("base64url");
```

The signature is an unpadded base64url encoding of 64 bytes. `canonicalMandateBytes`
binds the exact RFC 8785-canonicalized mandate to the `COUNTERSIGN-MANDATE` domain and
version `1`. The script verifies the signature locally before proceeding.

Expected output under `[2/7] Owner-signed mandate` is the seven-field mandate,
`signature`, and a 64-character lowercase `mandateDigest`.

## 6. Run the allowed paid transfer

```powershell
npm run demo
# Equivalent when GNU Make is installed: make demo
```

The run creates fresh owner, agent, guard, and x402 payer keys and accounts. It publishes
a 25,000,000-tinybar transfer within a 50,000,000-tinybar mandate cap, receives the live
402 quote for 1,000,000 tinybars, settles it, and requests guard review.

Expected milestones:

```text
COUNTERSIGN: ALLOWED TRANSFER
[4/7] Caller requests guard review without payment
HTTP 402 Payment Required
Quote: 1000000 tinybars
[5/7] Caller settles the x402 review price
Settlement confirmed: <transaction-id>
[6/7] Guard resolves consensus and reviews every protected field
Review outcome: APPROVED
Guard signature: submitted after exact policy approval
Balance delta:   25000000 tinybars
Allowed transfer executed with the exact mandated balance delta; temporary balances were recovered afterward.
```

The run also prints schedule, account, and HCS verdict evidence URLs.

## 7. Run the refused paid transfer

```powershell
npm run refusal
# Equivalent when GNU Make is installed: make attack
```

This run still pays for review, but proposes the separately keyed x402 payer account as a
recipient outside the mandate allowlist.

Expected milestones:

```text
COUNTERSIGN: OUT-OF-POLICY TRANSFER
HTTP 402 Payment Required
Settlement confirmed: <transaction-id>
Review outcome: REFUSED: recipient is outside the mandate allowlist
Guard signature: not submitted
Guard refused the out-of-policy recipient: no guard signature, the transfer never executed, and the treasury balance stayed unchanged during review. Temporary balances were recovered afterward.
```

The treasury balances printed before and after review must be identical.

## 8. Verify both ScheduleIDs on the mirror node

For each printed ScheduleID, open:

```text
https://testnet.mirrornode.hedera.com/api/v1/schedules/{id}
```

Or fetch it directly:

```powershell
$scheduleId = "0.0.REPLACE_ME"
Invoke-RestMethod "https://testnet.mirrornode.hedera.com/api/v1/schedules/$scheduleId" |
  ConvertTo-Json -Depth 10
```

Check the raw response, not only the script summary:

- **Allowed transfer:** `executed_timestamp` is set, `deleted` is `false`, and
  `signatures[]` contains both authorization `public_key_prefix` values: the agent's
  prefix and the guard's prefix.
- **Refused transfer:** `executed_timestamp` is `null`, `deleted` is `false`,
  `signatures[]` contains the agent's `public_key_prefix`, and the guard's prefix is
  absent.

## Troubleshooting

- **Unfunded operator:** account creation, schedule creation, payment, or cleanup can fail
  for insufficient balance. Fund the testnet operator in the Hedera portal and rerun.
- **Wrong key type or encoding:** `HEDERA_OPERATOR_PRIVATE_KEY` is parsed as DER. Use the
  DER-encoded private key belonging to `HEDERA_OPERATOR_ACCOUNT_ID`. Mandate owners and
  the generated authorization keys are Ed25519.
- **Missing version variables:** the first spike intentionally stops after printing the
  live versions. Copy both complete triples into `.env`; do not guess or truncate them.
- **Version mismatch:** rerun the blank-version discovery step and review the newly
  reported versions before changing the allowlist. The guard is designed to fail closed.
- **`make` is unavailable:** PowerShell does not include GNU Make by default. Use
  `npm run demo`, `npm run refusal`, `npm test`, `npm run typecheck`, and `npm run spike`.
