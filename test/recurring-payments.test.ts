import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { parseRecurringArguments, runRecurring, validateRecurringMandates, type Occurrence } from "../scripts/recurring-payments.ts";
import { createSandbox, type SandboxDependencies } from "../scripts/serve-sandbox.ts";
import { mandateDigest, type MandateEnvelope } from "../src/mandate.ts";

const options = { count: 3, intervalMilliseconds: 35_000 };
const env = {
  COUNTERSIGN_GUARD_ORIGIN: "https://countersign.gudman.xyz",
  COUNTERSIGN_TENANT_ID: "sandbox", COUNTERSIGN_TREASURY_ACCOUNT_ID: "0.0.10", COUNTERSIGN_VENDOR_ACCOUNT_ID: "0.0.11",
};

function fixture(t: TestContext, overrides: Partial<SandboxDependencies> = {}) {
  let time = 1_800_000_000_000;
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const envelopes: MandateEnvelope[] = Array.from({ length: 5 }, (_, index) => ({
    mandate: { tenantId: "sandbox", nonce: String(1001 + index), treasuryAccountId: "0.0.10",
      recipientAllowlist: ["0.0.11"], maxAmountTinybars: "50000000", validFromEpochSeconds: "1", expiresAtEpochSeconds: "9999999999" },
    signature: "A".repeat(86),
  }));
  const messages = new Map<string, Record<string, unknown>>();
  const events: string[] = [];
  const snapshots: Occurrence[] = [];
  const starts: number[] = [];
  const sandbox = createSandbox(envelopes, database, {
    async checkBalances() { return true; },
    async createSchedule(proposal, envelope) {
      events.push(`schedule:${envelope.mandate.nonce}`);
      assert.deepEqual(proposal, { recipient: "vendor", amountTinybars: "1000000" });
      return `0.0.${envelope.mandate.nonce}`;
    },
    async review(envelope, scheduleId, paid) {
      events.push(`review:${envelope.mandate.nonce}`);
      const settlementId = `0.0.20@1800000000.${envelope.mandate.nonce.padStart(9, "0")}`;
      paid(settlementId);
      const hcsVerdictUrl = `https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.100/messages/${envelope.mandate.nonce}`;
      const verdict = { outcome: "approved", tenantId: "sandbox", scheduleId, settlementId, mandateDigest: mandateDigest(envelope.mandate) };
      messages.set(hcsVerdictUrl, { topic_id: "0.0.100", sequence_number: Number(envelope.mandate.nonce), message: Buffer.from(JSON.stringify(verdict)).toString("base64") });
      return { outcome: "approved", hcsVerdictUrl };
    },
    ...overrides,
  }, () => time);
  async function* body(value: string) { yield Buffer.from(value); }
  const dependencies = {
    now: () => time,
    async sleep(milliseconds: number) { time += milliseconds; await new Promise<void>(resolve => setImmediate(resolve)); },
    record(value: Occurrence) { snapshots.push(value); },
    fetch: (async (input, init) => {
      const url = new URL(String(input));
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      if (url.hostname === "testnet.mirrornode.hedera.com") {
        const message = messages.get(url.href);
        assert.ok(message, "fixture must contain the actual review's message");
        return Response.json(message);
      }
      assert.equal(url.origin, env.COUNTERSIGN_GUARD_ORIGIN);
      if (init?.method === "POST") { starts.push(time); events.push("post"); }
      const result = await sandbox.handle(init?.method ?? "GET", url.pathname, "controller", body(String(init?.body ?? "")));
      return Response.json(result.body, { status: result.status });
    }) satisfies typeof fetch,
  };
  return { envelopes, dependencies, events, snapshots, starts, sandbox, messages, database };
}

test("recurring arguments have small defaults and enforce the sandbox admission interval", () => {
  assert.deepEqual(parseRecurringArguments([]), options);
  assert.deepEqual(parseRecurringArguments(["--count", "2", "--interval-seconds", "40"]), { count: 2, intervalMilliseconds: 40_000 });
  for (const args of [["--count"], ["--count", "0"], ["--count", "201"], ["--count", "1.5"], ["--count", "01"],
    ["--interval-seconds", "29"], ["--interval-seconds", "86401"], ["--count", "2", "--count", "3"], ["--recipient", "stranger"]]) {
    assert.throws(() => parseRecurringArguments(args));
  }
});

