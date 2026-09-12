# 03 — One HTS guarded transfer (last T1 item)

Prepend `01-COMMON.md`. **Run brief 02 first** — it closes a token gap in the payment guard
that this brief would otherwise widen into a real hole.

## Why this is last, and the honest exit
The roadmap's T1 cut says *"drop HTS breadth and UI polish first"*, and the Day-1 review
flagged the reason: **token custom fees can move value independently of the transfer**. If
you cannot fully constrain them, **refuse HTS by default and say so in `THREAT_MODEL.md`**.
That is a perfectly good outcome — a documented, deliberate refusal beats a partial check
that looks like support. Do not ship a half-constrained token path.

## The current state
`src/review-schedule.ts` around line 453 refuses every token transfer:
```ts
denialCase = check(
  "token transfers are empty",
  cryptoTransfer.tokenTransfers != null &&
    cryptoTransfer.tokenTransfers.length === 0,
  "token transfers must be empty",
);
if (denialCase !== false) return denialCase;
```
The mandate has **no asset field** — it is implicitly HBAR-only:
```ts
export interface Mandate {
  tenantId: string;
  nonce: string;
  treasuryAccountId: string;
  recipientAllowlist: string[];
  maxAmountTinybars: string;
  validFromEpochSeconds: string;
  expiresAtEpochSeconds: string;
}
```

## What to build
1. **Add an explicit asset to the mandate.** A mandate must name exactly one asset: either
   HBAR or one specific token id. **Never rely on `DEFAULT_ASSETS`** — the roadmap is explicit
   about this. An absent or ambiguous asset must be refused, not defaulted.

   This changes the signed mandate shape, so **bump the mandate schema version** and keep the
   domain-separated preimage rule intact. Existing HBAR mandates must either keep working or
   be refused loudly — decide, implement it, and say which you chose and why.

2. **Extend the validator** so that when the mandate names a token, exactly one token's
   transfer list is present, it is that token, and it contains exactly two entries: the
   treasury debited and one allowlisted recipient credited, equal and opposite, within cap.
   The HBAR transfer list must then be empty or contain only what is genuinely required.
   Every existing HBAR invariant must keep its force — reuse the same per-adjustment checks
   (`isApproval`, the two allowance-hook fields, alias rejection, unknown-field rejection).

3. **Custom fees.** `maxCustomFees` is already refused for HBAR; keep it refused. Then
   establish what a token's own custom-fee schedule can do to a transfer of that token. If a
   token can move extra value to a third party through its fee schedule, then a guard that
   only inspects the transfer list is not making the guarantee it claims. Either constrain
   it fully — e.g. refuse any token whose fee schedule is non-empty or mutable — or refuse
   HTS by default. **State plainly in your report which you did.**

4. **`THREAT_MODEL.md` and `docs/INVARIANTS.md`** — add the HTS rows: what is now allowed,
   what is refused, and what remains outside the guarantee. Cite real test names.

## Tests — write the failing tests first
New file `test/review-schedule-hts.test.ts` so you never open the 697-line existing one.
Cover at least: wrong token id; token transfer when the mandate says HBAR; HBAR transfer when
the mandate says a token; both lists populated; over-cap token amount; recipient outside the
allowlist; a third balance entry; `isApproval` set; either hook field present; non-empty
`maxCustomFees`.

Do not modify existing tests. If one now asserts something wrong, say so and leave it.

## Done when
`npm run typecheck` clean and your new test file passes on its own. Do not run the full suite.

## Report
Five lines: whether you shipped HTS or refused it by default and why; the custom-fee ruling;
how you versioned the mandate; your test counts; anything above that was wrong.
