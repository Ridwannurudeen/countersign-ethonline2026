const mirrorNodeBaseUrl = "https://testnet.mirrornode.hedera.com/api/v1";
const numericEntityIdPattern =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const publicKeyHexPattern = /^(?:[0-9a-fA-F]{2})+$/;
const consensusTimestampPattern = /^(0|[1-9][0-9]*)\.[0-9]{9}$/;

export interface ScheduleEvidence {
  readonly creatorAccountId: string;
  readonly payerAccountId: string;
  readonly executedTimestamp: string | null;
  readonly deleted: boolean;
  readonly publicKeyPrefixes: readonly string[];
}

export interface ExpectedScheduleEvidence {
  readonly expectedAgentAccountId: string;
  readonly agentPublicKeyHex: string;
  readonly guardPublicKeyHex: string;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }

  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }

  return value;
}

function requireNumericEntityId(value: string, field: string): string {
  if (!numericEntityIdPattern.test(value)) {
    throw new Error(`${field} must be a canonical numeric Hedera ID`);
  }

  return value;
}

function decodeMirrorPublicKeyPrefix(value: string, field: string): string {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value) {
    throw new Error(`${field} must be canonical base64`);
  }

  return bytes.toString("hex");
}

function containsPublicKeyPrefix(
  publicKeyPrefixes: readonly string[],
  publicKeyHex: string,
): boolean {
  if (!publicKeyHexPattern.test(publicKeyHex)) {
    throw new Error("expected public key must be hexadecimal");
  }

  const normalizedPublicKey = publicKeyHex.toLowerCase();
  return publicKeyPrefixes.some((prefix) =>
    normalizedPublicKey === prefix.toLowerCase(),
  );
}

function assertCommonScheduleEvidence(
  evidence: ScheduleEvidence,
  expected: ExpectedScheduleEvidence,
): void {
  if (evidence.creatorAccountId !== expected.expectedAgentAccountId) {
    throw new Error(
      "mirror evidence creator_account_id does not match the agent",
    );
  }
  if (evidence.payerAccountId !== expected.expectedAgentAccountId) {
    throw new Error(
      "mirror evidence payer_account_id does not match the agent",
    );
  }
  if (evidence.deleted) {
    throw new Error("mirror evidence reports the schedule as deleted");
  }
  if (
    !containsPublicKeyPrefix(
      evidence.publicKeyPrefixes,
      expected.agentPublicKeyHex,
    )
  ) {
    throw new Error("agent key prefix must be present in mirror evidence");
  }
}

export function scheduleMirrorNodeUrl(scheduleId: {
  toString(): string;
}): string {
  const value = requireNumericEntityId(scheduleId.toString(), "scheduleId");
  return `${mirrorNodeBaseUrl}/schedules/${value}`;
}

export function accountMirrorNodeUrl(accountId: {
  toString(): string;
}): string {
  const value = requireNumericEntityId(accountId.toString(), "accountId");
  return `${mirrorNodeBaseUrl}/accounts/${value}`;
}

export function parseScheduleEvidence(value: unknown): ScheduleEvidence {
  const record = requireRecord(value, "mirror schedule response");
  const creatorAccountId = requireNumericEntityId(
    requireString(record.creator_account_id, "creator_account_id"),
    "creator_account_id",
  );
  const payerAccountId = requireNumericEntityId(
    requireString(record.payer_account_id, "payer_account_id"),
    "payer_account_id",
  );
  const executedTimestamp =
    record.executed_timestamp === null
      ? null
      : requireString(record.executed_timestamp, "executed_timestamp");
  if (
    executedTimestamp !== null &&
    !consensusTimestampPattern.test(executedTimestamp)
  ) {
    throw new Error("executed_timestamp must be a consensus timestamp");
  }
  if (typeof record.deleted !== "boolean") {
    throw new TypeError("deleted must be a boolean");
  }
  if (!Array.isArray(record.signatures)) {
    throw new TypeError("signatures must be an array");
  }

  const publicKeyPrefixes = record.signatures.map((signature, index) => {
    const prefix = requireString(
      requireRecord(signature, `signatures[${index}]`).public_key_prefix,
      `signatures[${index}].public_key_prefix`,
    );
    return decodeMirrorPublicKeyPrefix(
      prefix,
      `signatures[${index}].public_key_prefix`,
    );
  });

  return {
    creatorAccountId,
    payerAccountId,
    executedTimestamp,
    deleted: record.deleted,
    publicKeyPrefixes,
  };
}

export function assertPendingScheduleEvidence(
  evidence: ScheduleEvidence,
  expected: ExpectedScheduleEvidence,
): void {
  assertCommonScheduleEvidence(evidence, expected);
  if (evidence.executedTimestamp !== null) {
    throw new Error("pending schedule must not have an executed_timestamp");
  }
  if (
    containsPublicKeyPrefix(
      evidence.publicKeyPrefixes,
      expected.guardPublicKeyHex,
    )
  ) {
    throw new Error(
      "guard key prefix must be absent from pending mirror evidence",
    );
  }
}

export function assertExecutedScheduleEvidence(
  evidence: ScheduleEvidence,
  expected: ExpectedScheduleEvidence,
): void {
  assertCommonScheduleEvidence(evidence, expected);
  if (evidence.executedTimestamp === null) {
    throw new Error("executed schedule must have an executed_timestamp");
  }
  if (
    !containsPublicKeyPrefix(
      evidence.publicKeyPrefixes,
      expected.guardPublicKeyHex,
    )
  ) {
    throw new Error(
      "guard key prefix must be present in executed mirror evidence",
    );
  }
}
