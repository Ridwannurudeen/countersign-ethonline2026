import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  ScheduleCreateTransaction,
  type ScheduleId,
  Timestamp,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

import {
  accountMirrorNodeUrl,
  assertExecutedScheduleEvidence,
  assertPendingScheduleEvidence,
  parseScheduleEvidence,
  scheduleMirrorNodeUrl,
  type ScheduleEvidence,
} from "../src/evidence-links.ts";
import {
  canonicalMandateBytes,
  mandateDigest,
  parseMandateEnvelope,
  verifyMandateSignature,
  type Mandate,
  type MandateEnvelope,
} from "../src/mandate.ts";

// A caller that pays the guard over the public internet.
//
// The narrated flows start the guard in their own process and talk to it on
// loopback, which proves the protocol but not that the service exists for
// anyone else. This script holds only the keys a treasury owner would hold and
// sends its review request to whatever COUNTERSIGN_GUARD_URL points at, so the
// guard being reviewed is a separate process on a separate machine.
//
// Pass "refused" to propose a transfer to an account outside the mandate
// allowlist. The caller pays for that review exactly as it pays for an approval.

const HEDERA_TESTNET = "hedera:testnet";
const HBAR_ASSET_ID = "0.0.0";
const PROTOCOL_MAX_FEE_TINYBARS = "100000000";
const REVIEW_PRICE_TINYBARS = "1000000";
const MANDATE_CAP_TINYBARS = "50000000";
const TRANSFER_TINYBARS = "25000000";
const MIRROR_ATTEMPTS = 20;
const MIRROR_RETRY_MILLISECONDS = 1_500;

type Outcome = "approved" | "refused";

interface ReviewResponseBase {
  readonly scheduleId: string;
  readonly mandateDigest: string;
  readonly settlementId: string;
  readonly mirrorNodeUrl: string;
}

