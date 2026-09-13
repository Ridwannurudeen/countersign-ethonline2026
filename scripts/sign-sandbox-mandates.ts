import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { AccountId, PrivateKey } from "@hiero-ledger/sdk";

import {
  canonicalMandateBytes,
  parseMandateEnvelope,
  verifyMandateSignature,
  type Mandate,
  type MandateEnvelope,
} from "../src/mandate.ts";

// Run locally once, then close the owner key; never upload sandbox-owner.env.
// The sandbox receives only pre-signed envelopes it cannot alter. The replay
// store's primary key is (tenant_id, nonce), with an ascending high-water mark:
// N single-use mandates impose a hard ceiling of N sandbox runs. The spend
// bound is structural, not a rate limit. Consume these nonces in order; signing
// this range again does not replenish it. Every signature is verified before
// any mandate file is written.

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value.trim();
}

function main(): void {
  const ownerPrivateKey = PrivateKey.fromStringDer(
    requireEnvironmentVariable("COUNTERSIGN_OWNER_PRIVATE_KEY"),
  );
  const treasuryAccountId = AccountId.fromString(
    requireEnvironmentVariable("COUNTERSIGN_TREASURY_ACCOUNT_ID"),
  ).toString();
  const vendorAccountId = AccountId.fromString(
    requireEnvironmentVariable("COUNTERSIGN_VENDOR_ACCOUNT_ID"),
  ).toString();
  const strangerAccountId = AccountId.fromString(
    requireEnvironmentVariable("COUNTERSIGN_STRANGER_ACCOUNT_ID"),
  ).toString();
  if (vendorAccountId === strangerAccountId) {
    throw new Error(
      "COUNTERSIGN_VENDOR_ACCOUNT_ID must differ from COUNTERSIGN_STRANGER_ACCOUNT_ID",
    );
  }
  const { values } = parseArgs({
    options: {
      count: { type: "string", default: "200" },
      "start-nonce": { type: "string", default: "1" },
      "validity-hours": { type: "string", default: "72" },
    },
  });
  const count = Number(values.count);
  if (!/^[1-9][0-9]*$/.test(values.count!) || !Number.isSafeInteger(count)) {
    throw new Error(
      "--count must be a positive safe integer in minimal decimal form",
    );
  }
  // The guard keeps an ascending high-water mark per tenant, so a replacement set must start
  // above every nonce the guard has already approved. Re-signing from 1 turns the first
  // envelopes into paid refusals for the recipient the owner actually allowed.
  const startNonce = Number(values["start-nonce"]);
  if (!/^[1-9][0-9]*$/.test(values["start-nonce"]!) || !Number.isSafeInteger(startNonce)) {
    throw new Error(
      "--start-nonce must be a positive safe integer in minimal decimal form",
    );
  }
  const validityHours = Number(values["validity-hours"]);
  if (!/^[1-9][0-9]*$/.test(values["validity-hours"]!) || !Number.isSafeInteger(validityHours)) {
    throw new Error(
      "--validity-hours must be a positive safe integer in minimal decimal form",
    );
  }
  const outputPath = resolve("var", "sandbox-mandates.json");
  if (existsSync(outputPath)) {
    throw new Error(
      `${outputPath} already exists. Nonces are single-use; move the file aside before signing again.`,
    );
  }
  const nowEpochSeconds = Math.floor(Date.now() / 1_000);
  const envelopes: MandateEnvelope[] = [];
  for (let nonce = startNonce; nonce < startNonce + count; nonce += 1) {
    const mandate: Mandate = {
      tenantId: "sandbox",
      nonce: nonce.toString(),
      treasuryAccountId,
      recipientAllowlist: [vendorAccountId],
      maxAmountTinybars: "50000000",
      validFromEpochSeconds: nowEpochSeconds.toString(),
      expiresAtEpochSeconds: (nowEpochSeconds + validityHours * 60 * 60).toString(),
    };
    const signature = Buffer.from(
      ownerPrivateKey.sign(canonicalMandateBytes(mandate)),
    ).toString("base64url");
    const envelope = parseMandateEnvelope({ mandate, signature });
    if (!verifyMandateSignature(envelope, ownerPrivateKey.publicKey)) {
      throw new Error(
        `owner mandate signature verification failed for nonce ${nonce}`,
      );
    }
    envelopes.push(envelope);
  }
  mkdirSync(resolve("var"), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(envelopes, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    `Wrote ${envelopes.length} verified sandbox mandates to ${outputPath}`,
  );
}

main();
