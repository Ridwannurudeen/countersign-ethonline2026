import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../web/sandbox.html", import.meta.url), "utf8");
const script = source.match(/<script type="module">([\s\S]*?)<\/script>/)![1];
const mirror = "https://testnet.mirrornode.hedera.com/api/v1/";
const completed = {
  runId: "run-1", origin: "operator", recipient: "vendor", amountTinybars: "1000000",
  outcome: "approved", scheduleId: "0.0.123", settlementId: "0.0.10@123.000000001",
  hcsVerdictUrl: `${mirror}topics/0.0.100/messages/1`,
  steps: ["envelope", "schedule", "payment", "verdict"].map(name => ({ name, state: "done" })),
};

type Event = { preventDefault(): void; target: Element };
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  listeners = new Map<string, (event: Event) => unknown>();
  className = "";
  href = "";
  rel = "";
  value = "";
  focused = false;
  private text = "";
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(" "); }
  set textContent(value: string) { this.text = value; this.children = []; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.text = ""; this.children = children; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  getAttribute(name: string) { return this.attributes[name]; }
  addEventListener(name: string, callback: (event: Event) => unknown) { this.listeners.set(name, callback); }
  focus() { this.focused = true; }
  async dispatch(name: string) {
    const listener = this.listeners.get(name);
    assert.ok(listener);
    await listener({ preventDefault() {}, target: this });
  }
}

async function page(handler: (url: string, options?: RequestInit) => Promise<Response>, hash = "") {
  const elements = new Map<string, Element>();
  for (const match of source.matchAll(/id="([^"]+)"/g)) elements.set(`#${match[1]}`, new Element());
  const recipient = new Element();
  recipient.value = "vendor";
  elements.set("input[name=recipient]:checked", recipient);
  elements.get("#amount")!.value = "0.01";
  const location = new URL(`https://sandbox.example/sandbox.html${hash}`);
  const events = new Map<string, () => void>();
  const timers: (() => void)[] = [];
  const requests: string[] = [];
  runInNewContext(script, {
    document: { querySelector: (selector: string) => elements.get(selector), createElement: () => new Element() },
    window: { addEventListener: (name: string, callback: () => void) => events.set(name, callback) },
    location, history: { replaceState: (_state: unknown, _title: string, path: string) => { location.hash = path; } },
    fetch: (url: string, options?: RequestInit) => { requests.push(url); return handler(url, options); },
    setTimeout: (callback: () => void) => timers.push(callback), AbortSignal,
  });
  await setImmediate();
  return {
    element: (id: string) => elements.get(id)!, requests, timers,
    submit: () => elements.get("#proposal-form")!.dispatch("submit"),
    open: async (id: string) => { location.hash = `#run/${id}`; events.get("hashchange")!(); await setImmediate(); },
  };
}

const emptyHistory = () => Response.json({ origin: "operator", runs: [] });

test("sandbox polls admission through approval without inventing mirror execution", async () => {
  let polls = 0;
  let proposal: unknown;
  const pendingMirror = Promise.withResolvers<Response>();
  const view = await page(async (url, options) => {
    if (url === "/sandbox/runs") return emptyHistory();
    if (url === "/sandbox/run") {
      proposal = JSON.parse(String(options?.body));
      return Response.json({ runId: "run-1" }, { status: 202 });
    }
    if (url.startsWith(mirror)) return pendingMirror.promise;
    polls += 1;
    return Response.json(polls === 1 ? {
      ...completed, outcome: "running", settlementId: undefined, hcsVerdictUrl: undefined,
      steps: completed.steps.map(step => ({ ...step, state: step.name === "payment" ? "running" : step.name === "verdict" ? "pending" : "done" })),
    } : completed);
  });
  assert.match(view.element("#recent-status").textContent, /No runs yet.*Try this transfer/);
  const submitting = view.submit();
  await setImmediate();
  assert.deepEqual(proposal, { recipient: "vendor", amountTinybars: "1000000" });
  assert.match(view.element("#payment-state").textContent, /In progress/);
  assert.match(view.element("#signature-state").textContent, /Waiting/);
  await view.submit();
  assert.equal(view.requests.filter(url => url === "/sandbox/run").length, 1);
  view.timers.shift()!();
  await setImmediate();
  assert.match(view.element("#signature-state").textContent, /Signed — reported by the guard/);
  assert.doesNotMatch(view.element("#execution-state").textContent, /Executed/);
  pendingMirror.resolve(Response.json({ schedule_id: "0.0.123", executed_timestamp: null }));
  await submitting;
  assert.match(view.element("#execution-state").textContent, /Not observed/);
  assert.equal(view.element("#payment-evidence").children[0]!.href, `${mirror}transactions/0.0.10-123-000000001`);
  assert.equal(view.element("#verdict-evidence").children[0]!.href, completed.hcsVerdictUrl);
});

