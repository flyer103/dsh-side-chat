# Contract — dsh-side-chat (v0.10.4)

Two halves, two surfaces: a JSON RPC surface plus one server-push event stream. The host
half is a plain ESM Cordis plugin; the client half is a browser ModuleLoader bundle. They
never share imports — only these routes.

## Plugin identity

| item | value |
|---|---|
| package name | `@flyer103/dsh-side-chat` |
| host module | `lib/index.js` (`export const name`, `export const inject`, `export function apply(ctx)`) |
| client bundle | `lib/client.js`, served by the client module loader; loader id = package name |
| bundle patch | `cordis.patch.yml` → `insert: [{ id: dsh-side-chat, name: '@flyer103/dsh-side-chat' }]` |
| CSS prefix | `sc-` |
| boundary source marker | `{ kind: 'plugin:side-chat' }` (V4 producer kind; `kind: 'plugin'` is retired) |
| side session id prefix | `side-chat-` |

## Host → JSON routes (registered on `ctx.webServer`, all `POST`, JSON in / JSON out)

The two byte routes below (image upload and image read) are the only exceptions: they carry
raw bytes instead of JSON.

| path | request | response |
|---|---|---|
| `/side-chat/api/create` | `{ sourceId, instanceKey? }` | `{ ok: true, sessionId, inheritedEventCount }` \| `{ ok: false, code, message }` |
| `/side-chat/api/prompt` | `{ sessionId, text, attachments? }` | `{ ok: true }` \| `{ ok: false, code, message, reason? }` |
| `/side-chat/api/cancel` | `{ sessionId }` | `{ ok: true }` \| `{ ok: false, code }` |
| `/side-chat/api/close` | `{ sessionId }` | `{ ok: true }` \| `{ ok: false, code, message }` |
| `/side-chat/api/status` | `{ sessionId }` | `{ ok: true, status, running, queue: [{ id, text, placement, images? }], lastError }` \| `{ ok: false, code }` |
| `/side-chat/api/snapshot` | `{ sessionId, fromSeq? }` | `{ ok: true, inheritedEventCount, contextWindow?, running, status, lastError, entries, truncated, live }` \| `{ ok: false, code }` |
| `/side-chat/api/list` | `{}` | `{ ok: true, sessions: [{ sessionId, sourceId }] }` |
| `/side-chat/api/references` | `{ sourceId?, sessionId?, query, quoted? }` | `{ ok: true, candidates: [{ path, kind: 'file' \| 'directory' } \| { kind: 'session', sessionId, label, mention, location?: string \| null, createdAt }] }` \| `{ ok: false, code, message? }` |

`snapshot` and the live stream below are the client's message sources. `entries` are
committed session events whose `seq >= max(inheritedEventCount, fromSeq ?? inheritedEventCount)`,
shaped `{ seq, type, time, data, surfaceOp?, sourceEventSeqs? }`; the fork history and the
boundary message live below that floor and are never re-sent. `live` is the in-flight
assistant attempt (see the stream section), included so the polling fallback can also render
in-progress tokens; it is `null` when no attempt is streaming. Both routes **only** serve
sessions this plugin created (`not-found` otherwise), so they cannot read other sessions.
A parent session may own several side sessions (one per `instanceKey`), so `list` can return
multiple entries with the same `sourceId`; each side session is still addressed by its own
`sessionId`.

`references` is the composer's `@` lookup: one of `sessionId` / `sourceId` must resolve,
and `sessionId` wins. A `sessionId` must name a side session this plugin created
(`not-found` otherwise); `sourceId` must name a live parent agent (`unknown-source`
otherwise) and covers the window before the first message creates the side session. The
addressed agent's working directory bounds discovery, `query` is the text after `@` passed
through unchanged (string, at most 512 characters, `bad-request` otherwise), and `quoted`
(default false) marks an open quoted path, for which session discovery is skipped.

Two optional providers feed the list: `ctx.fileReferences` for file/directory rows and
`ctx.sessionReferenceResolver` for session rows. Both are optional and independent: a domain
that is not mounted, or whose lookup throws, contributes no rows (the failure is logged);
`unavailable` is answered only when neither provider is mounted, or when every attempted
lookup failed, and the client then hides the menu for that tab. File rows come first, then
session rows in resolver rank order.

