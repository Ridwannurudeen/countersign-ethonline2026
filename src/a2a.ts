import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { canonicalize } from "json-canonicalize";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { PaymentPayloadV2Schema } from "@x402/core/schemas";
import type { SettleResponse } from "@x402/core/types";

export const A2A_X402_EXTENSION = "https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TASKS = 256;

export interface A2aTask {
  kind: "task";
  id: string;
  contextId: string;
  status: {
    state: "working" | "input-required" | "completed" | "failed" | "canceled";
    timestamp: string;
    message: {
      kind: "message";
      role: "agent";
      messageId: string;
      taskId: string;
      contextId: string;
      parts: { kind: "text"; text: string }[];
      metadata: Record<string, unknown>;
    };
  };
  artifacts?: { artifactId: string; name: string; parts: { kind: "data"; data: Record<string, unknown> }[] }[];
}

class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RpcError(-32602, "Expected an object");
  }
  return value as Record<string, unknown>;
}

function nonempty(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RpcError(-32602, "Expected a non-empty string");
  }
  return value;
}

export function a2aLoopbackOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/" || url.search !== "" || url.hash !== "" ||
      url.username !== "" || url.password !== "") {
    throw new Error("Local A2A origins must be HTTP loopback IP origins without credentials, paths, queries or fragments");
  }
  return url;
}

function status(task: A2aTask, state: A2aTask["status"]["state"], text: string, metadata: Record<string, unknown> = {}): void {
  task.status = {
    state,
    timestamp: new Date().toISOString(),
    message: {
      kind: "message", role: "agent", messageId: randomUUID(),
      taskId: task.id, contextId: task.contextId,
      parts: [{ kind: "text", text }], metadata,
    },
  };
}

function writeJson(response: ServerResponse, httpStatus: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(httpStatus, {
    "content-type": "application/json", "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store",
  });
  response.end(encoded);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0].trim() !== "application/json") {
    throw new RpcError(-32005, "Content-Type must be application/json");
  }
  request.setEncoding("utf8");
  let body = "";
  let bytes = 0;
  for await (const chunk of request as AsyncIterable<string>) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_BODY_BYTES) {
      request.pause();
      throw new RpcError(-32600, "Request exceeds the size limit");
    }
    body += chunk;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new RpcError(-32700, "Invalid JSON payload");
  }
}

