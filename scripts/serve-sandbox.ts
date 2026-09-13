import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { AccountBalanceQuery, AccountId, Client, Hbar, PrivateKey, ScheduleCreateTransaction, Timestamp, TransferTransaction } from "@hiero-ledger/sdk";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { mandateDigest, parseMandateEnvelope, type MandateEnvelope } from "../src/mandate.ts";

const provenance = {
  origin: "operator" as const,
  disclosure: "Accounts and funding are operator-owned. These are operator-run reliability exercises, not users.",
};
type Proposal = { recipient: "vendor" | "stranger" | "agent"; amountTinybars: string };
type Step = { name: string; state: "pending" | "running" | "done" | "failed" | "never-happened" };
type Verdict = { outcome: "approved" | "refused"; hcsVerdictUrl: string; reason?: string };
type Run = Proposal & typeof provenance & {
  runId: string;
  nonce: string;
  outcome: "running" | "failed" | Verdict["outcome"];
  steps: Step[];
  scheduleId?: string;
  settlementId?: string;
  hcsVerdictUrl?: string;
  reason?: string;
};
export interface SandboxDependencies {
  checkBalances(): Promise<boolean>;
  createSchedule(proposal: Proposal, envelope: MandateEnvelope): Promise<string>;
  review(envelope: MandateEnvelope, scheduleId: string, paid: (settlementId: string) => void): Promise<Verdict>;
}
class RequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function parseProposal(value: unknown): Proposal {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(400, "proposal must be an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 ||
      typeof record.recipient !== "string" || !["vendor", "stranger", "agent"].includes(record.recipient) ||
      typeof record.amountTinybars !== "string" ||
      !/^[1-9][0-9]{6,8}$/.test(record.amountTinybars) ||
      BigInt(record.amountTinybars) < 1000000n || BigInt(record.amountTinybars) > 100000000n) {
    throw new RequestError(400, "recipient must be vendor, stranger or agent; amountTinybars must be a minimal decimal string from 1000000 to 100000000");
  }
  return { recipient: record.recipient as Proposal["recipient"], amountTinybars: record.amountTinybars };
}

