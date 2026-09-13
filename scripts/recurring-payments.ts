import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";

import { mandateDigest, parseMandateEnvelope, type MandateEnvelope } from "../src/mandate.ts";

const origin = "https://countersign.gudman.xyz";
const amountTinybars = "1000000";
const verdictUrlPattern = /^https:\/\/testnet\.mirrornode\.hedera\.com\/api\/v1\/topics\/0\.0\.[0-9]+\/messages\/[1-9][0-9]*$/;

export interface RecurringOptions {
  count: number;
  intervalMilliseconds: number;
}

export interface Occurrence {
  occurrence: number;
  startedAt: string;
  runId?: string;
  nonce?: string;
  scheduleId?: string;
  settlementId?: string;
  hcsVerdictUrl?: string;
  hcsVerdict?: Record<string, unknown>;
  outcome: "running" | "approved" | "refused" | "failed";
  reason?: string;
}

interface RecurringDependencies {
  fetch: typeof fetch;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
  record(occurrence: Occurrence): void;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "expected an object response");
  return value as Record<string, unknown>;
}

export function parseRecurringArguments(args: string[]): RecurringOptions {
  const options = { count: 3, intervalMilliseconds: 35_000 };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    assert.ok((flag === "--count" || flag === "--interval-seconds") && !seen.has(flag), "use --count N and --interval-seconds N once each");
    assert.ok(value && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)), `${flag} requires a positive integer`);
    seen.add(flag);
    if (flag === "--count") options.count = Number(value);
    else options.intervalMilliseconds = Number(value) * 1000;
  }
  assert.ok(options.count <= 200, "count must be at most 200");
  assert.ok(options.intervalMilliseconds >= 30_000 && options.intervalMilliseconds <= 86_400_000,
    "interval must be between 30 and 86400 seconds (sandbox admission policy)");
  return options;
}

export function validateRecurringMandates(envelopes: MandateEnvelope[], env: NodeJS.ProcessEnv, now: number): void {
  assert.ok(envelopes.length > 0, "pre-signed mandate set is empty");
  assert.equal(env.COUNTERSIGN_GUARD_ORIGIN, origin, "sandbox must use the live guard origin");
  const first = BigInt(envelopes[0].mandate.nonce);
  for (const [index, { mandate }] of envelopes.entries()) {
    assert.equal(BigInt(mandate.nonce), first + BigInt(index), "pre-signed nonces must be contiguous and ascending");
    assert.ok(BigInt(mandate.nonce) >= 1001n && BigInt(mandate.nonce) <= 1200n, "nonce is outside the sandbox authorization set");
    assert.equal(mandate.tenantId, env.COUNTERSIGN_TENANT_ID, "sandbox tenant mismatch");
    assert.equal(mandate.treasuryAccountId, env.COUNTERSIGN_TREASURY_ACCOUNT_ID, "sandbox treasury mismatch");
    assert.deepEqual(mandate.recipientAllowlist, [env.COUNTERSIGN_VENDOR_ACCOUNT_ID], "sandbox vendor mismatch");
    assert.equal(mandate.schemaVersion, undefined, "recurrence requires the existing HBAR authorizations");
    assert.equal(mandate.maxAmountTinybars, "50000000", "sandbox authorization cap mismatch");
    assert.ok(BigInt(mandate.validFromEpochSeconds) * 1000n <= BigInt(now) && BigInt(mandate.expiresAtEpochSeconds) * 1000n > BigInt(now),
      "pre-signed authorization is not currently valid");
  }
}

