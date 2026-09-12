// THE GATE: can an account whose key is a nested threshold KeyList pay an x402 invoice
// through the Blocky402 facilitator, signing with only the inner 2-of branch?
//
// The treasury key is 1-of[owner, 2-of[agent, guard]]. Signing with the owner alone would
// satisfy the outer 1-of and prove nothing, so this spike signs with the agent and guard
// keys ONLY. If the facilitator settles that, the guarded treasury can pay any Hedera x402
// seller with no change to any seller or facilitator.
import {
  AccountCreateTransaction,
  AccountId,
  Client,
  Hbar,
  KeyList,
  PrivateKey,
  TransferTransaction,
  TransactionId,
} from "@hiero-ledger/sdk";
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type HTTPAdapter,
} from "@x402/core/server";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";

import { ExactHederaScheme as ServerScheme } from "@x402/hedera/exact/server";
import { ExactHederaScheme as ClientScheme } from "@x402/hedera/exact/client";

const FACILITATOR_URL = "https://api.testnet.blocky402.com";
const HEDERA_TESTNET = "hedera:testnet";
const HBAR_ASSET_ID = "0.0.0";
const PRICE_TINYBARS = "1000000";
const RESOURCE_URL = "https://spike.invalid/gate";

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (value == null || value.length === 0) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

function adapter(paymentSignatureHeader?: string): HTTPAdapter {
  return {
    getHeader: (name) =>
      name.toLowerCase() === "payment-signature"
        ? paymentSignatureHeader
        : undefined,
    getMethod: () => "POST",
    getPath: () => "/gate",
    getUrl: () => RESOURCE_URL,
    getAcceptHeader: () => "application/json",
    getUserAgent: () => "Countersign-Gate",
  };
}

// Same interface as createClientHederaSigner, but applies the two inner-branch signatures.
function createCoSignedSigner(
  accountId: string,
  agentKey: PrivateKey,
  guardKey: PrivateKey,
  client: Client,
) {
  return {
    accountId,
    createPartiallySignedTransferTransaction: async (requirements: {
      network: string;
      amount: string;
      asset: string;
      payTo: string;
      extra?: { feePayer?: unknown };
    }) => {
      const feePayer = requirements.extra?.feePayer;
      if (typeof feePayer !== "string") {
        throw new Error("feePayer is required in paymentRequirements.extra");
      }
      const amount = BigInt(requirements.amount);
      const transaction = new TransferTransaction()
        .addHbarTransfer(
          AccountId.fromString(accountId),
          Hbar.fromTinybars((-amount).toString()),
        )
        .addHbarTransfer(
          AccountId.fromString(requirements.payTo),
          Hbar.fromTinybars(amount.toString()),
        )
        .setTransactionId(
          TransactionId.generate(AccountId.fromString(feePayer)),
        )
        .freezeWith(client);
      const agentSigned = await transaction.sign(agentKey);
      const bothSigned = await agentSigned.sign(guardKey);
      return Buffer.from(bothSigned.toBytes()).toString("base64");
    },
  };
}