export function createSandbox(envelopes: MandateEnvelope[], database: DatabaseSync, dependencies: SandboxDependencies, now = Date.now) {
  database.exec("PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS sandbox_identity (digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sandbox_runs (position INTEGER PRIMARY KEY, record TEXT NOT NULL)");
  const digest = createHash("sha256").update(JSON.stringify(envelopes)).digest("hex");
  const identity = database.prepare("SELECT digest FROM sandbox_identity").get();
  if (identity && identity.digest !== digest) throw new Error("sandbox mandates differ from the persisted run budget");
  if (!identity) database.prepare("INSERT INTO sandbox_identity VALUES (?)").run(digest);
  const runs = database.prepare("SELECT record FROM sandbox_runs ORDER BY position").all().map(row => JSON.parse(String(row.record)) as Run);
  let storageFailed = false;
  const save = (run: Run, position: number, insert = false) => {
    try {
      if (insert) database.prepare("INSERT INTO sandbox_runs VALUES (?, ?)").run(position, JSON.stringify(run));
      else database.prepare("UPDATE sandbox_runs SET record = ? WHERE position = ?").run(JSON.stringify(run), position);
    } catch (error) {
      storageFailed = true;
      throw error;
    }
  };
  for (const [position, run] of runs.entries()) {
    if (run.outcome === "running") {
      run.outcome = "failed";
      run.reason = "service interrupted; authorization outcome is unknown; envelope will not be reused";
      for (const step of run.steps) {
        if (step.state === "running") step.state = "failed";
        if (step.state === "pending") step.state = "never-happened";
      }
      save(run, position);
    }
  }
  let tail = Promise.resolve();
  let queued = 0;
  const buckets = new Map<string, number>();

  function submit(proposal: Proposal, address: string): Promise<Run> {
    if (storageFailed) throw new RequestError(503, "sandbox storage unavailable");
    if (runs.length + queued >= envelopes.length) throw new RequestError(503, "sandbox pre-signed envelopes exhausted");
    const time = now();
    for (const [ip, refill] of buckets) if (refill <= time) buckets.delete(ip);
    if (buckets.has(address)) throw new RequestError(429, "one sandbox run per 30 seconds per client address");
    buckets.set(address, time + 30_000);
    queued += 1;
    const admitted = Promise.withResolvers<Run>();
    tail = tail.then(async () => {
      let run: Run | undefined;
      const position = runs.length;
      let waiting = true;
      try {
        if (storageFailed) throw new RequestError(503, "sandbox storage unavailable");
        if (!await dependencies.checkBalances()) throw new RequestError(503, "sandbox budget exhausted");
        const envelope = envelopes[position];
        run = {
          ...proposal, ...provenance, runId: randomUUID(), nonce: envelope.mandate.nonce, outcome: "running",
          steps: ["envelope", "schedule", "payment", "verdict"].map(name => ({ name, state: "pending" })),
        };
        run.steps[0].state = "done";
        // Persist consumption before any transaction, including refused or failed reviews.
        save(run, position, true);
        runs.push(run);
        queued -= 1;
        waiting = false;
        admitted.resolve(structuredClone(run));
        run.steps[1].state = "running";
        save(run, position);
        run.scheduleId = await dependencies.createSchedule(proposal, envelope);
        run.steps[1].state = "done";
        run.steps[2].state = "running";
        save(run, position);
        const verdict = await dependencies.review(envelope, run.scheduleId, settlementId => {
          run!.settlementId = settlementId;
          run!.steps[2].state = "done";
          run!.steps[3].state = "running";
          save(run!, position);
        });
        Object.assign(run, verdict);
        run.steps[3].state = "done";
        save(run, position);
      } catch (error) {
        // The visitor-facing reason stays generic, but swallowing the cause entirely left a
        // production failure impossible to investigate.
        console.error("sandbox run failed:", error instanceof Error ? (error.stack ?? error.message) : error);
        if (run && runs.includes(run)) {
          run.outcome = "failed";
          run.reason = "authorization exercise failed; inspect recorded identifiers before investigating";
          for (const step of run.steps) {
            if (step.state === "running") step.state = "failed";
            if (step.state === "pending") step.state = "never-happened";
          }
          try { save(run, position); } catch { storageFailed = true; }
        }
        admitted.reject(error);
      } finally {
        if (waiting) queued -= 1;
      }
    });
    return admitted.promise;
  }

  return {
    idle: () => tail,
    async handle(method: string, path: string, address: string, body: AsyncIterable<Uint8Array>) {
      try {
        if (method === "POST" && path === "/sandbox/run") {
          const chunks: Uint8Array[] = [];
          let size = 0;
          for await (const chunk of body) {
            size += chunk.byteLength;
            if (size > 8192) throw new RequestError(400, "request body exceeds 8 KB");
            chunks.push(chunk);
          }
          let value: unknown;
          try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
          catch { throw new RequestError(400, "request body must contain valid JSON"); }
          const run = await submit(parseProposal(value), address);
          return { status: 202, body: { runId: run.runId, ...provenance } };
        }
        if (method === "GET" && path === "/sandbox/runs") {
          return { status: 200, body: { ...provenance, runs: runs.slice(-20).reverse().map(run => ({
            ...provenance, runId: run.runId, recipient: run.recipient, amountTinybars: run.amountTinybars,
            outcome: run.outcome, scheduleId: run.scheduleId ?? null,
          })) } };
        }
        if (method === "GET" && path.startsWith("/sandbox/run/")) {
          const run = runs.find(entry => entry.runId === path.slice("/sandbox/run/".length));
          if (run) return { status: 200, body: structuredClone(run) };
        }
        throw new RequestError(404, "not found");
      } catch (error) {
        return { status: error instanceof RequestError ? error.status : 503,
          body: { error: error instanceof RequestError ? error.message : "sandbox unavailable", ...provenance } };
      }
    },
  };
}

// The service binds loopback only, so every peer is the reverse proxy: without the proxy's
// X-Real-IP the per-address bucket would collapse into one global run per 30 seconds and tell a
// throttled visitor they were going too fast when someone else had just run.
export function clientAddress(socketAddress: string | undefined, forwarded: string | string[] | undefined): string {
  const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (header !== undefined && /^[0-9a-fA-F.:]{3,45}$/.test(header)) return header;
  return socketAddress ?? "unknown";
}

