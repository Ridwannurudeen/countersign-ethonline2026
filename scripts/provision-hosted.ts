import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  AccountCreateTransaction,
  AccountId,
  Client,
  Hbar,
  KeyList,
  NetworkVersionInfoQuery,
  PrivateKey,
  type Key,
} from "@hiero-ledger/sdk";

import { accountMirrorNodeUrl } from "../src/evidence-links.ts";

// Provisions the persistent authorization topology that the hosted guard
// reviews against. The narrated flows create and then destroy their accounts on
// every run, which is correct for a demonstration and useless for a service
// that has to stay reachable. This script creates those accounts once and keeps
// them, then writes two files that must never be merged:
//
//   var/hosted-guard.env   the guard operator key only. This goes to the host.
//   var/hosted-caller.env  the owner, agent and payer keys. These stay local.
//
// The split is the point. A treasury authorization key on the guard host would
// defeat the entire design, so the guard is given exactly one private key: its
// own. The production server independently re-checks that separation at startup
// and refuses to run if it does not hold.

const TREASURY_INITIAL_BALANCE_TINYBARS = "5000000000";
const AGENT_INITIAL_BALANCE_TINYBARS = "1000000000";
const GUARD_INITIAL_BALANCE_TINYBARS = "1000000000";
const PAYER_INITIAL_BALANCE_TINYBARS = "500000000";
const FEE_DESTINATION_INITIAL_BALANCE_TINYBARS = "100000000";

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} must be set`);
  }

  return value.trim();
}

async function createAccount(
  client: Client,
  key: Key,
  initialBalanceTinybars: string,
  label: string,
): Promise<AccountId> {
  const response = await new AccountCreateTransaction()
    .setKeyWithoutAlias(key)
    .setInitialBalance(Hbar.fromTinybars(initialBalanceTinybars))
    .execute(client);
  const receipt = await response.getReceipt(client);
  if (receipt.accountId == null) {
    throw new Error(`${label} account receipt did not contain an account ID`);
  }

  console.log(`  ${label}: ${receipt.accountId.toString()}`);
  console.log(`  Evidence: ${accountMirrorNodeUrl(receipt.accountId)}`);
  return receipt.accountId;
}

function renderEnvFile(values: Record<string, string>): string {
  return `${Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;
}

