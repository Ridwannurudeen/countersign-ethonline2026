# Python x402 Hedera client preview

This directory closes the Python buyer-side gap for x402 exact payments on Hedera. It
builds a frozen `TransferTransaction`, binds its transaction ID to the facilitator's
`feePayer`, signs it with the buyer key, and returns the base64 transaction as
`{"transaction": "..."}`. HBAR and one explicitly requested HTS token are supported.

The layout mirrors `x402/mechanisms/<chain>/` so the implementation can be reviewed for a
future upstream contribution. It is an unaffiliated preview in the Countersign repository;
it has not been contributed to, endorsed by, or published by the x402 project.

## Why byte identity is not required

`hiero-sdk-python==0.2.10` and `@hiero-ledger/sdk==2.85.0` serialize semantically equivalent
transactions differently. TypeScript explicitly writes several zero-valued protobuf fields
and wraps the transaction in a `TransactionList`; Python omits those defaults. The acceptance
boundary is interoperability: the checked-in Python payload is decoded and asserted by the
real TypeScript `@x402/hedera` inspector in the test suite.

## Test

From the repository root:

```bash
python -m pytest python/ -q
```

The suite is offline. It does not contact Hedera or Blocky402 and requires no credentials.

## Minimal buyer example

Set `HEDERA_ACCOUNT_ID`, `HEDERA_PRIVATE_KEY`, `HEDERA_FEE_PAYER`, and
`HEDERA_PAY_TO`, then run this from the repository root:

```bash
python python/examples/create_payment.py
```

The example prints an x402 scheme payload. It does not submit the transaction; the
facilitator supplies its own signature and performs submission after verification.
