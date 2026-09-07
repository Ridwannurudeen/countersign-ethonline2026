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
boundary is interoperability: generated HBAR and HTS payloads and the checked-in Python
payload are decoded by the real TypeScript `@x402/hedera` inspector. The installed SDK's
`PublicKey.verifyTransaction` also verifies the expected payer's signature. Tests alter
one signature byte in each generated asset payload and require verification to fail.

## Test

With the dependencies declared in `pyproject.toml` and pytest already installed, run
from the repository root; no preview package installation is needed:

```bash
python -m pytest python/ -q
```

This tree is a namespace portion intended to live inside the upstream `x402` package.
Upstream `x402` is a regular package, so this separate portion cannot be imported as
`x402.mechanisms.hedera` alongside an installed upstream `x402` without the test shim.
Adding this directory to `PYTHONPATH` or installing it in editable mode does not extend
upstream's regular package.

`conftest.py` loads the local Hedera package from its file path using `importlib` and
registers it in `sys.modules` as `x402.mechanisms.hedera`. Its submodules then resolve
from the local package directory under their real dotted names. Tests keep upstream-style
imports; the shim neither installs files nor changes the installed upstream package.

The suite is offline. It does not contact Hedera or Blocky402 and requires no credentials.

## Minimal buyer example

Set `HEDERA_ACCOUNT_ID`, `HEDERA_PRIVATE_KEY`, `HEDERA_FEE_PAYER`, and
`HEDERA_PAY_TO`, then run this from the repository root:

```bash
python -m python.examples.create_payment
```

The standalone example uses repository-qualified `python.x402.mechanisms.hedera` imports
so it runs without pytest's shim or a preview package installation.

The example prints an x402 scheme payload. It does not submit the transaction; the
facilitator supplies its own signature and performs submission after verification.
