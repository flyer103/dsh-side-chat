# Design — dsh-side-chat

## Positioning

A DeepSeek Harness (DSH) profile plugin that gives the Web GUI **side chats** for the
current session: ephemeral, context-inheriting conversations that can **really modify
files** while the main thread keeps running, without writing anything into the main
session transcript.

Delta against the existing community plugins:

| Plugin | can modify files | inherits in-flight context | ephemeral |
|---|---|---|---|
| `Lukknow0/dsh-side-chat` | no (read-only QA) | yes | yes |
| `Diluka/dsh-side-session` | no (prompt forbids mutation) | yes (live-log snapshot) | yes |
| `Yur0918/dsh-sidepanel` | no (read-only persona side chat) | fork only | no |
| **this plugin** | **yes — full tool chain in the same workspace** | **yes** | **yes** |

## P0 (shipped)

1. **Entry**: the plugin registers a native tab type of the right Sidebar (`kind: side-chat`,
   `multiple: true`) plus a guide entry, so it is reached through the session header's "Open
   sidebar" control rather than a standalone button. Each activation of the guide entry, and
   each press of the tab status bar's new-side-chat button, opens another tab instance.
   Opening a tab performs no agent/fork work.
2. **Lazy creation**: the side session is created on the first submitted message.
3. **Context inheritance**: seed = the parent's event prefix through its last completed
   turn (`turn/end`); plus a live-log snapshot of everything committed after that boundary
   (in-flight user/assistant messages, tool calls) appended as reference context.
4. **Same agent**: `agentPresets.composeFrom` joins the parent's preset, so tools, skills,
   prompt sections and permission rows match; `cwd`, provider/model, sandbox mode and
   approval policy are inherited.
5. **Real mutations**: the boundary + developer instructions explicitly allow
   `write`/`edit`/`bash`-driven changes in the same working directory. Mutations are real;
   they are never mirrored into the main session.
6. **Isolation**: `origin: 'subagent'` keeps the side sessions out of the session list; no
   `parentSession` (avoids the subagent catalog). One side session per tab instance: a
   parent session may hold several side chats concurrently, and none of them is visible in
   the session list or the subagent catalog.
7. **Lifecycle**: closing one side-chat tab disposes that tab's side session and then
   best-effort deletes its persisted artifact (a failed removal is logged; the close still
   succeeds and the orphan never appears in any list). Other side chats and the main session
   are untouched; a closed side chat cannot be reopened.
8. **UI**: each side chat lives in its own right-Sidebar tab instance (body fills the
   column): user bubbles + assistant markdown, reasoning fold, tool chips with results,
   **token-streamed assistant output**, running/thinking state, optimistic pending messages,
   Stop, auto-follow scrolling, `Enter` send / `Shift+Enter` newline. Tab chips are numbered
   per parent session (plain title for the first, `Side chat 2` / 「侧边会话 2」… for later
   ones), and the status bar has a new-side-chat button. Collapsing the column or switching
   tabs pauses the live updates and keeps the sessions; closing a tab destroys only that
   tab's side session.
9. **Streaming**: the host folds `agent/assistant-stream` frames into a per-side-session live
   attempt and pushes it (plus committed events, status and errors) over
   `POST /side-chat/api/events` (SSE). The tab renders the active attempt as a normal
   assistant row while it streams and swaps in the committed message when it settles. When a
   stream cannot be established — no readable body, JSON refusal, or a transport that buffers
   the response — the tab degrades to the existing `snapshot` polling, which also carries the
   live attempt. Hiding the tab aborts the stream; showing it reconnects from the last seen
   sequence with a fresh live baseline. Live state and streams are per side session, so
   several tabs of one parent session stream independently.