A session row carries the resolver's display title (`label`, falling back to the resolver's
`label`), the host-generated canonical prompt mention, a home-abbreviated `location` (omitted
when the session shares the addressed agent's workspace, `null` when it records no cwd) and
the session creation time in epoch milliseconds. `mention` is
`@[label](dsh-session:<base64url(JSON.stringify(sessionId))>)`, with `\` and `]` escaped in
the label, control characters collapsed to spaces, and the session id as the label when no
title survives. This is the spelling DSH's own session reference service parses. The route reads no
file content and no session log: it lists names, workspaces and ages only. It keeps no cache
and no durable state; a client disconnect aborts both lookups (which is why it reads its own
request body rather than going through the shared JSON handler) and gets no response.

`contextWindow` is an optional, additive field on `snapshot` and on the stream's `hello`
frame: the side session's current route capacity as a positive number, omitted when no
route context is known yet. A seeded side session normally inherits the parent's
`request/context` and appends no `request/context` event of its own, so `entries` alone often
carry no denominator; the field hands it over without a new route. An older client ignores
it, and a client that does not receive it simply omits the context reading instead of
guessing. A later own `request/context` entry (for example after a model switch) takes
precedence over the baseline.

`prompt` accepts an optional `attachments` array of durable image reference ids
(`'sha256:<64 hex>'`) created by the upload route below, in message order. `text` may be
empty exactly when `attachments` is non-empty; `empty-prompt` still covers the no-text,
no-image case. The host resolves each id through its own upload staging record — the record
keeps the reference the provider returned, so the wire cannot substitute a different
reference — re-admits the batch through `ctx.attachments.admitPromptContent()` (which applies
the provider's count and aggregate-byte limits), and appends one user message whose content
is the text block (when non-empty) followed by the image blocks. An id the staging record no
longer knows (for example after a host restart) is refused with `reason:
'ATTACHMENT_NOT_FOUND'` rather than sent. Deployment image limits (count per message,
per-image and aggregate bytes, pixels, media types) belong to the mounted attachment provider
and are never restated or hardcoded here. A route whose model reports `inputModalities`
without `image` is refused before the append with `reason:
'MODEL_DOES_NOT_SUPPORT_IMAGES'`.

Error codes: `unknown-source`, `not-found`, `empty-prompt`, `create-failed`,
`prompt-failed`, `dispose-failed`, `bad-request`, `unavailable`, `internal`,
`attachment-rejected`. `attachment-rejected` carries `reason`: the attachment provider's
stable code (`UNSUPPORTED_IMAGE_TYPE`, `IMAGE_TOO_LARGE`, `IMAGE_TOO_MANY_PIXELS`,
`IMAGE_DIMENSION_TOO_LARGE`, `IMAGE_TYPE_MISMATCH`, `INVALID_IMAGE`, `TOO_MANY_IMAGES`,
`IMAGES_TOO_LARGE`, `ATTACHMENT_NOT_FOUND`, `ATTACHMENT_CORRUPT`, `ATTACHMENT_WRITE_FAILED`,
…) or `MODEL_DOES_NOT_SUPPORT_IMAGES`; unrecognized reasons fall back to `message`.

### Image upload and serving

Two routes carry image bytes and therefore bypass the JSON handler:

| path | request | response |
|---|---|---|
| `POST /side-chat/api/attachment` | raw image bytes as the body; query `sourceId?`, `sessionId?`, `mime`, `name?` | `{ ok: true, attachment: { attachmentId, mediaType, width, height, bytes, name? } }` \| `{ ok: false, code, message?, reason? }` |
| `GET /side-chat/api/image` | query `sessionId`, `attachmentId`, `mediaType`, `width`, `height`, `bytes` | the stored image bytes with `Content-Type: <mediaType>`; `404` with no JSON envelope on any failure |

- **Identity.** `sessionId` must name a side session this plugin created and wins when both
  are sent; `sourceId` must name a live parent agent and covers the window before the first
  message creates the side session. Neither present or unresolvable → `bad-request` /
  `not-found` / `unknown-source`. Same-origin only, like every other route: there are no auth
  headers.
- **Upload.** `mime` must be one of `ctx.attachments.imageLimits.mediaTypes`
  (`UNSUPPORTED_IMAGE_TYPE` otherwise); the raw body is capped at the provider's
  `maxImageBytes`, and a larger body is refused as `IMAGE_TOO_LARGE` without being stored.
  The bytes are committed through
  `ctx.attachments.saveImages([{ data, mediaType, name }])`, and the route records the
  returned reference as the staging entry whose `bytes` are the stored object's byte length.
  `ctx.attachments` absent → `unavailable`; every provider failure maps to
  `attachment-rejected` with its `reason`.
- **Serving.** The image route serves only an attachment that a user message of the addressed
  side session actually references; the host reads it through
  `ctx.attachments.readImage(ref)`, which re-verifies digest, length, format and dimensions.
  Bytes are served with the reference media type and a long, immutable cache header, so a
  thumbnail and its full-size click share one cached response.
- **Sessions and lifetime.** Attachments are never deleted by DSH. An upload that is removed
  from the composer, never sent, or lost with a closed tab leaves an unreferenced stored
  object; that is harmless and documented, not an error.

`create` is idempotent per identity: the opaque `instanceKey` when a non-empty one is sent,
otherwise the legacy identity `source:<sourceId>`. A repeated call for the same identity
returns `{ ok: true, sessionId, inheritedEventCount }` for the existing side session, and
concurrent calls are deduplicated onto one create. Different instance keys under one
`sourceId` are independent side sessions; an absent or empty key keeps the old
one-side-session-per-parent behavior. Because the client keeps a stable per-tab identity,
a retried `create` — or a reload that reissues the same tab identity — reattaches to the
still-running host-side session instead of creating another. `close` removes the handle
before disposing so a racing call gets `not-found`, never a double free.

## Host → live stream (`POST /side-chat/api/events`)

Request `{ sessionId, fromSeq? }`. On success the answer is not JSON: HTTP 200 with
`Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`,
`Connection: keep-alive`, and `X-Accel-Buffering: no`. The body is SSE
(`event: <name>\ndata: <json>\n\n`):

| frame | data | meaning |
|---|---|---|
| `hello` | `{ ok: true, inheritedEventCount, contextWindow?, status, running, lastError, entries, truncated, live }` | opening baseline; same floor and `entries` rule as `snapshot` |
| `event` | `{ entry }` | one newly committed session event above the baseline, in `seq` order |
| `live` | `{ live }` | authoritative replacement of the in-flight assistant attempt |
| `status` | `{ status, running }` | agent lifecycle change |
| `error` | `{ message }` | last contained agent failure |

`live` is `null` or `{ revision, activeAttempt }`. `activeAttempt` is `null` or
`{ attemptId, turn, step, nextIndex, blocks }`: `revision` is the dense assistant-stream
revision, `nextIndex` the number of chunks folded into the attempt, and `blocks` the ordered
renderable prefix of the current attempt —
`{ kind: 'text', text }`, `{ kind: 'reasoning', text }`, or
`{ kind: 'tool-call', callId, name, argsRaw }` (`argsRaw` is the accumulated argument text).
It is presentation data only; the durable settlement is still the committed
`assistant/message` / `assistant/attempt` event. A revision gap invalidates the attempt (the
client re-baselines on reconnect or from `snapshot`). The host clears the attempt as soon as
the matching settlement commits: it emits `live: null` and then forwards that committed
event's `event` frame, in that order; an `end` frame with an `abandoned` outcome clears it
too. A `: ping` comment is sent about every 15 s.

If the stream cannot open, the host answers a normal JSON 200 `{ ok: false, code, message }`
instead — `not-found` for a session it does not own, `internal` for an unparsable body — so
the client can fall back to polling. The client aborts the request when the tab becomes
hidden or closes and reconnects later from `fromSeq`; a reconnect `hello` carries the
in-flight `live` baseline, so text streamed while the tab was hidden is recovered.

## Client ↔ host call

JSON routes: `POST <path>` with `Content-Type: application/json`, body `JSON.stringify(args)`.
Non-2xx or `ok !== true` is an error. The live stream keeps the same POST + JSON request but
reads the response body incrementally (`fetch` + `ReadableStream` + `TextDecoder`) and parses
SSE frames; an `AbortController` stops it. Each side-chat tab owns the stream for its own
side session, so several tabs of the same parent session hold independent connections. No
auth headers: same-origin only. When the body is not readable, or no `hello` arrives within
~2.5 s (a buffering transport), the client degrades that tab to `snapshot` polling and does
not mix the two paths.

The `references` lookup is an ordinary JSON POST with one extra rule: the tab debounces it
(120 ms) and aborts the previous request when a newer token supersedes it, so at most one
lookup per tab is in flight. The host observes the disconnect and cancels the provider scan;
an aborted answer is never rendered. `sessionId` is sent only once the tab's side session
exists; before that the request carries `sourceId`.

Two routes carry raw bytes instead of JSON: the image upload posts the file itself as the
body (`Content-Type` from the file, query carries the identity, `mime` and `name`) and
answers JSON, while the image read is a plain `GET` consumed by `<img>` (`Content-Type` is the
stored media type, a long immutable cache header, `404` without a JSON body on failure). No
auth headers on either; same-origin only, like every other route.

## Client integration (right Sidebar tab, no standalone button)

The side chat is a native tab type of the right Sidebar, opened from that column's guide
page — the same public path every shipped tab uses (`ctx.sidebarRightTabs.register` +
`ctx.slots.register`). There is no session-header button and no floating overlay. The tab
type is registered with `multiple: true`, so one parent session can hold several side-chat
tab instances in the same pane; each instance owns its own side session. The guide entry
and the tab's status-bar new-side-chat button each open a fresh instance.

| registration | value | purpose |
|---|---|---|
| `ctx.sidebarRightTabs.register` | `{ id: pkg, kind: 'side-chat', multiple: true, priority: 'extension', title, guide: [{ id: 'side-chat', order: 10, title, description }], keepMounted: true }` | tab type + guide entry |
| `ctx.slots.register` | `{ name: 'sidebar.right.pane.tab', key: pkg }` | tab body (message flow + composer) |
| `ctx.slots.register` | `{ name: 'sidebar.right.pane.tab.title', key: pkg }` | tab chip title (plain, or numbered for later instances) |
| `ctx.sidebarRight.registerCloseHandler` | `('side-chat', (sessionId, tab) => close)` | closing the tab destroys only that tab's side session |

- One side session per tab instance, not per parent session. The client derives an opaque
  per-tab identity `${sourceId}#${tabId}` from the parent session id and the tab instance
  id, keys its per-tab runtime record by that identity, and sends it as `instanceKey` on
  `create`; a parent session can therefore drive several side chats concurrently. Chips are
  numbered per parent session: the first instance uses the plain localized title, later
  instances the indexed key `tab.titleIndexed` (`Side chat {index}` / `侧边会话 {index}`).