// Local adapter only: all payment and authorization decisions remain in /review.
export function createA2aServer(config: { guardOrigin: string; publicOrigin: string }) {
  const guardOrigin = a2aLoopbackOrigin(config.guardOrigin);
  const publicOrigin = a2aLoopbackOrigin(config.publicOrigin);
  const tasks = new Map<string, { task: A2aTask; body: Record<string, unknown> }>();

  async function card() {
    const response = await fetch(new URL("/.well-known/agent.json", guardOrigin), {
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Guard card unavailable");
    const original = record(await response.json());
    const endpoint = new URL("/a2a", publicOrigin);
    if (endpoint.port === "0") {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Adapter is not listening on TCP");
      endpoint.port = String(address.port);
    }
    return {
      ...original,
      protocolVersion: "0.3.0", preferredTransport: "JSONRPC", version: "0.1.0",
      url: endpoint.href,
      description: "Paid authorization review of Hedera schedules against owner-signed policy mandates. Task settlement over A2A, not open-ended negotiation.",
      defaultInputModes: ["application/json"], defaultOutputModes: ["application/json"],
      capabilities: {
        streaming: false, pushNotifications: false,
        extensions: [{ uri: A2A_X402_EXTENSION, required: true,
          description: "Standalone x402 payment authorization and settlement for review tasks." }],
      },
      skills: [{
        id: "review", name: "Review schedule authorization",
        description: "Submit a data part containing the existing /review request: tenantId, mandateEnvelope and scheduleId. Accept the x402 terms to receive the policy verdict.",
        tags: ["authorization", "policy", "hedera", "x402"],
      }],
    };
  }

  async function send(params: Record<string, unknown>): Promise<A2aTask> {
    const message = record(params.message);
    if (message.kind !== "message" || message.role !== "user") {
      throw new RpcError(-32602, "Expected a user message");
    }
    nonempty(message.messageId);
    if (!Array.isArray(message.parts) || message.parts.length !== 1) {
      throw new RpcError(-32602, "Expected one review data part or payment text part");
    }
    const part = record(message.parts[0]);
    const metadata = message.metadata === undefined ? {} : record(message.metadata);
    const configuration = params.configuration === undefined ? {} : record(params.configuration);
    if (configuration.pushNotificationConfig !== undefined) throw new RpcError(-32003, "Push notifications are not supported");
    if (configuration.acceptedOutputModes !== undefined &&
        (!Array.isArray(configuration.acceptedOutputModes) || !configuration.acceptedOutputModes.includes("application/json"))) {
      throw new RpcError(-32005, "application/json output is required");
    }
    if (configuration.historyLength !== undefined &&
        (!Number.isSafeInteger(configuration.historyLength) || Number(configuration.historyLength) < 0)) {
      throw new RpcError(-32602, "historyLength must be a non-negative integer");
    }
    if (configuration.blocking !== undefined && typeof configuration.blocking !== "boolean") {
      throw new RpcError(-32602, "blocking must be boolean");
    }
    if (configuration.blocking === false) throw new RpcError(-32004, "Non-blocking message submission is not supported");
    let entry: { task: A2aTask; body: Record<string, unknown> } | undefined;
    let paymentHeader: string | undefined;
    if (message.taskId !== undefined) {
      entry = tasks.get(nonempty(message.taskId));
      if (entry === undefined) throw new RpcError(-32001, "Task not found");
      if (message.contextId !== undefined && message.contextId !== entry.task.contextId) {
        throw new RpcError(-32602, "Task context does not match");
      }
      if (part.kind === "data") {
        if (canonicalize(record(part.data)) !== canonicalize(entry.body)) {
          throw new RpcError(-32602, "A payment cannot change the review request");
        }
      } else if (part.kind !== "text" || typeof part.text !== "string") {
        throw new RpcError(-32005, "Expected review data or payment text");
      }
      if (entry.task.status.state === "working") return entry.task;
      if (entry.task.status.state !== "input-required") throw new RpcError(-32004, "A terminal task cannot be restarted");
      if (metadata["x402.payment.status"] === "payment-rejected") {
        status(entry.task, "canceled", "Payment terms declined.", { "x402.payment.status": "payment-rejected", "x402.payment.receipts": [] });
        return entry.task;
      }
      const payload = PaymentPayloadV2Schema.safeParse(metadata["x402.payment.payload"]);
      if (metadata["x402.payment.status"] !== "payment-submitted" || !payload.success || payload.data.accepted.network !== "hedera:testnet") {
        throw new RpcError(-32602, "Expected an x402 payment submission");
      }
      paymentHeader = encodePaymentSignatureHeader({
        ...payload.data,
        accepted: { ...payload.data.accepted, network: "hedera:testnet", extra: record(payload.data.accepted.extra) },
        extensions: payload.data.extensions == null ? undefined : payload.data.extensions,
      });
    } else {
      if (message.contextId !== undefined) throw new RpcError(-32602, "New review tasks use server-generated contexts");
      if (metadata["x402.payment.payload"] !== undefined) throw new RpcError(-32602, "Obtain the task payment terms first");
      if (part.kind !== "data") throw new RpcError(-32005, "Expected review data");
      const body = record(part.data);
      if (Buffer.byteLength(JSON.stringify(body)) > 16 * 1024) throw new RpcError(-32602, "Review request exceeds the size limit");
      if (tasks.size >= MAX_TASKS) throw new RpcError(-32000, "Local task capacity reached; restart the adapter after collecting results");
      const taskId = randomUUID();
      const contextId = randomUUID();
      const task: A2aTask = {
        kind: "task", id: taskId, contextId,
        status: { state: "working", timestamp: new Date().toISOString(), message: {
          kind: "message", role: "agent", messageId: randomUUID(), taskId, contextId,
          parts: [{ kind: "text", text: "Review request received." }], metadata: {},
        } },
      };
      entry = { task, body };
      tasks.set(task.id, entry);
    }
    const { task, body } = entry;
    status(task, "working", "Review request submitted to the guard.");
    let receipts: SettleResponse[] = [];
    try {
      const response = await fetch(new URL("/review", guardOrigin), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(120_000),
        headers: { "content-type": "application/json", ...(paymentHeader === undefined ? {} : { "payment-signature": paymentHeader }) },
        body: JSON.stringify(body),
      });
      const receiptHeader = response.headers.get("payment-response");
      if (receiptHeader !== null) {
        const receipt = decodePaymentResponseHeader(receiptHeader);
        if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt) ||
            typeof receipt.success !== "boolean" || typeof receipt.transaction !== "string" ||
            typeof receipt.network !== "string" || (receipt.success && receipt.transaction === "")) {
          throw new Error("Guard settlement receipt is invalid");
        }
        receipts = [receipt];
      }
      const result: unknown = await response.json();
      if (response.status === 402) {
        const header = response.headers.get("payment-required");
        if (header === null && paymentHeader !== undefined) {
          status(task, "failed", "The guard did not accept the payment.", {
            "x402.payment.status": "payment-failed", "x402.payment.error": "PAYMENT_NOT_ACCEPTED",
            "x402.payment.receipts": receipts,
          });
          return task;
        }
        if (header === null) throw new Error("Guard payment terms missing");
        status(task, "input-required", "Accept the x402 terms to receive the authorization verdict.", {
          "x402.payment.status": paymentHeader === undefined ? "payment-required" : "payment-failed",
          "x402.payment.required": decodePaymentRequiredHeader(header),
          ...(paymentHeader === undefined ? {} : { "x402.payment.error": "PAYMENT_NOT_ACCEPTED" }),
          "x402.payment.receipts": receipts,
        });
        return task;
      }
      if (!response.ok) {
        if (paymentHeader === undefined) {
          tasks.delete(task.id);
          throw new RpcError(response.status === 400 || response.status === 413 ? -32602 : -32004,
            "Guard rejected the review request", { httpStatus: response.status, response: result });
        }
        status(task, "failed", "Guard review did not complete; inspect the receipt before taking further action.", {
          "x402.payment.status": receipts.some((receipt) => receipt.success) ? "payment-completed" : "payment-failed",
          "x402.payment.receipts": receipts, "review.httpStatus": response.status,
        });
        return task;
      }
      if (result === null || typeof result !== "object" || Array.isArray(result)) throw new Error("Guard verdict must be an object");
      const verdict = result as Record<string, unknown>;
      if (paymentHeader === undefined || (verdict.outcome !== "approved" && verdict.outcome !== "refused") ||
          receipts.length !== 1 || !receipts[0].success ||
          typeof verdict.settlementId !== "string" || verdict.settlementId !== receipts[0].transaction) {
        throw new Error("Guard returned an incomplete paid verdict");
      }
      task.artifacts = [{ artifactId: randomUUID(), name: "authorization-verdict", parts: [{ kind: "data", data: verdict }] }];
      status(task, "completed", "Authorization review completed.", {
        "x402.payment.status": "payment-completed", "x402.payment.receipts": receipts,
      });
      return task;
    } catch (error) {
      if (error instanceof RpcError) throw error;
      status(task, "failed", "Guard response unavailable or invalid; settlement may be pending. Do not automatically pay again.", {
        "x402.payment.status": receipts.some((receipt) => receipt.success) ? "payment-completed" : "payment-failed",
        "x402.payment.error": "GUARD_RESPONSE_UNAVAILABLE", "x402.payment.receipts": receipts,
      });
      return task;
    }
  }

  const server = createServer((request, response) => {
    let id: string | number | null = null;
    void (async () => {
      const path = new URL(request.url ?? "/", publicOrigin).pathname;
      if (["/.well-known/agent.json", "/.well-known/agent-card.json"].includes(path) && request.method === "GET") {
        writeJson(response, 200, await card());
        return;
      }
      if (path !== "/a2a") { writeJson(response, 404, { error: "not found" }); return; }
      if (request.method !== "POST") { response.setHeader("allow", "POST"); writeJson(response, 405, { error: "method not allowed" }); return; }
      const raw = await readBody(request);
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new RpcError(-32600, "Invalid JSON-RPC request");
      const rpc = record(raw);
      if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string" ||
          !(typeof rpc.id === "string" || (typeof rpc.id === "number" && Number.isSafeInteger(rpc.id)))) {
        throw new RpcError(-32600, "Expected JSON-RPC 2.0 with a request id");
      }
      id = rpc.id;
      if (!["message/send", "tasks/get", "tasks/cancel"].includes(rpc.method)) throw new RpcError(-32601, "Method not found");
      const params = record(rpc.params);
      let result: A2aTask;
      if (rpc.method === "message/send") {
        const extensions = request.headers["a2a-extensions"];
        if (typeof extensions !== "string" || !extensions.split(",").map((value) => value.trim()).includes(A2A_X402_EXTENSION)) {
          throw new RpcError(-32004, "Activate the required x402 extension using A2A-Extensions");
        }
        result = await send(params);
      } else {
        if (params.historyLength !== undefined && (!Number.isSafeInteger(params.historyLength) || Number(params.historyLength) < 0)) {
          throw new RpcError(-32602, "historyLength must be a non-negative integer");
        }
        const entry = tasks.get(nonempty(params.id));
        if (entry === undefined) throw new RpcError(-32001, "Task not found");
        if (rpc.method === "tasks/cancel") {
          if (entry.task.status.state !== "input-required") throw new RpcError(-32002, "Task cannot be canceled");
          status(entry.task, "canceled", "Unpaid review task canceled.", {
            "x402.payment.status": "payment-rejected", "x402.payment.receipts": entry.task.status.message.metadata["x402.payment.receipts"],
          });
        }
        result = entry.task;
      }
      writeJson(response, 200, { jsonrpc: "2.0", id, result });
    })().catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      response.setHeader("connection", "close");
      writeJson(response, 200, { jsonrpc: "2.0", id, error: error instanceof RpcError
        ? { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
        : { code: -32603, message: "Internal server error" } });
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  return server;
}
