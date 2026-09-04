import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test, { afterEach } from "node:test";
import { Worker } from "node:worker_threads";

import {
  completeMandateReview,
  getCompletedMandateReview,
  getMandateReviewState,
  initializeReplayStore,
  ReplayStoreContentionError,
  reserveMandateReview,
  type CompletedMandateReview,
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

function completedReview(
  overrides: Partial<CompletedMandateReview> = {},
): CompletedMandateReview {
  return {
    outcome: "approved",
    recipientAccountId: "0.0.1002",
    amountTinybars: "25000000",
    settlementId: "0.0.8001@1788509000.000000001",
    mirrorNodeUrl:
      "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.9001/messages/4",
    ...overrides,
  };
}

async function nextWorkerMessage(worker: Worker): Promise<unknown> {
  const [message] = await once(worker, "message");
  return message;
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

test("initializeReplayStore rejects every supported in-memory database path", () => {
  for (const path of [
    ":memory:",
    "file::memory:",
    "file::memory:?cache=shared",
    "file:countersign?mode=memory&cache=shared",
  ]) {
    assert.throws(
      () => initializeReplayStore(path),
      /replay database must be file-backed/,
      path,
    );
  }
});

test("reserveMandateReview rejects every supported in-memory database path", () => {
  for (const path of [
    ":memory:",
    "file::memory:",
    "file::memory:?cache=shared",
    "file:countersign?mode=memory&cache=shared",
  ]) {
    assert.throws(
      () => reserveMandateReview(path, reservation()),
      /replay database must be file-backed/,
      path,
    );
  }
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
  completeMandateReview(path, value, completedReview());

  assert.deepEqual(reserveMandateReview(path, value), {
    status: "retry",
    outcome: "approved",
  });
});

test("getCompletedMandateReview returns the exact stored approval response", () => {
  const path = databasePath();
  const value = reservation();
  const completion = completedReview();
  reserveMandateReview(path, value);
  completeMandateReview(path, value, completion);

  assert.deepEqual(getCompletedMandateReview(path, value), completion);
  assert.equal(
    getCompletedMandateReview(path, {
      ...value,
      mandateDigest: "b".repeat(64),
    }),
    null,
  );
});

test("getMandateReviewState distinguishes absent, pending, and completed exact tuples", () => {
  const path = databasePath();
  const value = reservation();
  const completion = completedReview();
  initializeReplayStore(path);

  assert.deepEqual(getMandateReviewState(path, value), { status: "absent" });

  reserveMandateReview(path, value);
  assert.deepEqual(getMandateReviewState(path, value), { status: "pending" });
  assert.deepEqual(
    getMandateReviewState(path, {
      ...value,
      scheduleId: "0.0.7002",
    }),
    { status: "absent" },
  );

  completeMandateReview(path, value, completion);
  assert.deepEqual(getMandateReviewState(path, value), {
    status: "completed",
    completion,
  });
});

test("replay store migrates an existing database before persisting an approval response", () => {
  const path = databasePath();
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE mandate_reviews (
      tenant_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      mandate_digest TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      outcome TEXT,
      PRIMARY KEY (tenant_id, nonce)
    ) STRICT
  `);
  database.close();

  initializeReplayStore(path);

  const value = reservation();
  const completion = completedReview();
  reserveMandateReview(path, value);
  completeMandateReview(path, value, completion);

  assert.deepEqual(getCompletedMandateReview(path, value), completion);
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

test("INVARIANT: nonces must be scoped per tenant", () => {
  const path = databasePath();
  const firstTenant = reservation();
  const secondTenant = reservation({
    tenantId: "treasury-2",
    mandateDigest: "b".repeat(64),
    scheduleId: "0.0.7002",
  });

  assert.deepEqual(reserveMandateReview(path, firstTenant), {
    status: "reserved",
  });
  assert.deepEqual(reserveMandateReview(path, secondTenant), {
    status: "reserved",
  });
  assert.deepEqual(
    reserveMandateReview(path, {
      ...firstTenant,
      mandateDigest: "c".repeat(64),
    }),
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
        completedReview(),
      ),
    /mandate review tuple is not reserved/,
  );
});

test("concurrent workers reserve one tuple exactly once", async () => {
  const path = databasePath();
  reserveMandateReview(
    path,
    reservation({ tenantId: "bootstrap", nonce: "1" }),
  );

  const source = String.raw`
    const { parentPort, workerData } = require("node:worker_threads");
    void import(workerData.moduleUrl).then(({ reserveMandateReview }) => {
      parentPort.postMessage("ready");
      parentPort.once("message", () => {
        try {
          parentPort.postMessage({ result: reserveMandateReview(workerData.databasePath, workerData.reservation) });
        } catch (error) {
          parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
        } finally {
          parentPort.close();
        }
      });
    });
  `;
  const workerData = {
    moduleUrl: pathToFileURL(resolve("src/replay-store.ts")).href,
    databasePath: path,
    reservation: reservation(),
  };
  const workers = [
    new Worker(source, { eval: true, workerData }),
    new Worker(source, { eval: true, workerData }),
  ];

  await Promise.all(workers.map(nextWorkerMessage));
  for (const worker of workers) {
    worker.postMessage("start");
  }
  const results = await Promise.all(workers.map(nextWorkerMessage));
  await Promise.all(workers.map((worker) => worker.terminate()));

  assert.deepEqual(
    new Set(results.map((result) => JSON.stringify(result))),
    new Set([
      JSON.stringify({ result: { status: "reserved" } }),
      JSON.stringify({ result: { status: "retry", outcome: null } }),
    ]),
  );
});

test("write contention waits for a bounded interval and returns a retryable error", async () => {
  const path = databasePath();
  reserveMandateReview(
    path,
    reservation({ tenantId: "bootstrap", nonce: "1" }),
  );

  const holder = new Worker(
    String.raw`
      const { DatabaseSync } = require("node:sqlite");
      const { parentPort, workerData } = require("node:worker_threads");
      const database = new DatabaseSync(workerData.databasePath);
      database.exec("BEGIN IMMEDIATE");
      parentPort.postMessage("locked");
      parentPort.once("message", () => {
        database.exec("ROLLBACK");
        database.close();
        parentPort.postMessage("released");
        parentPort.close();
      });
    `,
    { eval: true, workerData: { databasePath: path } },
  );
  assert.equal(await nextWorkerMessage(holder), "locked");

  const startedAt = Date.now();
  let contention: unknown;
  try {
    reserveMandateReview(path, reservation());
  } catch (error) {
    contention = error;
  } finally {
    holder.postMessage("release");
  }
  const elapsedMilliseconds = Date.now() - startedAt;
  assert.equal(await nextWorkerMessage(holder), "released");
  await holder.terminate();

  assert.ok(contention instanceof ReplayStoreContentionError);
  assert.equal(contention.retryable, true);
  assert.ok(elapsedMilliseconds >= 75, `${elapsedMilliseconds}ms was too short`);
  assert.ok(elapsedMilliseconds < 2_000, `${elapsedMilliseconds}ms was too long`);
});