- The guide card opens a new side chat on every activation rather than focusing an existing
  tab, and every tab's status bar carries a new-side-chat button (locale key `tab.new`) that
  opens another side-chat tab in the same pane.
- `keepMounted` keeps each tab's own scroll position and draft across tab switches.
- Live updates are gated by each tab's own `visible` flag from `useTabInfo()`: collapsing
  the column, switching tabs, or hiding the browser tab aborts that tab's event stream (or
  pauses polling in fallback mode) and keeps the side session; closing the tab destroys only
  that side session and leaves the other side chats and the parent session untouched.
- Body props: `sessionId` (parent session) plus the framework-injected `useTabInfo()`; the
  tab instance id from `useTabInfo()` is what makes the identity per-tab.

## Rendering contract (client)

- The panel has two update paths and never runs both at once: the live `events` stream when
  it is available, else `/side-chat/api/snapshot` polling (`running` → ~400 ms, idle →
  ~1500 ms). Both are stopped while the panel is closed or the page is hidden. `fromSeq`
  starts at the fork floor (`inheritedEventCount`) and advances to `max(seen seq) + 1`.
- Tab chip title and new side chat: the title slot renders the plain localized title for the
  first side chat of a parent session and the indexed key `tab.titleIndexed`
  (`Side chat {index}` / `侧边会话 {index}`) for later ones, numbered per parent session.
  The tab status bar carries a new-side-chat button (locale key `tab.new`) that opens
  another side-chat tab in the same pane. Neither depends on a side session existing:
  opening a tab does no host work.
