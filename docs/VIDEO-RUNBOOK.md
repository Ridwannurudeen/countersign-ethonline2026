# Demo video runbook

Everything needed to record the submission video in one sitting. Read the two traps in
"What must not be said" before recording — both are claims an earlier plan made that this
build does not support.

## Hard requirements

ETHGlobal rejects a video that breaks any of these:

- **2 to 4 minutes.** Under two or over four is auto-rejected.
- **720p or higher.**
- **Your real voice.** No text-to-speech, no AI voiceover.
- **No sped-up footage.** Cutting between takes and between clips is fine; changing
  playback rate is not.
- **No phone recording of a screen**, and no music over text in place of narration.

## Verified timings

All three scripts were run end to end against Hedera testnet on 2026-09-12 immediately
before this runbook was written:

| Command | Wall clock | What it proves |
| --- | --- | --- |
| `npm run spike` | 27s | The network itself refuses the agent acting alone |
| `npm run hosted-review` | 19s | A paid review of an in-policy transfer, by the **live public guard** |
| `npm run hosted-review refused` | 24s | A paid refusal of an out-of-policy transfer, by the same guard |

All three were timed against the live guard immediately before this was written.

That is **70 seconds** of screen time, which makes the **two-minute floor the real
constraint, not the four-minute ceiling**. Do not rush the narration to fit — there is room
to spare. Let each run finish on screen, pause on the lines that matter, and talk through
what just happened before moving on. If a finished cut lands under 2:00 it is rejected, so
check the length before uploading.

**Record against the deployed guard, not the local one.** `npm run demo` and
`npm run refusal` still work and still prove the protocol, but they start a guard inside
their own process on `127.0.0.1`. The `hosted-review` commands send the same request over
the public internet to `https://countersign.gudman.xyz`, which is the thing worth showing.

## Before you hit record

1. `npm test` — expect 360 passing, 0 failing.
2. Terminal at a large font, full screen, dark background. The output is wide; make sure
   `PASS:` lines do not wrap.
3. Check your configuration **before** recording, not mid-take. The scripts fail by name on
   a missing value, which is good behaviour and a ruined take. `npm run spike` reads
   `.env`; `npm run hosted-review` reads `var/hosted-caller.env`, which provisioning wrote
   on 2026-09-12. Both must exist. If `var/hosted-caller.env` is missing, **stop and ask** —
   do not re-run `npm run provision-hosted`, because that would create a new treasury and
   invalidate every evidence link in the README.
4. Confirm the guard is up: `curl https://countersign.gudman.xyz/guard` should return JSON
   with a `guardPublicKey`. If it does not, see the fallback below before you start.
5. Close anything that could raise a notification.
6. Have one browser tab open on
   `https://testnet.mirrornode.hedera.com/api/v1/schedules/` so you can paste a ScheduleID
   straight into it for the evidence beat.
7. The treasury, agent and guard accounts are fixed and will match the README. Each run
   creates a **new ScheduleID**, so that one number will differ from anything written down.
   That is expected — read whatever your run prints. (`npm run spike` is the exception: it
   creates its own throwaway accounts, so every ID in that scene is new.)

## If the live guard or the facilitator is unavailable

Scene 3 and Scene 4 depend on two things outside this machine: the deployed guard at
`countersign.gudman.xyz` and the Blocky402 facilitator. If either is down, `hosted-review`
fails at the payment step.

Do not lose the night to it. `npm run demo` and `npm run refusal` run the identical
protocol against a guard started inside the script on loopback, and they still show the
402, a real Blocky402 settlement, the consensus checks and the outcome. Fall back to them,
and in that take say "the guard" rather than naming the URL — then the narration stays true
regardless of which guard answered. The spike scene is unaffected either way.

If the facilitator itself is down, both paths fail at the same step. In that case record
Scenes 1, 2 and 5 — the enforcement proof and the mirror-node verification are the
strongest material anyway — and add the paid scenes when it recovers.

## Shot list

### Scene 1 — The claim (0:00–0:20, talking over a still or the README)

> "This is a Hedera treasury controlled by an autonomous agent. The agent can propose
> payments all day. It cannot make one. Moving money needs a second signature from an
> independent guard that the agent does not control — and that guard charges for every
> decision it makes."

### Scene 2 — The network refuses the agent (0:20–0:55) — `npm run spike`

