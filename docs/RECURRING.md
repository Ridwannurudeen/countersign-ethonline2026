# Recurring payments from single-use authorizations

The owner pre-authorizes discrete occurrences. The controller requests one on each
interval; every occurrence gets its own Hedera ScheduleCreate, HBAR x402 review
payment, independent guard decision and HCS verdict. A refusal or failure ends the
run. **This is not a standing allowance.** No authorization renews itself.

```sh
npm run recurring-payments -- --count 3 --interval-seconds 35
```

Those are also the defaults. The recipient is the existing sandbox allowlisted
vendor; each proposal transfers `1000000` tinybars (0.01 HBAR). Count must be from
1 through 200, and interval from 30 through 86400 whole seconds. The lower interval
bound respects the sandbox's per-address admission policy. Start times are separated
by the requested interval when work completes in time. Slow authorization or mirror
indexing delays the next occurrence; missed times are not accumulated for catch-up.
The controller must remain running: this is a process timer, not a Hedera-native
recurrence instruction or streaming transfer.

## Shared serialization and evidence

Run from the repository root with the existing `var/sandbox.env` and
`var/sandbox-mandates.json`. Only public configuration fields are used locally;
the controller does not read a private key, re-sign an envelope or edit those files.

The controller submits `{recipient: "vendor", amountTinybars: "1000000"}` to
`https://countersign.gudman.xyz/sandbox/run`. The existing sandbox service owns the
live durable envelope ledger and creates the ScheduleCreate, pays the x402 fee and
calls the guard's `/review` endpoint. Reusing this queue is essential: choosing a
nonce locally would race sandbox visitors. The entire schedule/payment/review flow
is serialized by that service, across visitors and controllers. No second service,
direct `/review` caller, nonce counter or signing implementation is introduced.

The service reserves its next unused envelope before creating a schedule. The
controller waits for the final run record and HCS evidence before requesting another
occurrence. It checks strictly increasing assigned nonces against the local set and
binds the decoded HCS verdict to the mandate digest, tenant, schedule, settlement and
outcome. Other visitors may consume intervening nonces. HBAR remains the review
settlement asset under the existing sandbox payment policy.

Each invocation writes `var/recurring-<uuid>.jsonl`, including observations before
admission, the run ID, nonce, schedule ID, settlement ID, HCS URL and decoded verdict.
The final table prints occurrence, nonce, schedule ID, outcome and mirror-node URL.
`approved` means guard authorization with matching HCS evidence; it does not alone
assert independent confirmation of the scheduled transfer's execution.

Admission requests are never retried. Refusal, service failure, rate limiting,
exhaustion, malformed evidence or polling failure stops the run with a nonzero exit.
An interrupted or timed-out request may already have consumed an envelope or paid
the review fee. Inspect its journal and `/sandbox/run/{runId}` before another
invocation. There is no automatic resume. Preserve the service's nonce ledger.

## What bounds it

For a set of N owner-signed envelopes, the guard can authorize at most N distinct
occurrences, bounded in amount by the sum of their individual caps. Single-use
nonces and the tenant's ascending high-water mark enforce that ceiling even if a
controller misbehaves. Every occurrence remains individually refusable.

The reused sandbox set contains 200 authorizations, nonces `1001–1200`, each capped
at `50000000` tinybars (0.5 HBAR) and valid for 30 days. This command requests N
occurrences from the remaining shared set. **`--count` is a controller limit, not a
new cryptographic ceiling on the entire sandbox.** Likewise, the fixed 0.01 HBAR
proposal is below the existing per-envelope cap; the command does not narrow or
raise that signed cap. Review and network fees are separate from the authorized
treasury transfer amount. The finite signed set, its caps and expiration remain
the structural authorization ceiling.

Accounts and funding are operator-owned; live runs are testnet authorization
exercises. Offline tests use the actual sandbox queue with simulated schedule,
payment and mirror boundaries, without network calls:

```sh
node --test --experimental-strip-types test/recurring-payments.test.ts
npm run typecheck
npm test
python -m pytest python/ -q
```

## Observed live run: 2026-09-13

The command above completed with these actual results. Read-only mirror checks
also confirmed each scheduled transfer executed with `SUCCESS`, debiting treasury
`0.0.10511893` and crediting vendor `0.0.10511898` exactly `1000000` tinybars.
Every review settlement was `SUCCESS`, paying `1000000` tinybars of HBAR from
`0.0.10511896` to `0.0.10502371`. These execution checks were performed separately
after the controller finished.

| Occurrence | Start (UTC) | Nonce | Schedule | HBAR review settlement | HCS verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | 11:54:46.550 | 1010 | [0.0.10522683](https://testnet.mirrornode.hedera.com/api/v1/schedules/0.0.10522683) | [0.0.7162784@1789300481.903747133](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789300481-903747133) | [approved, message 9](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10511981/messages/9) |
| 2 | 11:55:21.564 | 1011 | [0.0.10522695](https://testnet.mirrornode.hedera.com/api/v1/schedules/0.0.10522695) | [0.0.7162784@1789300518.821766363](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789300518-821766363) | [approved, message 10](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10511981/messages/10) |
| 3 | 11:55:56.570 | 1012 | [0.0.10522705](https://testnet.mirrornode.hedera.com/api/v1/schedules/0.0.10522705) | [0.0.7162784@1789300553.407023610](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789300553-407023610) | [approved, message 11](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10511981/messages/11) |

The corresponding scheduled transfer records are
[occurrence 1](https://testnet.mirrornode.hedera.com/api/v1/transactions?timestamp=1789300492.824045225),
[occurrence 2](https://testnet.mirrornode.hedera.com/api/v1/transactions?timestamp=1789300528.653377838), and
[occurrence 3](https://testnet.mirrornode.hedera.com/api/v1/transactions?timestamp=1789300565.319241105).
