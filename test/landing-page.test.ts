import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const script = source.match(/<script type="module">([\s\S]*?)<\/script>/)![1];
const mirror = "https://testnet.mirrornode.hedera.com/api/v1/schedules/0.0.10502603";
const schedule = {
  schedule_id: "0.0.10502603", executed_timestamp: null, deleted: false,
  signatures: [{ public_key_prefix: "o1f/BmxLtnrkkqZOK3aE1zvkqRFAs61C9gY6k4rnPqU=" }],
};
const guard = {
  guardPublicKey: "302a300506032b657003210041510f63ae4cd1e11e9a1147166bbfb749ea0fe784c6aea3a95fb8689ab368e5",
  guardIdentifier: "uaid:aid:9Us31TEAEQZrKAuN9XKiaVCEHE59my6uoPfUH8aAXFVQUVz4AAxxKf4bjv8mreGAHz;uid=0;registry=countersign;proto=hcs-10;nativeId=hedera:testnet:0.0.10502369",
};
const runs = {
  origin: "operator", disclosure: "Operator-run reliability exercises, not users.",
  runs: [
    { origin: "operator", runId: "approved-run", recipient: "vendor", amountTinybars: "10000000", outcome: "approved", scheduleId: "0.0.10512157" },
    { origin: "operator", runId: "refused-run", recipient: "stranger", amountTinybars: "1000000", outcome: "refused", scheduleId: "0.0.10512142" },
  ],
};

class Element {
  children: Element[] = [];
  href = "";
  rel = "";
  private text = "";
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(" "); }
  set textContent(value: string) { this.text = value; this.children = []; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.text = ""; this.children = children; }
}

async function page(handler: (url: string, options: RequestInit) => Promise<Response>) {
  const elements = new Map<string, Element>();
  for (const match of source.matchAll(/id="([^"]+)"/g)) {
    const id = match[1];
    const content = source.match(new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)<\\/\\1>`))![2];
    const element = new Element();
    element.textContent = content.replace(/<[^>]+>/g, "").replaceAll("&hellip;", "…").replaceAll("&mdash;", "—");
    elements.set(`#${id}`, element);
  }
  const initial = new Map([...elements].map(([id, element]) => [id, element.textContent]));
  const controllers: AbortController[] = [];
  const requests: string[] = [];
  runInNewContext(script, {
    document: { querySelector: (id: string) => elements.get(id), createElement: () => new Element() },
    fetch: (url: string, options: RequestInit) => { requests.push(url); return handler(url, options); },
    AbortSignal: { timeout: (milliseconds: number) => {
      assert.equal(milliseconds, 8000);
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    } },
    atob, btoa, Date,
  });
  await setImmediate();
  return { element: (id: string) => elements.get(id)!, initial, controllers, requests };
}

const successful = async (url: string) => Response.json(url === mirror ? schedule : url === "/guard" ? guard : runs);
const values = ["#ledger-executed", "#ledger-deleted", "#ledger-signatures", "#ledger-guard", "#feed-list", "#feed-summary", "#guard-key", "#guard-identifier"];

test("landing keeps the actual HTML fallback visible before any response and after timeout", async () => {
  const view = await page((_url, options) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener("abort", () => reject(new Error("timed out")));
  }));
  for (const id of values) assert.equal(view.element(id).textContent, view.initial.get(id));
  assert.equal(view.element("#ledger-executed").textContent, "null");
  assert.equal(view.element("#ledger-guard").textContent, "absent");
  for (const controller of view.controllers) controller.abort();
  await setImmediate();
  for (const id of values) assert.equal(view.element(id).textContent, view.initial.get(id));
  for (const id of ["#ledger-status", "#feed-status", "#guard-status"]) assert.match(view.element(id).textContent, /Live read did not complete.*Recorded values retained/);
});

test("landing retains every fallback after network and HTTP failures", async () => {
  for (const handler of [async () => { throw new Error("offline"); }, async () => new Response("unavailable", { status: 503 })]) {
    const view = await page(handler);
    for (const id of values) assert.equal(view.element(id).textContent, view.initial.get(id));
    assert.match(view.element("#ledger-status").textContent, /Reload to retry/);
  }
});

test("landing decodes mirror base64 and explicitly reports the absent guard prefix", async () => {
  const view = await page(successful);
  assert.equal(view.element("#ledger-guard").textContent, "absent from signatures[]");
  assert.equal(view.element("#ledger-signatures").textContent, "1 entry — agent prefix a357ff06… present");
  assert.equal(view.element("#guard-key").textContent, "41510f63…");
  assert.equal(view.element("#guard-identifier").textContent, guard.guardIdentifier);
  assert.match(view.element("#ledger-status").textContent, /Read live at \d{4}-.*schedule fields only/);
  assert.deepEqual(view.requests, [mirror, "/sandbox/runs", "/guard"]);
});