async function main(): Promise<void> {
  const operatorAccountId = AccountId.fromString(
    requireEnvironmentVariable("HEDERA_OPERATOR_ACCOUNT_ID"),
  );
  const operatorKey = PrivateKey.fromStringDer(
    requireEnvironmentVariable("HEDERA_OPERATOR_PRIVATE_KEY"),
  );
  const client = Client.forTestnet().setOperator(
    operatorAccountId,
    operatorKey,
  );

  const ownerKey = PrivateKey.generateED25519();
  const agentKey = PrivateKey.generateED25519();
  const guardKey = PrivateKey.generateED25519();
  const treasuryKey = new KeyList(
    [
      ownerKey.publicKey,
      new KeyList([agentKey.publicKey, guardKey.publicKey], 2),
    ],
    1,
  );

  console.log("Creating a 1-of[owner, 2-of[agent, guard]] treasury...");
  const receipt = await (
    await new AccountCreateTransaction()
      .setKeyWithoutAlias(treasuryKey)
      .setInitialBalance(Hbar.fromTinybars("500000000"))
      .execute(client)
  ).getReceipt(client);
  const treasuryAccountId = receipt.accountId;
  if (treasuryAccountId == null) {
    throw new Error("treasury account creation returned no account ID");
  }
  console.log(`  treasury: ${treasuryAccountId.toString()}`);
  console.log(
    `  https://testnet.mirrornode.hedera.com/api/v1/accounts/${treasuryAccountId.toString()}`,
  );

  try {
    const resourceServer = new x402ResourceServer(
      new HTTPFacilitatorClient({ url: FACILITATOR_URL }),
    ).register(HEDERA_TESTNET, new ServerScheme());
    const httpServer = new x402HTTPResourceServer(resourceServer, {
      "POST /gate": {
        accepts: {
          scheme: "exact",
          network: HEDERA_TESTNET,
          payTo: operatorAccountId.toString(),
          price: { asset: HBAR_ASSET_ID, amount: PRICE_TINYBARS },
          extra: { paymentFlow: "upfront" },
        },
        resource: RESOURCE_URL,
        description: "KeyList payer gate",
        mimeType: "application/json",
        serviceName: "CountersignGate",
      },
    });
    await httpServer.initialize();

    console.log("\n[1] Unpaid request -> expecting a 402 challenge");
    const challenge = await httpServer.processHTTPRequest({
      adapter: adapter(),
      path: "/gate",
      method: "POST",
    });
    if (
      challenge.type !== "payment-error" ||
      challenge.response.status !== 402
    ) {
      throw new Error(`expected a 402 challenge, got ${challenge.type}`);
    }
    console.log("  402 received");

    console.log(
      "\n[2] Building the payment, signed by AGENT + GUARD only (never the owner)",
    );
    const payer = new x402Client()
      .register(
        HEDERA_TESTNET,
        new ClientScheme(
          createCoSignedSigner(
            treasuryAccountId.toString(),
            agentKey,
            guardKey,
            client,
          ),
        ),
      )
      .setSpendControls({
        allowedAssets: [
          {
            network: HEDERA_TESTNET,
            asset: HBAR_ASSET_ID,
            maxAmountPerPayment: PRICE_TINYBARS,
          },
        ],
      });
    const httpPayer = new x402HTTPClient(payer);
    const challengeHeaders = challenge.response.headers;
    const paymentRequired = httpPayer.getPaymentRequiredResponse(
      (name: string) =>
        challengeHeaders[name] ?? challengeHeaders[name.toLowerCase()],
      challenge.response.body,
    );
    const paymentPayload =
      await httpPayer.createPaymentPayload(paymentRequired);
    const header =
      httpPayer.encodePaymentSignatureHeader(paymentPayload)[
        "PAYMENT-SIGNATURE"
      ];
    console.log("  payload built");

    console.log("\n[3] Submitting to Blocky402 for verify + settle");
    const paid = await httpServer.processHTTPRequest({
      adapter: adapter(header),
      path: "/gate",
      method: "POST",
      paymentHeader: header,
    });

    if (paid.type !== "payment-verified") {
      console.log("\n=== GATE FAILED — facilitator did not verify ===");
      console.log(JSON.stringify(paid, null, 2).slice(0, 2000));
      return;
    }
    const settlement = paid.beforeHandlerSettlement;
    if (settlement === undefined) {
      console.log("\n=== GATE FAILED — verified but never settled ===");
      return;
    }
    const settlementId = settlement.result.transaction;
    console.log(`  settlement id: ${settlementId}`);
    const mirrorId = settlementId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
    console.log(
      `  https://testnet.mirrornode.hedera.com/api/v1/transactions/${mirrorId}`,
    );
    console.log(
      "\n=== GATE PASSED — a threshold-key treasury paid an x402 invoice ===",
    );
  } finally {
    console.log("\nCleanup: returning the treasury balance to the operator");
    try {
      const balance = Hbar.fromTinybars("400000000");
      const sweep = await new TransferTransaction()
        .addHbarTransfer(treasuryAccountId, balance.negated())
        .addHbarTransfer(operatorAccountId, balance)
        .freezeWith(client)
        .sign(agentKey);
      const swept = await sweep.sign(guardKey);
      await (await swept.execute(client)).getReceipt(client);
      console.log("  recovered");
    } catch (error) {
      console.log(`  cleanup failed: ${(error as Error).message}`);
    }
    client.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    `\nGate spike failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
