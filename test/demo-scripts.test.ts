import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

test("live flow keeps treasury authorization keys out of the x402 payment payload", () => {
  const source = readFileSync(resolve("scripts", "live-flow.ts"), "utf8");

  assert.match(
    source,
    /createClientHederaSigner\(\s*paymentPayerAccountId\.toString\(\),\s*paymentPayerPrivateKey,/,
  );
  assert.doesNotMatch(
    source,
    /createClientHederaSigner\(\s*agentAccountId\.toString\(\),\s*agentPrivateKey,/,
  );
  assert.match(
    source,
    /operationalAccount: \{\s*accountId: operatorAccountId\.toString\(\),\s*publicKey: operatorPrivateKey\.publicKey,/,
  );
  assert.match(
    source,
    /requirePaymentQuote\(\s*paymentRequired,\s*operatorAccountId\.toString\(\),/,
  );
});

test("live flow recovers every created account from finally", () => {
  const source = readFileSync(resolve("scripts", "live-flow.ts"), "utf8");
  const cleanup = source.slice(source.lastIndexOf("} finally {"));

  for (const accountId of [
    "treasuryAccountId",
    "agentAccountId",
    "guardAccountId",
    "paymentPayerAccountId",
  ]) {
    assert.match(
      source,
      new RegExp(
        `temporaryAccounts\\.push\\(\\{\\s*accountId: ${accountId},`,
      ),
    );
  }
  assert.match(cleanup, /for \(const account of temporaryAccounts\)/);
  assert.match(
    cleanup,
    /recoverTemporaryBalance\([\s\S]*?account\.accountId,[\s\S]*?account\.privateKey/,
  );
  assert.match(
    source,
    /catch \(error\) \{\s*primaryFailure = \{ error \};\s*\} finally/,
  );
  assert.match(
    source,
    /if \(primaryFailure !== null\) \{\s*throw primaryFailure\.error;/,
  );
});

test("nested-key spike recovers every created account from finally", () => {
  const source = readFileSync(
    resolve("scripts", "spike-nested-key.ts"),
    "utf8",
  );
  const cleanup = source.slice(source.lastIndexOf("} finally {"));

  for (const accountId of [
    "treasuryAccountId",
    "agentAccountId",
    "guardAccountId",
  ]) {
    assert.match(
      source,
      new RegExp(
        `temporaryAccounts\\.push\\(\\{\\s*accountId: ${accountId},`,
      ),
    );
  }
  assert.match(cleanup, /for \(const account of temporaryAccounts\)/);
  assert.match(
    cleanup,
    /recoverTemporaryBalance\([\s\S]*?account\.accountId,[\s\S]*?account\.privateKey/,
  );
  assert.match(
    source,
    /catch \(error\) \{\s*primaryFailure = \{ error \};\s*\} finally/,
  );
  assert.match(
    source,
    /if \(primaryFailure !== null\) \{\s*throw primaryFailure\.error;/,
  );
});

test("nested-key spike proves agent-only direct transfer rejection before scheduling", () => {
  const source = readFileSync(
    resolve("scripts", "spike-nested-key.ts"),
    "utf8",
  );

  assert.match(
    source,
    /new TransferTransaction\(\)[\s\S]*?addHbarTransfer\(treasuryAccountId, [^)]+\.negated\(\)\)[\s\S]*?addHbarTransfer\(operatorAccountId, [^)]+\)[\s\S]*?freezeWith\(agentClient\)/,
  );
  assert.match(source, /await agentOnlyDirectTransfer\.sign\(agentPrivateKey\)/);
  assert.match(
    source,
    /await agentOnlyDirectTransfer\.execute\(agentClient\)[\s\S]*?await [^)]+\.getReceipt\(agentClient\)/,
  );
  assert.match(
    source,
    /error instanceof ReceiptStatusError[\s\S]*?error\.status === Status\.InvalidSignature/,
  );
  assert.match(
    source,
    /throw new Error\("agent-only direct transfer unexpectedly executed"\)/,
  );

  const keyTreeVerified = source.indexOf("Treasury key tree verified");
  const directTransferAttempt = source.indexOf(
    "const agentOnlyDirectTransfer = new TransferTransaction()",
  );
  const scheduledPath = source.indexOf(
    "const approvedScheduleId = await createHbarSchedule",
  );
  assert.ok(keyTreeVerified < directTransferAttempt);
  assert.ok(directTransferAttempt < scheduledPath);
});
