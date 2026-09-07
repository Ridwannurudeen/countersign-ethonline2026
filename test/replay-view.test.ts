import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

import {
  executePage,
  manifestWithRecords,
  mirrorSchedule,
  reviewRecord,
} from "./page-harness.ts";

const validResponse = async () => Response.json(mirrorSchedule);

test("INVARIANT: pending mirror verification must assert neither refusal nor stopped steps", async () => {
  const { promise, resolve } = Promise.withResolvers<Response>();
  const page = await executePage("replay", manifestWithRecords(), () => promise);
  const steps = page.element("#chain").children;
  assert.equal(steps.length, 6);
  for (const index of [1, 4, 5]) {
    assert.equal(
      steps[index]!.descendants("step-state")[0]!.textContent,
      "Awaiting live verification",
    );
    assert.equal(steps[index]!.dataset.stopped, "false");
  }
  resolve(await validResponse());
  await setImmediate();
  for (const index of [4, 5]) {
    assert.match(steps[index]!.textContent, /Never happened/);
    assert.equal(steps[index]!.dataset.stopped, "true");
  }
});

test("INVARIANT: validated absence alone may render ScheduleSign and execution as never happened", async () => {
  const page = await executePage("replay", manifestWithRecords(), validResponse);
  const steps = page.element("#chain").children;
  assert.match(steps[1]!.textContent, /Verified live/);
  assert.match(
    steps[4]!.textContent,
    /ScheduleSign.*Never happened.*guard prefix absent/,
  );
  assert.match(
    steps[5]!.textContent,
    /Execution.*Never happened.*executed_timestamp is null/,
  );
});

test("INVARIANT: mirror facts remain distinct from manifest facts", async () => {
  const page = await executePage("replay", manifestWithRecords(), validResponse);
  assert.deepEqual(
    page.element("#chain").descendants("source").map((item) => item.dataset.source),
    ["manifest", "live", "manifest", "manifest", "live", "live"],
  );
  assert.deepEqual(page.requests, ["./evidence.json", reviewRecord.mirrorNodeUrl]);
});

test("INVARIANT: guard signature matching must be exact", async () => {
  for (const prefix of [
    reviewRecord.guardPublicKeyPrefix.toUpperCase(),
    `${reviewRecord.guardPublicKeyPrefix}aa`,
  ]) {
    const page = await executePage("replay", manifestWithRecords(), async () =>
      Response.json({
        ...mirrorSchedule,
        signatures: [{ public_key_prefix: prefix }],
      }),
    );
    assert.match(
      page.element("#chain").children[4]!.textContent,
      prefix.length === reviewRecord.guardPublicKeyPrefix.length
        ? /Verification mismatch.*present/
        : /Never happened.*absent/,
    );
  }
});

test("INVARIANT: operator activity must remain labelled operator-run", async () => {
  const page = await executePage("replay", manifestWithRecords(), validResponse);
  assert.equal(page.element("#origin").textContent, "Operator-run");
});

test("INVARIANT: an empty manifest must show no reviews recorded", async () => {
  const page = await executePage("replay", manifestWithRecords([]), validResponse);
  assert.equal(page.element("#empty-state").hidden, false);
  assert.equal(page.element("#empty-state").textContent, "No reviews recorded yet.");
  assert.deepEqual(page.requests, ["./evidence.json"]);
});

for (const [name, patch] of [
  ["non-mirror URL", { mirrorNodeUrl: "https://example.com/schedule" }],
  ["relative URL", { mirrorNodeUrl: "./evidence.json" }],
  [
    "another schedule URL",
    { mirrorNodeUrl: reviewRecord.mirrorNodeUrl.replace("7001", "7002") },
  ],
  ["URL query", { mirrorNodeUrl: `${reviewRecord.mirrorNodeUrl}?limit=1` }],
  ["URL fragment", { mirrorNodeUrl: `${reviewRecord.mirrorNodeUrl}#schedule` }],
  [
    "URL credentials",
    { mirrorNodeUrl: reviewRecord.mirrorNodeUrl.replace("https://", "https://user@") },
  ],
  [
    "noncanonical schedule ID",
    {
      scheduleId: "0.0.07001",
      mirrorNodeUrl: reviewRecord.mirrorNodeUrl.replace("7001", "07001"),
    },
  ],
  ["missing guard identity", { guardPublicKeyPrefix: undefined }],
  ["malformed guard identity", { guardPublicKeyPrefix: "not-hex" }],
  ["odd-length guard identity", { guardPublicKeyPrefix: "abc" }],
  ["empty guard identity", { guardPublicKeyPrefix: "" }],
] as const) {
  test(`INVARIANT: ${name} must never establish replay provenance`, async () => {
    const page = await executePage(
      "replay",
      manifestWithRecords([{ ...reviewRecord, ...patch }] as typeof reviewRecord[]),
      validResponse,
    );
    assert.match(page.element("#load-state").textContent, /Could not verify/);
    assert.deepEqual(page.requests, ["./evidence.json"]);
    assert.equal(page.element("#chain").children.length, 0);
  });
}

