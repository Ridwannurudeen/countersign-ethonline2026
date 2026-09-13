# ETHOnline 2026 submission copy

The text entered into the ETHGlobal submission form, kept here so it can be reviewed and
edited outside the browser. Project created as **Countersign**, category **Security**,
emoji **🔏**, track **Building from Scratch**.

## Short description (max 100 characters)

> An agent's Hedera treasury cannot move until an independent guard, paid per decision, countersigns.

## Description

Autonomous agents are being handed treasuries. The usual protection is a policy check
inside the agent's own code — which a compromised agent simply skips.

Countersign removes that assumption. The treasury account holds a native Hedera key tree:
`1-of[ownerKey, 2-of[agentKey, guardKey]]`. The owner can always recover funds alone. The
agent alone satisfies neither branch — when it signs a transfer by itself, the Hedera
network rejects it with INVALID_SIGNATURE. Nothing inside the agent's process can talk its
way past that.

So the agent proposes instead. It publishes the transfer it wants as a Hedera Scheduled
Transaction — public, and unexecuted, carrying only its own signature. It then pays an
independent guard to review it. The guard answers HTTP 402 Payment Required, quotes its
price in HBAR, and settlement goes through the Blocky402 x402 facilitator on Hedera
testnet.

Only after settlement does the guard perform consensus authorization work. It resolves the ScheduleID from consensus —
it never trusts a summary the caller sent it — and checks every decoded field in the
supported transfer and schedule envelope against a
mandate the treasury owner signed: recipient allowlist, amount cap, asset, fee, expiry, who
created the schedule, who pays for it, and that its own key is not already on it. If every
check passes it adds its signature and Hedera executes the transfer. If one fails it
refuses, and the schedule simply never executes.

The caller pays either way. A refusal is a delivered service, not a failed request.

Refusal has no state of its own on Hedera, so it is proved by absence: the schedule exists,
its `executed_timestamp` is null, only the agent's key prefix appears in `signatures[]`, and
the treasury balance is unchanged. Every verdict is also written to a Hedera Consensus
Service topic. All of it is readable from the public mirror node without running any of my
code.

The guard is live at https://countersign.gudman.xyz. `GET /guard` returns its public key
and HCS-14 identifier for free, so a caller can identify the service before paying it, and
`POST /review` is the paid endpoint. The approved and refused runs linked from the repository were made from a
separate machine against that endpoint.

Anyone can put a proposal to that live guard at
https://countersign.gudman.xyz/sandbox.html: pick a recipient and an amount and watch it be
approved or refused, then read the outcome on the public mirror node. The sandbox holds no
owner key and no guard key, only mandate envelopes signed in advance that it cannot alter, so
a fixed number of single-use nonces is a structural ceiling on what it can spend.

Honest limits, also stated in the README: these are my own operator runs, not external
users, and testnet payments are paid protocol trials, not revenue. The sandbox accounts are
operator-owned and operator-funded, and its runs are counted separately and never summed into
the manifest. One guard process authorizes exactly one treasury, so this is not a marketplace
— a second treasury needs a second guard. HTS approval differs by route: the schedule path
(`POST /review`) refuses every token proposal because it does not resolve the token's
consensus fee state, while the transfer path (`POST /countersign`) resolves `TokenInfo` from
consensus and approves a fungible token only when it carries no custom fees and an immutable
fee schedule. That route was exercised live on 2026-09-13, moving a fungible token out of the guarded treasury; the x402 review fee itself remained HBAR. It was not exercised live
on testnet and no token run appears in the manifest.

## How it's made

TypeScript on Node 24, and no Solidity anywhere — Hedera native services only, through
`@hiero-ledger/sdk`.

The treasury is a nested KeyList, `1-of[ownerKey, 2-of[agentKey, guardKey]]`. Hedera
evaluates it at consensus, which is what makes the guarantee structural instead of
procedural. Scheduled Transactions are the product mechanism rather than decoration: they
are how a second signature arrives asynchronously. The agent's ScheduleCreate publishes the
exact transfer; the guard's ScheduleSign completes the threshold.

