import { createHash } from "node:crypto";

export interface Hcs14AgentIdentity {
  readonly registry: string;
  readonly name: string;
  readonly version: string;
  readonly protocol: string;
  readonly nativeId: string;
  readonly skills: readonly number[];
  readonly uid?: string;
  readonly domain?: string;
}

const base58Alphabet =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const hederaCaip10Pattern =
  /^hedera:(mainnet|testnet|previewnet|devnet):\d+\.\d+\.\d+(?:-[a-zA-Z0-9]{5})?$/;
const hcs14IdentifierPattern = /^uaid:(aid|did):[^\s]+$/;
const maxHcsMessageBytes = 1_024;

export function validateHcs14Identifier(
  identifier: string,
  field?: string,
): void {
  if (!hcs14IdentifierPattern.test(identifier)) {
    throw new Error(
      field === undefined
        ? "HCS-14 identifier must not contain whitespace"
        : `${field} must be an HCS-14 identifier without whitespace`,
    );
  }
  if (Buffer.byteLength(identifier, "utf8") > maxHcsMessageBytes) {
    throw new Error(
      `${field ?? "HCS-14 identifier"} must fit in one HCS message chunk`,
    );
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must not be empty`);
  }

  return value.trim();
}

function normalizeSkills(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new TypeError("skills must be an array");
  }

  const skills: number[] = [];
  for (const skill of value) {
    if (
      typeof skill !== "number" ||
      !Number.isSafeInteger(skill) ||
      skill < 0 ||
      (skill >= 40 && skill <= 99)
    ) {
      throw new Error(
        "skill identifier must be an integer in 0-39 or at least 100",
      );
    }
    skills.push(skill);
  }

  return skills.sort((left, right) => left - right);
}

function base58Encode(bytes: Uint8Array): string {
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) {
    leadingZeroes += 1;
  }

  const hex = Buffer.from(bytes).toString("hex");
  let value = BigInt(`0x${hex}`);
  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = `${base58Alphabet[remainder]}${encoded}`;
    value /= 58n;
  }

  return `${"1".repeat(leadingZeroes)}${encoded}`;
}

export function generateHcs14Aid(identity: Hcs14AgentIdentity): string {
  const registry = requireNonEmptyString(
    identity.registry,
    "registry",
  ).toLowerCase();
  const name = requireNonEmptyString(identity.name, "name");
  const version = requireNonEmptyString(identity.version, "version");
  const protocol = requireNonEmptyString(
    identity.protocol,
    "protocol",
  ).toLowerCase();
  const nativeId = requireNonEmptyString(identity.nativeId, "nativeId");
  if (protocol === "hcs-10" && !hederaCaip10Pattern.test(nativeId)) {
    throw new Error(
      "nativeId must be a Hedera CAIP-10 account identifier for hcs-10",
    );
  }
  const skills = normalizeSkills(identity.skills);
  const uid =
    identity.uid === undefined
      ? "0"
      : requireNonEmptyString(identity.uid, "uid");
  const domain =
    identity.domain === undefined
      ? null
      : requireNonEmptyString(identity.domain, "domain");

  const canonicalJson = JSON.stringify({
    name,
    nativeId,
    protocol,
    registry,
    skills,
    version,
  });
  const hash = createHash("sha384").update(canonicalJson, "utf8").digest();
  const parameters = [
    `uid=${uid}`,
    `registry=${registry}`,
    `proto=${protocol}`,
    `nativeId=${nativeId}`,
  ];
  if (domain !== null) {
    parameters.push(`domain=${domain}`);
  }

  const identifier = `uaid:aid:${base58Encode(hash)};${parameters.join(";")}`;
  validateHcs14Identifier(identifier);
  return identifier;
}