export async function runRecurring(
  options: RecurringOptions, envelopes: MandateEnvelope[], dependencies: RecurringDependencies,
): Promise<Occurrence[]> {
  assert.ok(Number.isSafeInteger(options.count) && options.count > 0 && options.count <= envelopes.length, "count exceeds the pre-signed authorization set");
  assert.ok(Number.isSafeInteger(options.intervalMilliseconds) && options.intervalMilliseconds >= 30_000 && options.intervalMilliseconds <= 86_400_000,
    "invalid recurring interval");
  const byNonce = new Map(envelopes.map(envelope => [envelope.mandate.nonce, envelope]));
  assert.equal(byNonce.size, envelopes.length, "duplicate pre-signed nonce");
  for (let index = 1; index < envelopes.length; index += 1) {
    assert.ok(BigInt(envelopes[index].mandate.nonce) > BigInt(envelopes[index - 1].mandate.nonce), "pre-signed nonces must be strictly ascending");
  }
  const results: Occurrence[] = [];
  let previousNonce = -1n;
  let nextStart = dependencies.now();
  for (let occurrence = 1; occurrence <= options.count; occurrence += 1) {
    await dependencies.sleep(Math.max(0, nextStart - dependencies.now()));
    const started = dependencies.now();
    nextStart = started + options.intervalMilliseconds;
    const current: Occurrence = { occurrence, startedAt: new Date(started).toISOString(), outcome: "running" };
    results.push(current);
    dependencies.record(structuredClone(current));
    try {
      // Only the existing service allocates envelopes. Its durable queue also serializes visitors.
      // Never retry a POST: a lost admission response can already have consumed an authorization.
      const admitted = await dependencies.fetch(`${origin}/sandbox/run`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ recipient: "vendor", amountTinybars }),
      });
      assert.equal(admitted.status, 202, `sandbox admission failed: HTTP ${admitted.status}; no retry`);
      const admission = record(await admitted.json());
      assert.ok(typeof admission.runId === "string" && /^[0-9a-f-]{36}$/.test(admission.runId), "invalid sandbox run ID");
      current.runId = admission.runId;
      dependencies.record(structuredClone(current));
      const deadline = dependencies.now() + 180_000;
      let envelope: MandateEnvelope | undefined;
      while (current.outcome === "running") {
        assert.ok(dependencies.now() < deadline, "authorization outcome unknown after polling deadline; inspect the run ID before another invocation");
        const response = await dependencies.fetch(`${origin}/sandbox/run/${current.runId}`, {
          redirect: "error", signal: AbortSignal.timeout(30_000),
        });
        assert.equal(response.status, 200, `sandbox observation failed: HTTP ${response.status}`);
        const detail = record(await response.json());
        assert.equal(detail.runId, current.runId, "sandbox run ID mismatch");
        assert.equal(detail.recipient, "vendor", "sandbox recipient mismatch");
        assert.equal(detail.amountTinybars, amountTinybars, "sandbox amount mismatch");
        assert.ok(typeof detail.nonce === "string" && /^(0|[1-9][0-9]*)$/.test(detail.nonce), "invalid assigned nonce");
        if (current.nonce !== undefined) assert.equal(detail.nonce, current.nonce, "assigned nonce changed while polling");
        assert.ok(BigInt(detail.nonce) > previousNonce, "assigned nonces must be strictly ascending");
        envelope = byNonce.get(detail.nonce);
        assert.ok(envelope, "assigned nonce is absent from the local pre-signed set");
        current.nonce = detail.nonce;
        for (const field of ["scheduleId", "settlementId", "hcsVerdictUrl", "reason"] as const) {
          const value = detail[field];
          if (value !== undefined) {
            assert.ok(typeof value === "string", `invalid ${field}`);
            current[field] = value;
          }
        }
        assert.ok(detail.outcome === "running" || detail.outcome === "approved" || detail.outcome === "refused" || detail.outcome === "failed", "invalid authorization outcome");
        current.outcome = detail.outcome;
        dependencies.record(structuredClone(current));
        if (current.outcome === "running") await dependencies.sleep(2000);
      }
      if (current.outcome === "failed") break;
      assert.ok(current.scheduleId && /^0\.0\.[1-9][0-9]*$/.test(current.scheduleId), "missing schedule evidence");
      assert.ok(current.settlementId && /^0\.0\.[1-9][0-9]*@[0-9]+\.[0-9]{9}$/.test(current.settlementId), "missing HBAR settlement evidence");
      assert.ok(current.hcsVerdictUrl && verdictUrlPattern.test(current.hcsVerdictUrl), "missing HCS verdict URL");
      const mirrorDeadline = dependencies.now() + 60_000;
      let mirror: Response;
      do {
        mirror = await dependencies.fetch(current.hcsVerdictUrl, { redirect: "error", signal: AbortSignal.timeout(20_000) });
        if (mirror.status !== 404) break;
        assert.ok(dependencies.now() < mirrorDeadline, "HCS verdict not indexed before deadline");
        await dependencies.sleep(2000);
      } while (true);
      assert.equal(mirror.status, 200, `HCS observation failed: HTTP ${mirror.status}`);
      const message = record(await mirror.json());
      const urlParts = new URL(current.hcsVerdictUrl).pathname.split("/");
      assert.equal(message.topic_id, urlParts[4], "HCS topic mismatch");
      assert.equal(String(message.sequence_number), urlParts[6], "HCS sequence mismatch");
      assert.ok(typeof message.message === "string", "missing HCS message");
      const verdict = record(JSON.parse(Buffer.from(message.message, "base64").toString("utf8")));
      assert.equal(verdict.tenantId, envelope!.mandate.tenantId, "HCS tenant mismatch");
      assert.equal(verdict.mandateDigest, mandateDigest(envelope!.mandate), "HCS pre-signed mandate mismatch");
      assert.equal(verdict.scheduleId, current.scheduleId, "HCS schedule mismatch");
      assert.equal(verdict.settlementId, current.settlementId, "HCS settlement mismatch");
      assert.equal(verdict.outcome, current.outcome, "HCS outcome mismatch");
      current.hcsVerdict = verdict;
      dependencies.record(structuredClone(current));
      if (current.outcome !== "approved") break;
      previousNonce = BigInt(current.nonce!);
    } catch (error) {
      current.outcome = "failed";
      current.reason = error instanceof Error ? error.message : String(error);
      dependencies.record(structuredClone(current));
      break;
    }
  }
  return results;
}