- Fold `entries` into rows with pure functions: `user/message` (`data.source` / `data.content`,
  including `{ type: 'image', attachment }` blocks → the row's `images` list),
  `assistant/message` (`data.message.content` blocks: `text`, `reasoning`, `tool-call`),
  `tool/call`, `tool/result` (`data.message.source.callId`, `content`, `isError`), plus small
  tags for `context` / `steering`. Unknown event types are ignored, never thrown on. A
  user message with no text still renders when it carries at least one image.
- Hide rows below the fork floor (`seq < inheritedEventCount`) and the injected boundary
  message (`source.kind === 'plugin:side-chat'`, or text starting with
  `Side conversation boundary.`).
- The in-flight attempt (`live.activeAttempt`) renders after the committed rows as a normal
  assistant row: reasoning and tool folds, tool arguments, and Markdown rendered with the
  shell renderer's `streaming` flag. It is hidden when there is no active attempt or when
  every assembled block is empty. When the attempt settles, the committed
  `assistant/message` replaces it; the client reconciles on the `live: null` frame (and
  defensively on a matching settlement `event`), issuing one snapshot catch-up so a
  settlement is never lost. The thinking indicator shows only while a turn runs with no
  visible live blocks.
- Committed assistant rows expose a **Quote into main chat** action (locale key
  `return.action`, switching to `return.done` after a press) when the tab body's standard
  `inputActions` seat is present. The press calls `inputActions.insertQuote` with the row's
  text blocks joined by blank lines, so the text becomes a Markdown blockquote in the main
  session's composer draft; it never sends, never touches the side session and never needs a
  host route. The action is omitted for live streaming rows, for blank replies, and when
  `inputActions`/`insertQuote` is unavailable (the body stays usable in a plain slot host).
- Composer: own textarea; `Enter` sends, `Shift+Enter` newline; send button becomes Stop
  while running; optimistic pending rows disappear when the same text echoes back from
  `entries`. Enter never submits while an input-method composition is in progress. The
  script owns the textarea's height: on every draft change, and whenever the panel's width or
  height changes (`ResizeObserver`), it resets `height: auto`, reads `scrollHeight`, and
  writes the result inline — capped at the primary composer's 14-line cap (336px) and at half
  the panel's height, so the box scrolls inside itself only past that cap. While the box
  grows, a transcript that was pinned to the bottom stays pinned; a scrolled-up reader is not
  moved. The stylesheet ships no competing height cap and no `field-sizing`; before the first
  measurement it gives the box its one-line height with `overflow-y: auto`, so a restored
  long draft still scrolls instead of being clipped.
- Composer images: paste, drop and the picker add thumbnails to a rail above the textarea;
  each uploads immediately and carries `uploading` / `ready` / `error`; the send button is
  enabled with a ready image even when the text is empty. A pending row carries the same
  thumbnails (local object URLs); it reconciles against the committed message by text **and**
  attachment-id list, not text alone.
- Assistant bodies render through the shell's `MarkdownText` (GFM: tables, task lists, code
  fences, footnotes, KaTeX; raw HTML stays literal text). Math delimiters come from the
  shell grammar (`$…$`, `$$…$$`, `\(…\)`, a line-start `\[…\]`); the bundle additionally
  wraps a **column-0 bare display environment** — `\begin{align}…\end{align}` and the other
  KaTeX display environments in `TEX_DISPLAY_ENVIRONMENTS` — as `$$\n…\n$$` before a settled
  message reaches the renderer, because that spelling is valid LaTeX but never enters math
  on its own. The wrap only happens when the matching `\end{…}` closes its own line, and is
  skipped for streaming text, code fences, existing math, indented environments, unknown
  environments and an unclosed environment; declared limits are a `\[…\]` that does not
  start a line and a bare environment inside a list item or blockquote, which stay literal.
  The seed module exports `MarkdownText` as a `React.memo` component, so detection accepts a
  component object (`$$typeof`), not only a function; the renderer receives `streaming` and
  a reference-stable `labels` object built
  from the active locale seat (`markdown.copy`, `markdown.copied`,
  `markdown.codeBlock.title`, `markdown.codeBlock.wrap`, `markdown.codeBlock.unwrap`,
  `markdown.footnotes`). A lightweight built-in renderer is the fallback only when the
  module or its `MarkdownText` export is missing; it ignores `streaming`, treats `\|` as a
  literal pipe inside a table cell, and pads/truncates every row to the header's column
  count.