Run it. The line that matters is `Agent-only direct transfer rejected with
INVALID_SIGNATURE`. Pause on it.

> "The treasury key is one-of: either the owner alone, or the agent and the guard
> together. Here the agent signs a transfer by itself and submits it. The Hedera network
> rejects it. This is not a policy check inside the agent's own code that a compromised
> agent could skip — the agent's signature does not satisfy the account's key, so the
> transfer cannot happen."

Then, as the same run continues: the approved schedule executes and the refused one does
not, and the owner-only recovery branch works.

> "The same run shows the two escapes: the owner can always recover funds alone, and a
> schedule the guard refuses simply never executes."

### Scene 3 — A paid approval (0:55–1:45) — `npm run hosted-review`

Let steps 1 through 3 scroll. Slow down at step 4.

> "The agent publishes the transfer it wants as a Hedera Scheduled Transaction. It is
> public and it is unexecuted — the agent's signature is on it, the guard's is not.
> The agent now asks the guard to review it. That guard is not running on this machine —
> it is a service at countersign dot gudman dot xyz — and it answers with HTTP 402,
> Payment Required, quoting its price in HBAR."

At step 5, the settlement line:

> "The caller pays over x402. That settlement is executed by the Blocky402 facilitator on
> Hedera testnet — here is the transaction ID."

At step 6, as the checks scroll:

> "Only now does the guard do any work. It resolves the ScheduleID from consensus — it
> never trusts a summary the caller sent it — and checks every decoded field against a
> mandate the treasury owner signed. Recipient, amount, asset, fee, expiry, who created it,
> who pays for it, and that its own key is not already on it."

At step 7:

> "Every check passes, so the guard adds its signature and Hedera executes the schedule.
> The treasury moved by exactly the mandated amount, and the verdict is written to a
> Hedera Consensus Service topic."

### Scene 4 — A paid refusal (1:45–2:35) — `npm run hosted-review refused`

> "Same agent, same guard, same price. This time the transfer goes to an account outside
> the owner's allowlist."

Stop on the `REFUSED:` line.

> "The guard refuses. It still charges for the review — a refusal is a delivered service,
> not a failed request."

On the final evidence block:

> "And this is what refusal looks like on Hedera. There is no rejection state to point at.
> The proof is absence: the schedule exists, its executed timestamp is null, only the
> agent's key prefix is in the signature list, and the treasury balance is unchanged."

### Scene 5 — Independent verification (2:35–3:00)

Optionally show `curl https://countersign.gudman.xyz/guard` first — it returns the guard's
public key and HCS-14 identifier, free, which is how a caller identifies the service before
paying it.


Paste the refused ScheduleID into the mirror-node tab in the browser. Show the raw JSON.

> "None of this needs my code to check. That is the public Hedera mirror node, and every
> claim I just made is a field in it. The repository has the same links written down, plus
> the full evidence manifest."

Close:

> "Everything you saw ran on Hedera testnet. These are my own runs, not outside users, and
> the repository says so."

## What must not be said

Two claims from the original plan are **not true of this build**. Saying either on camera
would be caught by a Hedera-literate judge.

- **Do not say the guard "signs the exact transaction bytes."** It does not.
  `ScheduleSignTransaction` signs a body containing only the ScheduleID. The guard
  *resolves* that ScheduleID from consensus and validates the decoded fields, then
  authorizes the ScheduleID. The accurate framing is used throughout the script above.
- **Do not say the agent was prompt-injected.** There is no LLM agent and no injection in
  this repository. `make attack` proposes a transfer to a non-allowlisted recipient. Call
  it an out-of-policy transfer, or a compromised agent proposing one — not a demonstrated
  injection.

Three more wordings to keep honest, all of which the repository already follows:

- Say "the network rejects it", not "it fails at consensus".
- Say "my own runs" or "operator runs", never "users". Say "testnet trials", never
  "revenue".
- The guard **is** publicly hosted, at `https://countersign.gudman.xyz`, and you can say so.
  What you must not say is that it is multi-tenant or a marketplace: one guard process
  authorizes exactly one treasury, and a second treasury would need a second guard.

## After recording

The runs you record are real and they emit evidence events. Fold them in so the repository
and the video agree:

```bash
npm run build-evidence
git add web/evidence.json
git commit -m "chore: record the demo session runs in the evidence manifest"
```

Then check the uploaded video plays, and that it is still between 2 and 4 minutes after
editing.
