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
  hidden = false;
  disabled = false;
  value = "";
  dataset: Record<string, string> = {};
  focus() {}
  listeners = new Map<string, () => Promise<void>>();
  addEventListener(name: string, listener: () => Promise<void>) { this.listeners.set(name, listener); }
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
  const timers: (() => void)[] = [];
  let elapsed = 0;
  let heartbeat: (() => void) | undefined;
  class Clock extends Date { static now() { return elapsed; } }
  runInNewContext(script, {
    document: { querySelector: (id: string) => elements.get(id), createElement: () => new Element() },
    fetch: (url: string, options: RequestInit) => { requests.push(url); return handler(url, options); },
    AbortSignal: { timeout: (milliseconds: number) => {
      assert.ok([8000, 15000].includes(milliseconds));
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    } },
    atob, btoa, Date: Clock,
    setTimeout: (callback: () => void) => { timers.push(callback); },
    setInterval: (callback: () => void) => { heartbeat = callback; return 1; },
    clearInterval: () => { heartbeat = undefined; },
  });
  await setImmediate();
  return { element: (id: string) => elements.get(id)!, initial, controllers, requests,
    submit: async (recipient = "vendor") => {
      elements.get("#recipient")!.value = recipient;
      const listener = elements.get("#encounter-form")!.listeners.get("submit")!;
      return (listener as (event: { preventDefault(): void }) => Promise<void>)({ preventDefault() {} });
    },
    tick: async () => { timers.shift()?.(); await setImmediate(); },
    advance: (milliseconds: number) => { elapsed += milliseconds; heartbeat?.(); },
  };
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

const encounterRun = {
  origin: "operator", disclosure: runs.disclosure, runId: "test-run", recipient: "vendor",
  amountTinybars: "1000000", outcome: "approved",
  steps: ["envelope", "schedule", "payment", "verdict"].map(name => ({ name, state: "done" })),
  scheduleId: "0.0.10512157", settlementId: "0.0.7162784@1789254730.435839576",
  hcsVerdictUrl: "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10511981/messages/2",
};
const encounterFetch = async (url: string) => {
  if (url === "/sandbox/run") return Response.json({ origin: "operator", runId: "test-run" }, { status: 202 });
  if (url === "/sandbox/run/test-run") return Response.json(encounterRun);
  if (url.endsWith("/schedules/0.0.10512157")) return Response.json({ ...schedule, schedule_id: "0.0.10512157", executed_timestamp: "1789254816.147827986" });
  return successful(url);
};

test("encounter starts only on an explicit action and hides its explanation until then", async () => {
  const view = await page(successful);
  assert.deepEqual(view.requests, [mirror, "/sandbox/runs", "/guard"]);
  assert.equal(view.element("#explanation").hidden, true);
  assert.equal(view.element("#recorded-refusal").hidden, true);
  await view.submit("");
  assert.ok(!view.requests.includes("/sandbox/run"));
});

for (const status of [503, 429]) {
  test(`encounter shows the recorded refusal on ${status}, never a fabricated visitor verdict`, async () => {
    const view = await page(async url => url === "/sandbox/run" ? new Response("unavailable", { status }) : successful(url));
    await view.submit("stranger");
    assert.equal(view.element("#recorded-refusal").hidden, false);
    assert.equal(view.element("#explanation").hidden, false);
    assert.match(view.element("#encounter-notice").textContent, status === 429 ? /30 seconds/ : /unavailable|exhausted/);
    assert.match(view.element("#recorded-refusal").textContent, /Previous operator run/);
    assert.match(view.element("#recorded-refusal").textContent, /0\.0\.10512142/);
    assert.equal(view.element("#recipient").value, "stranger");
    assert.notEqual(view.element("#outcome-title").textContent, "Refused.");
  });
}

test("encounter network failure preserves selection, labels the fallback and does not resubmit", async () => {
  const view = await page(async url => { if (url === "/sandbox/run") throw new Error("offline"); return successful(url); });
  await view.submit("agent");
  assert.equal(view.element("#recorded-refusal").hidden, false);
  assert.match(view.element("#encounter-notice").textContent, /may still be running/);
  assert.equal(view.element("#recipient").value, "agent");
  assert.equal(view.requests.filter(url => url === "/sandbox/run").length, 1);
});