10. **Usage dock**: a slim row under the composer — the same relationship as DSH's own
    composer dock — with total tokens, cache-hit percentage, and a context-occupancy ring
    plus percentage. Values are folded client-side from the committed events the tab already
    receives (assistant/message and assistant/attempt usage, the settlement's stream usage
    chunk as fallback, replacement on a same-turn/step retry). The token and cache totals
    count only what the side chat itself billed — its own requests, including the inherited
    prefix its first request re-sends — and never the parent's earlier usage, whose events are
    below the fork floor; context occupancy is absolute for the same reason, and approximate.
    The host contributes exactly one optional, additive `contextWindow` to the existing
    snapshot and SSE `hello` payloads so a seeded side session can show the denominator it
    usually never appends itself. Native tooltips carry the exact bucket counts (with a
    cache-write segment when the provider reports it) and `~used / window`; there are no
    dialogs, turns, steps or tok/s, no new route, no extra polling, and no config option.

## P1a — `@file` references (shipped)

The side-chat composer adopts the primary composer's file-reference flow: `@` opens a
workspace path menu for the side chat's inherited working directory, and a pick inserts the
same prompt text the primary composer would insert. Model-side semantics are already in
place — `file-reference-local` installs the stable `FILE_REFERENCE_PROMPT` section on every
agent that can call `read`, so a side chat receives the same `@path` guidance as the main
session. This phase therefore adds discovery, insertion and presentation only; it changes no
prompt, no DSH contract and adds no dependency.

### In scope

1. **Host route** `POST /side-chat/api/references` — a read-only, workspace-bounded path
   candidate lookup backed by the host's optional `ctx.fileReferences` service. The route
   exists for side sessions the plugin owns and for the parent session before the side
   session exists.
2. **Composer completion** — typing `@` at the start of input or after whitespace opens a
   candidate menu for the side chat's working directory; typed text narrows it; `@"` opens a
   quoted path that may contain spaces.
3. **Insertion** — the pick replaces the active token with exactly the spelling the primary
   composer produces (`@path`, `@"path with spaces"`, `@dir/`, `@"dir/` when the quote stays
   open), leaving the caret after it. A directory pick keeps completion open inside that
   directory.
4. **IME safety** — no completion request and no send while an input-method composition is
   in progress; `Enter` never submits a half-composed message.
5. **Chips** (presentation only) — committed user bubbles render file/folder references as
   chips using the same token grammar; no click action, no sidebar navigation.
6. **Graceful absence** — a profile without `ctx.fileReferences` simply has no menu; plain
   `@` text still sends (without that provider the model also gets no reference guidance
   section, which is upstream of this plugin).

### Out of scope

- `@session` references, `/` commands and the skill menu, attachments/images, drag & drop,
  model picker, approval rendering, plan mode (P1b).
- Reading or attaching file content; a reference is text the model must resolve with `read`.
- Clicking a chip to open the file in a sidebar; chip menus, directory drill UI beyond the
  continuation described above, per-profile configuration.
- Any change to the parent session, the fork boundary, or the DSH prompt/compose contract.

### Contract sketch

`CONTRACT.md` is the shipped wire contract and stays authoritative once this lands; the
sketch below fixes the semantics for review.

| path | request | response |
|---|---|---|
| `/side-chat/api/references` | `{ sourceId?, sessionId?, query }` | `{ ok: true, candidates: [{ path, kind: 'file' \| 'directory' }] }` \| `{ ok: false, code, message? }` |

- Exactly one of `sessionId` / `sourceId` must be usable. `sessionId` must name a side
  session this plugin created; `sourceId` must name a live agent (the parent) and covers the
  window before the first message creates the side session. When both are sent, `sessionId`
  wins.
- Discovery is bounded by the addressed agent's working directory; `query` is the text after
  `@` and is passed through unchanged. Only path candidates are returned — no file content,
  no size/type metadata.
- The provider is optional: `ctx.get('fileReferences')` absent or degraded answers
  `code: 'unavailable'`; the client then hides the menu for that tab.
- Errors: `unknown-source` (no such live parent), `not-found` (session not owned by this
  plugin), `bad-request` (non-string or over-long query, missing identity), `unavailable`,
  `internal`.
