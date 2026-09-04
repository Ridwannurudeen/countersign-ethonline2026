import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const requiredEnvironmentVariables = [
  "HEDERA_OPERATOR_ACCOUNT_ID",
  "HEDERA_OPERATOR_PRIVATE_KEY",
  "COUNTERSIGN_ALLOWED_PROTOBUF_VERSION",
  "COUNTERSIGN_ALLOWED_SERVICES_VERSION",
] as const;

test("demo entrypoints fail fast when Hedera credentials are missing", async (t) => {
  for (const script of ["demo.ts", "refusal.ts"] as const) {
    await t.test(script, () => {
      const environment = { ...process.env };
      for (const name of requiredEnvironmentVariables) {
        delete environment[name];
      }

      const result = spawnSync(
        process.execPath,
        ["--experimental-strip-types", resolve("scripts", script)],
        {
          cwd: resolve("."),
          encoding: "utf8",
          env: environment,
        },
      );

      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /missing required environment variable: HEDERA_OPERATOR_ACCOUNT_ID/,
      );
      assert.doesNotMatch(result.stderr, /HAPI protobuf version/);
    });
  }
});