test("encounter approval shows the guard decision and independently observed ledger execution", async () => {
  const view = await page(async (url, options) => {
    if (url === "/sandbox/run") assert.deepEqual(JSON.parse(options.body as string), { recipient: "vendor", amountTinybars: "1000000" });
    return encounterFetch(url);
  });
  await view.submit();
  assert.equal(view.element("#outcome-title").textContent, "Approved.");
  assert.match(view.element("#outcome-detail").textContent, /policy allowed.*another recipient/i);
  assert.match(view.element("#execution-status").textContent, /Executed.*1789254816\.147827986/);
  assert.equal(view.element("#run-schedule").href, "https://testnet.mirrornode.hedera.com/api/v1/schedules/0.0.10512157");
  assert.equal(view.element("#recorded-refusal").hidden, true);
  assert.equal(view.element("#explanation").hidden, false);
});

test("encounter refusal retains the actual reason and never claims ledger execution", async () => {
  const view = await page(async url => {
    if (url === "/sandbox/run/test-run") return Response.json({ ...encounterRun, recipient: "stranger", outcome: "refused", reason: "recipient is outside the mandate allowlist" });
    if (url.endsWith("/schedules/0.0.10512157")) return Response.json({ ...schedule, schedule_id: "0.0.10512157" });
    return encounterFetch(url);
  });
  await view.submit("stranger");
  assert.equal(view.element("#outcome-title").textContent, "Refused.");
  assert.match(view.element("#outcome-detail").textContent, /outside the mandate allowlist/);
  assert.match(view.element("#execution-status").textContent, /executed_timestamp: null/);
});

test("encounter advances only on received stages and prevents duplicate submissions while waiting", async () => {
  let complete = false;
  const view = await page(async url => url === "/sandbox/run/test-run" && !complete ? Response.json({
    ...encounterRun, outcome: "running", settlementId: undefined, hcsVerdictUrl: undefined,
    steps: [{ name: "envelope", state: "done" }, { name: "schedule", state: "done" }, { name: "payment", state: "running" }, { name: "verdict", state: "pending" }],
  }) : encounterFetch(url));
  const pending = view.submit();
  await setImmediate();
  assert.equal(view.element("#stage-payment").textContent, "In progress");
  assert.equal(view.element("#stage-verdict").textContent, "Waiting");
  assert.equal(view.element("#explanation").hidden, true);
  await view.submit();
  assert.equal(view.requests.filter(url => url === "/sandbox/run").length, 1);
  complete = true;
  await view.tick();
  await pending;
  assert.equal(view.element("#stage-verdict").textContent, "Done");
});

test("encounter rejects malformed admission responses without polling an invented run", async () => {
  for (const body of [{ runId: "javascript:alert(1)", origin: "operator" }, { runId: "test-run", origin: "external" }, null]) {
    const view = await page(async url => url === "/sandbox/run" ? Response.json(body, { status: 202 }) : successful(url));
    await view.submit();
    assert.equal(view.element("#recorded-refusal").hidden, false);
    assert.ok(!view.requests.some(url => url.startsWith("/sandbox/run/")));
  }
});

test("encounter validates the entire response before replacing actual stage content", async () => {
  for (const patch of [
    { runId: "wrong-run" }, { recipient: "stranger" }, { amountTinybars: "9999999" },
    { outcome: "accepted" }, { origin: "external" }, { steps: [null] }, { steps: null },
    { scheduleId: "javascript:alert(1)" }, { hcsVerdictUrl: "https://example.com" },
    { settlementId: undefined }, { outcome: "refused", reason: undefined },
  ]) {
    const view = await page(async url => url === "/sandbox/run/test-run" ? Response.json({ ...encounterRun, ...patch }) : encounterFetch(url));
    await view.submit();
    assert.equal(view.element("#recorded-refusal").hidden, false);
    assert.notEqual(view.element("#outcome-title").textContent, "Approved.");
    assert.notEqual(view.element("#stage-payment").textContent, "Done");
  }
});

