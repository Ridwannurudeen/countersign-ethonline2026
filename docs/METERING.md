# Countersign request-derived work metering

`POST /countersign` quotes submitted decoding and validation work before payment.
`POST /review` keeps its configured flat HBAR price: the caller supplies a ScheduleID,
and the guard cannot inspect its consensus body until after settlement. Neither route
bills elapsed CPU time, inference tokens, or measured post-usage work. There is no volume
discount. This branch is locally verified and has not been pushed or deployed.

## Reproduce the quote

The base64-decoded `PAYMENT-REQUIRED` response header contains one payment requirement
in `accepts[0]`. Its `extra.meter` publishes the version, decoded inputs, configured
rates and bounds, both charges, subtotal and final amount. `accepts[0].amount` must
equal `extra.meter.amountTinybars`; the settlement asset is still HBAR (`0.0.0`).
`GET /.well-known/agent.json` also publishes the configured meter and identifies the
existing `priceTinybars` as applying to `/review`.

For `version: "countersign-v1"`:

1. Decode `transactionBase64`. `decodedBytes` is the byte length of the entire submitted
   transaction list, including wrappers and signatures. JSON, the mandate, and base64
   text overhead are not byte units.
2. With the pinned `@hiero-ledger/proto` decoder, traverse `TransactionList`, each
   `signedTransactionBytes`, then each `bodyBytes`. Sum HBAR `accountAmounts.length`,
   each token's `transfers.length`, and each token's `nftTransfers.length` across **all
   node variants**. An NFT transfer entry counts as one adjustment; counting it does
   not authorize NFTs or change the existing transfer policy. Do not deduplicate entries.
3. Use integer arithmetic:

   ```text
   byteCharge = ceil(decodedBytes * perKilobyteTinybars / 1024)
   adjustmentCharge = transferAdjustments * perAdjustmentTinybars
   subtotal = baseTinybars + byteCharge + adjustmentCharge
   amount = min(maxTinybars, max(minTinybars, subtotal))
   ```

All monetary values are decimal strings in tinybars. The default byte rate adds 100
tinybars for each additional byte, and each adjustment adds 10,000, until the ceiling.
The floor and ceiling deliberately create plateaus; fractional tinybars under custom
rates round upward. The implementation uses `BigInt`, including intermediate arithmetic.
The pure exported function is `quoteCountersign(transactionBase64, config)` in
[`src/payment-meter.ts`](../src/payment-meter.ts).

For empty or noncanonical base64, an empty transaction list, missing signed/body bytes,
or a decoding error, `decodeStatus` is `invalid` and `transferAdjustments` is zero.
The decoded byte length still contributes; the quote never claims a partial adjustment
count. This preserves the existing paid policy-refusal path. A `decoded` meter is not
an authorization decision: unsupported fields, signatures and policy are still checked
after settlement. The HTTP request body remains limited to 16 KiB; direct meter calls
also reject base64 text over 16 KiB before allocating decoded bytes.

## Operator configuration

`PaymentGateConfig.countersignMeter` accepts the complete rate/bounds object. Omitting
it uses these defaults. `scripts/serve-guard.ts` exposes the same settings through
environment variables, validates them before starting the client, and passes them to
the payment gate. No secret-file edits are needed to set these process variables.

| Field | Environment variable | Default tinybars |
| --- | --- | ---: |
| `baseTinybars` | `COUNTERSIGN_METER_BASE_TINYBARS` | 1000000 |
| `perKilobyteTinybars` | `COUNTERSIGN_METER_PER_KILOBYTE_TINYBARS` | 102400 |
| `perAdjustmentTinybars` | `COUNTERSIGN_METER_PER_ADJUSTMENT_TINYBARS` | 10000 |
| `minTinybars` | `COUNTERSIGN_METER_MIN_TINYBARS` | 1000000 |
| `maxTinybars` | `COUNTERSIGN_METER_MAX_TINYBARS` | 10000000 |

Each value must be a positive canonical decimal int64 string, and the minimum cannot
exceed the maximum. Rate changes invalidate a prior quote; callers must obtain and
check the new challenge. The fee remains due on either an approval or a refusal and
does not depend on which result the authorization policy produces.

## Caller rollout requirement

The reusable countersigning client reads the 402 challenge and uses the supplied
`guardPaymentClient` to pay it. Its existing spending controls remain effective;
the tests prove that a 1,000,000-tinybar cap refuses a larger metered quote and that
an explicitly configured sufficient cap permits exact payment.

The recorded demonstration scripts `scripts/guarded-purchase.ts` and
`scripts/hts-purchase.ts` still set that cap to 1,000,000 tinybars and additionally
assert that every guard quote equals that flat amount. **Those scripts will refuse
the new default quotes.** Before rollout, their guard-payment budget and fixed-price
assertions need a separately reviewed update to check the metered quote under an
explicit caller spending limit. This change leaves those existing payment
authorizations intact. Do not derive a caller's spending authorization solely from
an amount advertised by a remote service. The `/review` caller keeps its flat terms.

## Local HTTP evidence

The server test `POST /countersign publishes reproducible metered 402 quotes for two
request sizes` sends real SDK-encoded, agent-signed transfers to a loopback HTTP server.
The requests differ by one versus two node variants. They do not settle payments or
contact Hedera. The HTTP output decoded from their actual challenges was:

| HTTP status | JSON request bytes | Decoded transaction bytes | Adjustments | Quoted tinybars |
| ---: | ---: | ---: | ---: | ---: |
| 402 | 643 | 190 | 2 | 1039000 |
| 402 | 895 | 380 | 4 | 1078000 |

Both challenges carry `scheme: "exact"`, `network: "hedera:testnet"`, `asset: "0.0.0"`,
and `paymentFlow: "upfront"`. The tests emit the full decoded challenges for inspection.
The exact-payment test uses the installed Hedera facilitator scheme with an offline
consensus-submission adapter. It rejects both a lower accepted amount and actual HBAR
underpayment disguised by a correct accepted amount, then accepts exact payment.
HTTP tests separately verify that underpayment reaches no authorization checks,
nonce reservation, guard signature or verdict publication.

Run the offline checks from the repository root:

```sh
npm run typecheck
npm test
python -m pytest python/ -q
```

## Mutation evidence

Each mutation was applied alone, tested with
`node --test --experimental-strip-types test/payment-meter.test.ts`, then restored.

Removing the ceiling branch from the amount calculation produced this real failure:

```text
✖ configured ceiling caps a crafted adjustment-heavy transaction (4.4899ms)
  + '52001700'
  - '10000000'
ℹ tests 17
ℹ pass 14
ℹ fail 3
```

Replacing the dynamic payment requirement's `amount: meter.amountTinybars` with
`amount: config.priceTinybars` produced:

```text
✖ countersign quotes increase with decoded bytes and adjustments, while review stays flat (9.434ms)
  AssertionError [ERR_ASSERTION]: more decoded bytes must increase the quote
ℹ tests 17
ℹ pass 13
ℹ fail 4
```

After restoring the second mutation:

```text
ℹ tests 17
ℹ pass 17
ℹ fail 0
```

The complete suite before committing passed 599 TypeScript tests with zero failures;
the Python suite passed 13 tests. `npm run typecheck` completed without diagnostics.