test("recurring configuration matches existing HBAR authorizations without reading private keys", t => {
  const { envelopes } = fixture(t);
  const config: NodeJS.ProcessEnv = { ...env };
  for (const role of ["OWNER", "AGENT", "PAYER", "GUARD"]) {
    Object.defineProperty(config, `COUNTERSIGN_${role}_PRIVATE_KEY`, { get() { assert.fail("controller must not read a private key"); } });
  }
  validateRecurringMandates(envelopes, config, 1_800_000_000_000);
  for (const mutate of [
    (set: MandateEnvelope[]) => { set[1].mandate.nonce = "1001"; },
    (set: MandateEnvelope[]) => { set[1].mandate.recipientAllowlist = ["0.0.12"]; },
    (set: MandateEnvelope[]) => { set[1].mandate.maxAmountTinybars = "50000001"; },
    (set: MandateEnvelope[]) => { set[1].mandate.expiresAtEpochSeconds = "1"; },
  ]) {
    const changed = structuredClone(envelopes);
    mutate(changed);
    assert.throws(() => validateRecurringMandates(changed, config, 1_800_000_000_000));
  }
});

test("recurring occurrences wait for complete authorization and HCS evidence before the next fixed interval", async t => {
  const f = fixture(t);
  const results = await runRecurring(options, f.envelopes, f.dependencies);
  assert.deepEqual(results.map(value => value.outcome), ["approved", "approved", "approved"]);
  assert.deepEqual(results.map(value => value.nonce), ["1001", "1002", "1003"]);
  assert.deepEqual(f.events, ["post", "schedule:1001", "review:1001", "post", "schedule:1002", "review:1002", "post", "schedule:1003", "review:1003"]);
  assert.deepEqual(f.starts.map(value => value - f.starts[0]), [0, 35_000, 70_000]);
  assert.ok(results.every(value => value.hcsVerdict?.mandateDigest && value.settlementId));
  assert.equal(f.snapshots[0].runId, undefined);
  assert.equal(f.snapshots[0].outcome, "running", "durable snapshots must not mutate after recording");
});

test("recurring controller remains serial while an authorization is blocked", async t => {
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const f = fixture(t, { async createSchedule(_proposal, envelope) {
    if (envelope.mandate.nonce === "1001") { entered.resolve(); await release.promise; }
    return `0.0.${envelope.mandate.nonce}`;
  } });
  const running = runRecurring(options, f.envelopes, f.dependencies);
  await entered.promise;
  try {
    for (let index = 0; index < 5; index += 1) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.starts.length, 1);
    assert.equal(f.database.prepare("SELECT count(*) AS count FROM sandbox_runs").get()?.count, 1);
  } finally {
    release.resolve();
  }
  assert.equal((await running).length, 3);
});

test("recurring uses the next durable unused nonce across controller invocations", async t => {
  const f = fixture(t);
  const first = await runRecurring({ ...options, count: 1 }, f.envelopes, f.dependencies);
  assert.equal(first[0].nonce, "1001");
  await f.dependencies.sleep(35_000);
  const second = await runRecurring(options, f.envelopes, f.dependencies);
  assert.deepEqual(second.map(value => value.nonce), ["1002", "1003", "1004"]);
});

test("recurring stops on refusal and retains the settlement and verified HCS refusal", async t => {
  const f = fixture(t);
  const original = f.dependencies.fetch;
  f.dependencies.fetch = async (input, init) => {
    const response = await original(input, init);
    const value = await response.json() as Record<string, unknown>;
    if (String(input).includes("/topics/")) {
      assert.ok(typeof value.message === "string");
      const verdict = JSON.parse(Buffer.from(value.message, "base64").toString("utf8")) as Record<string, unknown>;
      verdict.outcome = "refused";
      value.message = Buffer.from(JSON.stringify(verdict)).toString("base64");
    } else if (value.outcome === "approved") { value.outcome = "refused"; value.reason = "authorization refused"; }
    return Response.json(value, { status: response.status });
  };
  const results = await runRecurring(options, f.envelopes, f.dependencies);
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, "refused");
  assert.equal(results[0].hcsVerdict?.outcome, "refused");
  assert.ok(results[0].settlementId);
  assert.equal(f.starts.length, 1);
});

test("recurring stops on schedule failure without consuming later envelopes", async t => {
  const f = fixture(t, { async createSchedule() { throw new Error("schedule unavailable"); } });
  const results = await runRecurring(options, f.envelopes, f.dependencies);
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, "failed");
  assert.equal(results[0].nonce, "1001");
  assert.equal(f.database.prepare("SELECT count(*) AS count FROM sandbox_runs").get()?.count, 1);
});