async function main(): Promise<void> {
  const operatorAccountId = requireEnvironmentVariable(
    "HEDERA_OPERATOR_ACCOUNT_ID",
  );
  const operatorPrivateKey = PrivateKey.fromStringDer(
    requireEnvironmentVariable("HEDERA_OPERATOR_PRIVATE_KEY"),
  );
  const tenantId = process.env.COUNTERSIGN_TENANT_ID?.trim() || "hosted-guard";
  const publicOrigin =
    process.env.COUNTERSIGN_PUBLIC_ORIGIN?.trim() ||
    "https://countersign.gudman.xyz";

  const client = Client.forTestnet().setOperator(
    AccountId.fromString(operatorAccountId),
    operatorPrivateKey,
  );

  try {
    console.log("\nCOUNTERSIGN: PROVISION THE HOSTED AUTHORIZATION BOUNDARY\n");

    console.log("[1/3] Confirm the live network schema versions");
    const versions = await new NetworkVersionInfoQuery().execute(client);
    const protobufVersion = `${versions.protobufVersion.major}.${versions.protobufVersion.minor}.${versions.protobufVersion.patch}`;
    const servicesVersion = `${versions.servicesVersion.major}.${versions.servicesVersion.minor}.${versions.servicesVersion.patch}`;
    console.log(`  HAPI protobuf version: ${protobufVersion}`);
    console.log(`  Services version: ${servicesVersion}`);

    console.log("\n[2/3] Create the persistent keys and accounts");
    const ownerPrivateKey = PrivateKey.generateED25519();
    const agentPrivateKey = PrivateKey.generateED25519();
    const guardPrivateKey = PrivateKey.generateED25519();
    const payerPrivateKey = PrivateKey.generateED25519();
    const feeDestinationPrivateKey = PrivateKey.generateED25519();

    const treasuryKey = new KeyList(
      [
        ownerPrivateKey.publicKey,
        new KeyList([agentPrivateKey.publicKey, guardPrivateKey.publicKey], 2),
      ],
      1,
    );

    const treasuryAccountId = await createAccount(
      client,
      treasuryKey,
      TREASURY_INITIAL_BALANCE_TINYBARS,
      "Treasury account",
    );
    const agentAccountId = await createAccount(
      client,
      agentPrivateKey.publicKey,
      AGENT_INITIAL_BALANCE_TINYBARS,
      "Agent account",
    );
    const guardAccountId = await createAccount(
      client,
      guardPrivateKey.publicKey,
      GUARD_INITIAL_BALANCE_TINYBARS,
      "Guard account",
    );
    const payerAccountId = await createAccount(
      client,
      payerPrivateKey.publicKey,
      PAYER_INITIAL_BALANCE_TINYBARS,
      "x402 payer account",
    );
    const feeDestinationAccountId = await createAccount(
      client,
      feeDestinationPrivateKey.publicKey,
      FEE_DESTINATION_INITIAL_BALANCE_TINYBARS,
      "Review fee destination",
    );

    console.log("\n  Authorization: 1-of[owner, 2-of[agent, guard]]");
    console.log(
      `  Owner public key: ${ownerPrivateKey.publicKey.toStringRaw()}`,
    );
    console.log(
      `  Agent public key: ${agentPrivateKey.publicKey.toStringRaw()}`,
    );
    console.log(
      `  Guard public key: ${guardPrivateKey.publicKey.toStringRaw()}`,
    );

    console.log("\n[3/3] Write the split configuration");
    mkdirSync(resolve("var"), { recursive: true });

    const guardEnvPath = resolve("var", "hosted-guard.env");
    writeFileSync(
      guardEnvPath,
      renderEnvFile({
        COUNTERSIGN_TENANT_ID: tenantId,
        COUNTERSIGN_PUBLIC_ORIGIN: publicOrigin,
        COUNTERSIGN_GUARD_ACCOUNT_ID: guardAccountId.toString(),
        COUNTERSIGN_GUARD_PRIVATE_KEY: guardPrivateKey.toStringDer(),
        COUNTERSIGN_OWNER_PUBLIC_KEY: ownerPrivateKey.publicKey.toStringDer(),
        COUNTERSIGN_AGENT_PUBLIC_KEY: agentPrivateKey.publicKey.toStringDer(),
        COUNTERSIGN_TREASURY_ACCOUNT_ID: treasuryAccountId.toString(),
        COUNTERSIGN_AGENT_ACCOUNT_ID: agentAccountId.toString(),
        COUNTERSIGN_FEE_ACCOUNT_ID: feeDestinationAccountId.toString(),
        COUNTERSIGN_FEE_PUBLIC_KEY:
          feeDestinationPrivateKey.publicKey.toStringDer(),
        COUNTERSIGN_ALLOWED_PROTOBUF_VERSION: protobufVersion,
        COUNTERSIGN_ALLOWED_SERVICES_VERSION: servicesVersion,
      }),
      { mode: 0o600 },
    );
    console.log(`  Guard host configuration: ${guardEnvPath}`);

    const callerEnvPath = resolve("var", "hosted-caller.env");
    writeFileSync(
      callerEnvPath,
      renderEnvFile({
        COUNTERSIGN_TENANT_ID: tenantId,
        COUNTERSIGN_GUARD_URL: `${publicOrigin}/review`,
        COUNTERSIGN_OWNER_PRIVATE_KEY: ownerPrivateKey.toStringDer(),
        COUNTERSIGN_AGENT_PRIVATE_KEY: agentPrivateKey.toStringDer(),
        COUNTERSIGN_PAYER_PRIVATE_KEY: payerPrivateKey.toStringDer(),
        COUNTERSIGN_TREASURY_ACCOUNT_ID: treasuryAccountId.toString(),
        COUNTERSIGN_AGENT_ACCOUNT_ID: agentAccountId.toString(),
        COUNTERSIGN_PAYER_ACCOUNT_ID: payerAccountId.toString(),
        COUNTERSIGN_FEE_ACCOUNT_ID: feeDestinationAccountId.toString(),
        COUNTERSIGN_ALLOWED_RECIPIENT_ACCOUNT_ID: operatorAccountId,
        COUNTERSIGN_GUARD_PUBLIC_KEY_RAW: guardPrivateKey.publicKey.toStringRaw(),
      }),
      { mode: 0o600 },
    );
    console.log(`  Caller configuration: ${callerEnvPath}`);

    console.log(
      "\nProvisioned. The guard host file contains exactly one private key, the guard's own.",
    );
    console.log(
      "The owner, agent and payer keys stay in the caller file and must not leave this machine.",
    );
  } finally {
    client.close();
  }
}

await main();