export function parseSandboxConfiguration(env: NodeJS.ProcessEnv = process.env) {
  function required(name: string) {
    const value = env[name]?.trim();
    if (!value) throw new Error(`missing required environment variable: ${name}`);
    return value;
  }
  const tenantId = required("COUNTERSIGN_TENANT_ID");
  const origin = new URL(required("COUNTERSIGN_GUARD_ORIGIN"));
  if ((origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))) ||
      origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("invalid guard origin");
  const treasury = AccountId.fromString(required("COUNTERSIGN_TREASURY_ACCOUNT_ID"));
  const agent = AccountId.fromString(required("COUNTERSIGN_AGENT_ACCOUNT_ID"));
  const agentKey = PrivateKey.fromStringDer(required("COUNTERSIGN_AGENT_PRIVATE_KEY"));
  const payer = AccountId.fromString(required("COUNTERSIGN_PAYER_ACCOUNT_ID"));
  const payerKey = PrivateKey.fromStringDer(required("COUNTERSIGN_PAYER_PRIVATE_KEY"));
  const vendor = AccountId.fromString(required("COUNTERSIGN_VENDOR_ACCOUNT_ID"));
  const stranger = AccountId.fromString(required("COUNTERSIGN_STRANGER_ACCOUNT_ID"));
  const portText = env.COUNTERSIGN_SANDBOX_PORT ?? "4030";
  const floorText = env.COUNTERSIGN_SANDBOX_BALANCE_FLOOR_TINYBARS ?? "100000000";
  if (!/^[1-9][0-9]*$/.test(portText) || Number(portText) > 65535) throw new Error("invalid COUNTERSIGN_SANDBOX_PORT");
  if (!/^[1-9][0-9]*$/.test(floorText)) throw new Error("invalid COUNTERSIGN_SANDBOX_BALANCE_FLOOR_TINYBARS");
  return { tenantId, origin, treasury, agent, agentKey, payer, payerKey, vendor, stranger, port: Number(portText), floor: BigInt(floorText) };
}

export function productionDependencies(config: ReturnType<typeof parseSandboxConfiguration>, client: Client): SandboxDependencies {
  const network = "hedera:testnet";
  const payer = new x402HTTPClient(new x402Client().register(network,
    new ExactHederaScheme(createClientHederaSigner(config.payer.toString(), config.payerKey, { network })),
  ).setSpendControls({ allowedAssets: [{ network, asset: "0.0.0", maxAmountPerPayment: "1000000" }] }));
  return {
    async checkBalances() {
      for (const account of [config.agent, config.payer]) {
        const balance = await new AccountBalanceQuery().setAccountId(account).execute(client);
        if (BigInt(balance.hbars.toTinybars().toString()) < config.floor) return false;
      }
      return true;
    },
    async createSchedule(proposal, envelope) {
      // hosted-review.ts keeps its schedule/payment constructors private; use the same SDK sequence.
      const digest = mandateDigest(envelope.mandate);
      const amount = Hbar.fromTinybars(proposal.amountTinybars);
      const transfer = new TransferTransaction().addHbarTransfer(config.treasury, amount.negated())
        .addHbarTransfer(config[proposal.recipient], amount)
        .setMaxTransactionFee(Hbar.fromTinybars("100000000")).setTransactionMemo(digest);
      const response = await new ScheduleCreateTransaction().setScheduledTransaction(transfer)
        .setPayerAccountId(config.agent).setScheduleMemo(digest)
        .setExpirationTime(Timestamp.fromDate(new Date(Date.now() + 1_800_000)))
        .setWaitForExpiry(false).setMaxTransactionFee(Hbar.fromTinybars("100000000")).execute(client);
      const receipt = await response.getReceipt(client);
      if (!receipt.scheduleId) throw new Error("schedule creation receipt did not contain a ScheduleID");
      return receipt.scheduleId.toString();
    },
    async review(envelope, scheduleId, paid) {
      const body = JSON.stringify({ tenantId: config.tenantId, mandateEnvelope: envelope, scheduleId });
      const url = new URL("/review", config.origin);
      const headers = { accept: "application/json", "content-type": "application/json" };
      const challenge = await fetch(url, { method: "POST", redirect: "error", headers, body, signal: AbortSignal.timeout(30_000) });
      if (challenge.status !== 402) throw new Error("guard did not return the required 402 challenge");
      const required = payer.getPaymentRequiredResponse(name => challenge.headers.get(name), await challenge.json());
      const quote = required.accepts[0];
      if (required.accepts.length !== 1 || quote.scheme !== "exact" || quote.network !== network ||
          quote.asset !== "0.0.0" || quote.amount !== "1000000" || !/^0\.0\.[1-9][0-9]*$/.test(quote.payTo) ||
          typeof quote.extra?.feePayer !== "string" || !/^0\.0\.[1-9][0-9]*$/.test(quote.extra.feePayer) ||
          [config.agent, config.payer, config.treasury].some(account => account.toString() === quote.extra?.feePayer)) {
        throw new Error("x402 quote does not match the sandbox payment policy");
      }
      const payload = await payer.createPaymentPayload(required);
      const response = await fetch(url, { method: "POST", redirect: "error",
        headers: { ...headers, ...payer.encodePaymentSignatureHeader(payload) }, body, signal: AbortSignal.timeout(60_000) });
      const settlement = payer.getPaymentSettleResponse(name => response.headers.get(name));
      if (!settlement.success || !settlement.transaction) throw new Error("x402 settlement was not confirmed");
      paid(settlement.transaction);
      const value: unknown = await response.json();
      if (!response.ok || value === null || typeof value !== "object") throw new Error("guard authorization response unavailable");
      const record = value as Record<string, unknown>;
      if ((record.outcome !== "approved" && record.outcome !== "refused") || record.scheduleId !== scheduleId ||
          record.mandateDigest !== mandateDigest(envelope.mandate) || record.settlementId !== settlement.transaction ||
          typeof record.mirrorNodeUrl !== "string" ||
          !/^https:\/\/testnet\.mirrornode\.hedera\.com\/api\/v1\/topics\/0\.0\.[0-9]+\/messages\/[1-9][0-9]*$/.test(record.mirrorNodeUrl) ||
          (record.outcome === "refused" && typeof record.reason !== "string")) throw new Error("guard authorization evidence does not match the proposal");
      return { outcome: record.outcome, hcsVerdictUrl: record.mirrorNodeUrl,
        ...(record.outcome === "refused" ? { reason: record.reason as string } : {}) };
    },
  };
}

