import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";

import { AccountId, Client, PrivateKey, PublicKey } from "@hiero-ledger/sdk";

import { createProductionReviewServer, type ProductionReviewTenant } from "../src/server.ts";
import { countersignTransfer } from "../src/countersign-transfer.ts";

// The long-running guard. The narrated flows start a review server on loopback
// for the duration of one run; this keeps the same server alive at a public
// origin so another machine can pay it.
//
// The configuration comes from var/hosted-guard.env, written by
// scripts/provision-hosted.ts. The only private key it carries is the guard's.
// COUNTERSIGN_TENANTS_JSON contains public enrollment data keyed by tenant ID.
// createProductionReviewServer re-derives every treasury key tree from consensus
// at startup and refuses to serve unless the owner, agent and guard keys are
// pairwise distinct and the fee destination is separate from all three, so a
// mistake in that file stops the process instead of weakening a review.

const PROTOCOL_MAX_FEE_TINYBARS = "100000000";
const REVIEW_PRICE_TINYBARS = "1000000";

function requireEnvironmentVariable(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`missing required environment variable: ${name}`);
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

export function parseGuardConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const tenantsJson = requireEnvironmentVariable(env, "COUNTERSIGN_TENANTS_JSON");
  let enrollment: unknown;
  try {
    enrollment = JSON.parse(tenantsJson);
  } catch {
    throw new Error("COUNTERSIGN_TENANTS_JSON must be a JSON object keyed by tenantId");
  }
  if (enrollment === null || typeof enrollment !== "object" || Array.isArray(enrollment)) {
    throw new Error("COUNTERSIGN_TENANTS_JSON must be a JSON object keyed by tenantId");
  }
  const tenants = new Map<string, ProductionReviewTenant>();
  const fields = ["ownerPublicKey", "agentPublicKey", "expectedAgentAccountId", "treasuryAccountId"] as const;
  for (const [tenantId, value] of Object.entries(enrollment)) {
    if (tenantId.trim() === "" || tenantId !== tenantId.trim()) {
      throw new Error("COUNTERSIGN_TENANTS_JSON tenantId must be a non-empty trimmed string");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`tenant ${tenantId}: enrollment must be an object`);
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((field) => !fields.includes(field as typeof fields[number]))) {
      throw new Error(`tenant ${tenantId}: enrollment contains an unknown field`);
    }
    const parsed: Record<string, string> = {};
    for (const field of fields) {
      if (typeof record[field] !== "string" || record[field].trim() === "") {
        throw new Error(`tenant ${tenantId}: ${field} must be a non-empty string`);
      }
      parsed[field] = record[field].trim();
    }
    for (const field of ["expectedAgentAccountId", "treasuryAccountId"] as const) {
      if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(parsed[field])) {
        throw new Error(`tenant ${tenantId}: ${field} must be a canonical numeric Hedera account ID`);
      }
    }
    let ownerPublicKey: PublicKey;
    let agentPublicKey: PublicKey;
    try {
      ownerPublicKey = PublicKey.fromString(parsed.ownerPublicKey);
      agentPublicKey = PublicKey.fromString(parsed.agentPublicKey);
    } catch {
      throw new Error(`tenant ${tenantId}: ownerPublicKey and agentPublicKey must be valid public keys`);
    }
    tenants.set(tenantId, {
      ownerPublicKey,
      agentPublicKey,
      expectedAgentAccountId: parsed.expectedAgentAccountId,
      treasuryAccountId: parsed.treasuryAccountId,
      agentIdentity: {
        registry: "countersign",
        name: "Countersign Agent",
        version: "0.1.0",
        protocol: "hcs-10",
        nativeId: `hedera:testnet:${parsed.expectedAgentAccountId}`,
        skills: [],
      },
    });
  }
  if (tenants.size === 0) {
    throw new Error("COUNTERSIGN_TENANTS_JSON must configure at least one tenant");
  }
  const publicOrigin = requireEnvironmentVariable(env, "COUNTERSIGN_PUBLIC_ORIGIN");
  const guardAccountId = requireEnvironmentVariable(env,
    "COUNTERSIGN_GUARD_ACCOUNT_ID",
  );
  const guardPrivateKey = PrivateKey.fromStringDer(
    requireEnvironmentVariable(env, "COUNTERSIGN_GUARD_PRIVATE_KEY"),
  );
  const feeAccountId = requireEnvironmentVariable(env, "COUNTERSIGN_FEE_ACCOUNT_ID");
  const feePublicKey = PublicKey.fromString(
    requireEnvironmentVariable(env, "COUNTERSIGN_FEE_PUBLIC_KEY"),
  );
  const allowedProtobufVersion = requireEnvironmentVariable(env,
    "COUNTERSIGN_ALLOWED_PROTOBUF_VERSION",
  );
  const allowedServicesVersion = requireEnvironmentVariable(env,
    "COUNTERSIGN_ALLOWED_SERVICES_VERSION",
  );
  const portValue = env.COUNTERSIGN_PORT ?? "4020";
  const port = Number(portValue);
  if (!/^[0-9]+$/.test(portValue) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("COUNTERSIGN_PORT must be an integer from 1 to 65535");
  }
  const host = env.COUNTERSIGN_HOST ?? "127.0.0.1";
  const verdictTopicId = env.COUNTERSIGN_VERDICT_TOPIC_ID?.trim();

  return {
    tenants, publicOrigin, guardAccountId, guardPrivateKey, feeAccountId,
    feePublicKey, allowedProtobufVersion, allowedServicesVersion, port, host, verdictTopicId,
  };
}

async function main(): Promise<void> {
  const {
    tenants, publicOrigin, guardAccountId, guardPrivateKey, feeAccountId,
    feePublicKey, allowedProtobufVersion, allowedServicesVersion, port, host, verdictTopicId,
  } = parseGuardConfiguration();

  const client = Client.forTestnet().setOperator(
    AccountId.fromString(guardAccountId),
    guardPrivateKey,
  );

  mkdirSync(resolve("var"), { recursive: true });

  const server = await createProductionReviewServer(client, {
    signCountersign: (approval) => countersignTransfer(approval, guardPrivateKey),
    tenants,
    guardPublicKey: guardPrivateKey.publicKey,
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
    guardIdentity: {
      registry: "countersign",
      name: "Countersign Guard",
      version: "0.1.0",
      protocol: "hcs-10",
      nativeId: `hedera:testnet:${guardAccountId}`,
      skills: [],
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
  console.log(`Configured tenants: ${tenants.size}`);
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

if (import.meta.main) {
  await main();
}