- Copy controls. Code cards keep the shell's own copy/wrap toolbar. Tables have no shell
  control, so the bundle decorates the committed Markdown DOM instead of re-rendering it:
  each rendered `table` gets one `button.sc-copy-chip` appended to its scroll container
  (which gains `sc-copy-host`), and each fallback `pre.sc-md-code` fence gets the same chip
  inside itself. Decoration is idempotent — an existing chip is found by class, so a stream
  mutation only re-syncs the localized label — and a `MutationObserver` scoped to that
  assistant row's `.sc-md-block` re-decorates as chunks arrive. Chips are hidden until the
  host is hovered or focused and stay visible on coarse pointers; the chip label comes from
  `markdown.tableCopy` / `markdown.tableCopied` (fences reuse `markdown.copy` /
  `markdown.copied`). A click reads the rendered grid at click time into one
  `ClipboardItem` with two flavours: `text/plain` is TSV (row `\n`, cell `\t`, whitespace
  collapsed per cell) for spreadsheets, and `text/html` is the same grid as a `<table>`
  whose leading all-`th` row becomes `<thead>` and whose cell text is escaped (`&`, `<`,
  `>`, `"`) with whitespace collapsed. The HTML flavour is what makes a rich-text target
  (Feishu docs, Word, browser editors) paste a real table; those targets read only
  `text/plain` when it is absent and paste one run of tab-separated text instead. The
  write goes through `navigator.clipboard.write` and falls back to `writeText` with the
  TSV payload when `ClipboardItem` is missing or the item is rejected, then to a temporary
  textarea plus `execCommand('copy')`; code fences write their text only. A successful
  write shows the copied label for `COPY_FEEDBACK_MS` (1200 ms), a rejected write shows
  nothing. Known limits: the chip is a node React does not own (appended last, positioned
  absolutely so DOM order never matters), a wide table that scrolls horizontally carries
  the chip with its content, and both flavours carry rendered text, so emphasis,
  inline-code and link markup are not preserved, and a pasted table keeps no cell styling
  beyond header cells.

