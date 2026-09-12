import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  AccountCreateTransaction,
  AccountId,
  Client,
  Hbar,
  KeyList,
  PrivateKey,
  PublicKey,
  type Key,
} from "@hiero-ledger/sdk";

import { accountMirrorNodeUrl } from "../src/evidence-links.ts";

// Provision a separate sandbox against the existing guard's public key.
// var/sandbox-owner.env stays local forever; never send it to a server.
// Only var/sandbox.env (agent + payer keys and public configuration) may be
// hosted. Vendor and stranger accounts use the local owner's public key.
// No guard private key is generated, loaded, or written by this script.

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`missing required environment variable: ${name}`);
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
  const operatorAccountId = AccountId.fromString(
    requireEnvironmentVariable("HEDERA_OPERATOR_ACCOUNT_ID"),
  );
  const operatorPrivateKey = PrivateKey.fromStringDer(
    requireEnvironmentVariable("HEDERA_OPERATOR_PRIVATE_KEY"),
  );
  const { values } = parseArgs({
    options: { force: { type: "boolean", default: false } },
  });
  const ownerEnvPath = resolve("var", "sandbox-owner.env");
  const sandboxEnvPath = resolve("var", "sandbox.env");
  for (const path of [ownerEnvPath, sandboxEnvPath]) {
    if (existsSync(path) && !values.force) {
      throw new Error(
        `${path} already exists. Provisioning would replace keys that control funded accounts. Move the existing files aside first, or explicitly use --force.`,
      );
    }
  }

  const guardOrigin = "https://countersign.gudman.xyz";
  const response = await fetch(`${guardOrigin}/guard`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`GET /guard failed: HTTP ${response.status}`);
  }
  const guard: unknown = await response.json();
  if (
    guard === null ||
    typeof guard !== "object" ||
    !("guardPublicKey" in guard) ||
    typeof guard.guardPublicKey !== "string"
  ) {
    throw new Error("GET /guard must return a guardPublicKey string");
  }
  const guardPublicKey = PublicKey.fromString(guard.guardPublicKey);
  const ownerPrivateKey = PrivateKey.generateED25519();
  const agentPrivateKey = PrivateKey.generateED25519();
  const payerPrivateKey = PrivateKey.generateED25519();
  const treasuryKey = new KeyList(
    [
      ownerPrivateKey.publicKey,
      new KeyList([agentPrivateKey.publicKey, guardPublicKey], 2),
    ],
    1,
  );

  // Save recovery keys before funding any accounts, including if provisioning
  // stops partway through. Account IDs are printed as receipts arrive.
  mkdirSync(resolve("var"), { recursive: true });
  const fileOptions = { mode: 0o600, flag: values.force ? "w" : "wx" };
  writeFileSync(
    ownerEnvPath,
    renderEnvFile({
      COUNTERSIGN_OWNER_PRIVATE_KEY: ownerPrivateKey.toStringDer(),
    }),
    fileOptions,
  );
  const sandboxConfig: Record<string, string> = {
    COUNTERSIGN_TENANT_ID: "sandbox",
    COUNTERSIGN_GUARD_ORIGIN: guardOrigin,
    COUNTERSIGN_GUARD_PUBLIC_KEY_RAW: guardPublicKey.toStringRaw(),
    COUNTERSIGN_AGENT_PRIVATE_KEY: agentPrivateKey.toStringDer(),
    COUNTERSIGN_PAYER_PRIVATE_KEY: payerPrivateKey.toStringDer(),
  };
  writeFileSync(sandboxEnvPath, renderEnvFile(sandboxConfig), fileOptions);

  const client = Client.forTestnet().setOperator(
    operatorAccountId,
    operatorPrivateKey,
  );
  try {
    console.log("\nCOUNTERSIGN: PROVISION SANDBOX AUTHORIZATION\n");
    const treasuryAccountId = await createAccount(
      client,
      treasuryKey,
      "3000000000",
      "Treasury",
    );
    const agentAccountId = await createAccount(
      client,
      agentPrivateKey.publicKey,
      "500000000",
      "Agent",
    );
    const payerAccountId = await createAccount(
      client,
      payerPrivateKey.publicKey,
      "500000000",
      "Payer",
    );
    const vendorAccountId = await createAccount(
      client,
      ownerPrivateKey.publicKey,
      "100000000",
      "Vendor",
    );
    const strangerAccountId = await createAccount(
      client,
      ownerPrivateKey.publicKey,
      "100000000",
      "Stranger",
    );

    writeFileSync(
      sandboxEnvPath,
      renderEnvFile({
        ...sandboxConfig,
        COUNTERSIGN_TREASURY_ACCOUNT_ID: treasuryAccountId.toString(),
        COUNTERSIGN_AGENT_ACCOUNT_ID: agentAccountId.toString(),
        COUNTERSIGN_PAYER_ACCOUNT_ID: payerAccountId.toString(),
        COUNTERSIGN_VENDOR_ACCOUNT_ID: vendorAccountId.toString(),
        COUNTERSIGN_STRANGER_ACCOUNT_ID: strangerAccountId.toString(),
      }),
      { mode: 0o600 },
    );

    console.log(
      "\nMerge this public enrollment into COUNTERSIGN_TENANTS_JSON:",
    );
    console.log(
      JSON.stringify(
        {
          sandbox: {
            ownerPublicKey: ownerPrivateKey.publicKey.toStringDer(),
            agentPublicKey: agentPrivateKey.publicKey.toStringDer(),
            expectedAgentAccountId: agentAccountId.toString(),
            treasuryAccountId: treasuryAccountId.toString(),
          },
        },
        null,
        2,
      ),
    );
    console.log(`\nLocal owner configuration (never upload): ${ownerEnvPath}`);
    console.log(`Sandbox host configuration: ${sandboxEnvPath}`);
  } finally {
    client.close();
  }
}

await main();
