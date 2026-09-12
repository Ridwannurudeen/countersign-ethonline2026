# Countersign — remaining work, as Codex briefs

Everything left to build and fix, written so you can hand each file to Codex directly.
Written 2026-09-04. Repo state at the time: branch `build/day1-foundation`, HEAD
`62d8697`, **236 tests passing**, typecheck clean, no `.env`.

## How to run one

```bash
cd /c/Users/gudma/OneDrive/Desktop/GITHUB-FILES/countersign-ethonline2026
cat ../countersign-codex-briefs/01-COMMON.md ../countersign-codex-briefs/<brief>.md > /tmp/b.md
"/c/Users/gudma/AppData/Roaming/npm/codex.cmd" exec -p lean -s danger-full-access \
  -o /tmp/out.md - < /tmp/b.md
```

**Always prepend `01-COMMON.md`.** Each numbered brief assumes it.

### Why `-p lean`
I created `~/.codex/lean.config.toml`. Your default config auto-starts **5 MCP servers and
13 plugins on every run** — measured live at **19 descendant processes / 676 MB before any
work**. That is what was killing runs on this machine. Under `-p lean`: **0 descendants,
0 MB**. Your global `config.toml` is untouched; the profile only applies with `-p lean`.

### Rules that made runs succeed (7 died before I found these)
1. **`-p lean`**, and `model_reasoning_effort="high"` — **never `xhigh`**, it died twice.
2. **One task per brief.** A five-task brief was killed; its first slice succeeded.
3. **Never let Codex read a big file.** Every failure died *mid-file-read*, never
   mid-reasoning. `src/server.ts` is 892 lines and `test/server.test.ts` is 1300+. Extract
   the lines it needs into the brief instead — that turned three consecutive failures into
   a first-try success.
4. **Never tell it to run `npm test`** — 1400 lines into its context. Have it run only its
   own new test file. You run the full suite.
5. Reap orphans between runs:
   `powershell -c "Get-Process codex -EA SilentlyContinue | Stop-Process -Force"`
6. **A killed run usually leaves its work intact.** Check `git status` and the suite before
   redoing anything — one killed build needed zero rework.

## Order to run them

| # | Brief | Needs `.env`? | Why this order |
|---|---|---|---|
| 02 | Payment-gate token gap | no | Small, real security gap, must land before HTS |
| 03 | HTS guarded transfer | no (tests offline) | Last T1 item; depends on 02 |
| 04 | Python x402 package | no | The upstreamable artifact |
| 05 | Evidence manifest | no | Schema + generator |
| 06 | Judge replay view | no | Consumes 05 |
| 07 | **Live go/no-go** | **YES** | The gate everything else assumes |
| 08 | Owner-only items | — | Not Codex work |

**07 is the most important thing in this folder.** Nothing in this project has ever run
against Hedera. Until it does, T0 is code, not proof.

## Verify every run yourself
Codex reports have been accurate but not always complete. After each run:
```bash
git status --porcelain --untracked-files=all | grep -v node_modules   # scope + junk check
npm run typecheck && npm test                                          # must stay green
```
Two runs dumped a virtualenv and extracted wheels into the repo (6700+ files). `.tmp-*/`
and `.tmp_*/` are now gitignored, but check anyway.

**Mutation-check anything security-critical**: delete the guard, confirm a test fails,
restore. That is how I verified every commit so far — a green suite alone proves nothing
about whether the tests are load-bearing.

## Do not let Codex do these
Deploying, opening a PR, publishing to PyPI, pushing to GitHub, recruiting, or submitting.
Your roadmap gates all of them on you.
