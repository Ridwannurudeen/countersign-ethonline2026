import { DatabaseSync } from "node:sqlite";

export type MandateReviewReservation = {
  tenantId: string;
  nonce: string;
  mandateDigest: string;
} & (
  | { scheduleId: string; transactionDigest?: never }
  | { scheduleId?: never; transactionDigest: string }
);

export interface CompletedMandateReview {
  outcome: "approved";
  recipientAccountId: string;
  amountTinybars: string;
  settlementId: string;
  mirrorNodeUrl: string;
}

export type MandateReviewReservationResult =
  | { status: "reserved" }
  | { status: "retry"; outcome: string | null }
  | { status: "refused"; reason: string };

export type MandateReviewState =
  | { status: "absent" }
  | { status: "pending" }
  | { status: "completed"; completion: CompletedMandateReview };

const tenantIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const minimalUnsignedDecimalPattern = /^(0|[1-9][0-9]*)$/;
const digestPattern = /^[0-9a-f]{64}$/;
const scheduleIdPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const replayDatabaseBusyTimeoutMilliseconds = 100;

export class ReplayStoreContentionError extends Error {
  readonly retryable = true;

  constructor(cause: unknown) {
    super("replay database is busy; retry the review", { cause });
    this.name = "ReplayStoreContentionError";
  }
}

function validateDatabasePath(databasePath: string): void {
  if (databasePath.length === 0) {
    throw new Error("database path must not be empty");
  }
}

