import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

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
