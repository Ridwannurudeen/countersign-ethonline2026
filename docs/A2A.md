# Authorization review over A2A

This is **task settlement over A2A, not open-ended negotiation**. A counterparty
agent submits a review task, receives the guard's x402 terms, accepts those terms
with a signed payment payload, and retrieves the authorization verdict. The
challenge and acceptance establish protocol terms; there is no counter-offer
bargaining.

The implementation is a separate, local adapter. It forwards the original request
and payment to the existing `/review` HTTP route. The guard still checks the owner
mandate, authorizes the tenant, settles payment, resolves the schedule, applies
policy, reserves the nonce, and records the verdict. `/review`, `/countersign`,
pricing, and the deployed server are unchanged.

## Protocol

The adapter implements the [A2A JSON-RPC protocol at version 0.3.0](https://a2a-protocol.org/v0.3.0/specification/),
which defines `message/send`, `tasks/get`, and `tasks/cancel`. Both
`/.well-known/agent.json` and `/.well-known/agent-card.json` publish the card. Its
`url` names `/a2a`, and it advertises the review skill, input/output modes, and
protocol version while retaining the upstream guard identity and HTTP service
entries.

Payments use the [x402 extension's standalone flow](https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2/spec.md).
The client activates it with `A2A-Extensions`. The initial message has one data
part containing the existing `tenantId`, `mandateEnvelope`, and `scheduleId` request.
The response is an `input-required` task whose status message metadata contains
`x402.payment.status: "payment-required"` and the unmodified decoded HTTP quote in
`x402.payment.required`.

The counterparty sends a new message with the returned `taskId` and `contextId`,
`x402.payment.status: "payment-submitted"`, and `x402.payment.payload`. The adapter
forwards that payload as `PAYMENT-SIGNATURE` to `/review`. A completed task contains
the verdict data artifact and the guard's settlement receipt in
`x402.payment.receipts`. A policy refusal is also a completed, paid review.

Only unpaid tasks can be canceled. Concurrent submissions to a working task return
its state without another payment submission. Terminal tasks cannot restart.
Failures retain available receipts; a failed task can still carry a successful
payment receipt. Transport failures can leave settlement uncertain. Inspect the
task and payment evidence before authorizing another payment.

## Local demonstration

Run from the repository root with the existing dependencies:

```powershell
node --test --experimental-strip-types --test-name-pattern="counterparty script" test/a2a.test.ts
```

This launches the counterparty CLI as a separate process and prints its actual
card, terms, receipt, and verdict events. HTTP, payer signatures, the payment gate,
policy review, and SQLite are real. Hedera consensus, facilitator settlement, and
HCS receipts are offline test doubles. Their account IDs and receipt URLs are
fixture values, **not live settlement evidence**. No funds move in this test.

To attach the adapter to an already configured local guard, pass the guard origin
and adapter origin to `scripts/serve-a2a.ts`:

```powershell
node --experimental-strip-types scripts/serve-a2a.ts $env:COUNTERSIGN_LOCAL_GUARD_ORIGIN $env:COUNTERSIGN_A2A_ORIGIN
node --experimental-strip-types scripts/a2a-client.ts $env:COUNTERSIGN_REVIEW_REQUEST_PATH
```

The request file contains an existing review request with its owner-signed mandate.
The client also requires these environment variables:

| Variable | Authorization input |
| --- | --- |
| `COUNTERSIGN_GUARD_UAID` | Expected guard identity |
| `COUNTERSIGN_GUARD_PUBLIC_KEY` | Exact public-key string published by the guard |
| `COUNTERSIGN_FEE_ACCOUNT_ID` | Authorized payment recipient |
| `COUNTERSIGN_A2A_MAX_PAYMENT_TINYBARS` | Maximum authorized review payment |
| `COUNTERSIGN_PAYER_ACCOUNT_ID` | Separate payment account |
| `COUNTERSIGN_PAYER_PRIVATE_KEY` | Payment key, supplied through the environment |

The CLI authorizes one payment submission and validates the returned verdict's
schedule, mandate digest, and settlement receipt. Running it against a local guard
configured for testnet performs that guard's real paid review; the offline test
above is the credential-free demonstration.

The adapter accepts HTTP loopback IP origins only. Its task IDs act as local
capability handles, not production tenant authentication. It retains at most 256
tasks in memory until restart and does not retain message history or expose signed
payment payloads through `tasks/get`. Streaming, push notifications, non-blocking
submission, and production hosting are outside this local implementation.
