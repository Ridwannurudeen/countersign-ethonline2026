# 04 — Python x402 Hedera buyer (the one upstreamable artifact)

Prepend `01-COMMON.md`.

## Why this exists, and what is already known
Python agents cannot pay Hedera services. **Verified**: the `x402` 2.22.0 wheel from PyPI
ships mechanisms `evm`, `svm`, `tvm` only — no `hedera`. TypeScript has `@x402/hedera` 2.25.0.
This closes the buyer-side gap, shaped for contribution to `x402-foundation/x402`.

**It stays in this repo under `python/`. Do NOT open a pull request, publish to PyPI, fork,
or push anywhere.** The owner approves any external publication.

### 🔴 Byte parity was already tested. It does NOT hold, and that is fine.
Do not spend the run rediscovering this. `scripts/parity-check.py` reproduces it:

| | bytes | sha256 |
|---|---|---|
| TypeScript `tx.toBytes()` | 197 | `dcbb204f…` |
| `hiero_sdk_python` `to_bytes()` | 170 | `70613b05…` |

Cause: TypeScript **explicitly encodes zero-valued** `shardNum`, `realmNum`, `scheduled`,
`memo` and both `isApproval` (+24 bytes), and wraps the result in **`TransactionList`** (+3).
Fee, duration, field ordering and signature-map shape all agree, and **the public keys are
identical**.

**But the payloads are interoperable** — proven: `inspectHederaTransaction` from
`@x402/hedera` decodes the Python-produced transaction and returns the correct fee payer and
both transfer entries.

So **do not chase byte equality, and do not hand-tune bytes to force a match.** The
acceptance test is *interoperability*: a payload this library builds must decode correctly in
the TypeScript tooling and be acceptable to the facilitator.

## Do not create a venv or download anything
`hiero_sdk_python` **0.2.10 is already installed system-wide**. Just import it. No
`pip install`, no `pip download`, no wheel extraction, no virtualenv — earlier attempts left
6,700+ junk files in the repo. Scratch files go in the system temp directory, never the repo.

## Scope — buyer side only
**In scope:** a typed Hedera signer adapter; the exact-scheme payment payload; explicit HBAR
and HTS asset selection; fee-payer binding; frozen signed `TransferTransaction` serialization;
cross-language interop fixtures; unit tests; one minimal example.

**Out of scope, do not build:** a Python facilitator, server middleware, an agent framework,
or anything Countersign-specific. It must be useful to *any* Python agent paying *any* Hedera
service, or it is not upstreamable.

## Package layout — mirror the upstream convention
The Python `x402` package uses `x402/mechanisms/<chain>/` with
`exact/{client,facilitator,server,register}.py` plus `signer.py`, `types.py`,
`default_assets.py`, `constants.py`, `utils.py`. **Mirror that** under `python/` so a
maintainer recognises the shape. Build the **client** path; leave facilitator/server files out
rather than stubbing them.

## The TypeScript behaviour to match (semantics, not bytes)
```js
async createPaymentPayload(x402Version, paymentRequirements, _) {
  if (paymentRequirements.scheme !== "exact") throw new Error("Unsupported scheme for Hedera exact client");
  assertSupportedHederaNetwork(paymentRequirements.network);
  if (typeof paymentRequirements.extra?.feePayer !== "string")
    throw new Error("feePayer is required in paymentRequirements.extra for Hedera exact");
  const transaction = await this.signer.createPartiallySignedTransferTransaction(paymentRequirements);
  return { x402Version, payload: { transaction } };
}
```
Payload type: `{ transaction: string }` — base64 of a serialized, **partially signed**
transfer. The buyer signs; the facilitator adds the fee-payer signature and submits.

⚠️ The transaction id is generated from the **fee payer**, not the sender. Bind it that way.

## Tests
Runnable offline with `python -m pytest python/ -q`. Include an **interop fixture**: a payload
your library builds, checked into the repo, plus a test asserting the TypeScript
`inspectHederaTransaction` reads back the expected fee payer, sender and amount from it.
(A small Node one-liner invoked from the test, or a checked-in expected-decode JSON that a
Node script regenerates — your call, but the assertion must be real.)

Anything needing the live network or Blocky402 must **skip with a clear reason**, never fail
and never simulate.

## Deliverables
`python/` with the mirrored layout, `pyproject.toml`, and a README stating the gap it closes,
that byte-identity with the TS client is not a goal and why, and that it is not yet affiliated
with the upstream project.

## Done when
`python -m pytest python/ -q` passes offline and `npm run typecheck` is still clean.
Do not run `npm test`.

## Report
Five lines: what you built, the interop assertion you wrote and its result, the Python test
counts, what needs credentials, and anything above that was wrong.