test("landing renders changed mirror evidence instead of assuming the guard remains absent", async () => {
  const view = await page(async url => url === mirror ? Response.json({
    ...schedule, executed_timestamp: "1789222049.366021529", deleted: true,
    signatures: [{ public_key_prefix: Buffer.from(guard.guardPublicKey.slice(24), "hex").toString("base64") }],
  }) : successful(url));
  assert.equal(view.element("#ledger-guard").textContent, "present");
  assert.match(view.element("#ledger-signatures").textContent, /agent prefix a357ff06… absent/);
  assert.equal(view.element("#ledger-executed").textContent, "1789222049.366021529");
  assert.equal(view.element("#ledger-deleted").textContent, "true");
});

test("landing rejects malformed schedules atomically, without claiming an absence", async () => {
  for (const patch of [
    { schedule_id: "0.0.1" }, { executed_timestamp: undefined }, { deleted: "false" },
    { executed_timestamp: [] }, { signatures: null },
    { signatures: [{ public_key_prefix: "bad base64!" }] },
    { signatures: [{ public_key_prefix: btoa("a") }] },
    { signatures: [schedule.signatures[0], null] },
  ]) {
    const view = await page(async url => url === mirror ? Response.json({ ...schedule, ...patch }) : successful(url));
    for (const id of values.filter(id => id.startsWith("#ledger"))) assert.equal(view.element(id).textContent, view.initial.get(id));
    assert.match(view.element("#ledger-status").textContent, /did not complete/);
    assert.match(view.element("#guard-status").textContent, /Read live/);
  }
});

test("landing renders separate outcome counts and only numeric testnet schedule links", async () => {
  const view = await page(successful);
  assert.match(view.element("#feed-summary").textContent, /2 listed runs: 1 approved \/ 1 refused \/ 0 other.*Separate from evidence.json/);
  assert.equal(view.element("#feed-list").children[1].children[0].href, "https://testnet.mirrornode.hedera.com/api/v1/schedules/0.0.10512142");
});

test("landing rejects malformed runs before replacing the fallback list or counts", async () => {
  for (const data of [
    { ...runs, origin: "external" }, { ...runs, runs: null },
    ...[{ scheduleId: "javascript:alert(1)" }, { outcome: "accepted" }, { amountTinybars: [] }, { origin: "external" }, { scheduleId: undefined }].map(patch => ({ ...runs, runs: [runs.runs[0], { ...runs.runs[1], ...patch }] })),
  ]) {
    const view = await page(async url => url === "/sandbox/runs" ? Response.json(data) : successful(url));
    for (const id of ["#feed-list", "#feed-summary"]) assert.equal(view.element(id).textContent, view.initial.get(id));
    assert.match(view.element("#feed-status").textContent, /did not complete/);
  }
});

test("landing empty feed names the outcome and the control that populates it", async () => {
  const view = await page(async url => url === "/sandbox/runs" ? Response.json({ ...runs, runs: [] }) : successful(url));
  assert.match(view.element("#feed-list").textContent, /No sandbox runs recorded yet.*Authorization outcomes.*Try this transfer/);
  assert.match(view.element("#feed-summary").textContent, /0 listed runs: 0 approved \/ 0 refused \/ 0 other/);
});

test("landing retains running and failed runs without inventing a schedule link", async () => {
  const view = await page(async url => url === "/sandbox/runs" ? Response.json({ ...runs, runs: [
    { ...runs.runs[0], outcome: "running", scheduleId: null },
    { ...runs.runs[1], outcome: "failed", scheduleId: null },
  ] }) : successful(url));
  assert.match(view.element("#feed-summary").textContent, /2 listed runs: 0 approved \/ 0 refused \/ 2 other/);
  assert.match(view.element("#feed-list").textContent, /Running.*schedule not yet recorded.*Failed/);
  assert.equal(view.element("#feed-list").children[0].children[0].href, "");
});

test("landing retains the complete identity if either identity field is malformed", async () => {
  for (const patch of [{ guardPublicKey: "41510f63" }, { guardPublicKey: [] }, { guardIdentifier: "<script>" }, { guardIdentifier: undefined }]) {
    const view = await page(async url => url === "/guard" ? Response.json({ ...guard, ...patch }) : successful(url));
    for (const id of ["#guard-key", "#guard-identifier"]) assert.equal(view.element(id).textContent, view.initial.get(id));
    assert.match(view.element("#guard-status").textContent, /did not complete/);
  }
});