Payment is x402 through `@x402/core` and `@x402/hedera`, settled by the hosted Blocky402
facilitator on `hedera:testnet`. The exact-scheme 402 challenge quotes the price before
authorization work. `POST /countersign` meters request-derived work: a published base,
a prorated rate per 1,024 decoded transaction bytes, and a rate per transfer adjustment
across all submitted node variants, clamped to a configured positive floor and ceiling.
The challenge exposes those inputs, rates, bounds and the resulting amount so the caller
can reproduce it. `POST /review` remains flat because it receives only a ScheduleID and
fetches the body from consensus after settlement. This is not elapsed compute or post-usage
inference metering. Both routes still settle in HBAR before authorization review and signing.
The metering change has HTTP and payment-scheme test evidence and is deployed and live on the transfer path.
The fee is paid from a separately keyed operational account, so no treasury
authorization key ever enters a payment payload; startup asserts that separation and
refuses to run otherwise.

The validator is a pure function, and the subtle part is what it is allowed to trust.
`ScheduleInfo` returns an already-decoded body, and a protobuf decoder silently drops
fields it does not know. So the guard pins the exact HAPI protobuf and services versions,
reads them from the same consensus node both before and after resolving the schedule, and
refuses on any mismatch — a schema change makes it fail closed rather than approve
something it cannot see. It also rejects any body carrying a field outside the audited
schema.

Mandates are RFC 8785 JCS-canonicalized, domain-separated and Ed25519-signed by the owner,
so the agent cannot rewrite its own policy. They are single-use: the nonce is atomically
reserved in SQLite before approval, and only the request that wins the reservation may
submit ScheduleSign. Participant identity is HCS-14 for both agent and guard, and verdicts
go to immutable, submit-key-protected HCS topics with custom fees rejected at startup.

652 TypeScript tests and 13 Python tests, all offline. One defect the offline suite could not have caught
surfaced on the first live run: the mirror node returns `signatures[].public_key_prefix` as
base64 and three code paths expected hex. The fixtures used `"a".repeat(16)`, which is
itself valid base64, so they passed while asserting nothing about the real encoding. The
regression tests now run against verbatim mirror-node responses captured from that run.

The build briefs each task was run from, and a full AI usage disclosure, are published in
the repository.

## What else it does

**The review is metered, not a flat fee.** `POST /countersign` quotes 1,000,000 tinybars base plus
102,400 per 1,024 decoded bytes and 10,000 per transfer adjustment, with a 1,000,000 floor and a
10,000,000 ceiling. The challenge publishes the whole calculation, so a caller can reproduce the
quote and check what they were charged. `POST /review` stays flat because the request carries only
a ScheduleID and the body is fetched from consensus afterwards, so there is nothing to meter at
quote time.

**It authorizes HTS tokens, not only HBAR.** The transfer path approves a fungible token only when
consensus shows no custom fees and an immutable fee schedule. Exercised live on 2026-09-13: transfer
`0.0.10502370-1789298664-120630881` moved a token out of the guarded treasury. The x402 review fee
itself remained HBAR, so this is HTS in the guarded transfer, not as the settlement currency. The
schedule path still refuses every token proposal.

**Recurring payments are built from single-use authorizations.** Mandates permit one approval each,
so recurrence is a fixed number of pre-authorised occurrences spent on a timer rather than a standing
allowance. Three live occurrences on 2026-09-13 — schedules `0.0.10522683`, `0.0.10522695` and
`0.0.10522705`, each executed with both signatures, roughly 35 seconds apart. Every occurrence is
reviewed separately and the total can never exceed what the owner signed. This is a process timer,
not a Hedera-native recurrence instruction.

**An A2A adapter exposes the guard as a task.** A task submitted without payment returns the same
x402 terms the HTTP route quotes; the counterparty settles and the task completes with the verdict.
It is a standalone adapter, not wired into the deployed guard, and its end-to-end demonstration runs
against offline Hedera and facilitator responses rather than a live paid run. It demonstrates task
settlement over A2A, not open-ended negotiation.

**Not claimed: agent discovery.** Registration with a public agent registry was attempted and
rejected because the service does not fit its categories, and we declined to reclassify a
deterministic authorization service as an AI agent to get listed.


## Links

- **GitHub:** https://github.com/Ridwannurudeen/countersign-ethonline2026
- **Demonstration:** https://countersign.gudman.xyz/sandbox.html (drive the live guard yourself)
- **Guard identity:** https://countersign.gudman.xyz/guard (unpaid, returns the key and HCS-14 identifier)
- **Video:** pending recording

## Prize selection

Hedera — **AI & Agentic Payments**. This is the only track the build qualifies for. It does
not qualify for Hedera Harness (does not build from or contribute to `hedera-harness`) or
Hedera Tokenization (does not use ATS to issue or manage an asset), and no other partner
technology was integrated.