- The route keeps no cache and no durable state; the existing 1 MB request-body cap applies;
  `query` is capped at 512 characters. Requests abort their provider lookup when the client
  disconnects, so fast typing does not leave workspace scans running.

### Editor flow

- **Grammar**: the client replicates the browser-safe `activeAtToken` / `formatFileMention`
  behaviour (~60 lines with attribution) because the hand-written bundle cannot require
  `@deepseek-ai/dsh-file-reference/grammar` (not a client package). Unit tests pin the
  behaviour: token only at line start/after whitespace, `@` inside a word (an email) does not
  trigger, quoted paths, unsafe characters rejected.
- **Replaced range**: `[token start, caret]` on the current line. A file pick finishes the
  token; a directory pick inserts the trailing slash and keeps the menu open on the resulting
  query.
- **Fetch**: 120 ms debounce, exactly one request in flight per tab, the previous request
  aborted, monotonic request id drops stale answers. `sessionId` is sent only after the side
  session exists; before that the request carries the parent `sourceId`.
- **Menu**: rendered at the top of the composer card, above the textarea (no portal, no new
  dependency),
  listbox semantics with `aria-activedescendant`, Up/Down wrap, Enter/Tab pick, Escape close,
  click pick; mousedown on a row keeps textarea focus; a pick never submits. A loading or
  empty menu has nothing to pick, so Enter closes it and submits while Up/Down/Tab stay inert.
- **Chips**: committed user rows tokenize file and folder references with the primary
  reference rule (including trailing punctuation trimming) and render text nodes; the chip
  carries no click handler and no HTML injection.

### Acceptance

- Before the first message and after it, typing `@` in a side-chat tab lists paths of the
  parent workspace; typing narrows; Enter inserts the path and the send carries it; the model
  reads the referenced file (no content is sent by the pick).
- `@"` works for paths with spaces; selecting a directory inserts `@dir/` (or an open quoted
  form) and immediately lists that directory's children.
- A profile without the file-reference provider shows no menu; `@` text still sends.
- Chinese IME: typing `@`/paths during composition opens no menu, `Enter` during composition
  does not send; after composition the next change behaves normally.
- Two side-chat tabs hold independent menu state and each queries against its own session.
- Existing tests, `npm run check` and `npm test` stay green; no main-session behavior changes.

### Adversarial notes (P1a)

- **Before `create` resolves**: the menu addresses the parent agent by `sourceId`, so the
  very first message can use a reference. A `create` racing a keystroke cannot make the route
  fail: the next request simply switches to `sessionId` once the session exists.
- **Parent disposed while the menu is open**: the route answers `unknown-source`; the client
  closes the menu and keeps the draft. Sending then reports the same `not-found` the panel
  already handles.
- **Tab hidden or closed mid-request**: the fetch is aborted and the stale answer dropped;
  the route holds no state to leak, and the provider lookup is cancelled on disconnect.
- **Out-of-order answers / retry**: debounce plus monotonic request id; only the newest answer
  matching the current token is rendered.
- **Directory continuation**: after a directory pick the caret sits after the trailing slash;
  the token remains active, so the follow-up lookup lists that directory without a second
  trigger gesture.
- **Route abuse**: the route is read-only, bounded by an agent's working directory, and
  returns names only. It accepts any live `sourceId`, the same trust boundary `create`
  already crosses (which creates an agent in that workspace); it never reads file content and
  never answers for sessions the plugin does not own.
- **Provider absent or slow**: `unavailable` is cached per tab; slow lookups are aborted by
  the next keystroke rather than queued.
- **Unsafe mentions**: `formatFileMention` rejects control characters and embedded quotes, so
  those candidates are not inserted (the raw text stands); the menu never renders candidate
  text as HTML.
- **IME + Enter + menu**: pick, send and close are mutually exclusive key paths; a composing
  Enter reaches neither pick nor send.
