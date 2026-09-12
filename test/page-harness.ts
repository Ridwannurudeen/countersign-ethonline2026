import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";

import { parseEvidenceManifest } from "../src/evidence-manifest.ts";

const fixture = parseEvidenceManifest(
  JSON.parse(
    await readFile(
      new URL("./fixtures/replay-evidence.json", import.meta.url),
      "utf8",
    ),
  ),
);

export const reviewRecord = fixture.records[0]!;

export function manifestWithRecords(records = [reviewRecord]) {
  return { ...fixture, records };
}

// The mirror node returns public_key_prefix as base64 (OpenAPI format: byte).
export function mirrorPrefix(publicKeyHex: string): string {
  return Buffer.from(publicKeyHex, "hex").toString("base64");
}

export const mirrorSchedule = {
  creator_account_id: "0.0.8001",
  payer_account_id: "0.0.8001",
  memo: reviewRecord.mandateDigest,
  deleted: false,
  executed_timestamp: null,
  signatures: [{ public_key_prefix: mirrorPrefix("aaaa") }],
};

class PageElement {
  children: PageElement[] = [];
  dataset: Record<string, string> = {};
  className = "";
  hidden = false;
  value = "";
  href = "";
  private text = "";
  private listeners = new Map<string, () => void>();

  get textContent(): string {
    return (
      this.text + this.children.map((child) => child.textContent).join(" ")
    );
  }

  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }

  append(...children: PageElement[]) {
    this.children.push(...children);
  }

  replaceChildren(...children: PageElement[]) {
    this.text = "";
    this.children = children;
  }

  addEventListener(event: string, listener: () => void) {
    this.listeners.set(event, listener);
  }

  dispatch(event: string) {
    const listener = this.listeners.get(event);
    assert.ok(listener, `missing ${event} listener`);
    listener();
  }

  descendants(className: string): PageElement[] {
    return this.children.flatMap((child) => [
      ...(child.className === className ? [child] : []),
      ...child.descendants(className),
    ]);
  }
}

export async function executePage(
  page: "replay" | "evidence",
  manifest: unknown,
  mirrorFetch: (url: string) => Promise<Response>,
) {
  const source = await readFile(
    new URL(`../web/${page}.html`, import.meta.url),
    "utf8",
  );
  const script = source.match(
    /<script type="module">([\s\S]*?)<\/script>/,
  )?.[1];
  assert.ok(script, "page must contain its executable module");
  const elements = new Map<string, PageElement>();
  for (const match of source.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>([^<]*)/g)) {
    const element = new PageElement();
    element.hidden = /\bhidden\b/.test(match[0].split(">")[0]!);
    element.textContent = match[2]!;
    elements.set(`#${match[1]}`, element);
  }
  const requests: string[] = [];
  const location = new URL(`https://countersign.example/${page}.html`);
  const done = runInNewContext(`(async () => {${script}\n})()`, {
    document: {
      querySelector: (selector: string) => elements.get(selector) ?? null,
      createElement: () => new PageElement(),
    },
    fetch: async (url: string) => {
      requests.push(url);
      return url === "./evidence.json"
        ? Response.json(manifest)
        : mirrorFetch(url);
    },
    window: {
      location,
      history: {
        replaceState: (_state: unknown, _title: string, url: URL) => {
          location.href = url.href;
        },
      },
    },
    URL,
    URLSearchParams,
    Error,
    atob,
    btoa,
  }) as Promise<void>;
  await setImmediate();
  return {
    done,
    requests,
    element(selector: string) {
      const element = elements.get(selector);
      assert.ok(element, `missing ${selector}`);
      return element;
    },
  };
}
