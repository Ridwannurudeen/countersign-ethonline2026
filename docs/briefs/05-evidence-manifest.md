# 05 — Machine-readable evidence manifest

Prepend `01-COMMON.md`. One task.

## What the roadmap asks for
> A machine-readable evidence manifest separating external users / operator agents /
> successes / denials / setup txns

This is the honesty backbone of the traction claim. Get the separation right and the rest of
the submission can lean on it; blur it and the whole traction story becomes unciteable.

## The rules that matter more than the schema
The owner's roadmap is explicit, and the manifest must make these structurally impossible to
violate — not merely discouraged by a comment:

- **Owner-run agents are an operator reliability exercise. They are never "users."**
- **Testnet payments are paid protocol trials. They are never "revenue."**
- Setup transactions (account creation, funding, token association) are **not** reviews and
  must never be counted as activity.
- **No field may aggregate operator and external activity into one number.** If a consumer
  wants a total they must add two clearly named fields themselves and thereby notice what
  they are doing.

Every record carries an explicit `origin` of `operator` or `external`, and the type system /
validator must reject a record without one. There is no default and no "unknown" that
silently lands in the flattering bucket.

## What to build
`src/evidence-manifest.ts` with a validated record type and a builder that produces
`web/evidence.json` in the shape the existing page already consumes — read `web/evidence.html`
and `web/evidence.json` first (both are small) and **do not break the page**. It currently
holds `{ guardPublicKeyPrefix: string, records: [] }`.

Each record should carry at minimum: `origin`, the ScheduleID, the outcome
(`approved` | `refused`), the mandate digest, the settlement id where one exists, the payer
account, and the mirror-node URL. Reuse `src/evidence-links.ts` for URL construction —
it already exports `scheduleMirrorNodeUrl` and `accountMirrorNodeUrl`. Do not duplicate them.

Also expose counts that keep the separation: external reviews, operator reviews, approvals,
refusals, distinct external payer accounts — each named so it cannot be mistaken for a total.

**Every claim must be independently checkable.** A record is only useful if a judge can take
its ScheduleID to the mirror node and confirm the outcome without trusting us. Do not include
any field that cannot be verified that way, and do not compute a "success rate" that hides
how few runs there were.

## Empty state
There is no live data yet and there may be none for a while. The manifest must represent
"nothing has happened" honestly — empty collections and zero counts that the page renders as
*"No reviews recorded yet"*, never as a zero that implies a measured result.

## Tests
New file `test/evidence-manifest.test.ts`:
1. `INVARIANT: a record without an explicit origin must be refused.`
2. `INVARIANT: operator and external counts must never be summed into one field.`
3. A setup transaction is not counted as a review.
4. The empty manifest validates and produces zero counts.
5. The produced JSON still satisfies whatever `web/evidence.html` expects.

## Done when
`npm run typecheck` clean, your new test file passes on its own, and `web/evidence.html`
still works against the generated `web/evidence.json`. Do not run the full suite.

## Report
Four lines: the schema you chose, how the operator/external separation is enforced
structurally, your test counts, anything above that was wrong.