### Reference completion (`@`)

- The bundle cannot import `@deepseek-ai/dsh-file-reference`; it replicates the browser-safe
  `activeAtToken` / `formatFileMention` grammar locally, with the same prompt spellings:
  `@path`, `@"path with spaces"`, `@dir/`, and `@"dir/` (open quote) while descending.
- Typing `@` at input start or after whitespace opens a menu at the top of the composer card
  (above the textarea), filled from
  `POST /side-chat/api/references` (120 ms debounce, one in-flight request per tab, previous
  request aborted, stale answers dropped). The request carries `quoted: true` for an open
  quoted path so the host skips session discovery. No query is sent while composing, and no
  menu opens when the route reported `unavailable` (cached for that tab).
- The menu is a listbox inside the composer card (no portal): `role="listbox"` with rows
  `role="option"`, the textarea is a `combobox` with `aria-expanded`, `aria-controls` and
  `aria-activedescendant`; Up/Down wrap, Enter/Tab pick the highlighted row, Escape closes,
  blurring the composer closes, mousedown picks without stealing focus. A pick replaces
  `[token start, caret]` and moves the caret after the mention; a directory pick keeps
  completion open on the new query. With nothing to pick, Enter closes the menu and submits.
- Rows are grouped by domain with non-option headers (`reference.files` before file/directory
  rows, `reference.sessions` before session rows, whichever groups are present): a file row
  shows a kind glyph, its basename and its parent directory when it has one; a session row
  shows the title and a `location · age` description (the primary's relative-time buckets,
  `reference.noCwd` when the candidate records no cwd).