type ReviewResponse =
  | (ReviewResponseBase & { readonly outcome: "approved" })
  | (ReviewResponseBase & {
      readonly outcome: "refused";
      readonly reason: string;
    });

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} must be set`);
  }

  return value.trim();
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }

  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }

  return value;
}

function parseReviewResponse(value: unknown): ReviewResponse {
  const record = requireRecord(value, "review response");
  const base = {
    scheduleId: requireString(record.scheduleId, "scheduleId"),
    mandateDigest: requireString(record.mandateDigest, "mandateDigest"),
    settlementId: requireString(record.settlementId, "settlementId"),
    mirrorNodeUrl: requireString(record.mirrorNodeUrl, "mirrorNodeUrl"),
  };
  const outcome = requireString(record.outcome, "outcome");
  if (outcome === "approved") {
    return { ...base, outcome: "approved" };
  }
  if (outcome === "refused") {
    return {
      ...base,
      outcome: "refused",
      reason: requireString(record.reason, "reason"),
    };
  }

  throw new TypeError("review outcome must be approved or refused");
}

async function fetchScheduleEvidence(
  scheduleId: ScheduleId,
): Promise<ScheduleEvidence> {
  const response = await fetch(scheduleMirrorNodeUrl(scheduleId));
  if (!response.ok) {
    throw new Error(
      `mirror node returned HTTP ${response.status} for ${scheduleId.toString()}`,
    );
  }

  return parseScheduleEvidence(await response.json());
}

// The mirror node is eventually consistent, so a schedule that consensus has
// already accepted reads as 404 for a moment. That is transient absence, not
// evidence of anything, and it must not be confused with a schedule that does
// not exist or did not execute.
async function waitForScheduleEvidence(
  scheduleId: ScheduleId,
): Promise<ScheduleEvidence> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MIRROR_ATTEMPTS; attempt += 1) {
    try {
      return await fetchScheduleEvidence(scheduleId);
    } catch (error) {
      lastError = error;
      await sleep(MIRROR_RETRY_MILLISECONDS);
    }
  }

  throw new Error(
    `mirror node did not return ${scheduleId.toString()} within ${MIRROR_ATTEMPTS} attempts`,
    { cause: lastError },
  );
}

async function waitForExecutedScheduleEvidence(
  scheduleId: ScheduleId,
): Promise<ScheduleEvidence> {
  let evidence = await waitForScheduleEvidence(scheduleId);
  for (
    let attempt = 0;
    attempt < MIRROR_ATTEMPTS && evidence.executedTimestamp === null;
    attempt += 1
  ) {
    await sleep(MIRROR_RETRY_MILLISECONDS);
    evidence = await waitForScheduleEvidence(scheduleId);
  }

  return evidence;
}

function printScheduleEvidence(evidence: ScheduleEvidence): void {
  console.log(
    JSON.stringify(
      {
        creator_account_id: evidence.creatorAccountId,
        payer_account_id: evidence.payerAccountId,
        executed_timestamp: evidence.executedTimestamp,
        deleted: evidence.deleted,
        signer_public_keys: evidence.publicKeyPrefixes,
      },
      null,
      2,
    ),
  );
}

function requirePaymentQuote(
  paymentRequired: PaymentRequired,
  payTo: string,
  payerAccountId: string,
) {
  if (paymentRequired.accepts.length !== 1) {
    throw new Error("guard must return exactly one x402 payment option");
  }
  const quote = paymentRequired.accepts[0];
  if (
    quote.scheme !== "exact" ||
    quote.network !== HEDERA_TESTNET ||
    quote.asset !== HBAR_ASSET_ID ||
    quote.amount !== REVIEW_PRICE_TINYBARS ||
    quote.payTo !== payTo
  ) {
    throw new Error("x402 quote does not match the expected review payment");
  }

  // The challenge names the account that pays the Hedera transaction fee for the
  // settlement. An endpoint that names this caller would have it fund the
  // facilitator's submission as well as the review, so refuse anything but the
  // facilitator's own fee payer.
  const feePayer = (quote.extra as { feePayer?: unknown } | undefined)?.feePayer;
  if (typeof feePayer !== "string" || feePayer === "") {
    throw new Error("x402 quote must name the facilitator fee payer");
  }
  if (feePayer === payerAccountId) {
    throw new Error(
      "x402 quote names this caller as the settlement fee payer; refusing",
    );
  }

  return quote;
}

function buildMandate(
  tenantId: string,
  ownerPrivateKey: PrivateKey,
  treasuryAccountId: string,
  allowedRecipientAccountId: string,
  nowEpochSeconds: number,
): MandateEnvelope {
  const mandate: Mandate = {
    tenantId,
    nonce: Date.now().toString(),
    treasuryAccountId,
    recipientAllowlist: [allowedRecipientAccountId],
    maxAmountTinybars: MANDATE_CAP_TINYBARS,
    validFromEpochSeconds: (nowEpochSeconds - 60).toString(),
    expiresAtEpochSeconds: (nowEpochSeconds + 3_600).toString(),
  };
  const signature = Buffer.from(
    ownerPrivateKey.sign(canonicalMandateBytes(mandate)),
  ).toString("base64url");
  const envelope = parseMandateEnvelope({ mandate, signature });
  if (!verifyMandateSignature(envelope, ownerPrivateKey.publicKey)) {
    throw new Error("owner mandate signature verification failed");
  }

  return envelope;
}

async function main(): Promise<void> {
  const requested = process.argv[2] ?? "approved";
  if (requested !== "approved" && requested !== "refused") {
    throw new Error('outcome argument must be "approved" or "refused"');
  }
  const outcome: Outcome = requested;

  const tenantId = requireEnvironmentVariable("COUNTERSIGN_TENANT_ID");
  const guardUrl = requireEnvironmentVariable("COUNTERSIGN_GUARD_URL");
  const ownerPrivateKey = PrivateKey.fromStringDer(
    requireEnvironmentVariable("COUNTERSIGN_OWNER_PRIVATE_KEY"),
  );
  const agentPrivateKey = PrivateKey.fromStringDer(
    requireEnvironmentVariable("COUNTERSIGN_AGENT_PRIVATE_KEY"),
  );
  const payerPrivateKey = PrivateKey.fromStringDer(
    requireEnvironmentVariable("COUNTERSIGN_PAYER_PRIVATE_KEY"),
  );
  const treasuryAccountId = requireEnvironmentVariable(
    "COUNTERSIGN_TREASURY_ACCOUNT_ID",
  );
  const agentAccountId = requireEnvironmentVariable(
    "COUNTERSIGN_AGENT_ACCOUNT_ID",
  );
  const payerAccountId = requireEnvironmentVariable(
    "COUNTERSIGN_PAYER_ACCOUNT_ID",
  );
  const feeAccountId = requireEnvironmentVariable("COUNTERSIGN_FEE_ACCOUNT_ID");
  const allowedRecipientAccountId = requireEnvironmentVariable(
    "COUNTERSIGN_ALLOWED_RECIPIENT_ACCOUNT_ID",
  );
  const guardPublicKeyRaw = requireEnvironmentVariable(
    "COUNTERSIGN_GUARD_PUBLIC_KEY_RAW",
  );

  // The refused run proposes a transfer to the payer account, which is a real
  // account that is deliberately absent from the mandate allowlist.
  const recipientAccountId =
    outcome === "approved" ? allowedRecipientAccountId : payerAccountId;

  const agentClient = Client.forTestnet().setOperator(
    AccountId.fromString(agentAccountId),
    agentPrivateKey,
  );

  try {
    console.log(
      `\nCOUNTERSIGN: ${outcome === "approved" ? "ALLOWED" : "REFUSED"} TRANSFER, REVIEWED BY A REMOTE GUARD\n`,
    );
    console.log("[1/5] The guard under test");
    console.log(`  Guard endpoint: ${guardUrl}`);
    console.log(`  Treasury: ${treasuryAccountId}`);
    console.log(`  Agent: ${agentAccountId}`);
    console.log(`  Proposed recipient: ${recipientAccountId}`);
    console.log(
      `  This process holds the owner, agent and payer keys. It does not hold the guard key.`,
    );

    const nowEpochSeconds = Math.floor(Date.now() / 1_000);
    const envelope = buildMandate(
      tenantId,
      ownerPrivateKey,
      treasuryAccountId,
      allowedRecipientAccountId,
      nowEpochSeconds,
    );
    const digest = mandateDigest(envelope.mandate);
    console.log("\n[2/5] Owner-signed mandate");
    console.log(
      JSON.stringify({ ...envelope, mandateDigest: digest }, null, 2),
    );

    console.log("\n[3/5] Agent publishes a scheduled transfer");
    const amount = Hbar.fromTinybars(TRANSFER_TINYBARS);
    const transfer = new TransferTransaction()
      .addHbarTransfer(
        AccountId.fromString(treasuryAccountId),
        amount.negated(),
      )
      .addHbarTransfer(AccountId.fromString(recipientAccountId), amount)
      .setMaxTransactionFee(Hbar.fromTinybars(PROTOCOL_MAX_FEE_TINYBARS))
      .setTransactionMemo(digest);
    const scheduleResponse = await new ScheduleCreateTransaction()
      .setScheduledTransaction(transfer)
      .setPayerAccountId(AccountId.fromString(agentAccountId))
      .setScheduleMemo(digest)
      .setExpirationTime(
        Timestamp.fromDate(new Date((nowEpochSeconds + 1_800) * 1_000)),
      )
      .setWaitForExpiry(false)
      .execute(agentClient);
    const scheduleReceipt = await scheduleResponse.getReceipt(agentClient);
    if (scheduleReceipt.scheduleId == null) {
      throw new Error("schedule creation receipt did not contain a ScheduleID");
    }
    const scheduleId = scheduleReceipt.scheduleId;
    console.log(`  ScheduleID: ${scheduleId.toString()}`);
    console.log(`  Amount: ${TRANSFER_TINYBARS} tinybars`);
    console.log(`  Evidence: ${scheduleMirrorNodeUrl(scheduleId)}`);

    const expectedEvidence = {
      expectedAgentAccountId: agentAccountId,
      agentPublicKeyHex: agentPrivateKey.publicKey.toStringRaw(),
      guardPublicKeyHex: guardPublicKeyRaw,
    };
    let pendingEvidence = await waitForScheduleEvidence(scheduleId);
    for (
      let attempt = 0;
      attempt < MIRROR_ATTEMPTS && pendingEvidence.publicKeyPrefixes.length === 0;
      attempt += 1
    ) {
      await sleep(MIRROR_RETRY_MILLISECONDS);
      pendingEvidence = await waitForScheduleEvidence(scheduleId);
    }
    assertPendingScheduleEvidence(pendingEvidence, expectedEvidence);
    printScheduleEvidence(pendingEvidence);
    console.log(
      "  The agent signature is present, but the schedule is unexecuted.",
    );

    const reviewRequest = {
      tenantId,
      mandateEnvelope: envelope,
      scheduleId: scheduleId.toString(),
    };

    console.log("\n[4/5] Pay the remote guard over x402");
    const challengeResponse = await fetch(guardUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(reviewRequest),
    });
    const challengeBody = (await challengeResponse.json()) as unknown;
    if (challengeResponse.status !== 402) {
      throw new Error(
        `guard did not return the required 402 challenge: HTTP ${challengeResponse.status}`,
      );
    }

    const payer = new x402Client()
      .register(
        HEDERA_TESTNET,
        new ExactHederaScheme(
          createClientHederaSigner(payerAccountId, payerPrivateKey, {
            network: HEDERA_TESTNET,
          }),
        ),
      )
      .setSpendControls({
        allowedAssets: [
          {
            network: HEDERA_TESTNET,
            asset: HBAR_ASSET_ID,
            maxAmountPerPayment: REVIEW_PRICE_TINYBARS,
          },
        ],
      });
    const httpPayer = new x402HTTPClient(payer);
    const paymentRequired = httpPayer.getPaymentRequiredResponse(
      (name) => challengeResponse.headers.get(name),
      challengeBody,
    );
    const quote = requirePaymentQuote(
      paymentRequired,
      feeAccountId,
      payerAccountId,
    );
    console.log("  HTTP 402 Payment Required");
    console.log(`  Quote: ${quote.amount} tinybars`);
    console.log(`  Network: ${quote.network}`);
    console.log(`  Pay to: ${quote.payTo}`);
    console.log(`  Account evidence: ${accountMirrorNodeUrl(quote.payTo)}`);

    const paymentPayload =
      await httpPayer.createPaymentPayload(paymentRequired);
    const paidResponse = await fetch(guardUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...httpPayer.encodePaymentSignatureHeader(paymentPayload),
      },
      body: JSON.stringify(reviewRequest),
    });
    const paidBody = (await paidResponse.json()) as unknown;
    if (!paidResponse.ok) {
      throw new Error(
        `paid guard review failed with HTTP ${paidResponse.status}: ${JSON.stringify(paidBody)}`,
      );
    }
    const settlement = httpPayer.getPaymentSettleResponse((name) =>
      paidResponse.headers.get(name),
    );
    if (!settlement.success) {
      throw new Error(
        `x402 settlement failed: ${settlement.errorReason ?? "unknown reason"}`,
      );
    }
    console.log(`  Settlement confirmed: ${settlement.transaction}`);

    const reviewResponse = parseReviewResponse(paidBody);
    if (reviewResponse.settlementId !== settlement.transaction) {
      throw new Error("guard settlement ID does not match the x402 response");
    }
    if (reviewResponse.scheduleId !== scheduleId.toString()) {
      throw new Error("guard response ScheduleID does not match the proposal");
    }
    if (reviewResponse.mandateDigest !== digest) {
      throw new Error(
        "guard response mandate digest does not match the mandate",
      );
    }

    console.log("\n[5/5] Independent outcome evidence");
    console.log(
      `  Review outcome: ${
        reviewResponse.outcome === "approved"
          ? "APPROVED"
          : `REFUSED: ${reviewResponse.reason}`
      }`,
    );

    if (outcome === "approved") {
      if (reviewResponse.outcome !== "approved") {
        throw new Error(
          `allowed transfer was refused: ${reviewResponse.reason}`,
        );
      }
      const executedEvidence =
        await waitForExecutedScheduleEvidence(scheduleId);
      assertExecutedScheduleEvidence(executedEvidence, expectedEvidence);
      printScheduleEvidence(executedEvidence);
      console.log(
        `  Execution timestamp: ${executedEvidence.executedTimestamp}`,
      );
    } else {
      if (reviewResponse.outcome !== "refused") {
        throw new Error("out-of-policy transfer was approved");
      }
      // A single unexecuted snapshot proves nothing: the mirror node lags, so an
      // execution that already happened can still read as absent. Re-read after a
      // delay, and assert the whole refusal shape rather than just the timestamp —
      // the agent's key must be present and the guard's must not.
      await sleep(MIRROR_RETRY_MILLISECONDS * 4);
      const refusedEvidence = await waitForScheduleEvidence(scheduleId);
      assertPendingScheduleEvidence(refusedEvidence, expectedEvidence);
      if (refusedEvidence.deleted) {
        throw new Error(
          "refused schedule was deleted rather than left unexecuted",
        );
      }
      printScheduleEvidence(refusedEvidence);
      console.log(
        "  The schedule exists, carries only the agent signature, and never executed.",
      );
    }

    console.log(`  Schedule evidence: ${scheduleMirrorNodeUrl(scheduleId)}`);
    console.log(`  Verdict evidence: ${reviewResponse.mirrorNodeUrl}`);

    // Recorded as an operator-run exercise. A remote endpoint does not make
    // these external users, and the manifest must keep saying so.
    const eventDirectory = resolve("var", "evidence-events");
    mkdirSync(eventDirectory, { recursive: true });
    const eventPath = resolve(eventDirectory, `${scheduleId.toString()}.json`);
    writeFileSync(
      eventPath,
      `${JSON.stringify(
        {
          kind: "review",
          guardPublicKeyPrefix: guardPublicKeyRaw,
          origin: "operator",
          scheduleId: scheduleId.toString(),
          outcome: reviewResponse.outcome,
          decidingInvariant:
            reviewResponse.outcome === "approved"
              ? "every protected field matched the owner-signed mandate"
              : reviewResponse.reason,
          mandateDigest: digest,
          mandatePolicy: {
            asset: { kind: "hbar" },
            recipientAllowlist: envelope.mandate.recipientAllowlist,
            maxAmountTinybars: envelope.mandate.maxAmountTinybars,
            validFromEpochSeconds: envelope.mandate.validFromEpochSeconds,
            expiresAtEpochSeconds: envelope.mandate.expiresAtEpochSeconds,
          },
          settlementId: settlement.transaction,
          settlementAmountTinybars: REVIEW_PRICE_TINYBARS,
          paymentPayerAccountId: payerAccountId,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`  Evidence event: ${eventPath}`);
  } finally {
    agentClient.close();
  }
}

await main();
