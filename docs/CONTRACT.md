# Contract — dsh-side-chat (v0.7.1)

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

| path | request | response |
|---|---|---|
| `/side-chat/api/create` | `{ sourceId, instanceKey? }` | `{ ok: true, sessionId, inheritedEventCount }` \| `{ ok: false, code, message }` |
| `/side-chat/api/prompt` | `{ sessionId, text, images?: [{ mediaType, data }] }` | `{ ok: true }` \| `{ ok: false, code, message }` |
| `/side-chat/api/attachment` | `{ sessionId, attachmentId }` | `{ ok: true, mediaType, bytes, data }` \| `{ ok: false, code, message }` |
| `/side-chat/api/cancel` | `{ sessionId }` | `{ ok: true }` \| `{ ok: false, code }` |
| `/side-chat/api/close` | `{ sessionId }` | `{ ok: true }` \| `{ ok: false, code, message }` |
| `/side-chat/api/status` | `{ sessionId }` | `{ ok: true, status, running, queue: [{ id, text, placement }], lastError }` \| `{ ok: false, code }` |
| `/side-chat/api/snapshot` | `{ sessionId, fromSeq? }` | `{ ok: true, inheritedEventCount, contextWindow?, running, status, lastError, entries, truncated, live }` \| `{ ok: false, code }` |
| `/side-chat/api/list` | `{}` | `{ ok: true, sessions: [{ sessionId, sourceId }] }` |
| `/side-chat/api/references` | `{ sourceId?, sessionId?, query }` | `{ ok: true, candidates: [{ path, kind: 'file' \| 'directory' }] }` \| `{ ok: false, code, message? }` |

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

`references` is the composer's `@file` lookup: one of `sessionId` / `sourceId` must resolve,
and `sessionId` wins. A `sessionId` must name a side session this plugin created
(`not-found` otherwise); `sourceId` must name a live parent agent (`unknown-source`
otherwise) and covers the window before the first message creates the side session. The
addressed agent's working directory bounds discovery, `query` is the text after `@` passed
through unchanged (string, at most 512 characters, `bad-request` otherwise), and only path
candidates are returned — no file content, no reading or attaching. The provider
(`ctx.fileReferences`) is optional: absent or failing answers `unavailable`, and the client
then hides the menu for that tab. The route keeps no cache and no durable state; a client
disconnect aborts the provider lookup (which is why it reads its own request body rather
than going through the shared JSON handler) and gets no response.

`contextWindow` is an optional, additive field on `snapshot` and on the stream's `hello`
frame: the side session's current route capacity as a positive number, omitted when no
route context is known yet. A seeded side session normally inherits the parent's
`request/context` and appends no `request/context` event of its own, so `entries` alone often
carry no denominator; the field hands it over without a new route. An older client ignores
it, and a client that does not receive it simply omits the context reading instead of
guessing. A later own `request/context` entry (for example after a model switch) takes
precedence over the baseline.

Error codes: `unknown-source`, `not-found`, `empty-prompt`, `create-failed`,
`prompt-failed`, `dispose-failed`, `bad-request`, `unavailable`, `internal`,
`attachments-unavailable`, `image-rejected`.

### Pasted images (`prompt.images`)

`prompt` accepts an optional `images` array next to `text`. Each member is
`{ mediaType, data }`: `data` is canonical base64 **without** a `data:` prefix and
`mediaType` is one of `image/png`, `image/jpeg`, `image/webp`, `image/gif` (DSH's
`ImageMediaType` vocabulary — the only formats the attachment store admits). The
field is additive: a prompt without images keeps the old `{ sessionId, text }` body
and the old one-text-part followup.

- **Limits.** At most 8 images per message, 8 MiB per image and 16 MiB per message
  (decoded bytes, not base64 length). These are the plugin's own policy, deliberately
  below DSH's deployment limits (20 images, 50 MiB each) because one side-chat message
  is billed with the whole inherited context on top. The whole `images` field is
  validated — array shape, member shape, media type, canonical base64, per-image and
  total bytes — before anything is admitted; any violation answers `bad-request` with a
  message and queues nothing.
- **Body cap.** Only this route raises the request-body cap (24 MiB) so a legal image
  batch fits; every other JSON route keeps 1 MiB. Both caps are hard bounds.
- **Admission.** Accepted uploads go through the optional `attachments` service:
  `ctx.get('attachments')?.admitPromptContent([{ type: 'text', text }, { type: 'image',
  data, mediaType }, …])`. The text part is always first and the images follow in
  upload order. The returned admitted parts (durable `attachment` references, never the
  bytes) become the followup `content`. A missing service answers
  `attachments-unavailable`; a service refusal or a malformed answer answers
  `image-rejected` (the service message rides along as `message`). Neither case throws
  and neither queues a message. `attachments` is **not** part of `inject`, so a profile
  without the service still loads the plugin and only refuses image prompts.
- **Text stays required.** A prompt whose `text` is blank answers `empty-prompt` even
  when images are attached, so the admitted parts always start with a non-empty text
  block.