async function main() {
  const config = parseSandboxConfiguration();
  const value: unknown = JSON.parse(readFileSync(resolve("var", "sandbox-mandates.json"), "utf8"));
  if (!Array.isArray(value)) throw new Error("sandbox mandates must be an array");
  const envelopes = value.map(parseMandateEnvelope);
    // Nonces must be contiguous and ascending, but need not start at 1: the guard keeps an
    // ascending high-water mark per tenant, so a replacement mandate set has to begin above
    // every nonce it has already approved.
    const firstNonce = BigInt(envelopes[0]?.mandate.nonce ?? "1");
  for (const [index, envelope] of envelopes.entries()) {
    const mandate = envelope.mandate;
    if (BigInt(mandate.nonce) !== firstNonce + BigInt(index) || mandate.tenantId !== config.tenantId ||
        mandate.treasuryAccountId !== config.treasury.toString() || mandate.schemaVersion !== undefined ||
        mandate.maxAmountTinybars !== "50000000" || mandate.recipientAllowlist.length !== 1 ||
        mandate.recipientAllowlist[0] !== config.vendor.toString()) throw new Error("sandbox mandate does not match the provisioned authorization policy");
  }
  mkdirSync(resolve("var"), { recursive: true });
  const database = new DatabaseSync(resolve("var", "sandbox-runs.sqlite"));
  const client = Client.forTestnet().setOperator(config.agent, config.agentKey).setRequestTimeout(30_000).setMaxAttempts(5);
  const sandbox = createSandbox(envelopes, database, productionDependencies(config, client));
  const server = createServer((request, response) => {
    void sandbox.handle(request.method ?? "", request.url ?? "", clientAddress(request.socket.remoteAddress, request.headers["x-real-ip"]),
      request.iterator({ destroyOnReturn: false }) as AsyncIterable<Uint8Array>).then(result => {
      response.writeHead(result.status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
      response.end(JSON.stringify(result.body));
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  server.listen(config.port, "127.0.0.1", () => console.log(`Sandbox listening on 127.0.0.1:${config.port}`));
}

if (import.meta.main) await main();