for (const [name, patch] of [
  ["malformed signature", { signatures: [{ public_key_prefix: "not-hex" }] }],
  ["odd-length signature", { signatures: [{ public_key_prefix: "abc" }] }],
  ["empty signature", { signatures: [{ public_key_prefix: "" }] }],
  ["empty timestamp", { executed_timestamp: "" }],
  ["malformed timestamp", { executed_timestamp: "123.4" }],
  ["noncanonical timestamp", { executed_timestamp: "0123.000000001" }],
  ["mismatched memo", { memo: "c".repeat(64) }],
  ["missing memo", { memo: undefined }],
] as const) {
  test(`INVARIANT: ${name} must not produce verified replay facts`, async () => {
    const page = await executePage(
      "replay",
      manifestWithRecords(),
      async () => Response.json({ ...mirrorSchedule, ...patch }),
    );
    for (const index of [1, 4, 5]) {
      assert.match(
        page.element("#chain").children[index]!.textContent,
        /Could not verify/,
      );
      assert.doesNotMatch(
        page.element("#chain").children[index]!.textContent,
        /Verified live|Never happened/,
      );
    }
  });
}

for (const status of [404, 429, 500, 503]) {
  test(`INVARIANT: HTTP ${status} must never establish replay absence`, async () => {
    const page = await executePage(
      "replay",
      manifestWithRecords(),
      async () => new Response(null, { status }),
    );
    for (const index of [1, 4, 5]) {
      assert.match(
        page.element("#chain").children[index]!.textContent,
        /Could not verify/,
      );
      assert.doesNotMatch(
        page.element("#chain").children[index]!.textContent,
        /Never happened/,
      );
    }
  });
}

test("INVARIANT: a rejected request must not establish replay absence", async () => {
  const page = await executePage("replay", manifestWithRecords(), async () => {
    throw new Error("request failed");
  });
  assert.match(page.element("#chain").children[4]!.textContent, /Could not verify/);
  assert.doesNotMatch(page.element("#chain").textContent, /Never happened/);
});

test("INVARIANT: contradictory mirror facts must override the recorded refusal", async () => {
  const page = await executePage("replay", manifestWithRecords(), async () => Response.json({
    ...mirrorSchedule,
    executed_timestamp: "1788509000.000000001",
    signatures: [{ public_key_prefix: reviewRecord.guardPublicKeyPrefix }],
  }));
  for (const index of [4, 5]) {
    assert.match(
      page.element("#chain").children[index]!.textContent,
      /Verification mismatch/,
    );
    assert.equal(page.element("#chain").children[index]!.dataset.stopped, "false");
  }
  assert.doesNotMatch(page.element("#chain").textContent, /Never happened/);
});

test("INVARIANT: each replay record must use its own guard identity across selections", async () => {
  const second = {
    ...reviewRecord,
    scheduleId: "0.0.7002",
    mirrorNodeUrl: reviewRecord.mirrorNodeUrl.replace("7001", "7002"),
    guardPublicKeyPrefix: "cccccccccccccccc",
  };
  const records = [reviewRecord, second];
  const page = await executePage("replay", manifestWithRecords(records), async (url) => {
    const record = records.find((candidate) => candidate.mirrorNodeUrl === url)!;
    return Response.json({
      ...mirrorSchedule,
      signatures: [{ public_key_prefix: record.guardPublicKeyPrefix }],
    });
  });
  for (const record of [reviewRecord, second, reviewRecord]) {
    page.element("#review-select").value = record.scheduleId;
    page.element("#review-select").dispatch("change");
    await setImmediate();
    assert.match(
      page.element("#chain").children[4]!.textContent,
      /Verification mismatch.*guard prefix is present/,
    );
    assert.doesNotMatch(
      page.element("#chain").children[4]!.textContent,
      /Never happened/,
    );
  }
});
