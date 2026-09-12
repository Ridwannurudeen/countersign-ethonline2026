# 02 — Close the token-transfer gap in the payment identity guard

Prepend `01-COMMON.md`. One task. Small — this should finish quickly.

## The defect
`src/payment-gate.ts` refuses a payment whose sender is a treasury authorization identity.
It identifies the sender correctly for HBAR, but **it never inspects `tokenTransfers`.**
Confirmed: `grep -c "tokenTransfers" src/payment-gate.ts` → **0**.

Not exploitable today, because `src/review-schedule.ts` refuses all token transfers outright.
**It becomes exploitable the moment HTS support lands (brief 03)** — a treasury
authorization key could pay the guard with a token transfer and walk straight past this
guard. Close it now, before HTS, so the two changes never race.

## The current code — `src/payment-gate.ts` around line 156
```ts
const inspected = inspectHederaTransaction(transactionBase64);
if (
  hederaAccountIdsEqual(
    inspected.transactionIdAccountId,
    authorization.accountId,
  ) ||
  inspected.hbarTransfers.some(
    (transfer) =>
      BigInt(transfer.amount) < 0n &&
      hederaAccountIdsEqual(transfer.accountId, authorization.accountId),
  )
) {
  return true;
}
```

`inspectHederaTransaction` also returns
`tokenTransfers: Record<string, {accountId, amount}[]>` — keyed by token id, same
`{accountId, amount}` entry shape as `hbarTransfers`, and the **sender is again the negative
entry**.

⚠️ Note `transactionIdAccountId` is the **fee payer**, not the sender — that clause is a
belt-and-braces check, not the sender check. Do not remove it.

## What to do
Extend the same refusal so that **any negative entry in any token's transfer list** matching
an authorization identity refuses the payment, exactly as the HBAR case does. Keep it
readable; do not restructure the surrounding function.

## Tests — append to the END of `test/payment-gate.test.ts`
Read only the **last 60 lines** (`tail -60`) for style. Then add:
1. `INVARIANT: a payment whose token sender is a treasury authorization identity must be
   refused before settlement` — for each of owner, agent and guard.
2. The same for the treasury account itself.
3. A payment whose token sender is the legitimate operational account is still **accepted** —
   so the fix refuses the right thing and not everything.

Build the payload with a real serialized transaction so `inspectHederaTransaction` decodes it,
in the same way the existing payload tests in that file do — do not hand-craft a fake object
that bypasses the decoder.

## Done when
`npm run typecheck` is clean and your new tests pass via
`node --test --experimental-strip-types test/payment-gate.test.ts`.
Do not run the full suite.

## Report
Three lines: what you changed, your test counts, and anything above that was wrong.