- **Projection.** After admission the committed `user/message` carries `text` plus one
  `image` block per upload (`{ type: 'image', attachment: { attachmentId, mediaType,
  bytes, width, height } }`). The client folds these into a per-row `images` **count**
  and renders one localized chip per block; attachment bytes are never sent to the
  client and no thumbnail is served (see USAGE limitations).

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
- Fold `entries` into rows with pure functions: `user/message` (`data.source` / `data.content`),
  `assistant/message` (`data.message.content` blocks: `text`, `reasoning`, `tool-call`),
  `tool/call`, `tool/result` (`data.message.source.callId`, `content`, `isError`), plus small
  tags for `context` / `steering`. Unknown event types are ignored, never thrown on.
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
- Composer: own textarea; `Enter` sends, `Shift+Enter` newline; send button becomes Stop
  while running; optimistic pending rows disappear when the same text echoes back from
  `entries`. Enter never submits while an input-method composition is in progress.
- Pasted images: `paste` on the composer collects `clipboardData.files` (falling back to
  `items` with `kind: 'file'`) members whose type starts with `image/`, converts each
  through `Blob.arrayBuffer()` (or `FileReader` without it) into canonical base64
  without the `data:` prefix, and stores `{ id, mediaType, data, bytes }` in the tab's
  own runtime record. A text-only paste is never prevented, so ordinary clipboard text
  keeps its native behavior; a paste with at least one image is consumed
  (`preventDefault`) and its images are added. Unsupported types, unreadable blobs,
  oversize images and the count/byte caps skip that one file and set a localized error
  (`image-unsupported`, `image-unreadable`, `image-too-large`, `image-too-many`) instead
  of dropping the accepted images. Pending images render as cards in a
  `.sc-image-strip` at the top of the composer card, above the textarea and below the
  `@` menu, each holding an `img.sc-image-thumb` preview and a remove button that calls
  the runtime. The preview is a client-side 96px canvas downscale kept as a JPEG data URL
  (`thumbnail` on the pending record); without one the strip renders the original
  `data:` URL, and neither form reaches the host or the transcript. When no image is
  pending the strip does not exist; when no image is pending
  the strip does not exist, so the composer keeps its `[menu, textarea, actions]`
  shape. Sending posts `images: [{ mediaType, data }]` with the prompt, clears the
  pending set optimistically and restores it on failure together with the draft —
  under the same rule as the draft, so a message the user retyped meanwhile does not
  inherit stale images.
- Committed user bubbles render each image block as `img.sc-bubble-image` once the tab
  has fetched its bytes from `/side-chat/api/attachment`, and as an inert localized
  `sc-image-chip` until then (inside `.sc-bubble-images`), after the reference-chipped
  text; the row carries `{ attachmentId, mediaType, width, height }` references, never
  bytes, and the fetched blob URL is cached per tab and revoked when the tab goes away —
  out of scope.
- Assistant bodies render through the shell's `MarkdownText` (GFM: tables, task lists, code
  fences, footnotes, KaTeX; raw HTML stays literal text). The seed module exports it as a
  `React.memo` component, so detection accepts a component object (`$$typeof`), not only a
  function; the renderer receives `streaming` and a reference-stable `labels` object built
  from the active locale seat (`markdown.copy`, `markdown.copied`,
  `markdown.codeBlock.title`, `markdown.codeBlock.wrap`, `markdown.codeBlock.unwrap`,
  `markdown.footnotes`). A lightweight built-in renderer is the fallback only when the
  module or its `MarkdownText` export is missing; it ignores `streaming`, treats `\|` as a
  literal pipe inside a table cell, and pads/truncates every row to the header's column
  count.

### Reference completion (`@file`)

- The bundle cannot import `@deepseek-ai/dsh-file-reference`; it replicates the browser-safe
  `activeAtToken` / `formatFileMention` grammar locally, with the same prompt spellings:
  `@path`, `@"path with spaces"`, `@dir/`, and `@"dir/` (open quote) while descending.
- Typing `@` at input start or after whitespace opens a menu at the top of the composer card
  (above the textarea), filled from
  `POST /side-chat/api/references` (120 ms debounce, one in-flight request per tab, previous
  request aborted, stale answers dropped). No query is sent while composing, and no menu
  opens when the provider reported `unavailable` (cached for that tab).
- The menu is a listbox inside the composer card (no portal): `role="listbox"` with rows
  `role="option"` (kind glyph, basename — directories keep the trailing slash — and, when the
  path has one, its parent directory to tell same-named entries apart), the textarea is a
  `combobox` with `aria-expanded`, `aria-controls` and
  `aria-activedescendant`; Up/Down wrap, Enter/Tab pick the highlighted row, Escape closes,
  blurring the composer closes, mousedown picks without stealing focus. A pick replaces
  `[token start, caret]` and moves the caret after the mention; a directory pick keeps
  completion open on the new query. With nothing to pick, Enter closes the menu and submits.
- The pick never sends and never reads file content; the mention is plain prompt text.
- Committed user bubbles split their text with the primary reference rule (quoted paths
  preserved, trailing sentence punctuation trimmed) and render file/folder references as
  inert `sc-ref-chip` text nodes (no click, no HTML injection); directory labels keep the
  trailing slash.

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
  `reference.empty` (status rows).
- Pasted images add `image.pending` (strip aria label), `image.chip` (the chip label,
  used both in the pending strip and in committed bubbles) and `image.remove` (remove
  control label). Client-side paste failures use the codes `image-unsupported`,
  `image-unreadable`, `image-too-large` and `image-too-many`; host prompt-image
  failures use `bad-request`, `attachments-unavailable` and `image-rejected`. Each maps
  to `error.imageUnsupported`, `error.imageUnreadable`, `error.imageTooLarge`,
  `error.imageTooMany`, `error.badRequest`, `error.attachmentsUnavailable` and
  `error.imageRejected` in the same namespace.
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
