// Measures the guarded-buyer loop against the transaction validity window.
//
// The loop is: the agent freezes a purchase (the validity clock starts) -> the agent pays the
// guard, which is itself a full x402 settlement -> the guard reviews and countersigns -> the
// agent submits to the seller -> the seller settles. Everything after the freeze must finish
// inside transactionValidDuration, which the SDK defaults to 120 seconds and which
// @x402/hedera never overrides.
//
// This measures each real phase so the budget is known before the loop is built.
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
const RESOURCE_URL = "https://spike.invalid/loop";
const LIVE_GUARD = "https://countersign.gudman.xyz";

const marks: { label: string; ms: number }[] = [];
let last = 0;
function mark(label: string): void {
  const now = performance.now();
  marks.push({ label, ms: now - last });
  last = now;
}

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
    getPath: () => "/loop",
    getUrl: () => RESOURCE_URL,
    getAcceptHeader: () => "application/json",
    getUserAgent: () => "Countersign-Loop",
  };
}

function coSigner(
  accountId: string,
  a: PrivateKey,
  g: PrivateKey,
  client: Client,
) {
  return {
    accountId,
    createPartiallySignedTransferTransaction: async (r: {
      amount: string;
      payTo: string;
      extra?: { feePayer?: unknown };
    }) => {
      const feePayer = r.extra?.feePayer;
      if (typeof feePayer !== "string") {
        throw new Error("feePayer is required");
      }
      const amount = BigInt(r.amount);
      const tx = new TransferTransaction()
        .addHbarTransfer(
          AccountId.fromString(accountId),
          Hbar.fromTinybars((-amount).toString()),
        )
        .addHbarTransfer(
          AccountId.fromString(r.payTo),
          Hbar.fromTinybars(amount.toString()),
        )
        .setTransactionId(
          TransactionId.generate(AccountId.fromString(feePayer)),
        )
        .setTransactionValidDuration(180)
        .freezeWith(client);
      return Buffer.from((await (await tx.sign(a)).sign(g)).toBytes()).toString(
        "base64",
      );
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

  const receipt = await (
    await new AccountCreateTransaction()
      .setKeyWithoutAlias(treasuryKey)
      .setInitialBalance(Hbar.fromTinybars("500000000"))
      .execute(client)
  ).getReceipt(client);
  const treasury = receipt.accountId;
  if (treasury == null) throw new Error("no treasury account id");
  console.log(`treasury: ${treasury.toString()}\n`);

  try {
    const httpServer = new x402HTTPResourceServer(
      new x402ResourceServer(
        new HTTPFacilitatorClient({ url: FACILITATOR_URL }),
      ).register(HEDERA_TESTNET, new ServerScheme()),
      {
        "POST /loop": {
          accepts: {
            scheme: "exact",
            network: HEDERA_TESTNET,
            payTo: operatorAccountId.toString(),
            price: { asset: HBAR_ASSET_ID, amount: PRICE_TINYBARS },
            extra: { paymentFlow: "upfront" },
          },
          resource: RESOURCE_URL,
          description: "loop timing",
          mimeType: "application/json",
          serviceName: "CountersignLoop",
        },
      },
    );
    await httpServer.initialize();

    last = performance.now();
    const start = last;

    // Phase 1 — the agent freezes and co-signs the purchase. The validity clock starts here.
    const payer = new x402Client()
      .register(
        HEDERA_TESTNET,
        new ClientScheme(
          coSigner(treasury.toString(), agentKey, guardKey, client),
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
    const challenge = await httpServer.processHTTPRequest({
      adapter: adapter(),
      path: "/loop",
      method: "POST",
    });
    if (challenge.type !== "payment-error")
      throw new Error("expected a 402 challenge");
    mark("1. seller 402 challenge");

    const headers = challenge.response.headers;
    const required = httpPayer.getPaymentRequiredResponse(
      (n: string) => headers[n] ?? headers[n.toLowerCase()],
      challenge.response.body,
    );
    const payload = await httpPayer.createPaymentPayload(required);
    mark("2. freeze + agent/guard co-sign  [CLOCK STARTS]");

    // Phase 3 — the guard-payment step: a full round trip to the live guard, which answers 402.
    const guardStart = performance.now();
    await fetch(`${LIVE_GUARD}/.well-known/agent.json`).catch(() => undefined);
    const guardResolve = performance.now() - guardStart;
    const reviewProbe = performance.now();
    await fetch(`${LIVE_GUARD}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenantId: "probe",
        mandateEnvelope: {},
        scheduleId: "0.0.1",
      }),
    }).catch(() => undefined);
    const guardRoundTrip = performance.now() - reviewProbe;
    mark("3. live guard: resolve + review round trip");

    // Phase 4 — the seller verifies and settles through Blocky402. The second settlement.
    const header =
      httpPayer.encodePaymentSignatureHeader(payload)["PAYMENT-SIGNATURE"];
    const paid = await httpServer.processHTTPRequest({
      adapter: adapter(header),
      path: "/loop",
      method: "POST",
      paymentHeader: header,
    });
    mark("4. facilitator verify + settle");

    const total = performance.now() - start;
    const afterFreeze = total - marks[0]!.ms - marks[1]!.ms;

    console.log("PHASE TIMINGS");
    for (const m of marks)
      console.log(`  ${m.label.padEnd(46)} ${(m.ms / 1000).toFixed(2)}s`);
    console.log(
      `\n  agent-card resolve                             ${(guardResolve / 1000).toFixed(2)}s`,
    );
    console.log(
      `  guard /review round trip                       ${(guardRoundTrip / 1000).toFixed(2)}s`,
    );
    console.log(
      `\n  TOTAL                                          ${(total / 1000).toFixed(2)}s`,
    );
    console.log(
      `  CONSUMED AFTER FREEZE (the budget that matters) ${(afterFreeze / 1000).toFixed(2)}s`,
    );
    console.log(
      `\n  budget at SDK default 120s: ${(120 - afterFreeze / 1000).toFixed(1)}s spare`,
    );
    console.log(
      `  budget at network max  180s: ${(180 - afterFreeze / 1000).toFixed(1)}s spare`,
    );
    console.log(
      `\n  settled: ${paid.type === "payment-verified" ? (paid.beforeHandlerSettlement?.result.transaction ?? "(verified, no settlement)") : "NOT VERIFIED — " + paid.type}`,
    );
  } finally {
    try {
      const amount = Hbar.fromTinybars("400000000");
      const sweep = await (
        await new TransferTransaction()
          .addHbarTransfer(treasury, amount.negated())
          .addHbarTransfer(operatorAccountId, amount)
          .freezeWith(client)
          .sign(agentKey)
      ).sign(guardKey);
      await (await sweep.execute(client)).getReceipt(client);
      console.log("\ncleanup: treasury balance recovered");
    } catch (error) {
      console.log(`\ncleanup failed: ${(error as Error).message}`);
    }
    client.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    `loop timing failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
