import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import { createSandbox, type SandboxDependencies } from "../scripts/serve-sandbox.ts";
import type { MandateEnvelope } from "../src/mandate.ts";

// The page and the service were built separately: test/sandbox-page.test.ts drives the page against
// hand-written fixtures and test/sandbox.test.ts drives the service against its own assertions, so a
// shape the service emits but the page rejects would pass both. This runs the page's real validator
// over the service's real responses.
const source = readFileSync(new URL("../web/sandbox.html", import.meta.url), "utf8");
const script = source.match(/<script type="module">([\s\S]*?)<\/script>/)![1];
const hcsVerdictUrl = "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.100/messages/1";

function validator() {
  const element = { value: "vendor", textContent: "", href: "", dataset: {}, children: [] as unknown[],
    append() {}, replaceChildren() {}, setAttribute() {}, getAttribute() {}, addEventListener() {}, focus() {} };
  const context: Record<string, unknown> = {
    document: { querySelector: () => element, createElement: () => ({ ...element }) },
    window: { addEventListener() {} }, location: new URL("https://sandbox.example/sandbox.html"),
    history: { replaceState() {} }, fetch: async () => Response.json({}), setTimeout: () => 0, AbortSignal,
  };
  runInNewContext(script, context);
  const validateRun = context.validateRun;
  assert.equal(typeof validateRun, "function", "page must expose validateRun to this harness");
  return validateRun as (run: unknown, detailed?: boolean) => void;
}

function fixture(t: TestContext, review: SandboxDependencies["review"]) {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const envelopes: MandateEnvelope[] = Array.from({ length: 3 }, (_, index) => ({
    mandate: { tenantId: "sandbox", nonce: String(index + 1), treasuryAccountId: "0.0.10",
      recipientAllowlist: ["0.0.11"], maxAmountTinybars: "50000000", validFromEpochSeconds: "1", expiresAtEpochSeconds: "9999999999" },
    signature: "A".repeat(86),
  }));
  return createSandbox(envelopes, database, {
    async checkBalances() { return true; },
    async createSchedule(_proposal, envelope) { return `0.0.${envelope.mandate.nonce}`; },
    review,
  });
}

async function* body(value: unknown) { yield Buffer.from(JSON.stringify(value)); }

for (const [label, recipient, amountTinybars, review] of [
  ["an approval", "vendor", "1000000", async (_e, _s, paid) => {
    paid("0.0.10@123.000000001");
    return { outcome: "approved" as const, hcsVerdictUrl };
  }],
  ["a refusal", "stranger", "1000000", async (_e, _s, paid) => {
    paid("0.0.10@123.000000001");
    return { outcome: "refused" as const, hcsVerdictUrl, reason: "recipient outside the mandate allowlist" };
  }],
] satisfies [string, string, string, SandboxDependencies["review"]][]) {
  test(`the page accepts the service's real response for ${label}`, async t => {
    const sandbox = fixture(t, review);
    const validateRun = validator();

    const created = await sandbox.handle("POST", "/sandbox/run", "ip", body({ recipient, amountTinybars }));
    assert.equal(created.status, 202);
    await sandbox.idle();

    const runId = (created.body as { runId: string }).runId;
    const detail = await sandbox.handle("GET", `/sandbox/run/${runId}`, "ip", body(null));
    assert.equal(detail.status, 200);
    validateRun(detail.body, true);

    const history = await sandbox.handle("GET", "/sandbox/runs", "ip", body(null));
    assert.equal(history.status, 200);
    const runs = (history.body as { runs: { outcome: string; scheduleId: string | null }[] }).runs;
    assert.equal(runs.length, 1);
    for (const run of runs) validateRun(run);
    // The history list is what a visitor sees once the envelopes are spent, so a settled run must
    // still carry the schedule the page links to; the page omits the link rather than reporting a gap.
    assert.ok(runs[0].scheduleId, "a settled run must keep its schedule link in the history list");
  });
}

test("the page rejects a service response whose evidence is incomplete", async t => {
  const sandbox = fixture(t, async () => ({ outcome: "approved" as const, hcsVerdictUrl }));
  const validateRun = validator();
  const created = await sandbox.handle("POST", "/sandbox/run", "ip", body({ recipient: "vendor", amountTinybars: "1000000" }));
  await sandbox.idle();
  const runId = (created.body as { runId: string }).runId;
  const detail = await sandbox.handle("GET", `/sandbox/run/${runId}`, "ip", body(null));
  assert.throws(() => validateRun(detail.body, true), /Incomplete authorization evidence|Unexpected sandbox/);
});