for (const [recipient, amount, reason] of [
  ["stranger", "0.01", "recipient outside the mandate allowlist"],
  ["agent", "0.01", "recipient is the agent"],
  ["vendor", "1.00", "amount exceeds mandate cap"],
]) {
  test(`sandbox displays the guard's distinct refusal for ${recipient} at ${amount}`, async () => {
    const view = await page(async (url, options) => {
      if (url === "/sandbox/runs") return emptyHistory();
      if (url === "/sandbox/run") {
        assert.deepEqual(JSON.parse(String(options?.body)), { recipient, amountTinybars: String(Number(amount) * 100000000) });
        return Response.json({ runId: "run-1" }, { status: 202 });
      }
      if (url.startsWith(mirror)) return Response.json({ schedule_id: "0.0.123", executed_timestamp: null });
      return Response.json({ ...completed, recipient, outcome: "refused", reason });
    });
    view.element("input[name=recipient]:checked").value = recipient!;
    view.element("#amount").value = amount!;
    await view.submit();
    assert.match(view.element("#review-state").textContent, new RegExp(reason!));
    assert.match(view.element("#signature-state").textContent, /Never happened/);
    assert.match(view.element("#execution-state").textContent, /Never happened as of this check/);
    assert.match(view.element("#verdict-state").textContent, /Refused — HCS verdict recorded/);
  });
}

test("sandbox preserves controls and history through exhaustion, rate limit and storage failure", async () => {
  for (const [status, error, expected] of [
    [503, "sandbox budget exhausted", /operator-funded budget/],
    [503, "sandbox pre-signed envelopes exhausted", /pre-signed policy allowance/],
    [429, "one sandbox run per 30 seconds per client address", /going too fast/],
    [503, "sandbox storage unavailable", /service or network/],
  ] as const) {
    const view = await page(async url => url === "/sandbox/runs"
      ? Response.json({ origin: "operator", runs: [completed] })
      : Response.json({ error }, { status }));
    view.element("#amount").value = "1.00";
    view.element("input[name=recipient]:checked").value = "agent";
    await view.submit();
    assert.match(view.element("#notice").textContent, expected);
    assert.equal(view.element("#amount").value, "1.00");
    assert.equal(view.element("input[name=recipient]:checked").value, "agent");
    assert.equal(view.element("#recent-list").children.length, 1);
    assert.equal(view.element("#submit").getAttribute("aria-disabled"), "false");
  }
});

test("sandbox keeps service interruption and missing mirror evidence unknown", async () => {
  const view = await page(async url => url === "/sandbox/runs" ? emptyHistory()
    : url.startsWith(mirror) ? Response.json({}, { status: 404 })
    : Response.json({ ...completed, outcome: "failed", reason: "service interrupted", hcsVerdictUrl: undefined,
      steps: completed.steps.map(step => ({ ...step, state: step.name === "verdict" ? "failed" : "done" })) }), "#run/run-1");
  await setImmediate();
  assert.match(view.element("#signature-state").textContent, /Unknown/);
  assert.match(view.element("#execution-state").textContent, /Not verified/);
  assert.match(view.element("#notice").textContent, /service interrupted/);
  assert.equal(view.element("#verdict-evidence").children.length, 0);
  assert.ok(!view.requests.includes("/sandbox/run"));
});

test("sandbox rejects incomplete completed evidence and unsafe links before displaying approval", async () => {
  for (const patch of [{ hcsVerdictUrl: undefined }, { hcsVerdictUrl: "javascript:alert(1)" }, { hcsVerdictUrl: [completed.hcsVerdictUrl] }, { settlementId: [completed.settlementId] }, { scheduleId: [completed.scheduleId] }, { settlementId: undefined }, { scheduleId: undefined }, { outcome: "refused", reason: undefined }]) {
    const view = await page(async url => url === "/sandbox/runs" ? emptyHistory() : Response.json({ ...completed, ...patch }), "#run/run-1");
    await setImmediate();
    assert.doesNotMatch(view.element("#signature-state").textContent, /Signed|Never happened/);
    assert.match(view.element("#notice").textContent, /service or network/);
    assert.equal(view.element("#verdict-evidence").children.length, 0);
  }
});

test("sandbox ignores an older run response after another history selection", async () => {
  const delayed = Promise.withResolvers<Response>();
  const view = await page(async url => {
    if (url === "/sandbox/runs") return Response.json({ origin: "operator", runs: [completed] });
    if (url.endsWith("run-1")) return delayed.promise;
    if (url.startsWith(mirror)) return Response.json({ schedule_id: "0.0.123", executed_timestamp: "123.000000001" });
    return Response.json({ ...completed, runId: "run-2", recipient: "agent", outcome: "refused", reason: "recipient is the agent" });
  }, "#run/run-1");
  await view.open("run-2");
  delayed.resolve(Response.json(completed));
  await setImmediate();
  assert.match(view.element("#review-state").textContent, /Refused — recipient is the agent/);
  assert.match(view.element("#execution-state").textContent, /Mismatch: executed despite refusal/);
  assert.equal(view.requests.filter(url => url === "/sandbox/run").length, 0);
});
