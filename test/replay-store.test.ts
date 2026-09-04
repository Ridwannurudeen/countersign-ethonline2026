import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test, { afterEach } from "node:test";

import {
  completeMandateReview,
  reserveMandateReview,
  type MandateReviewReservation,
} from "../src/replay-store.ts";

const testRoot = resolve("var");
const temporaryDirectories: string[] = [];

function databasePath(): string {
  mkdirSync(testRoot, { recursive: true });
  const directory = mkdtempSync(join(testRoot, "replay-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "countersign.sqlite");
}

function reservation(overrides: Partial<MandateReviewReservation> = {}) {
  return {
    tenantId: "treasury-1",
    nonce: "7",
    mandateDigest: "a".repeat(64),
    scheduleId: "0.0.7001",
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (!directory.startsWith(`${testRoot}\\`) && !directory.startsWith(`${testRoot}/`)) {
      throw new Error(`refusing to remove path outside test var directory: ${directory}`);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reserveMandateReview reserves a new tenant nonce", () => {
  const result = reserveMandateReview(databasePath(), reservation());

  assert.deepEqual(result, { status: "reserved" });
});

test("reserveMandateReview resumes an identical pending tuple", () => {
  const path = databasePath();
  const value = reservation();
  reserveMandateReview(path, value);

  assert.deepEqual(reserveMandateReview(path, value), {
    status: "retry",
    outcome: null,
  });
});

test("reserveMandateReview returns the stored outcome for an identical tuple", () => {
  const path = databasePath();
  const value = reservation();
  reserveMandateReview(path, value);
  completeMandateReview(path, value, "executionConfirmed");

  assert.deepEqual(reserveMandateReview(path, value), {
    status: "retry",
    outcome: "executionConfirmed",
  });
});

test("reserveMandateReview refuses the same nonce with a different digest", () => {
  const path = databasePath();
  reserveMandateReview(path, reservation());

  assert.deepEqual(
    reserveMandateReview(path, reservation({ mandateDigest: "b".repeat(64) })),
    {
      status: "refused",
      reason: "nonce is already bound to a different mandate digest or ScheduleID",
    },
  );
});

test("reserveMandateReview refuses the same nonce with a different ScheduleID", () => {
  const path = databasePath();
  reserveMandateReview(path, reservation());

  assert.deepEqual(
    reserveMandateReview(path, reservation({ scheduleId: "0.0.7002" })),
    {
      status: "refused",
      reason: "nonce is already bound to a different mandate digest or ScheduleID",
    },
  );
});

test("reserveMandateReview refuses a nonce below the tenant high-water mark", () => {
  const path = databasePath();
  reserveMandateReview(path, reservation({ nonce: "8" }));

  assert.deepEqual(reserveMandateReview(path, reservation({ nonce: "7" })), {
    status: "refused",
    reason: "nonce must be greater than the tenant high-water mark",
  });
});

test("reserveMandateReview accepts a nonce above the tenant high-water mark", () => {
  const path = databasePath();
  reserveMandateReview(path, reservation({ nonce: "7" }));

  assert.deepEqual(reserveMandateReview(path, reservation({ nonce: "8" })), {
    status: "reserved",
  });
});

test("completeMandateReview refuses a tuple that was not reserved", () => {
  assert.throws(
    () =>
      completeMandateReview(
        databasePath(),
        reservation(),
        "guardSignatureSubmitted",
      ),
    /mandate review tuple is not reserved/,
  );
});
