# Build briefs

These are the planning and prompt artifacts for this project, included because ETHGlobal
requires spec files, prompts and planning artifacts to ship with the submission.

Each numbered file is a task brief written for OpenAI Codex and handed to it verbatim.
`01-COMMON.md` is prepended to every other brief. `00-README-HOW-TO-RUN.md` records how the
briefs were executed and the failure modes that had to be worked around first.
`08-OWNER-ONLY-not-codex.md` is the opposite: work no agent was allowed to do.

They were written on 2026-09-04, during the event, against branch `build/day1-foundation`
at `62d8697` with 236 tests passing. They describe the work as it stood then, so several
statements in them are now out of date — brief 08 says the repository is not on GitHub, and
briefs 07 and 08 say nothing has ever run against Hedera. Both were true when written and
are not true now. They are kept as written rather than revised, because their value is as a
record of how the build was actually directed.

Two edits were made before publishing, and nothing else was changed:

- Pointers into the owner's own strategy notes were removed. Those notes predate the event
  and are not part of this submission, so referencing them here would be misleading.
- Brief 08 gave the submission deadline the wrong weekday. 2026-09-13 is a Sunday.

`AI_USAGE.md` records which parts of the repository each tool produced.
