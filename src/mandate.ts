import { createHash, verify } from "node:crypto";

import type { PublicKey } from "@hiero-ledger/sdk";
import { canonicalize } from "json-canonicalize";

interface MandateFields {
  tenantId: string;
  nonce: string;
  treasuryAccountId: string;
  recipientAllowlist: string[];
  maxAmountTinybars: string;
  validFromEpochSeconds: string;
  expiresAtEpochSeconds: string;
}

export interface LegacyHbarMandate extends MandateFields {
  schemaVersion?: never;
  asset?: never;
}

export type MandateAsset =
  | { kind: "hbar" }
  | { kind: "hts"; tokenId: string };

export interface MandateV2 extends MandateFields {
  schemaVersion: "2";
  asset: MandateAsset;
}

export type Mandate = LegacyHbarMandate | MandateV2;

export interface MandateEnvelope {
  mandate: Mandate;
  signature: string;
}

const envelopeFields = ["mandate", "signature"] as const;
const legacyMandateFields = [
  "tenantId",
  "nonce",
  "treasuryAccountId",
  "recipientAllowlist",
  "maxAmountTinybars",
  "validFromEpochSeconds",
  "expiresAtEpochSeconds",
] as const;
const versionTwoMandateFields = [
  "schemaVersion",
  "asset",
  ...legacyMandateFields,
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
  name: string,
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

function parseAsset(value: unknown): MandateAsset {
  const asset = requireRecord(value, "asset");
  const kind = requireString(asset.kind, "asset kind");
  if (kind === "hbar") {
    requireExactFields(asset, ["kind"], "asset");
    return { kind };
  }
  if (kind === "hts") {
    requireExactFields(asset, ["kind", "tokenId"], "asset");
    return {
      kind,
      tokenId: normalizeTokenId(asset.tokenId),
    };
  }
  throw new Error("asset kind must be hbar or hts");
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

function normalizeTokenId(value: unknown): string {
  const text = requireString(value, "tokenId");
  const match = numericAccountIdPattern.exec(text);
  if (match === null) {
    throw new Error("tokenId must be a numeric Hedera token ID");
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
  const isVersionTwo =
    Object.hasOwn(unparsedMandate, "schemaVersion") ||
    Object.hasOwn(unparsedMandate, "asset");
  requireExactFields(
    unparsedMandate,
    isVersionTwo ? versionTwoMandateFields : legacyMandateFields,
    "mandate",
  );
  if (
    isVersionTwo &&
    requireString(unparsedMandate.schemaVersion, "schemaVersion") !== "2"
  ) {
    throw new Error("schemaVersion must be 2");
  }

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

  const fields: MandateFields = {
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
  };
  return isVersionTwo
    ? {
        mandate: {
          schemaVersion: "2",
          asset: parseAsset(unparsedMandate.asset),
          ...fields,
        },
        signature,
      }
    : { mandate: fields, signature };
}

export function canonicalMandateBytes(mandate: Mandate): Uint8Array {
  const schemaVersion = mandate.schemaVersion === "2" ? "2" : "1";
  return new TextEncoder().encode(
    `COUNTERSIGN-MANDATE\u0000${schemaVersion}\u0000${canonicalize(mandate)}`,
  );
}

export function mandateAsset(mandate: Mandate): MandateAsset {
  return mandate.schemaVersion === "2" ? mandate.asset : { kind: "hbar" };
}

export function verifyMandateSignature(
  envelope: MandateEnvelope,
  ownerPublicKey: PublicKey,
): boolean {
  if (ownerPublicKey.type !== "ED25519") {
    return false;
  }

  const signature = parseSignature(envelope.signature).bytes;
  return verify(
    null,
    canonicalMandateBytes(envelope.mandate),
    {
      key: Buffer.from(ownerPublicKey.toBytesDer()),
      format: "der",
      type: "spki",
    },
    signature,
  );
}

export function mandateDigest(mandate: Mandate): string {
  return createHash("sha256").update(canonicalMandateBytes(mandate)).digest("hex");
}
