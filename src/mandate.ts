import { createHash } from "node:crypto";

import type { PublicKey } from "@hiero-ledger/sdk";
import { canonicalize } from "json-canonicalize";

export interface Mandate {
  tenantId: string;
  nonce: string;
  treasuryAccountId: string;
  recipientAllowlist: string[];
  maxAmountTinybars: string;
  validFromEpochSeconds: string;
  expiresAtEpochSeconds: string;
}

export interface MandateEnvelope {
  mandate: Mandate;
  signature: string;
}

const envelopeFields = ["mandate", "signature"] as const;
const mandateFields = [
  "tenantId",
  "nonce",
  "treasuryAccountId",
  "recipientAllowlist",
  "maxAmountTinybars",
  "validFromEpochSeconds",
  "expiresAtEpochSeconds",
] as const;
const decimalFields = [
  "nonce",
  "maxAmountTinybars",
  "validFromEpochSeconds",
  "expiresAtEpochSeconds",
] as const;

const tenantIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const minimalUnsignedDecimalPattern = /^(0|[1-9][0-9]*)$/;
const numericAccountIdPattern = /^(\d+)\.(\d+)\.(\d+)$/;
const signaturePattern = /^[A-Za-z0-9_-]{86}$/;

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }

  return value as Record<string, unknown>;
}

function requireExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  name: "envelope" | "mandate",
): void {
  const allowedFields = new Set(fields);
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      throw new Error(`unknown ${name} field: ${field}`);
    }
  }

  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      throw new Error(`missing ${name} field: ${field}`);
    }
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string`);
  }

  return value;
}

function requireMinimalUnsignedDecimal(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!minimalUnsignedDecimalPattern.test(text)) {
    throw new Error(`${field} must be a minimal unsigned decimal string`);
  }

  return text;
}

function normalizeAccountId(value: unknown, field: string): string {
  const text = requireString(value, field);
  const match = numericAccountIdPattern.exec(text);
  if (match === null) {
    throw new Error(`${field} must be a numeric Hedera account ID`);
  }

  return `${BigInt(match[1]).toString()}.${BigInt(match[2]).toString()}.${BigInt(
    match[3],
  ).toString()}`;
}

function parseSignature(value: unknown): { encoding: string; bytes: Uint8Array } {
  const encoding = requireString(value, "signature");
  if (!signaturePattern.test(encoding)) {
    throw new Error("signature must be an unpadded base64url encoding of 64 bytes");
  }

  const bytes = Buffer.from(encoding, "base64url");
  if (bytes.length !== 64 || bytes.toString("base64url") !== encoding) {
    throw new Error("signature must be an unpadded base64url encoding of 64 bytes");
  }

  return { encoding, bytes };
}

function compareUnsignedDecimals(left: string, right: string): number {
  if (left.length !== right.length) {
    return left.length < right.length ? -1 : 1;
  }

  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

export function parseMandateEnvelope(input: unknown): MandateEnvelope {
  const envelope = requireRecord(input, "mandate envelope");
  requireExactFields(envelope, envelopeFields, "envelope");

  const unparsedMandate = requireRecord(envelope.mandate, "mandate");
  requireExactFields(unparsedMandate, mandateFields, "mandate");

  const tenantId = requireString(unparsedMandate.tenantId, "tenantId");
  if (!tenantIdPattern.test(tenantId)) {
    throw new Error("tenantId must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}");
  }

  const decimals = Object.fromEntries(
    decimalFields.map((field) => [
      field,
      requireMinimalUnsignedDecimal(unparsedMandate[field], field),
    ]),
  ) as Record<(typeof decimalFields)[number], string>;

  if (decimals.maxAmountTinybars === "0") {
    throw new Error("maxAmountTinybars must be positive");
  }
  if (
    compareUnsignedDecimals(
      decimals.expiresAtEpochSeconds,
      decimals.validFromEpochSeconds,
    ) <= 0
  ) {
    throw new Error(
      "expiresAtEpochSeconds must be greater than validFromEpochSeconds",
    );
  }

  if (!Array.isArray(unparsedMandate.recipientAllowlist)) {
    throw new TypeError("recipientAllowlist must be an array");
  }
  if (unparsedMandate.recipientAllowlist.length === 0) {
    throw new Error("recipientAllowlist must contain at least one account");
  }

  const recipientAllowlist = unparsedMandate.recipientAllowlist
    .map((accountId) => normalizeAccountId(accountId, "recipientAllowlist entry"))
    .sort();
  if (new Set(recipientAllowlist).size !== recipientAllowlist.length) {
    throw new Error("recipientAllowlist contains a duplicate account");
  }

  const { encoding: signature } = parseSignature(envelope.signature);

  return {
    mandate: {
      tenantId,
      nonce: decimals.nonce,
      treasuryAccountId: normalizeAccountId(
        unparsedMandate.treasuryAccountId,
        "treasuryAccountId",
      ),
      recipientAllowlist,
      maxAmountTinybars: decimals.maxAmountTinybars,
      validFromEpochSeconds: decimals.validFromEpochSeconds,
      expiresAtEpochSeconds: decimals.expiresAtEpochSeconds,
    },
    signature,
  };
}

export function canonicalMandateBytes(mandate: Mandate): Uint8Array {
  return new TextEncoder().encode(
    `COUNTERSIGN-MANDATE\u00001\u0000${canonicalize(mandate)}`,
  );
}

export function verifyMandateSignature(
  envelope: MandateEnvelope,
  ownerPublicKey: PublicKey,
): boolean {
  if (ownerPublicKey.type !== "ED25519") {
    return false;
  }

  const signature = parseSignature(envelope.signature).bytes;
  return ownerPublicKey.verify(canonicalMandateBytes(envelope.mandate), signature);
}

export function mandateDigest(mandate: Mandate): string {
  return createHash("sha256").update(canonicalMandateBytes(mandate)).digest("hex");
}