function openFileBackedDatabase(
  databasePath: string,
  readOnly: boolean,
): DatabaseSync {
  validateDatabasePath(databasePath);

  const database = new DatabaseSync(databasePath, {
    readOnly,
    timeout: replayDatabaseBusyTimeoutMilliseconds,
  });
  try {
    const mainDatabase = database
      .prepare("SELECT file FROM pragma_database_list WHERE name = 'main'")
      .get();
    if (mainDatabase === undefined || mainDatabase.file === "") {
      throw new Error("replay database must be file-backed");
    }
    if (typeof mainDatabase.file !== "string") {
      throw new Error("replay database path is invalid");
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function validateReservation(value: MandateReviewReservation): void {
  if (!tenantIdPattern.test(value.tenantId)) {
    throw new Error("tenantId must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}");
  }
  if (!minimalUnsignedDecimalPattern.test(value.nonce)) {
    throw new Error("nonce must be a minimal unsigned decimal string");
  }
  if (!digestPattern.test(value.mandateDigest)) {
    throw new Error("mandateDigest must be a lowercase SHA-256 digest");
  }
  if (value.transactionDigest !== undefined) {
    if (!digestPattern.test(value.transactionDigest)) {
      throw new Error("transactionDigest must be a lowercase SHA-256 digest");
    }
  } else if (!scheduleIdPattern.test(value.scheduleId)) {
    throw new Error("scheduleId must be a canonical numeric Hedera ScheduleID");
  }
}

function reservationTarget(value: MandateReviewReservation): string {
  return value.transactionDigest === undefined
    ? value.scheduleId
    : `transfer:${value.transactionDigest}`;
}

function validateCompletedReview(value: CompletedMandateReview): void {
  if (value.outcome !== "approved") {
    throw new Error("review outcome must be approved");
  }
  if (!scheduleIdPattern.test(value.recipientAccountId)) {
    throw new Error("recipientAccountId must be a canonical numeric Hedera AccountID");
  }
  if (!minimalUnsignedDecimalPattern.test(value.amountTinybars)) {
    throw new Error("amountTinybars must be a minimal unsigned decimal string");
  }
  if (value.settlementId.length === 0) {
    throw new Error("settlementId must not be empty");
  }
  if (value.mirrorNodeUrl.length === 0) {
    throw new Error("mirrorNodeUrl must not be empty");
  }
}

function completedReviewFromRow(
  row: Record<string, unknown>,
): CompletedMandateReview | null {
  if (row.outcome !== "approved") {
    return null;
  }

  const responseValues = [
    row.recipient_account_id,
    row.amount_tinybars,
    row.settlement_id,
    row.mirror_node_url,
  ];
  if (responseValues.every((value) => value === null)) {
    return null;
  }

  const completion: CompletedMandateReview = {
    outcome: "approved",
    recipientAccountId: requireStoredString(row, "recipient_account_id"),
    amountTinybars: requireStoredString(row, "amount_tinybars"),
    settlementId: requireStoredString(row, "settlement_id"),
    mirrorNodeUrl: requireStoredString(row, "mirror_node_url"),
  };
  validateCompletedReview(completion);
  return completion;
}

function initializeDatabase(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS mandate_reviews (
      tenant_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      mandate_digest TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      outcome TEXT,
      recipient_account_id TEXT,
      amount_tinybars TEXT,
      settlement_id TEXT,
      mirror_node_url TEXT,
      PRIMARY KEY (tenant_id, nonce)
    ) STRICT
  `);

  const columns = new Set(
    database
      .prepare("SELECT name FROM pragma_table_info('mandate_reviews')")
      .all()
      .map((row) => requireStoredString(row, "name")),
  );
  const responseColumns = [
    ["recipient_account_id", "TEXT"],
    ["amount_tinybars", "TEXT"],
    ["settlement_id", "TEXT"],
    ["mirror_node_url", "TEXT"],
  ] as const;
  for (const [name, type] of responseColumns) {
    if (!columns.has(name)) {
      database.exec(`ALTER TABLE mandate_reviews ADD COLUMN ${name} ${type}`);
    }
  }
}

function isGreaterUnsignedDecimal(candidate: string, highWaterMark: string): boolean {
  if (candidate.length !== highWaterMark.length) {
    return candidate.length > highWaterMark.length;
  }

  return candidate > highWaterMark;
}

function requireStoredString(
  row: Record<string, unknown>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`stored ${field} is invalid`);
  }

  return value;
}

function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const errcode = Reflect.get(error, "errcode");
  return (
    Reflect.get(error, "code") === "ERR_SQLITE_ERROR" &&
    typeof errcode === "number" &&
    (errcode & 0xff) === 5
  );
}

function withReplayDatabase<T>(
  databasePath: string,
  access: "read" | "write",
  operation: (database: DatabaseSync) => T,
): T {
  let database: DatabaseSync;
  try {
    database = openFileBackedDatabase(databasePath, access === "read");
  } catch (error) {
    if (isSqliteBusyError(error)) {
      throw new ReplayStoreContentionError(error);
    }
    throw error;
  }

  try {
    database.exec(access === "write" ? "BEGIN IMMEDIATE" : "BEGIN");
    if (access === "write") {
      initializeDatabase(database);
    }
    const result = operation(database);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }
    if (isSqliteBusyError(error)) {
      throw new ReplayStoreContentionError(error);
    }
    throw error;
  } finally {
    database.close();
  }
}

export function initializeReplayStore(databasePath: string): void {
  withReplayDatabase(databasePath, "write", () => undefined);
}

export function reserveMandateReview(
  databasePath: string,
  reservation: MandateReviewReservation,
): MandateReviewReservationResult {
  validateReservation(reservation);

  return withReplayDatabase(databasePath, "write", (database) => {
    const existing = database
      .prepare(
        `SELECT mandate_digest, schedule_id, outcome
         FROM mandate_reviews
         WHERE tenant_id = ? AND nonce = ?`,
      )
      .get(reservation.tenantId, reservation.nonce);

    if (existing !== undefined) {
      const sameTuple =
        requireStoredString(existing, "mandate_digest") ===
          reservation.mandateDigest &&
        requireStoredString(existing, "schedule_id") === reservationTarget(reservation);

      if (!sameTuple) {
        return {
          status: "refused",
          reason:
            "nonce is already bound to a different mandate digest or ScheduleID",
        };
      }

      const storedOutcome = existing.outcome;
      if (storedOutcome !== null && typeof storedOutcome !== "string") {
        throw new Error("stored outcome is invalid");
      }
      return { status: "retry", outcome: storedOutcome };
    }

    const highWaterRow = database
      .prepare(
        `SELECT nonce
         FROM mandate_reviews
         WHERE tenant_id = ?
         ORDER BY length(nonce) DESC, nonce DESC
         LIMIT 1`,
      )
      .get(reservation.tenantId);

    if (
      highWaterRow !== undefined &&
      !isGreaterUnsignedDecimal(
        reservation.nonce,
        requireStoredString(highWaterRow, "nonce"),
      )
    ) {
      return {
        status: "refused",
        reason: "nonce must be greater than the tenant high-water mark",
      };
    }

    database
      .prepare(
        `INSERT INTO mandate_reviews
           (tenant_id, nonce, mandate_digest, schedule_id, outcome)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .run(
        reservation.tenantId,
        reservation.nonce,
        reservation.mandateDigest,
        reservationTarget(reservation),
      );
    return { status: "reserved" };
  });
}

export function completeMandateReview(
  databasePath: string,
  reservation: MandateReviewReservation,
  completion: CompletedMandateReview,
): void {
  validateReservation(reservation);
  validateCompletedReview(completion);

  withReplayDatabase(databasePath, "write", (database) => {
    const result = database
      .prepare(
        `UPDATE mandate_reviews
         SET outcome = ?,
             recipient_account_id = ?,
             amount_tinybars = ?,
             settlement_id = ?,
             mirror_node_url = ?
         WHERE tenant_id = ?
           AND nonce = ?
           AND mandate_digest = ?
           AND schedule_id = ?`,
      )
      .run(
        completion.outcome,
        completion.recipientAccountId,
        completion.amountTinybars,
        completion.settlementId,
        completion.mirrorNodeUrl,
        reservation.tenantId,
        reservation.nonce,
        reservation.mandateDigest,
        reservationTarget(reservation),
      );

    if (result.changes !== 1) {
      throw new Error("mandate review tuple is not reserved");
    }
  });
}

export function getCompletedMandateReview(
  databasePath: string,
  reservation: MandateReviewReservation,
): CompletedMandateReview | null {
  const state = getMandateReviewState(databasePath, reservation);
  return state.status === "completed" ? state.completion : null;
}

export function getMandateReviewState(
  databasePath: string,
  reservation: MandateReviewReservation,
): MandateReviewState {
  validateReservation(reservation);

  return withReplayDatabase(databasePath, "read", (database) => {
    const existing = database
      .prepare(
        `SELECT outcome,
                recipient_account_id,
                amount_tinybars,
                settlement_id,
                mirror_node_url
         FROM mandate_reviews
         WHERE tenant_id = ?
           AND nonce = ?
           AND mandate_digest = ?
           AND schedule_id = ?`,
      )
      .get(
        reservation.tenantId,
        reservation.nonce,
        reservation.mandateDigest,
        reservationTarget(reservation),
      );

    if (existing === undefined) {
      return { status: "absent" };
    }

    const completion = completedReviewFromRow(existing);
    if (completion === null) {
      return { status: "pending" };
    }

    return { status: "completed", completion };
  });
}
