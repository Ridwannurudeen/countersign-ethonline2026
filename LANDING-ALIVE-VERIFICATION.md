# Landing live-read verification

Brief 32, 2026-09-13. Local work on `feat/landing-alive`, based on `main` at `f160468`. No merge, push or deployment.

The landing page reads the refused schedule directly from the testnet mirror, reads sandbox outcomes from `/sandbox/runs`, and reads the guard identity from `/guard`. Each response is validated before its values replace the HTML snapshot. Failed requests, invalid responses and the eight-second timeout retain that snapshot. Text uses `textContent`; schedule links are constructed only from validated numeric IDs.

The mirror's base64 signer prefixes are decoded before comparison. The guard's absence is explicit. The historical refusal label, treasury, review fee and failed check remain recorded evidence; the live-read notice identifies which fields were refreshed. Sandbox outcomes remain operator-run reliability exercises using operator-owned, operator-funded testnet accounts. Their counts are separate from both other evidence sets.

## Tests

Observed baseline output from `npm test`:

```text
ℹ tests 543
ℹ suites 0
ℹ pass 543
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

The added `node:vm` tests follow `test/sandbox-page.test.ts`. They cover pending reads, network/HTTP failure, abort, atomic response validation, base64 decoding, explicit absence, changed signatures, safe schedule links, separate counts, empty history, running/failed runs with null schedule IDs, and invalid identity fields. The null schedule-ID regression was observed failing before its fix.

Final output from `npm test`, `npm run typecheck`, and `python -m pytest python/ -q`:

```text
ℹ tests 553
ℹ suites 0
ℹ pass 553
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 24685.5498

> countersign@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit

.............                                                            [100%]
13 passed in 6.68s
```

Typecheck exited successfully. The original suite remains intact; ten added landing tests increase its total to 553.

## Browser acceptance

Chromium through the already-installed Playwright, without adding dependencies. The local HTML was intercepted in the browser at the production origin for read-only API verification; no hosted files changed. Real endpoint reads produced:

```text
Read live at 2026-09-13T08:45:07.906Z · schedule fields only; other review evidence remains recorded.
Read live at 2026-09-13T08:45:07.853Z · Hedera testnet.
Read live at 2026-09-13T08:45:07.853Z · Hedera testnet.
```

Controlled responses separately exercised these acceptance conditions:

| State | Observed acceptance |
| --- | --- |
| Before responses | Original ledger values, recorded identity and both recorded sandbox links already visible. |
| JavaScript disabled | Ledger, identity and both sandbox links remain visible. |
| Successful live read | Explicit `absent from signatures[]`, decoded agent prefix, real guard prefix, separate approved/refused counts and read timestamps. |
| Network failure | Recorded values retained; quiet failure notice and reload recovery. |
| Timeout | Stubbed abort preserves every fallback value; the request uses an eight-second abort signal. |
| Malformed response | Entire affected snapshot retained; other endpoints can still succeed. |
| Empty sandbox | Names the authorization outcomes that will appear and the sandbox's “Try this transfer” control. |
| Layout stability | Compared positions and sizes before and after replacement. Success at 320px; empty/failure at 320px and 1440px preserve measured geometry. |
| Reflow | 320px viewport, 320px document, no horizontally overflowing elements. Existing tables and key-tree text wrap at narrow widths. |
| Keyboard | All 55 links and explicit tab stops reached in document order with visible outlines; Enter opens the sandbox. Native list scrolling retains access to additional rows. |
| Motion | Reduced-motion emulation reports no animation; the existing media query disables transitions and animations. |
| CSS variables | No undefined or unused custom properties. |

Actual browser output:

```text
320px reflow: {"viewport":320,"document":320,"horizontalOverflow":[]}
320px live replacement geometry: unchanged
Keyboard: 55 targets in DOM/visual order, all visible focus outlines
Keyboard Enter: sandbox navigation passed
Reduced motion: none
Undefined CSS properties: []
Unused CSS properties: []
Browser errors: []
Desktop data overflow: []
JavaScript disabled: recorded ledger, identity and both schedule links visible
320px empty/failure states: fixed geometry, empty action named, failed reads retain snapshot
1440px empty/failure states: fixed geometry, empty action named, failed reads retain snapshot
Synthetic 20-row feed: keyboard End scrolls to later outcomes within reserved region
```

## Computed contrast

Linearized sRGB relative luminance, `(Llighter + 0.05) / (Ldarker + 0.05)`, rounded to two decimals. Computed styles were inspected on every text-bearing element, including inherited surfaces, then on hover/focus states. Duplicate pairs are consolidated below. Every text pair exceeds 4.5:1.

| Foreground | Surface | Ratio |
| --- | --- | ---: |
| Ink `#172019` | Canvas `#f4f1e8` | 14.79:1 |
| Muted `#4d574f` | Canvas | 6.66:1 |
| Green `#145c43` | Canvas | 7.04:1 |
| Ink | Surface `#fffcf4` | 16.29:1 |
| Muted | Surface | 7.34:1 |
| Green | Surface | 7.75:1 |
| Red `#8b2d27` | Surface | 8.18:1 |
| Green | Green-soft `#dcebe3` | 6.45:1 |
| Red | Red-soft `#f8e9e5` | 7.10:1 |
| Panel text `#f4f1e8` | Panel / primary button `#172019` | 14.79:1 |
| Panel dim `#c9c4b6` | Panel | 9.59:1 |
| Panel red `#f0a79f` | Panel | 8.54:1 |
| Panel green `#8fd0b4` | Panel, hovered links | 9.43:1 |
| Panel text | Green, primary hover / skip link | 7.04:1 |
| Ink | Sunk `#ebe7dc`, secondary hover | 13.52:1 |

Focus outlines: green on canvas **7.04:1**, green on surface **7.75:1**, panel-green on panel **9.43:1**. Strong rules / link underlines (`#687269`): canvas **4.43:1**, surface **4.88:1**. Status labels and their borders use the same passing foreground pairs; meaning is also spelled out in text. Pale hairlines remain decorative separators, with native table and list semantics carrying structure.

The existing serif/mono typography, palette, square corners and hairlines remain. Fixed line-height-based space preserves live-field geometry; the bounded ordered list scrolls vertically for additional history. Reads occur on page load; reloading reads subsequent sandbox outcomes.

No required work remains. Merge, push and deployment are excluded by the brief.
