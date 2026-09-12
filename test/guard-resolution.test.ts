import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { resolveGuard, resolveHostedReviewEndpoint } from "../scripts/hosted-review.ts";

const expectedUaid = "uaid:aid:expected;nativeId=hedera:testnet:0.0.3001";
const origin = "https://guard.example";
const endpoint = `${origin}/policy-review`;
const card = {
  uaid: expectedUaid,
  url: endpoint,
  service: [{ id: "review", type: "HTTP", method: "POST", serviceEndpoint: endpoint }],
};

function serveCard(t: TestContext, document: unknown, status = 200) {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL, options: RequestInit) => {
    requests.push(String(url));
    assert.equal(options.redirect, "error");
    return new Response(JSON.stringify(document), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return requests;
}

test("INVARIANT: the resolver must refuse a card whose UAID does not equal the expected UAID", async (t) => {
  const requests = serveCard(t, { ...card, uaid: "uaid:aid:different;nativeId=hedera:testnet:0.0.3002" });
  await assert.rejects(resolveGuard(expectedUaid, origin), /agent card UAID does not match the expected UAID/);
  assert.deepEqual(requests, [`${origin}/.well-known/agent.json`]);
});

test("resolver returns the card endpoint and describes exactly what it verified", async (t) => {
  const requests = serveCard(t, card);
  const result = await resolveGuard(expectedUaid, origin);
  assert.equal(result.id, expectedUaid);
  assert.equal(result.resolved, true);
  assert.deepEqual(result.document, card);
  assert.deepEqual(result.service, card.service);
  assert.deepEqual(result.verification, {
    uaidMatched: true,
    endpointSameOrigin: true,
    assurance: "Expected UAID matched at the configured origin; no cryptographic ownership proof.",
  });
  assert.deepEqual(requests, [`${origin}/.well-known/agent.json`]);
});

test("hosted caller defaults to UAID resolution even when legacy review URL configuration exists", async (t) => {
  const requests = serveCard(t, card);
  const result = await resolveHostedReviewEndpoint({
    COUNTERSIGN_GUARD_UAID: expectedUaid,
    COUNTERSIGN_GUARD_ORIGIN: origin,
    COUNTERSIGN_GUARD_URL: "https://legacy.example/review",
  });
  assert.equal(result, endpoint);
  assert.deepEqual(requests, [`${origin}/.well-known/agent.json`]);
});

test("resolver refuses missing identities, malformed cards and unsafe or ambiguous review endpoints", async (t) => {
  for (const [name, document] of [
    ["missing UAID", { ...card, uaid: undefined }],
    ["non-object", null],
    ["missing services", { ...card, service: undefined }],
    ["missing review", { ...card, service: [] }],
    ["duplicate reviews", { ...card, service: [...card.service, ...card.service] }],
    ["wrong method", { ...card, service: [{ ...card.service[0], method: "GET" }] }],
    ["cross-origin", { ...card, service: [{ ...card.service[0], serviceEndpoint: "https://other.example/review" }] }],
    ["credentials", { ...card, service: [{ ...card.service[0], serviceEndpoint: "https://user:password@guard.example/review" }] }],
    ["inconsistent URL", { ...card, url: `${origin}/different` }],
  ] as const) {
    await t.test(name, async (t) => {
      serveCard(t, document);
      await assert.rejects(resolveGuard(expectedUaid, origin));
    });
  }
});

test("resolver refuses failed card requests and redirects without falling back to a review URL", async (t) => {
  for (const status of [404, 503, 302]) {
    await t.test(String(status), async (t) => {
      serveCard(t, card, status);
      await assert.rejects(resolveGuard(expectedUaid, origin), new RegExp(`HTTP ${status}`));
    });
  }
});

test("local review URL override is explicit and restricted to loopback", async (t) => {
  const requests = serveCard(t, card);
  assert.equal(await resolveHostedReviewEndpoint({ COUNTERSIGN_REVIEW_URL_OVERRIDE: "http://127.0.0.1:4020/review" }), "http://127.0.0.1:4020/review");
  await assert.rejects(resolveHostedReviewEndpoint({ COUNTERSIGN_REVIEW_URL_OVERRIDE: endpoint }), /loopback/);
  await assert.rejects(resolveGuard(expectedUaid, "http://guard.example"), /HTTPS/);
  assert.deepEqual(requests, []);
});