test("recurring never retries ambiguous admission or continues after observation failure", async t => {
  for (const failAt of ["POST", "GET"]) {
    const f = fixture(t);
    const original = f.dependencies.fetch;
    f.dependencies.fetch = async (input, init) => {
      const response = await original(input, init);
      if ((init?.method ?? "GET") === failAt) throw new Error("response lost");
      return response;
    };
    const results = await runRecurring(options, f.envelopes, f.dependencies);
    await f.sandbox.idle();
    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, "failed");
    assert.match(results[0].reason!, /response lost/);
    assert.equal(f.starts.length, 1);
  }
});

test("recurring rejects repeated and descending assigned nonces and stops immediately", async t => {
  for (const assigned of ["1001", "1000"]) {
    const f = fixture(t);
    const original = f.dependencies.fetch;
    f.dependencies.fetch = async (input, init) => {
      const response = await original(input, init);
      const value = await response.json() as Record<string, unknown>;
      if (value.nonce === "1002") value.nonce = assigned;
      return Response.json(value, { status: response.status });
    };
    const results = await runRecurring(options, f.envelopes, f.dependencies);
    await f.sandbox.idle();
    assert.equal(results.length, 2);
    assert.equal(results[1].outcome, "failed");
    assert.match(results[1].reason!, /strictly ascending/);
    assert.equal(f.starts.length, 2);
  }
});

test("recurring stops on HCS evidence mismatches before another authorization", async t => {
  const f = fixture(t);
  const original = f.dependencies.fetch;
  f.dependencies.fetch = async (input, init) => {
    const response = await original(input, init);
    const value = await response.json() as Record<string, unknown>;
    if (String(input).includes("/topics/")) {
      assert.ok(typeof value.message === "string");
      const verdict = JSON.parse(Buffer.from(value.message, "base64").toString("utf8")) as Record<string, unknown>;
      verdict.mandateDigest = "f".repeat(64);
      value.message = Buffer.from(JSON.stringify(verdict)).toString("base64");
    }
    return Response.json(value, { status: response.status });
  };
  const results = await runRecurring(options, f.envelopes, f.dependencies);
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, "failed");
  assert.match(results[0].reason!, /HCS pre-signed mandate mismatch/);
  assert.ok(results[0].scheduleId && results[0].settlementId && results[0].hcsVerdictUrl);
});

test("recurring waits for mirror indexing without creating another schedule", async t => {
  const f = fixture(t);
  const original = f.dependencies.fetch;
  let pending = true;
  f.dependencies.fetch = async (input, init) => {
    if (String(input).includes("/topics/") && pending) { pending = false; return new Response(null, { status: 404 }); }
    return original(input, init);
  };
  const results = await runRecurring(options, f.envelopes, f.dependencies);
  assert.equal(results.length, 3);
  assert.ok(results.every(value => value.outcome === "approved"));
  assert.equal(f.starts.length, 3);
});

test("recurring stops after bounded observation deadlines without consuming another envelope", async t => {
  for (const stalled of ["authorization", "mirror"]) {
    const f = fixture(t);
    const original = f.dependencies.fetch;
    f.dependencies.fetch = async (input, init) => {
      if (stalled === "mirror" && String(input).includes("/topics/")) return new Response(null, { status: 404 });
      const response = await original(input, init);
      const value = await response.json() as Record<string, unknown>;
      if (stalled === "authorization" && value.nonce !== undefined) value.outcome = "running";
      return Response.json(value, { status: response.status });
    };
    const results = await runRecurring(options, f.envelopes, f.dependencies);
    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, "failed");
    assert.match(results[0].reason!, /deadline/);
    assert.equal(f.starts.length, 1);
  }
});

test("recurring delays slow work without accumulating missed occurrences for catch-up", async t => {
  const f = fixture(t);
  const original = f.dependencies.fetch;
  let delayed = false;
  f.dependencies.fetch = async (input, init) => {
    const response = await original(input, init);
    if (!delayed && String(input).includes("/topics/")) {
      delayed = true;
      await f.dependencies.sleep(80_000);
    }
    return response;
  };
  const results = await runRecurring(options, f.envelopes, f.dependencies);
  assert.ok(results.every(value => value.outcome === "approved"));
  assert.equal(results.length, 3);
  assert.ok(f.starts[1] - f.starts[0] >= 80_000);
  assert.equal(f.starts[2] - f.starts[1], 35_000);
});
