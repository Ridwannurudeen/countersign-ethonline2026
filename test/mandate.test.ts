import assert from "node:assert/strict";
import test from "node:test";

import { PrivateKey } from "@hiero-ledger/sdk";

import {
  canonicalMandateBytes,
  mandateDigest,
  parseMandateEnvelope,
  verifyMandateSignature,
  type Mandate,
} from "../src/mandate.ts";

const mandate: Mandate = {
  tenantId: "treasury-1",
  nonce: "7",
  treasuryAccountId: "0.0.1001",
  recipientAllowlist: ["0.0.1002", "0.0.1003"],
  maxAmountTinybars: "50000000",
  validFromEpochSeconds: "1788508800",
  expiresAtEpochSeconds: "1788512400",
};

function signedEnvelope(value: Mandate) {
  const ownerKey = PrivateKey.generateED25519();
  const signature = Buffer.from(ownerKey.sign(canonicalMandateBytes(value))).toString(
    "base64url",
  );

  return {
    ownerKey,
    input: { mandate: value, signature },
  };
}

test("canonicalMandateBytes uses the domain-separated RFC 8785 preimage", () => {
  const text = new TextDecoder().decode(canonicalMandateBytes(mandate));

  assert.equal(
    text,
    'COUNTERSIGN-MANDATE\u00001\u0000{"expiresAtEpochSeconds":"1788512400","maxAmountTinybars":"50000000","nonce":"7","recipientAllowlist":["0.0.1002","0.0.1003"],"tenantId":"treasury-1","treasuryAccountId":"0.0.1001","validFromEpochSeconds":"1788508800"}',
  );
});

test("verifyMandateSignature accepts the owner Ed25519 signature", () => {
  const { ownerKey, input } = signedEnvelope(mandate);
  const envelope = parseMandateEnvelope(input);

  assert.equal(verifyMandateSignature(envelope, ownerKey.publicKey), true);
});

test("verifyMandateSignature refuses a signature from a different key", () => {
  const { input } = signedEnvelope(mandate);
  const envelope = parseMandateEnvelope(input);

  assert.equal(
    verifyMandateSignature(envelope, PrivateKey.generateED25519().publicKey),
    false,
  );
});

test("parseMandateEnvelope rejects unknown envelope fields", () => {
  const { input } = signedEnvelope(mandate);

  assert.throws(
    () => parseMandateEnvelope({ ...input, untrustedInstruction: "ignored" }),
    /unknown envelope field/,
  );
});

test("parseMandateEnvelope rejects unknown mandate fields", () => {
  const { input } = signedEnvelope(mandate);

  assert.throws(
    () =>
      parseMandateEnvelope({
        ...input,
        mandate: { ...mandate, outOfPolicy: true },
      }),
    /unknown mandate field/,
  );
});

test("parseMandateEnvelope rejects every missing mandate field", () => {
  for (const field of Object.keys(mandate)) {
    const incomplete = { ...mandate } as Record<string, unknown>;
    delete incomplete[field];

    assert.throws(
      () => parseMandateEnvelope({ mandate: incomplete, signature: "A".repeat(86) }),
      new RegExp(`missing mandate field: ${field}`),
    );
  }
});

test("parseMandateEnvelope rejects non-minimal unsigned decimal fields", () => {
  for (const field of [
    "nonce",
    "maxAmountTinybars",
    "validFromEpochSeconds",
    "expiresAtEpochSeconds",
  ] as const) {
    assert.throws(
      () =>
        parseMandateEnvelope({
          mandate: { ...mandate, [field]: "01" },
          signature: "A".repeat(86),
        }),
      new RegExp(`${field} must be a minimal unsigned decimal string`),
    );
  }
});

test("parseMandateEnvelope rejects an invalid tenant identifier", () => {
  assert.throws(
    () =>
      parseMandateEnvelope({
        mandate: { ...mandate, tenantId: "contains spaces" },
        signature: "A".repeat(86),
      }),
    /tenantId must match/,
  );
});

test("parseMandateEnvelope normalizes numeric account IDs and sorts the allowlist", () => {
  const envelope = parseMandateEnvelope({
    mandate: {
      ...mandate,
      treasuryAccountId: "00.000.001001",
      recipientAllowlist: ["00.0.001003", "0.00.01002"],
    },
    signature: "A".repeat(86),
  });

  assert.equal(envelope.mandate.treasuryAccountId, "0.0.1001");
  assert.deepEqual(envelope.mandate.recipientAllowlist, ["0.0.1002", "0.0.1003"]);
});

test("parseMandateEnvelope rejects duplicate recipients after normalization", () => {
  assert.throws(
    () =>
      parseMandateEnvelope({
        mandate: {
          ...mandate,
          recipientAllowlist: ["0.0.1002", "00.00.001002"],
        },
        signature: "A".repeat(86),
      }),
    /recipientAllowlist contains a duplicate account/,
  );
});

test("parseMandateEnvelope rejects non-numeric account IDs", () => {
  assert.throws(
    () =>
      parseMandateEnvelope({
        mandate: { ...mandate, treasuryAccountId: "0.0.alias" },
        signature: "A".repeat(86),
      }),
    /treasuryAccountId must be a numeric Hedera account ID/,
  );
});

test("parseMandateEnvelope rejects an empty recipient allowlist", () => {
  assert.throws(
    () =>
      parseMandateEnvelope({
        mandate: { ...mandate, recipientAllowlist: [] },
        signature: "A".repeat(86),
      }),
    /recipientAllowlist must contain at least one account/,
  );
});

test("parseMandateEnvelope rejects a zero cap", () => {
  assert.throws(
    () =>
      parseMandateEnvelope({
        mandate: { ...mandate, maxAmountTinybars: "0" },
        signature: "A".repeat(86),
      }),
    /maxAmountTinybars must be positive/,
  );
});

test("parseMandateEnvelope rejects a validity interval with no duration", () => {
  assert.throws(
    () =>
      parseMandateEnvelope({
        mandate: {
          ...mandate,
          expiresAtEpochSeconds: mandate.validFromEpochSeconds,
        },
        signature: "A".repeat(86),
      }),
    /expiresAtEpochSeconds must be greater than validFromEpochSeconds/,
  );
});

test("parseMandateEnvelope rejects non-canonical signature encoding", () => {
  const { input } = signedEnvelope(mandate);

  assert.throws(
    () => parseMandateEnvelope({ ...input, signature: `${input.signature}=` }),
    /signature must be an unpadded base64url encoding of 64 bytes/,
  );
});

test("mandateDigest is a deterministic lowercase SHA-256 digest", () => {
  const digest = mandateDigest(mandate);

  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, mandateDigest({ ...mandate }));
});
