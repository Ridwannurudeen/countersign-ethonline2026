import {
  Client,
  type Key,
  PublicKey,
  TopicCreateTransaction,
  TopicInfoQuery,
  TopicMessageSubmitTransaction,
} from "@hiero-ledger/sdk";

export interface VerdictRecord {
  readonly outcome: "approved" | "refused";
  readonly scheduleId: string;
  readonly mandateDigest: string;
  readonly settlementId: string;
  readonly tenantId: string;
  readonly agentIdentifier: string;
  readonly guardIdentifier: string;
}

export interface VerdictRecordReceipt {
  readonly topicId: string;
  readonly sequenceNumber: string;
  readonly mirrorNodeUrl: string;
}

export interface VerdictLog {
  record(record: VerdictRecord): Promise<VerdictRecordReceipt>;
}

export interface VerdictTopicTransport {
  lookupTopic(topicId: string): Promise<void>;
  createTopic(): Promise<string>;
  submitMessage(topicId: string, message: string): Promise<string>;
}

export interface VerdictTopicInfo {
  readonly topicId: { toString(): string };
  readonly topicMemo: string;
  readonly adminKey: Key | null;
  readonly submitKey: Key | null;
  readonly feeScheduleKey: Key | null;
  readonly customFees: readonly unknown[] | null;
}

const topicMemo = "Countersign review verdicts";
const mirrorNodeTopicBaseUrl =
  "https://testnet.mirrornode.hedera.com/api/v1/topics";
const topicIdPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const sequenceNumberPattern = /^[1-9][0-9]*$/;
const scheduleIdPattern = topicIdPattern;
const mandateDigestPattern = /^[0-9a-f]{64}$/;
const tenantIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const participantIdentifierPattern = /^uaid:(aid|did):[^\s]+$/;

function requireTopicId(value: string): string {
  if (!topicIdPattern.test(value)) {
    throw new Error(
      "verdict topic ID must be a canonical numeric Hedera TopicID",
    );
  }

  return value;
}

function validateVerdictRecord(record: VerdictRecord): void {
  if (record.outcome !== "approved" && record.outcome !== "refused") {
    throw new Error("verdict outcome must be approved or refused");
  }
  if (!scheduleIdPattern.test(record.scheduleId)) {
    throw new Error("scheduleId must be a canonical numeric Hedera ScheduleID");
  }
  if (!mandateDigestPattern.test(record.mandateDigest)) {
    throw new Error("mandateDigest must be a lowercase SHA-256 digest");
  }
  if (record.settlementId.length === 0) {
    throw new Error("settlementId must not be empty");
  }
  if (!tenantIdPattern.test(record.tenantId)) {
    throw new Error("tenantId must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}");
  }
  if (!participantIdentifierPattern.test(record.agentIdentifier)) {
    throw new Error("agentIdentifier must be an HCS-14 identifier");
  }
  if (!participantIdentifierPattern.test(record.guardIdentifier)) {
    throw new Error("guardIdentifier must be an HCS-14 identifier");
  }
}

function verdictMessage(record: VerdictRecord): string {
  validateVerdictRecord(record);
  const message = JSON.stringify({
    v: 1,
    outcome: record.outcome,
    scheduleId: record.scheduleId,
    mandateDigest: record.mandateDigest,
    settlementId: record.settlementId,
    tenantId: record.tenantId,
    participants: {
      agent: record.agentIdentifier,
      guard: record.guardIdentifier,
    },
  });
  if (Buffer.byteLength(message, "utf8") > 1024) {
    throw new Error("verdict record must fit in one HCS message chunk");
  }

  return message;
}

export function validateVerdictTopicInfo(
  info: VerdictTopicInfo,
  topicId: string,
  operatorPublicKey: PublicKey,
): void {
  if (info.topicId.toString() !== topicId) {
    throw new Error(
      "returned verdict topic ID does not match the configured TopicID",
    );
  }
  if (info.topicMemo !== topicMemo) {
    throw new Error("configured TopicID is not a Countersign verdict topic");
  }
  if (info.adminKey !== null) {
    throw new Error("verdict topic must not have an admin key");
  }
  if (
    !(info.submitKey instanceof PublicKey) ||
    !info.submitKey.equals(operatorPublicKey)
  ) {
    throw new Error(
      "verdict topic submit key does not match the client operator",
    );
  }
  if (info.feeScheduleKey !== null) {
    throw new Error("verdict topic must not have a fee schedule key");
  }
  if (info.customFees !== null && info.customFees.length !== 0) {
    throw new Error("verdict topic must not charge custom fees");
  }
}

export function createHederaVerdictTopicTransport(
  client: Client,
): VerdictTopicTransport {
  const operatorPublicKey = client.operatorPublicKey;
  if (operatorPublicKey === null) {
    throw new Error("HCS verdict client operator key is required");
  }

  return {
    async lookupTopic(topicId) {
      const info = await new TopicInfoQuery()
        .setTopicId(topicId)
        .execute(client);
      validateVerdictTopicInfo(info, topicId, operatorPublicKey);
    },

    async createTopic() {
      const response = await new TopicCreateTransaction()
        .setTopicMemo(topicMemo)
        .setSubmitKey(operatorPublicKey)
        .execute(client);
      const receipt = await response.getReceipt(client);
      if (receipt.topicId === null) {
        throw new Error("topic creation receipt did not contain a TopicID");
      }

      return receipt.topicId.toString();
    },

    async submitMessage(topicId, message) {
      const response = await new TopicMessageSubmitTransaction()
        .setTopicId(topicId)
        .setMessage(message)
        .execute(client);
      const receipt = await response.getReceipt(client);
      if (receipt.topicSequenceNumber === null) {
        throw new Error(
          "verdict submission receipt did not contain a sequence number",
        );
      }

      return receipt.topicSequenceNumber.toString();
    },
  };
}

export async function openVerdictLog(
  transport: VerdictTopicTransport,
  configuredTopicId?: string,
): Promise<VerdictLog> {
  let topicId: string;
  if (configuredTopicId === undefined) {
    topicId = requireTopicId(await transport.createTopic());
  } else {
    topicId = requireTopicId(configuredTopicId);
    await transport.lookupTopic(topicId);
  }

  return {
    async record(record) {
      const sequenceNumber = await transport.submitMessage(
        topicId,
        verdictMessage(record),
      );
      if (!sequenceNumberPattern.test(sequenceNumber)) {
        throw new Error(
          "verdict sequence number must be a positive decimal string",
        );
      }

      return {
        topicId,
        sequenceNumber,
        mirrorNodeUrl: `${mirrorNodeTopicBaseUrl}/${topicId}/messages/${sequenceNumber}`,
      };
    },
  };
}