async function main(): Promise<void> {
  const options = parseRecurringArguments(process.argv.slice(2));
  const value: unknown = JSON.parse(readFileSync(resolve("var", "sandbox-mandates.json"), "utf8"));
  assert.ok(Array.isArray(value), "sandbox mandates must be an array");
  const envelopes = value.map(parseMandateEnvelope);
  validateRecurringMandates(envelopes, process.env, Date.now());
  mkdirSync(resolve("var"), { recursive: true });
  const journal = resolve("var", `recurring-${randomUUID()}.jsonl`);
  writeFileSync(journal, `${JSON.stringify({ options, origin, recipient: process.env.COUNTERSIGN_VENDOR_ACCOUNT_ID, amountTinybars })}\n`, { flag: "wx", flush: true });
  console.log(`Operator-run testnet authorizations. Evidence journal: ${journal}`);
  console.log(`Fixed vendor: ${process.env.COUNTERSIGN_VENDOR_ACCOUNT_ID}; amount: ${amountTinybars} tinybars per occurrence.`);
  const results = await runRecurring(options, envelopes, {
    fetch: globalThis.fetch, sleep, now: Date.now,
    record(occurrence) {
      appendFileSync(journal, `${JSON.stringify(occurrence)}\n`, { flush: true });
      if (occurrence.outcome === "failed" || occurrence.hcsVerdict) console.log(JSON.stringify(occurrence));
    },
  });
  console.table(results.map(result => ({ occurrence: result.occurrence, nonce: result.nonce ?? "unknown",
    "schedule id": result.scheduleId ?? "unknown", outcome: result.outcome,
    "mirror-node URL": result.hcsVerdictUrl ?? "unavailable" })));
  if (results.length !== options.count || results.some(result => result.outcome !== "approved")) process.exitCode = 1;
}

if (import.meta.main) await main();
