import assert from "node:assert/strict";
import test from "node:test";

import { generateHcs14Aid } from "../src/hcs14.ts";

const officialHcs10Vector = {
  registry: "hol",
  name: "Support Agent",
  version: "1.0.0",
  protocol: "hcs-10",
  nativeId: "hedera:testnet:0.0.123456",
  skills: [0, 17],
};

test("generateHcs14Aid matches the HCS-14 HCS-10 known answer", () => {
  assert.equal(
    generateHcs14Aid(officialHcs10Vector),
    "uaid:aid:8yjEeyipVRyYFKKjnt8QXXTTQbprY1fVCqZA3UvN39v4JQtjHACwMmaq9HXCcZRu6V;uid=0;registry=hol;proto=hcs-10;nativeId=hedera:testnet:0.0.123456",
  );
});

test("generateHcs14Aid normalizes strings and sorts skills without mutating input", () => {
  const skills = [17, 0];

  assert.equal(
    generateHcs14Aid({
      ...officialHcs10Vector,
      registry: " HOL ",
      name: " Support Agent ",
      version: " 1.0.0 ",
      protocol: " HCS-10 ",
      nativeId: " hedera:testnet:0.0.123456 ",
      skills,
    }),
    generateHcs14Aid(officialHcs10Vector),
  );
  assert.deepEqual(skills, [17, 0]);
});

test("generateHcs14Aid emits routing parameters in the required order", () => {
  assert.match(
    generateHcs14Aid({
      ...officialHcs10Vector,
      uid: "operator-7",
      domain: "guard.example",
    }),
    /;uid=operator-7;registry=hol;proto=hcs-10;nativeId=hedera:testnet:0\.0\.123456;domain=guard\.example$/,
  );
});

test("generateHcs14Aid permits an empty skills array and OASF skill identifiers", () => {
  assert.doesNotThrow(() =>
    generateHcs14Aid({ ...officialHcs10Vector, skills: [] }),
  );
  assert.doesNotThrow(() =>
    generateHcs14Aid({ ...officialHcs10Vector, skills: [100, 1403] }),
  );
});

test("generateHcs14Aid preserves duplicate skill identifiers while sorting", () => {
  assert.equal(
    generateHcs14Aid({
      ...officialHcs10Vector,
      skills: [17, 0, 17],
    }),
    generateHcs14Aid({
      ...officialHcs10Vector,
      skills: [0, 17, 17],
    }),
  );
  assert.notEqual(
    generateHcs14Aid({
      ...officialHcs10Vector,
      skills: [0, 17, 17],
    }),
    generateHcs14Aid(officialHcs10Vector),
  );
});

test("generateHcs14Aid rejects every empty required string", () => {
  for (const field of [
    "registry",
    "name",
    "version",
    "protocol",
    "nativeId",
  ] as const) {
    assert.throws(
      () => generateHcs14Aid({ ...officialHcs10Vector, [field]: "   " }),
      new RegExp(`${field} must not be empty`),
    );
  }
});

test("generateHcs14Aid rejects reserved and invalid skill identifiers", () => {
  for (const skill of [-1, 1.5, 40, 99, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => generateHcs14Aid({ ...officialHcs10Vector, skills: [skill] }),
      /skill identifier/,
    );
  }
});

test("generateHcs14Aid requires a Hedera CAIP-10 native ID for hcs-10", () => {
  for (const nativeId of [
    "0.0.123456",
    "eip155:1:0x1234",
    "hedera:testnet:not-an-account",
  ]) {
    assert.throws(
      () => generateHcs14Aid({ ...officialHcs10Vector, nativeId }),
      /nativeId must be a Hedera CAIP-10 account identifier for hcs-10/,
    );
  }

  assert.doesNotThrow(() =>
    generateHcs14Aid({
      ...officialHcs10Vector,
      nativeId: "hedera:mainnet:0.0.123456",
    }),
  );
});

test("generateHcs14Aid refuses whitespace in routing parameters", () => {
  for (const identity of [
    { ...officialHcs10Vector, registry: "counter sign" },
    { ...officialHcs10Vector, protocol: "hcs 10" },
    {
      ...officialHcs10Vector,
      protocol: "custom",
      nativeId: "native identifier",
    },
    { ...officialHcs10Vector, uid: "operator 7" },
    { ...officialHcs10Vector, domain: "guard example" },
  ]) {
    assert.throws(
      () => generateHcs14Aid(identity),
      /HCS-14 identifier must not contain whitespace/,
    );
  }
});

test("generateHcs14Aid refuses an identifier larger than one HCS message chunk", () => {
  assert.throws(
    () =>
      generateHcs14Aid({
        ...officialHcs10Vector,
        domain: "a".repeat(1_024),
      }),
    /HCS-14 identifier must fit in one HCS message chunk/,
  );
});
