import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";

import { AccountId, Client, PrivateKey, PublicKey } from "@hiero-ledger/sdk";

import { createProductionReviewServer } from "../src/server.ts";

// The long-running guard. The narrated flows start a review server on loopback
// for the duration of one run; this keeps the same server alive at a public
// origin so another machine can pay it.
//
// The configuration comes from var/hosted-guard.env, written by
// scripts/provision-hosted.ts. The only private key it carries is the guard's.
// createProductionReviewServer re-derives the treasury key tree from consensus
// at startup and refuses to serve unless the owner, agent and guard keys are
// pairwise distinct and the fee destination is separate from all three, so a
// mistake in that file stops the process instead of weakening a review.

const PROTOCOL_MAX_FEE_TINYBARS = "100000000";
const REVIEW_PRICE_TINYBARS = "1000000";

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} must be set`);
  }

  return value.trim();
}

async function listen(server: Server, port: number, host: string) {
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

async function main(): Promise<void> {
  const tenantId = requireEnvironmentVariable("COUNTERSIGN_TENANT_ID");
  const publicOrigin = requireEnvironmentVariable("COUNTERSIGN_PUBLIC_ORIGIN");
  const guardAccountId = requireEnvironmentVariable(
    "COUNTERSIGN_GUARD_ACCOUNT_ID",
  );
  const guardPrivateKey = PrivateKey.fromStringDer(
    requireEnvironmentVariable("COUNTERSIGN_GUARD_PRIVATE_KEY"),
  );
  const ownerPublicKey = PublicKey.fromString(
    requireEnvironmentVariable("COUNTERSIGN_OWNER_PUBLIC_KEY"),
  );
  const agentPublicKey = PublicKey.fromString(
    requireEnvironmentVariable("COUNTERSIGN_AGENT_PUBLIC_KEY"),
  );
  const treasuryAccountId = requireEnvironmentVariable(
    "COUNTERSIGN_TREASURY_ACCOUNT_ID",
  );
  const agentAccountId = requireEnvironmentVariable(
    "COUNTERSIGN_AGENT_ACCOUNT_ID",
  );
  const feeAccountId = requireEnvironmentVariable("COUNTERSIGN_FEE_ACCOUNT_ID");
  const feePublicKey = PublicKey.fromString(
    requireEnvironmentVariable("COUNTERSIGN_FEE_PUBLIC_KEY"),
  );
  const allowedProtobufVersion = requireEnvironmentVariable(
    "COUNTERSIGN_ALLOWED_PROTOBUF_VERSION",
  );
  const allowedServicesVersion = requireEnvironmentVariable(
    "COUNTERSIGN_ALLOWED_SERVICES_VERSION",
  );
  const port = Number.parseInt(process.env.COUNTERSIGN_PORT ?? "4020", 10);
  const host = process.env.COUNTERSIGN_HOST ?? "127.0.0.1";
  const verdictTopicId = process.env.COUNTERSIGN_VERDICT_TOPIC_ID?.trim();

  const client = Client.forTestnet().setOperator(
    AccountId.fromString(guardAccountId),
    guardPrivateKey,
  );

  mkdirSync(resolve("var"), { recursive: true });

  const server = await createProductionReviewServer(client, {
    tenantId,
    ownerPublicKey,
    agentPublicKey,
    guardPublicKey: guardPrivateKey.publicKey,
    expectedAgentAccountId: agentAccountId,
    treasuryAccountId,
    protocolMaxFeeTinybars: PROTOCOL_MAX_FEE_TINYBARS,
    allowedNetworkVersions: {
      protobuf: allowedProtobufVersion,
      services: allowedServicesVersion,
    },
    replayDatabasePath: resolve("var", "hosted-guard.sqlite"),
    ...(verdictTopicId ? { verdictTopicId } : {}),
    payment: {
      resourceUrl: `${publicOrigin}/review`,
      priceTinybars: REVIEW_PRICE_TINYBARS,
      operationalAccount: {
        accountId: feeAccountId,
        publicKey: feePublicKey,
      },
    },
    participantIdentities: {
      agent: {
        registry: "countersign",
        name: "Countersign Agent",
        version: "0.1.0",
        protocol: "hcs-10",
        nativeId: `hedera:testnet:${agentAccountId}`,
        skills: [],
      },
      guard: {
        registry: "countersign",
        name: "Countersign Guard",
        version: "0.1.0",
        protocol: "hcs-10",
        nativeId: `hedera:testnet:${guardAccountId}`,
        skills: [],
      },
    },
    reviewObserver: {
      onPaymentSettled(settlementId) {
        console.log(`settlement ${settlementId}`);
      },
      onReviewCheck(check) {
        if (!check.passed) {
          console.log(`refused: ${check.invariant}`);
        }
      },
    },
  });

  await listen(server, port, host);
  console.log(`Countersign guard listening on ${host}:${port}`);
  console.log(`Public origin: ${publicOrigin}`);
  console.log(`Tenant: ${tenantId}`);
  console.log(`Treasury: ${treasuryAccountId}`);
  console.log(`Guard account: ${guardAccountId}`);
  console.log(`Review price: ${REVIEW_PRICE_TINYBARS} tinybars`);

  const shutdown = (signal: string) => {
    console.log(`${signal} received, closing the guard`);
    server.close(() => {
      client.close();
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

await main();
