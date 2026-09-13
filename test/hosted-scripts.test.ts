import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { PrivateKey } from "@hiero-ledger/sdk";
import { parseGuardConfiguration } from "../scripts/serve-guard.ts";
import { DEFAULT_COUNTERSIGN_METER } from "../src/payment-meter.ts";

test("hosted entrypoints name missing configuration before any network work", async (t) => {
  for (const [script, variable] of [
    ["serve-guard.ts", "COUNTERSIGN_TENANTS_JSON"],
    ["hosted-review.ts", "COUNTERSIGN_TENANT_ID"],
    ["provision-hosted.ts", "HEDERA_OPERATOR_ACCOUNT_ID"],
  ]) {
    await t.test(script, () => {
      const env = { ...process.env };
      for (const name of Object.keys(env)) {
        if (name.startsWith("COUNTERSIGN_") || name.startsWith("HEDERA_")) {
          delete env[name];
        }
      }
      const result = spawnSync(process.execPath, [
        "--env-file-if-exists=var/brief13-missing.env",
        "--experimental-strip-types",
        resolve("scripts", script),
      ], { env, encoding: "utf8", timeout: 10_000 });
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(`missing required environment variable: ${variable}`));
    });
  }
});

test("hosted guard configures and validates every countersign meter rate and bound", () => {
  const owner = PrivateKey.generateED25519().publicKey;
  const agent = PrivateKey.generateED25519().publicKey;
  const guard = PrivateKey.generateED25519();
  const fee = PrivateKey.generateED25519().publicKey;
  const env = {
    COUNTERSIGN_TENANTS_JSON: JSON.stringify({ "treasury-1": {
      ownerPublicKey: owner.toString(), agentPublicKey: agent.toString(),
      expectedAgentAccountId: "0.0.2001", treasuryAccountId: "0.0.1001",
    } }),
    COUNTERSIGN_PUBLIC_ORIGIN: "https://guard.example",
    COUNTERSIGN_GUARD_ACCOUNT_ID: "0.0.3001",
    COUNTERSIGN_GUARD_PRIVATE_KEY: guard.toStringDer(),
    COUNTERSIGN_FEE_ACCOUNT_ID: "0.0.9001",
    COUNTERSIGN_FEE_PUBLIC_KEY: fee.toString(),
    COUNTERSIGN_ALLOWED_PROTOBUF_VERSION: "0.64.0",
    COUNTERSIGN_ALLOWED_SERVICES_VERSION: "0.64.0",
  };
  assert.deepEqual(parseGuardConfiguration(env).countersignMeter, DEFAULT_COUNTERSIGN_METER);
  assert.deepEqual(parseGuardConfiguration({
    ...env,
    COUNTERSIGN_METER_BASE_TINYBARS: "10",
    COUNTERSIGN_METER_PER_KILOBYTE_TINYBARS: "2048",
    COUNTERSIGN_METER_PER_ADJUSTMENT_TINYBARS: "2",
    COUNTERSIGN_METER_MIN_TINYBARS: "20",
    COUNTERSIGN_METER_MAX_TINYBARS: "1000",
  }).countersignMeter, {
    baseTinybars: "10", perKilobyteTinybars: "2048", perAdjustmentTinybars: "2", minTinybars: "20", maxTinybars: "1000",
  });
  assert.throws(() => parseGuardConfiguration({ ...env, COUNTERSIGN_METER_MIN_TINYBARS: "0" }), /positive canonical int64/);
  assert.throws(() => parseGuardConfiguration({ ...env, COUNTERSIGN_METER_MAX_TINYBARS: "1" }), /minimum must not exceed maximum/);
});
