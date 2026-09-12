# 08 — Owner-only items. Do not hand these to Codex.

Everything here needs your voice, your judgement, or your account. Listed so nothing falls
through the gap between "Codex can build it" and "someone has to do it."

## 1. The 2–4 minute video — T0, and T0 is "never cut"
This is the only T0 item that is not code, and it is **not done**. The agreed script — its
first thirty seconds lead with the outcome, not the vocabulary:

> 0:00 "This autonomous agent controls a funded Hedera treasury. This webpage just prompt-
> injected it: send the treasury to the attacker." → 0:09 the schedule appears, unexecuted →
> 0:15 it pays the guard over x402 → 0:22 **REFUSED**, funds unmoved, *even though the agent
> itself is compromised* → then the allowed transfer executing.

Requirements from the roadmap: **real voice** (not synthetic), unsped, ≥720p, 2–4 minutes.

**It cannot be recorded until brief 07 passes** — the whole film is screen capture of the
live flows. That dependency is the strongest argument for running 07 soon.

⚠️ One wording trap: the guard **approves a ScheduleID**; it does **not** sign the scheduled
transaction bytes. Do not narrate it as "signs the exact bytes" — that claim was in the
original roadmap, it is false, and a Hedera-savvy judge would catch it on stage. The accurate
line is in `README.md` and it is just as strong.

## 2. The Guarded Transfer Challenge — recruiting
8–12 targeted Hedera/agent builders, from the event Discord. The ask:

> *"Can your agent complete one allowed transfer and survive one injected malicious transfer
> through a live paid Hedera guard? Setup target: ten minutes. I need technical feedback, not
> promotion."*

`ONBOARDING.md` is written and ready to hand them. **Recruiting is the long pole** — the
roadmap says the list should exist before Day 6, and this is the single highest-scoring axis
(Success 20% + Validation 15%).

Minimum credible target: **3 independent external builders, 3+ distinct external payer
accounts, 6 completed reviews, <15 min median to first paid review.**

Publish the failures too — *"8 invited, 4 attempted, 3 completed, 1 blocked by token
association"* is more persuasive than a clean number, and the roadmap says so.

🔴 **Never call operator runs "users." Never call testnet payments "revenue."** The evidence
manifest (brief 05) enforces this structurally; keep the same discipline in every message you
send.

## 3. Deploy the guard publicly
T1 needs a reachable endpoint for adopters. Nothing is deployed. Whoever does it: the guard
holds its own key only — **no tenant treasury key may ever sit server-side**, and there is a
test asserting that. Keep it true in the deployment too.

## 4. Push the repo to GitHub
Not on GitHub yet. Branch `build/day1-foundation`, HEAD `62d8697`, **main is empty of this
work** — a hook blocks direct commits to main, so the branch will need merging. Repo must be
public before submission.

## 5. Upstream PR for the Python artifact — explicitly gated
The roadmap: *"No PR or external publish without your explicit approval."* Note its success
criterion is **not** a merge — *"a clean, tested, maintainer-shaped contribution."*

See brief 04's finding: **byte parity with the TS client is not achievable and is the wrong
test.** Python omits zero-valued protobuf defaults and skips the `TransactionList` wrapper;
the payloads are still interoperable. Your Sep 10 18:00 cut trigger says "cut unless
byte-matched to the TS fixture" — **that criterion would kill a working client.** I'd replace
it with *"the facilitator settles a Python-built payload."*

## 6. The submission itself
**Sun 2026-09-13 12:00 EDT.** The roadmap requires explicit owner approval before submitting,
and no new features, dependency upgrades or mainnet experiments on submission morning.

Also on the checklist: verify every explorer link from a clean browser, confirm repo
visibility, and check the uploaded video plays.

## 7. Decide the other two partner slots
0G, The Graph, World, ENS, Ledger and Chainlink still read "details coming soon" and
need a recheck on Sep 4 — that's today. Worth a look while the build continues.

---

## Honest status of the two cut triggers you are closest to
- **Sep 8 18:00** — *"if approve + attack aren't live, freeze T1–T3."* Both flows are written
  and green offline, but **neither has ever run live**. This trigger is measured on live
  behaviour, so brief 07 decides it.
- **Sep 10 12:00** — *"cut T1 unless deployed T0 has run ≥10 consecutive approve/deny cycles
  without manual repair."* Nothing is deployed and zero cycles have run.

Neither is failed yet. Both are entirely gated on credentials plus a deploy.