- A file pick inserts the primary's prompt spelling and remains plain prompt text. A session
  pick inserts the readable `@[title]` token (escaped `\` / `]`) and records
  `{ token, mention }` in the per-tab reference list; `send` expands each recorded token to
  the host-returned canonical `@[title](dsh-session:…)` mention (first exact occurrence;
  duplicates consume successive occurrences) and sends that. A token edited or deleted before
  sending is skipped, so no reference is invented. The pending row shows the expanded text.
- Committed user bubbles split their text with the primary reference rule (quoted paths
  preserved, trailing sentence punctuation trimmed, canonical session mentions with escaped
  labels), render file/folder/session references as inert `sc-ref-chip` text nodes (no click,
  no HTML injection), and keep the trailing slash on directory labels. A malformed session
  mention is treated as text, never as a chip or an inserted reference.

### Image input (composer rail)

- Three channels feed one per-tab rail: `paste` (clipboard items with `kind === 'file'` whose
  type is `image/png`, `image/jpeg`, `image/webp` or `image/gif`), `drop`/`dragover` on the
  composer card (files only), and a hidden `<input type="file" accept="image/*" multiple>` run
  by a paperclip button in the actions row. A drop that carries any file is accepted so the
  page never navigates to it, but only image files reach the rail; other files are ignored and
  nothing is uploaded for them.
- Each accepted file is uploaded immediately with
  `fetch('/side-chat/api/attachment?…', { method: 'POST', body: file })`; the rail shows the
  local object URL at once, then `uploading → ready` (or `error` with the mapped reason).
  Removing a thumbnail revokes its object URL; a failed file can be retried (re-uploaded) or
  removed. Uploads never block typing, the `@` menu, IME composition, or `Enter`.
- The rail is per tab and per panel runtime record: another tab never sees these files, and
  closing the tab discards them (the stored objects may remain unreferenced; see the upload
  route).
- Sending posts `attachments` as reference ids only. The draft and the rail survive a send
  failure. `pending` rows render the same thumbnails and reconcile against the committed
  message by text **and** attachment-id list.
- Thumbnails in committed user bubbles are `<img>` elements pointing at
  `GET /side-chat/api/image?…` with the reference fields as query parameters (no fetch, no
  base64 in the client state); a non-200 response swaps in a failed placeholder. Clicking a
  thumbnail opens the full image in a new tab. Object URLs are revoked when the tab closes.
- Queue rows from `status` gain an additive `images` count; an image-only queued prompt is
  projected with `text: ''` and `images > 0` instead of being dropped from the wire. The
  panel's own queue surface stays the pending-row count; it does not render those rows today.

### Usage dock (bottom row)

Under the composer, inside the same footer element, the panel renders one slim metrics row
(`.sc-dock`) in this order: total tokens, cache-hit percentage, and a context-occupancy ring
plus percentage. It is always enabled — there is no config option — and it is hidden until
the side session has a usage sample with non-zero tokens; the context reading appears only
once a `contextWindow` is known, and the cache-hit reading is omitted when no prompt input
was billed. Readings are sticky for that side session and reset when a new one is created.

Readings are folded client-side from the committed `entries` the tab already receives (and
from `event` frames), under the same fork-floor rule as the transcript:

- **total tokens** — sum over accepted samples of `uncachedInputTokens + cacheReadTokens +
  cacheWriteTokens + outputTokens`;
- **cache-hit percentage** — `cacheReadTokens / (uncachedInputTokens + cacheReadTokens +
  cacheWriteTokens)`, rounded to an integer; a partial hit never reads `100` (it falls back
  to one decimal near the top), and only an exact full hit reads `100`;
- **context occupancy** — `min(100, round(pressure / contextWindow * 100))`, where
  `pressure` is the newest sample's `uncachedInputTokens + cacheReadTokens +
  cacheWriteTokens`.

A usage sample comes from `assistant/message.data.usage`, `assistant/attempt.data.usage`,
or — as a fallback — the settlement's stream `usage` chunk. A sample for the same `turn` +
`step` replaces the earlier one instead of adding to it, and `llm/retry-started` closes the
replaceable slot for that turn + step. Malformed or unknown events are ignored, never thrown
on. The context-window denominator is the newest `request/context` above the fork floor when
the side session appends one; otherwise the host baseline (`contextWindow` on `snapshot` /
`hello`) supplies it.

The token and cache totals count only the side session's own requests: they sum its provider
usage and skip events below the fork floor, so they include the inherited context the side
chat's first request re-sends (its usage sample belongs to the side session) but never the
parent's earlier requests, which were billed before the fork. Context occupancy is
deliberately **absolute and approximate** for the same reason: the side session's prompt
really carries the inherited context, and the reading is the newest provider-reported prompt
size without DSH's projected-token surface-delta correction, so it can trail the main
composer's meter by up to one step. These numbers ride the existing payloads — no new route
and no polling change.

All detail lives in native tooltips: the token reading's `title` carries the exact bucket
counts (`dock.usageTitle`: uncached input, cache read and output, plus a cache-write segment
via `dock.usageTitleWithWrite` only when the provider reported non-zero cache-write tokens;
cache-write tokens always count toward the totals and the cache-hit denominator) and the
context reading's `title` carries the approximate `~used / window` pair (`dock.contextTitle`);
the context element also carries an `aria-label` with the rounded percentage
(`dock.contextAria`). Compact counts use the `dock.thousand` / `dock.million` templates and
exact titles use `dock.groupSeparator`. There are no click-open dialogs and no turns, steps
or tok/s in this version. Classes keep the `sc-` prefix, the ring is an inline SVG, and the
dock uses no portal or fixed positioning. Its content is fixed: it does not follow DSH's
Performance & usage detailed/compact preference.

## Localization contract (client)

- The panel follows the DSH locale service (`ctx.locale`); the plugin never keeps its own
  language preference.
- Namespace: `side-chat`; two dictionaries registered with the untyped single-locale form —
  `ctx.locale.register(NS, 'zh', ZH)` and `ctx.locale.register(NS, 'en', EN)`. Built-in locale
  ids are exactly `zh` and `en`; other languages resolve through the DSH fallback chain to
  `en`, so the plugin implements no fallback of its own.
- The `zh` and `en` dictionaries must expose the identical key set with non-empty values.
- Localized surfaces: tab type title, guide entry title/description (thunks, re-read on every
  projection), tab chip title (plain, or `tab.titleIndexed` for later side chats of the same
  parent), the status-bar new-side-chat button (`tab.new`), status bar, empty state, composer
  placeholder, send/stop labels, thinking indicator, reasoning/tool fold titles,
  pending-message state, context and steering tags, the usage dock, and error text keyed by
  host error code. The `@` menu adds `reference.menu` (listbox aria), `reference.loading` and
  `reference.empty` (status rows), the group headers `reference.files` / `reference.sessions`,
  the session-row description keys `reference.noCwd` and `reference.timeNow` /
  `reference.timeMinutes` / `reference.timeHours` / `reference.timeDays` /
  `reference.timeMonths` / `reference.timeYears` (the primary's relative-time buckets). The
  image rail adds `image.add` (picker button), `image.dropHint`, `image.uploading`,
  `image.failed`, `image.remove`, `image.retry`, `image.queueLabel` (image-only queued or
  pending row), and one key per known `attachment-rejected` reason
  (`image.reason.<CODE>`), with `image.reason.unknown` as the fallback that shows the host
  message.
- Dock keys, in the same namespace: `dock.tokens` (compact total), `dock.cacheHit`
  (percentage), `dock.contextAria` (accessible percentage), `dock.contextTitle` (approximate
  `~used / window`), `dock.usageTitle` (exact bucket counts), `dock.usageTitleWithWrite`
  (exact bucket counts including cache-write tokens, used when the provider reported them),
  and the token-formatting keys `dock.thousand`, `dock.million` and `dock.groupSeparator`.
  The dock content is fixed; it does not follow DSH's own statistics preference.
- Not localized (deliberately): host error `message` detail, route paths, tool names, event
  types, package and slot ids. Host messages are rendered as a monospace technical detail on
  a second line under the localized error sentence.

## Boundary prompt (host, exact first line)

The injected user message must start with `Side conversation boundary.`; the panel also
accepts the `plugin: side-chat` source as the hiding marker. Unlike Codex `/side` and
`dsh-side-session`, the prompt **allows real mutations** in the same workspace.
