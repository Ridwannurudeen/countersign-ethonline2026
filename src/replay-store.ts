import { DatabaseSync } from "node:sqlite";

export interface MandateReviewReservation {
  tenantId: string;
  nonce: string;
  mandateDigest: string;
  scheduleId: string;
}

export type MandateReviewReservationResult =
  | { status: "reserved" }
  | { status: "retry"; outcome: string | null }
  | { status: "refused"; reason: string };

const tenantIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const minimalUnsignedDecimalPattern = /^(0|[1-9][0-9]*)$/;
const digestPattern = /^[0-9a-f]{64}$/;
const scheduleIdPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function validateDatabasePath(databasePath: string): void {
  if (databasePath.length === 0) {
    throw new Error("database path must not be empty");
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
  if (!scheduleIdPattern.test(value.scheduleId)) {
    throw new Error("scheduleId must be a canonical numeric Hedera ScheduleID");
  }
}

function initializeDatabase(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS mandate_reviews (
      tenant_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      mandate_digest TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      outcome TEXT,
      PRIMARY KEY (tenant_id, nonce)
    ) STRICT
  `);
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

export function reserveMandateReview(
  databasePath: string,
  reservation: MandateReviewReservation,
): MandateReviewReservationResult {
  validateDatabasePath(databasePath);
  validateReservation(reservation);

  const database = new DatabaseSync(databasePath);
  try {
    initializeDatabase(database);
    database.exec("BEGIN IMMEDIATE");

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
        requireStoredString(existing, "schedule_id") === reservation.scheduleId;

      database.exec("COMMIT");
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
      database.exec("COMMIT");
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
        reservation.scheduleId,
      );
    database.exec("COMMIT");
    return { status: "reserved" };
  } catch (error) {
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }
    throw error;
  } finally {
    database.close();
  }
}

export function completeMandateReview(
  databasePath: string,
  reservation: MandateReviewReservation,
  outcome: string,
): void {
  validateDatabasePath(databasePath);
  validateReservation(reservation);
  if (outcome.length === 0) {
    throw new Error("review outcome must not be empty");
  }

  const database = new DatabaseSync(databasePath);
  try {
    initializeDatabase(database);
    database.exec("BEGIN IMMEDIATE");

    const result = database
      .prepare(
        `UPDATE mandate_reviews
         SET outcome = ?
         WHERE tenant_id = ?
           AND nonce = ?
           AND mandate_digest = ?
           AND schedule_id = ?`,
      )
      .run(
        outcome,
        reservation.tenantId,
        reservation.nonce,
        reservation.mandateDigest,
        reservation.scheduleId,
      );

    if (result.changes !== 1) {
      throw new Error("mandate review tuple is not reserved");
    }

    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }
    throw error;
  } finally {
    database.close();
  }
}
