# Sandbox service

Run `npm run serve-sandbox` after the separate provisioning and local mandate-signing steps.
It loads only `var/sandbox.env` and `var/sandbox-mandates.json`. It never reads an owner
private key or holds a guard private key. The deployed guard performs authorization.
The schedule/payment constructors in `hosted-review.ts` are private; this service uses
the same SDK sequence. Its exported endpoint resolver requires an additional UAID,
so this service uses the configured guard origin's `/review` route directly.

Configuration comes from the sandbox environment produced by provisioning:
tenant, guard origin, treasury, agent account/key, payer account/key, vendor and stranger.
`COUNTERSIGN_SANDBOX_PORT` defaults to `4030`, bound only to `127.0.0.1`.
`COUNTERSIGN_SANDBOX_BALANCE_FLOOR_TINYBARS` defaults to `100000000` for each of agent
and payer. The payment challenge comes from the configured origin and is restricted
to one exact testnet HBAR payment of `1000000` tinybars with a separate settlement fee payer.

| Route | Contract |
| --- | --- |
| `POST /sandbox/run` | Exactly `{ "recipient": "vendor" / "stranger" / "agent", "amountTinybars": "1000000" }`; amount is a minimal decimal string from `1000000` through `100000000`. Returns `202` with `runId` after its queued turn reaches the balance check and reserves an envelope. |
| `GET /sandbox/run/{runId}` | Ordered envelope, schedule, payment and verdict steps; each is `pending`, `running`, `done`, `failed` or `never-happened`. Produced nonce, schedule ID, settlement ID and HCS verdict URL are on the run. Unknown ID returns `404`. |
| `GET /sandbox/runs` | Newest first, last 20 summaries with recipient, amount, outcome and schedule ID. Evidence remains available after exhaustion. |

Every response carries `origin: "operator"` and the disclosure: “Accounts and funding
are operator-owned. These are operator-run reliability exercises, not users.”
Approval describes the guard's authorization verdict; it does not claim independent
confirmation of schedule execution.

Invalid input, malformed JSON and bodies above 8 KB return `400`. A one-token bucket
per client address refills after 30 seconds; excess requests return `429`. The client
address is the proxy's `X-Real-IP` when present, because the service binds loopback only
and every socket peer is nginx; nginx overwrites that header from `$remote_addr`. A caller
reaching the service directly on the host could therefore set it, which the structural
envelope ceiling still bounds.
Envelope exhaustion returns `503` with `sandbox pre-signed envelopes exhausted`.
A low balance returns `503` with `sandbox budget exhausted`. Concurrent requests wait
for their turn; balance checks and the entire schedule/payment/review flow are serialized.
At most two runs may wait, including a run currently checking balances; a run whose
envelope consumption has been persisted no longer counts as waiting. When that queue
is full, otherwise eligible requests return `503` with `sandbox busy; try again shortly`
without consuming an address token or reserving an envelope. Genuine envelope exhaustion
still takes precedence. The page uses its generic retry guidance for busy responses,
not its terminal exhaustion copy. This small cap limits reservation bursts and waiting
behind active work; it does not guarantee a response before a proxy timeout or prevent
sustained requests from distinct addresses from eventually consuming the envelope budget.
Incoming headers and request bodies have timeouts; outbound operations are bounded.

Keep `var/sandbox-runs.sqlite` with the mandate file. It persists envelope consumption
before transactions, including failed/refused exercises, and retains run evidence.
Restarting never retries an interrupted run; its authorization outcome is unknown and
the envelope stays consumed. Replacing the mandate set fails closed against this ledger.
Do not delete the ledger to replenish the budget. Operate a single service instance.

Offline checks: `node --test --experimental-strip-types test/sandbox.test.ts`,
`npm run typecheck`, `npm test`, and `python -m pytest python/ -q`.
This slice does not provision accounts, change the live tenant, configure nginx or deploy.