- **Two tabs**: menu state lives in the per-tab runtime record, not in module scope.

### Delivery slices

1. Host route + route tests (inert until the client uses it).
2. Client grammar, token replacement and their tests (no UI yet).
3. Client menu + debounced fetch + styles + locale keys + tests.
4. IME guard + reference chips + tests.
5. User docs (CONTRACT/USAGE/README) once behaviour lands; a version bump/release commit is
   separate and not part of this slice.

### Rollback

The route registration and menu rendering are additive. Reverting the slices removes them;
there is no persistence, schema or prompt change to migrate.

## P1a-2 — `@session` references (shipped in 0.8.0)

The primary composer's `@` menu searches workspace paths *and* sessions. Picking a session
inserts the canonical `@[title](dsh-session:…)` mention, and DSH's mounted session-reference
plugin turns that mention into a prepared, budgeted snapshot of the referenced session at
`agent/pre-step`. The side-chat composer so far lists files only, so this slice makes the
menu search sessions too and inserts the same canonical mention: the model-visible effect is
the primary composer's, while the plugin still reads no file or session content itself.

Runtime basis: DSH `0.2.2-rc.3` (then the installed Desktop build; it is now `0.2.2-rc.5`).
Verified in the loaded profile through Inspect: `ctx.get('sessionReferenceResolver')` exposes
`listCandidates(agent, query, limit?, signal?)`, and the source installs the
`agent/pre-step` listener that replaces canonical mentions with prepared context. The side
agent is a normal `ctx.agents.create` agent whose user messages carry `source: { kind: 'user' }`,
so the same pre-step preparation applies to it. The mention format
(`@[label](dsh-session:<base64url(JSON.stringify(sessionId))>)`, with `\` and `]` escaped in
the label) is replicated locally because the plugin imports no `@deepseek-ai/*` package; the
installed `parseSessionReferenceText` was run against the generated spelling and round-trips
the session id and escaped labels.

### In scope

1. **Route** — `POST /side-chat/api/references` gains `quoted?: boolean` and returns one
   discriminated candidate list: file/directory rows as today plus session rows
   `{ kind: 'session', sessionId, label, mention, location?, createdAt }`. File and session
   lookups run in parallel against the addressed agent; a quoted query skips sessions (primary
   parity); a missing or failing domain only removes its rows. `unavailable` is answered only
   when neither domain is mounted, so the client keeps its one retry-free `unavailable` cache
   meaningful.
2. **Menu** — session rows render in a second group (`reference.sessions`) with the session
   title and a `location · age` description; directory/file rows keep the first group
   (`reference.files`). Up/Down still wrap over the flattened rows; group headers are not
   options and take no index.
3. **Insertion** — a session pick inserts the readable `@[title]` token at the caret and
   closes the menu. A per-tab list records `{ token, mention }`; `send` expands each recorded
   token to the canonical mention (first exact occurrence; duplicate picks consume successive
   occurrences) and sends the result, so the prompt text is exactly what the primary inserts.
   A token the user edited or deleted is skipped rather than mis-referenced.
4. **History** — committed user messages parse canonical mentions into inert session chips
   (label only, no click), alongside file/folder chips; pending rows render the same expanded
   text so the chip appears without a flash.
5. **Graceful absence** — no resolver: files only, no error. No file provider: sessions only.
   Neither: today's `unavailable`.

### Out of scope

- Opening a referenced session in the sidebar, drill/breadcrumb parity, subagent section
  headers, `/` commands and skills, generic (non-image) attachments.
- Reading the referenced session's log in this plugin; preparation stays DSH's.
- Persisting drafts or references across tab close/restart.

### Contract sketch

`CONTRACT.md` stays authoritative once this lands; the sketch fixes the semantics for review.

| path | request | response |
|---|---|---|
| `/side-chat/api/references` | `{ sourceId?, sessionId?, query, quoted? }` | `{ ok: true, candidates: [{ path, kind: 'file' \| 'directory' } \| { kind: 'session', sessionId, label, mention, location?: string \| null, createdAt }] }` \| `{ ok: false, code, message? }` |

- `quoted === true` skips session discovery; files only.
- Ordering: file/directory rows first, then sessions in resolver rank order (cwd affinity,
  then resolver order).
- `location` is omitted when the candidate shares the addressed agent's workspace, `null`
  when it has no recorded cwd, otherwise the home-abbreviated cwd.
- `unavailable` when both providers are absent, or when every attempted lookup failed; one
  failed domain is logged and dropped.
- A session row's `mention` is generated host-side from the resolver's session id and display
  title; the client rejects a malformed mention instead of inserting it.

### Editor flow

- A session pick replaces `[token start, caret]` exactly like a file pick. The readable token
  is `@[<escaped title>]`; `activeAtToken` treats a completed `@[…]` as inert so the menu does
  not reopen on it.
- Expansion happens in `send` only: the draft keeps the readable token, the pending row and
  the wire text carry the canonical mention. A failed send keeps both the draft and the
  recorded references.
- Label escaping mirrors the primary: `\` and `]` are escaped in the readable token and in the
  canonical mention; the host clamps control characters out of a mention label.

### Acceptance

1. Typing `@` plus a query lists files and sessions in two groups; `@"` lists files only.
2. Picking a session inserts `@[Title]`; sending produces the canonical mention, DSH prepares
   the referenced snapshot, and the committed bubble shows a session chip.
3. A profile without `sessionReferenceResolver` lists files only, with no error.
4. A malformed mention in a response is dropped, never inserted.
5. Two tabs keep independent menus and reference lists.
6. Levels: L1 host shaping/route and client parsing/menu/expansion; L2 real HTTP framing of the
   combined route; L3 manual after a DSH restart for the actual pick and prepared context.

### Adversarial notes (P1a-2)

- **Resolver absent or degraded**: sessions are not offered; the file path is unaffected.
- **Lookup race**: both lookups share one abort signal; a disconnected client aborts both and
  receives no response.
- **Mention injection**: the client only inserts a mention matching the canonical shape and
  returned by the host; arbitrary typed text has no more authority than any prompt text.
- **Editing the readable token**: expansion targets the exact token; an edited token sends
  literal text (no reference) instead of the wrong reference.
- **Preparation failure**: DSH terminates the turn after the message is accepted, exactly as in
  the primary session; the tab surfaces the turn error through its existing status path, and
  the draft was already consumed.
- **Self reference**: the resolver excludes the addressed agent. Before the first message the
  addressed agent is the parent, so the parent session is not offered (its context is already
  inherited by the seed); after `create` it is.
- **Two tabs**: menu and reference-list state live in the per-tab runtime record.

### Delivery slices

1. Host mention/candidate shaping + route + tests.
2. Client candidates/menu/insertion/expansion + tests.
3. History chips + locale/CSS + tests.
4. Docs and manual smoke; a version bump is a separate release commit.

### Rollback

Additive. Reverting the route fields and client rows falls back to files-only completion; no
persistence, schema or prompt change to migrate.

## P1b-1 — image input (shipped in 0.8.0)

DSH 0.2.2 already ships the whole image pipeline: the composer uploads bytes, the
`attachments` store normalizes and persists them, the user message carries durable
`ImageAttachmentRef` blocks, and the provider adapter resolves them into per-route request
images. The side-chat composer is a hand-written `<textarea>` that only sends text, so this
phase adds the composer/upload/serve triad and reuses `ctx.attachments` — it imports no
`@deepseek-ai/*` package and keeps the hand-written bundle.

Runtime basis at implementation: the installed DSH was **0.2.2-rc.3** (the local source
checkout lags at 0.2.1-rc.2; the installed Desktop build is now 0.2.2-rc.5). The host APIs
below are present in the 0.2.2 builds and the attachment service contract was checked through
Inspect; the image flow itself was implemented against 0.2.2-rc.1 and is covered by unit
tests, with no GUI run recorded:
`ctx.attachments.saveImages` / `admitPromptContent` / `readImage` / `isAttachmentError`,
`model.inputModalities`, and `agent.followup` with image content blocks
(`ImageBlock = { type: 'image', attachment: ImageAttachmentRef }`,
`ref = { attachmentId: 'sha256:<hex>', mediaType, width, height, bytes, name?, originalDimensions? }`).

### In scope

1. **Input channels** — paste (clipboard image), drag & drop (image files onto the composer
   card), and a file-picker button (`accept="image/*"`, multiple). Insert order is preserved.
2. **Per-image upload** — each file is uploaded as soon as it is added:
   `POST /side-chat/api/attachment` with the raw bytes as the body and identity/mime/name in
   the query; the host calls `ctx.attachments.saveImages([{ data, mediaType, name }])` and
   returns the durable reference. Deployment limits and accepted media types belong to the
   mounted attachment provider (defaults: PNG/JPEG/WebP/GIF, 50 MiB per source, 20 images and
   200 MiB per message) — the plugin hardcodes none of them.
3. **Composer rail** — 64 px thumbnails above the textarea with a remove control and the
   states `uploading` / `ready` / `error`; a rejected file shows a localized reason and can be
   retried or removed. Uploads never block typing, `@` completion, or `Enter`.
4. **Send** — `prompt` gains an optional `attachments: [ImageAttachmentRef]`. Text may be
   empty when attachments exist. The host re-admits the batch through
   `ctx.attachments.admitPromptContent()` (count and aggregate-byte limits, canonical refs)
   and `agent.followup`s a user message whose content is the text block (when non-empty)
   followed by the image blocks in order. Vision gating mirrors the main session: when the
   route's model reports `inputModalities` without `image`, the prompt is refused before the
   append with reason `MODEL_DOES_NOT_SUPPORT_IMAGES`.
5. **History** — committed `user/message` image blocks render as thumbnails inside the user
   bubble; a click opens the full image; missing or corrupt objects render a failed
   placeholder. `GET /side-chat/api/image` serves the stored bytes
   (`ctx.attachments.readImage(ref)`) with the reference media type and immutable caching.
6. **Queue projection** — image-only queued prompts are not dropped: queue rows gain an
   additive `images` count and the client renders a localized "image" label.

### Out of scope

- Generic (non-image) file attachments, pasted paths/text, camera capture, image editing.
- Deleting stored objects: DSH attachments are never garbage-collected, so a removed
  thumbnail, an uploaded-but-unsent image, or a tab closed before sending leaves an
  orphaned object. It is never referenced by a session log and is harmless.
- Re-opening a closed tab's draft or its composer rail (drafts remain in-memory only).
- Per-profile limits UI, upload progress percentages, and pausing uploads.

### Contract sketch

`CONTRACT.md` stays authoritative; this fixes the semantics for review.

| path | request | response |
|---|---|---|
| `/side-chat/api/attachment` | raw image bytes; query `{ sourceId?, sessionId?, mime, name? }` | `{ ok: true, attachment }` \| `{ ok: false, code, message?, reason? }` |
| `/side-chat/api/image` | `GET` query `{ sessionId, attachmentId, mediaType, width, height, bytes }` | image bytes (`Content-Type: <mediaType>`), 404 on failure |
| `/side-chat/api/prompt` | `{ sessionId, text, attachments? }` | unchanged `{ ok: true }` \| `{ ok: false, code, message?, reason? }` |

- The upload route accepts at most 50 MiB of raw body (provider limit plus one byte so the
  provider can refuse it); the body is not JSON, so this route bypasses `routeHandler` and
  owns its response. Identity: `sessionId` must name an owned side session; before the first
  message the tab sends `sourceId` (a live parent) instead. Neither present → `bad-request`.
- `attachments` entries are validated structurally (id `^sha256:[0-9a-f]{64}$`, media type in
  the provider's accepted set, positive integers, bounded name). The read path re-verifies
  digest, length and dimensions against the stored object, so a forged reference fails
  closed instead of leaking bytes.
- New error code `attachment-rejected` carries `reason` — the provider's stable
  `AttachmentError.code` (`UNSUPPORTED_IMAGE_TYPE`, `IMAGE_TOO_LARGE`, `IMAGE_TOO_MANY_PIXELS`,
  `TOO_MANY_IMAGES`, `IMAGES_TOO_LARGE`, `INVALID_IMAGE`, `IMAGE_TYPE_MISMATCH`, …) or
  `MODEL_DOES_NOT_SUPPORT_IMAGES`. Unknown reasons fall back to the host message text.
- The image route answers with `404` (no JSON envelope) because the consumer is `<img>`; the
  client renders its failed placeholder for any non-200.

### Acceptance

1. Paste an image → a thumbnail appears immediately, settles `ready`, and typing continues
   unaffected; a rejected file shows the reason and no message is sent.
2. Drag an image over the composer → drop target hint; dropping inserts it. Dropping a
   non-image file shows the "unsupported image" reason and stores nothing.
3. The paperclip opens a multi-select image picker; picks appear in selection order.
4. Remove works before send; sending image-only content is allowed; sending empty text with
   no image is still rejected exactly as today.
5. The committed bubble shows the thumbnails; clicking one opens the full image; a
   deliberately deleted object renders the failed placeholder.
6. With a text-only model the send is refused with a localized reason, and the draft and the
   thumbnails are preserved.
7. Two tabs keep independent rails; closing a tab discards its rail.
8. A reattached tab (snapshot) renders earlier images in history, and `@` completion, IME
   composition, and `Enter` semantics are unchanged.
9. Verification levels: L1 unit (host + client) for every rule above; L2 in-process real HTTP
   for upload framing, image serving and prompt refusal; L3 manual after a DSH restart for
   the interactions a unit test cannot see.

### Adversarial notes (P1b-1)

- **Crash between upload and send**: the object is already durable and unreferenced; the
  session log never mentions it. Recovery = user re-adds it; no state drifts.
- **Crash mid-send**: `followup` is one call after admission; the message is either committed
  whole or not at all. A retry re-sends the same refs; content-addressed storage makes that
  idempotent, and the client's single in-flight send guard prevents duplicates.
- **Ref forgery**: validation is structural only; the read path re-verifies digest, bytes and
  dimensions, and the provider projects request images from the stored object.
- **Provider absence**: no `ctx.attachments` (profile without the attachment bundle) → both
  routes answer `unavailable`, the composer hides paste-to-upload affordances only after a
  failed attempt and shows the reason; text-only sending is untouched.
- **Read during unload/close**: `readImage` rejects or the route is gone; thumbnails fall back
  to the failed placeholder; history rows stay rendered with the placeholder.
- **Large batches**: the provider owns the 20-image / 200 MiB rule; the plugin lets it reject
  and maps the reason, so limits never drift between plugin and deployment.
- **Model route changes mid-tab**: the vision check runs per send on the agent's current
  route, not on the route captured at creation.

## P1b (designed, not implemented)

- Model picker for the side session.
- Surfacing the side session's **approval prompts** in the panel (today the side session
  inherits the parent's approval policy; if that policy asks the human, the request has no
  answerer inside the panel).
- Side-session history across a GUI restart (today: in-memory handles only).

## Non-goals

- Merging side-chat content back into the main transcript.
- Making the side session visible in the workspace/session list.
- Mutating git state (branch/commit/push) on the user's behalf.
- Replacing the native conversation UI.
- Click-open statistics dialogs, turn/step counts and tok/s in the v1 side-chat dock;
  matching DSH's Performance & usage detailed/compact preference.

## Adversarial notes

- **Crash mid-creation**: `agents.create` rejects; the client shows the error and keeps the
  panel empty. No half-registered handle is stored before `create` resolves.
- **Double send / double create**: `create` is idempotent per identity (the per-tab
  `instanceKey`, or `source:<sourceId>` when no key is sent) and concurrent creates share
  one in-flight result; the client also guards with a single in-flight send per tab. A
  reissued identity (a retry, or a reload that keeps the tab identity) reattaches to the
  still-running side session instead of creating a second one.
- **Close during a running turn**: `close` disposes only that side session's handle; the
  dispose path cancels its turn. Other side chats keep running, and the client stops
  polling status for that id.
- **Parent unloaded while the panel is open**: `prompt`/`status` return `not-found`; the panel
  shows the error instead of silently queueing.
- **Artifact deletion**: path comes from `sessionPersistence.locate(header)`; deletion runs
  with `node:fs/promises.rm` after a short drain delay, guarded to this plugin's own session
  directory (absolute path, `basename(dir) === session id`). A failed removal is logged and the
  close still disposes and succeeds; the orphan never appears in any list.
- **Token cost**: every side chat inherits the parent history, so its first request is
  roughly as large as the parent's next request; N concurrent side chats multiply that
  first-request cost. Stated in the README.
- **Usage-dock fidelity**: the dock duplicates only a small, deliberate subset of DSH's
  token/context projections. Its cache-hit share is rounded instead of using DSH's
  distinguishing decimal precision, its context reading is the newest provider prompt size
  without the `projectedTokens` surface-delta estimate (so it can trail the main bar by up to
  one step), and a retried step replaces its sample rather than being folded with DSH's exact
  semantics. The fold ignores unknown or malformed events instead of throwing, so a DSH event
  change degrades a reading rather than the panel; fixture-based tests guard the current
  event shapes.
- **Snapshot page truncation**: a tab that reattaches to an existing side session receives at
  most the trailing 2000 entries in its snapshot, so usage events older than that page are
  missing from its dock totals. A tab that is mounted from creation sees every committed
  event and is unaffected. This is accepted for ephemeral side chats and documented rather
  than fixed with a second route.
- **Additive `contextWindow`**: the one host-payload change is optional and additive.
  An older client ignores it; a newer client against an older host (or a session with no
  route context yet) simply omits the context reading. No new route, no polling change.
- **Fixed dock content**: following DSH's `performanceUsage` detailed/compact choice would
  mean reading another package's config (an internal `ctx.configForms` service) for a
  cosmetic decision, so the dock's content is fixed and the mismatch is documented.
- **Streaming state is presentation only**: live frames come from the process-local
  `agent/assistant-stream` feed and are never treated as durable history. A revision gap, a
  host restart, or a reconnect invalidates the live attempt; the client re-baselines from the
  `hello`/`snapshot` payload and the committed `assistant/message` stays authoritative.
- **Stream/committed duplication**: the loop commits the settlement before emitting its
  `end` frame, so the host clears the live attempt on the committed
  `assistant/message`/`assistant/attempt` and emits `live: null` immediately before it
  forwards that committed event's `event` frame. Both frames travel in the same paint, and
  the client also reconciles defensively and may do one snapshot catch-up, so a dropped
  frame cannot leave a stale streaming row or hide the final message.
- **Buffering transports**: the Desktop IPC bridge and some proxies can buffer a whole
  response. The client waits ~2.5 s for the `hello` frame and otherwise aborts the stream and
  falls back to polling; a stream that drops after its baseline reconnects with backoff, and
  two failed connects without a baseline degrade the tab to polling. A tab never runs both
  paths at once.
- **Concurrent stream connections**: each tab opens one stream for its own side session; the
  host fans a side session's frames out to every connection on it and cleans each one up on
  request close, session close, or plugin unload. Live state is kept per side session even
  when no stream is connected, so the snapshot fallback sees it too, and several side chats
  stream independently.

## Rollback

Remove the bundle row (or `dsh plugin remove`), restart DSH. No schema, no persistence
migration, no main-session writes.