test("encounter polling failure preserves the last verified stages alongside the recorded refusal", async () => {
  let failed = false;
  const view = await page(async url => {
    if (url === "/sandbox/run/test-run") {
      if (failed) throw new Error("offline");
      return Response.json({ ...encounterRun, outcome: "running" });
    }
    return encounterFetch(url);
  });
  const pending = view.submit();
  await setImmediate();
  assert.equal(view.element("#stage-payment").textContent, "Done");
  failed = true;
  await view.tick();
  await pending;
  assert.equal(view.element("#stage-payment").textContent, "Done");
  assert.equal(view.element("#recorded-refusal").hidden, false);
  assert.match(view.element("#run-record").href, /sandbox\.html#run\/test-run$/);
});

test("encounter never turns an unverified mirror response into execution evidence", async () => {
  for (const response of [{ ...schedule, schedule_id: "wrong" }, { schedule_id: "0.0.10512157", executed_timestamp: [] }]) {
    const view = await page(async url => url.endsWith("/schedules/0.0.10512157") ? Response.json(response) : encounterFetch(url));
    await view.submit();
    assert.equal(view.element("#outcome-title").textContent, "Approved.");
    assert.match(view.element("#execution-status").textContent, /Not verified/);
  }
});

test("encounter static HTML remains an honest complete page without JavaScript", () => {
  assert.match(source, /<h1\b/);
  assert.match(source, /<fieldset[^>]*disabled/);
  assert.match(source, /<noscript>[\s\S]*Previous operator run|<noscript>[\s\S]*previous refusal/);
  assert.doesNotMatch(source.match(/<section[^>]*id="encounter"[\s\S]*?<\/section>/)![0], /<nav|allowlisted/i);
  assert.doesNotMatch(source, /innerHTML/);
});

test("encounter admission timeout shows a previous refusal without automatically spending again", async () => {
  const view = await page(async (url, options) => url === "/sandbox/run" ? new Promise((_resolve, reject) => {
    options.signal!.addEventListener("abort", () => reject(new Error("timeout")));
  }) : successful(url));
  const pending = view.submit();
  await setImmediate();
  view.controllers.at(-1)!.abort();
  await pending;
  assert.equal(view.element("#recorded-refusal").hidden, false);
  assert.equal(view.requests.filter(url => url === "/sandbox/run").length, 1);
  assert.equal(view.element("#encounter-controls").disabled, false);
});

test("encounter long wait stays explicit, then stops polling with its received evidence intact", async () => {
  const view = await page(async url => url === "/sandbox/run/test-run" ? Response.json({ ...encounterRun, outcome: "running" }) : encounterFetch(url));
  const pending = view.submit();
  await setImmediate();
  view.advance(16000);
  assert.match(view.element("#elapsed").textContent, /16s elapsed.*Still waiting/);
  assert.equal(view.element("#explanation").hidden, true);
  view.advance(45000);
  await view.tick();
  await pending;
  assert.equal(view.element("#outcome-title").textContent, "Updates paused.");
  assert.equal(view.element("#stage-payment").textContent, "Done");
  assert.equal(view.element("#recorded-refusal").hidden, false);
  const stopped = view.element("#elapsed").textContent;
  view.advance(1000);
  assert.equal(view.element("#elapsed").textContent, stopped);
});

test("encounter failed exercise is an unknown outcome, with a separately labelled previous refusal", async () => {
  const view = await page(async url => url === "/sandbox/run/test-run" ? Response.json({
    ...encounterRun, outcome: "failed", hcsVerdictUrl: undefined,
    steps: [{ name: "envelope", state: "done" }, { name: "schedule", state: "done" }, { name: "payment", state: "failed" }, { name: "verdict", state: "never-happened" }],
  }) : encounterFetch(url));
  await view.submit();
  assert.equal(view.element("#outcome-title").textContent, "Outcome unknown.");
  assert.equal(view.element("#stage-verdict").textContent, "Not reached");
  assert.equal(view.element("#recorded-refusal").hidden, false);
  assert.equal(view.element("#run-verdict").hidden, true);
});

test("encounter approval with null execution keeps approval and reports unobserved execution", async () => {
  const view = await page(async url => url.endsWith("/schedules/0.0.10512157") ? Response.json({ ...schedule, schedule_id: "0.0.10512157" }) : encounterFetch(url));
  await view.submit();
  assert.equal(view.element("#outcome-title").textContent, "Approved.");
  assert.match(view.element("#execution-status").textContent, /Execution is not yet observed/);
});

test("encounter exposes a ledger mismatch instead of converting execution into a refusal", async () => {
  const view = await page(async url => url === "/sandbox/run/test-run" ? Response.json({ ...encounterRun, outcome: "refused", reason: "policy refused" }) : encounterFetch(url));
  await view.submit();
  assert.equal(view.element("#outcome-title").textContent, "Refused.");
  assert.match(view.element("#execution-status").textContent, /Mismatch: executed despite refusal/);
});
