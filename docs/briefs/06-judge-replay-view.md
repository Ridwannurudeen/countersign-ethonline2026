# 06 — Judge-facing replay view

Prepend `01-COMMON.md`. **Run brief 05 first** — this consumes the manifest it produces.

## What the roadmap asks for
> A judge-facing replay view: mandate → schedule → x402 settlement → verdict → ScheduleSign
> → execution, one causal chain

Its purpose is stated plainly in the roadmap: *"the replay turns five protocols into one
legible chain."* An async judge skimming fifty projects needs to see one transfer's whole
life on a single screen and be able to check each step themselves.

## What to build
`web/replay.html` — a single static file, **no framework, no build step, no bundler, no
external assets**, matching how `web/evidence.html` is already built. Read that file first
(it is small) and follow its conventions; share its look so the two pages read as one thing.

For a selected review, show the causal chain in order, each step with what a reader can
verify and where:

1. **Mandate** — the digest, and the policy it authorized (allowlist, cap, validity window).
2. **Schedule** — the ScheduleID, linked to the mirror node, created by the agent and
   unexecuted at this point.
3. **x402 settlement** — the settlement id and the amount paid for the review.
4. **Verdict** — approved or refused, with the specific invariant that decided it.
5. **ScheduleSign** — present only when approved; the guard's key prefix appearing in
   `signatures[]`.
6. **Execution** — `executed_timestamp` set, and the balance moved.

**For a refusal the chain must visibly stop**, and steps 5 and 6 must be shown as *"never
happened"* — schedule exists, guard prefix absent from `signatures[]`, `executed_timestamp`
null. A refusal is the more persuasive story and it is proven by absence; render that
absence explicitly rather than omitting the rows.

## Honesty requirements
- Resolve steps 2, 5 and 6 **live from the mirror node in the reader's browser**, so those
  claims do not depend on trusting anything we generated. Steps 1, 3 and 4 come from the
  manifest — **label which is which** so a judge knows what is independently verified and
  what is our own record.
- Carry the manifest's `origin` through: an operator-run replay is **labelled operator-run**.
- A mirror-node 404/429/5xx renders as *"could not verify"* — never as a refusal and never as
  a success.
- With no records, say so plainly. Do not ship a demo chain built from invented data; a
  fabricated replay would be worse than no page.

## Tests
New file `test/replay-view.test.ts`, asserting against the page source and a fixture manifest:
1. A refused chain renders steps 5 and 6 as *never happened*, not as missing/blank.
2. Mirror-derived steps are labelled distinctly from manifest-derived steps.
3. An operator-origin record is labelled operator.
4. The empty state renders the no-records message.

## Done when
`npm run typecheck` clean and your new test file passes on its own. Do not run the full suite.

## Report
Four lines: what you built, how you separated verified-live from our-own-record, your test
counts, anything above that was wrong.
