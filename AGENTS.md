# AGENTS.md（dsh-side-chat）

Project-level instructions for this repository. The global `~/.agents/AGENTS.md` still applies;
this file only adds project-specific rules.

## Commands

```bash
npm run check   # node --check for both halves
npm test        # node --test (host + client)
```

There is no build step, no linter beyond `--check`, and the plugin itself is dependency-free
ESM with no `@deepseek-ai/*` imports. Do not add a bundler, a framework, or runtime deps for
a change that can be written by hand.

## Repository shape

| path | role |
|---|---|
| `lib/index.js` | host half: `webServer` JSON routes + SSE, fork seed, boundary prompt, side-session registry, close/dispose |
| `lib/client.js` | client half: hand-written `window.__ModuleLoader__` bundle — tab type, panel, composer, reference menu, usage dock |
| `tests/host.test.mjs`, `tests/client.test.mjs` | `node --test`; the client suite loads the real bundle with stub React/primitives/fetch |
| `docs/CONTRACT.md` | authoritative wire contract (routes, stream frames, rendering/localization contract) |
| `docs/DESIGN.md` | phases (P0/P1a/P1a-2/P1b-1/P1b), scope, adversarial notes |
| `docs/USAGE.md` | user semantics and known limitations |
| `README.md` / `README.zh.md` | positioning, quick start, feature summary, limitations |

A change that adds or alters a route, event, frame, or user-visible composer behavior must
update the contract/semantics docs **and** both READMEs when the user-facing summary changes.
README feature bullets must not restate semantic details that belong to USAGE/CONTRACT.

## DSH coupling

- Tested target: DSH `0.2.2-rc.3` (the installed Desktop build); no `engines.dsh` and no DSH
  peer dependency is declared. Treat other DSH releases as untested. The source checkout used
  for reference can lag the installed build — read the installed build out of
  `app.asar` before trusting a source path.
- Image input reuses host services instead of importing DSH packages: `ctx.get('attachments')`
  (`saveImages`, `admitPromptContent` with the stored-image arm
  `{ type: 'image', attachment, encodedBytes }`, `readImage`, `isAttachmentError`,
  `imageLimits`) plus `agent.followup` with image content blocks. The installed 0.2.2-rc.3
  service contract was checked through Inspect; the DSH Remote APIs remain unusable because
  the side session is `origin: 'subagent'` without `parentSession`.
- The client bundle may only `require` modules in the shell's platform seed table
  (`react`, `react/jsx-runtime`, `@deepseek-ai/dsh-client-ui-primitives`, …). Do not import
  `@deepseek-ai/*` packages from this repository; keep the hand-written bundle model.
- DSH behavior that is replicated here rather than imported (check it against the matching
  DSH source checkout after an upgrade; the paths below are relative to that checkout):
  - `packages/context/file-reference/src/grammar.ts` — `activeAtToken` / `formatFileMention`
    (prompt spellings `@path`, `@"path with spaces"`, `@dir/`, open `@"dir/`).
  - `packages/client/ui-reference/src/client/user-text-rules.ts` — reference chip tokenization
    (quoted paths, trailing punctuation trimming).
  - `packages/context/session-reference/src/uri.ts` — canonical session mention
    `@[label](dsh-session:<base64url(JSON.stringify(sessionId))>)`, `\`/`]` label escaping,
    and the resolver's `agent/pre-step` preparation; the host route generates the mention and
    the client never renders the raw mention as HTML.
- Side sessions are `origin: 'subagent'` without `parentSession`; DSH's session-controller
  Remote APIs reject them (`hasApiSessionSubagentOwner` returns true for any subagent origin),
  so primary-chat client features cannot be reused through `ctx.remote` / conversation slots.
  Use plugin-owned host routes over host services (`ctx.get('fileReferences')`,
  `sessionReferenceResolver`, `attachments`, `commands`, …) instead. Session references work
  because the side agent is a normal agent whose `agent/pre-step` receives DSH's mounted
  preparation; the plugin only lists candidates and inserts the canonical mention.

## Verification expectations

- Host changes: unit tests with the fake `webServer` / fake services, plus an in-process check
  with a real HTTP server when route framing or stream behavior changes.
- Client changes: the suite loads `lib/client.js` with stub React/primitives/fetch, so it
  verifies pure helpers, runtime state and render trees — not a browser. There is no GUI e2e.
- UI/composer changes require a manual smoke after restarting DSH (Desktop or `dsh web`):
  open the right sidebar → side chat → exercise the changed interaction, including empty,
  loading and error states, IME composition, focus/blur and two tabs. Record what was actually
  run; do not describe `node --test` as end-to-end verification.
- Keep README/CONTRACT verification claims level-accurate. If a route or behavior was only
  covered by unit tests, say so instead of claiming a real-process check.

## Composer conventions

- The composer's image rail is per-tab and in-memory: paste, drop and picker each add files,
  which upload immediately through `/side-chat/api/attachment` and render as thumbnails with
  `uploading` / `ready` / `error` states. A message may be image-only; failed or still-uploading
  images are never sent and stay in the rail. History thumbnails are served by
  `/side-chat/api/image`, which only serves images a user message of that side session
  references. Keep image bytes off the JSON routes (the raw body exceeds the 1 MiB JSON cap).
- The composer is a plain controlled `<textarea>` in `lib/client.js`, not the native
  conversation composer. Keep all input extensions inside the bundle: menu markup is rendered
  at the top of the composer card (no portal), per-tab state lives in the runtime panel record,
  and keyboard paths stay mutually exclusive (`pick` / `submit` / `newline` / `close`).
- A menu with no selectable row must not swallow `Enter`: close it and submit. A composing
  Enter must reach neither pick nor send. Menu rows/aria (`combobox`, `listbox`, `option`,
  `aria-activedescendant`) are part of the contract, not decoration.
- `@` references stay text-only in this plugin: it never reads or attaches file content or a
  session log. File picks insert the primary's `@path` spelling; session picks insert a
  readable `@[title]` token that `send` expands to the host-returned canonical
  `@[title](dsh-session:…)` mention. Keep both spellings identical to the primary composer and
  never invent a mention client-side; DSH's own pre-step prepares the referenced session.
- For a new host route: reuse the existing `{ ok: true|false, code, message? }` shape, validate
  identity and query length, bound discovery to the addressed agent's workspace, and abort the
  provider call when the client disconnects (the reference route reads its own request body for
  that reason).

## Markdown rendering

- Assistant bodies stay on the shell's `MarkdownText`; do not fork it to add chrome. Copy
  controls for tables are appended *into* the renderer's own DOM (`button.sc-copy-chip` as the
  last child of the table's scroll container, `sc-copy-host` added to that container) by
  `decorateCopyChips` + a per-row `MutationObserver`. Never wrap, move or re-parent a
  React-managed node from the decorator: React removes/reorders by its recorded DOM parent and
  will throw if the parent changed. Absolute positioning keeps DOM order irrelevant, chips are
  reused by class (idempotent under stream re-renders), and readers re-resolve the live node at
  click time so a replaced table or a locale switch cannot serve a stale payload or label.

## Release

Only when the user explicitly asks: feature commit(s) first (code + tests + docs), then a
separate `chore: release X.Y.Z` that bumps `package.json`, `dsh.plugin.json`, the version in
`docs/CONTRACT.md`, and version references in both READMEs. `npm publish` is user-performed:
give the exact commands/checks and do not run it yourself. Do not commit, tag, push or publish
unless the user explicitly asks for it.
