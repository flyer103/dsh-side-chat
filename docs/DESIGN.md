# Design — dsh-side-chat

## Positioning

A DeepSeek Harness (DSH) profile plugin that gives the Web GUI a **side chat** for the
current session: an ephemeral, context-inheriting conversation that can **really modify
files** while the main thread keeps running, without writing anything into the main
session transcript.

Delta against the existing community plugins:

| Plugin | can modify files | inherits in-flight context | ephemeral |
|---|---|---|---|
| `Lukknow0/dsh-side-chat` | no (read-only QA) | yes | yes |
| `Diluka/dsh-side-session` | no (prompt forbids mutation) | yes (live-log snapshot) | yes |
| `Yur0918/dsh-sidepanel` | no (read-only persona side chat) | fork only | no |
| **this plugin** | **yes — full tool chain in the same workspace** | **yes** | **yes** |

## P0 (this phase)

1. **Entry**: a `侧边会话` button in `conversation.session.header.actions`; clicking opens the
   panel instantly (no agent/fork work).
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
6. **Isolation**: `origin: 'subagent'` keeps the side session out of the session list; no
   `parentSession` (avoids the subagent catalog); one side session per parent session.
7. **Lifecycle**: closing the panel disposes the agent and then best-effort deletes its
   persisted artifact (a failed removal is logged; the close still succeeds and the orphan
   never appears in any list). A side chat cannot be reopened.
8. **UI**: own floating panel (right edge, 460px / 46vw), user bubbles + assistant markdown,
   reasoning fold, tool chips with results, running/thinking state, optimistic pending
   messages, Stop, auto-follow scrolling, `Enter` send / `Shift+Enter` newline.

## P1 (designed, not implemented)

- Model picker for the side session.
- Multiple concurrent side chats per session (tab strip).
- Surfacing the side session's **approval prompts** in the panel (today the side session
  inherits the parent's approval policy; if that policy asks the human, the request has no
  answerer inside the panel).
- Side-session history across a GUI restart (today: in-memory handles only).

## Non-goals

- Merging side-chat content back into the main transcript.
- Making the side session visible in the workspace/session list.
- Mutating git state (branch/commit/push) on the user's behalf.
- Replacing the native conversation UI.

## Adversarial notes

- **Crash mid-creation**: `agents.create` rejects; the client shows the error and keeps the
  panel empty. No half-registered handle is stored before `create` resolves.
- **Double send / double create**: `create` is idempotent per `sourceId`; the client also
  guards with a single in-flight send.
- **Close during a running turn**: `close` disposes the handle; the dispose path cancels the
  turn. The client stops polling status for that id.
- **Parent unloaded while the panel is open**: `prompt`/`status` return `not-found`; the panel
  shows the error instead of silently queueing.
- **Artifact deletion**: path comes from `sessionPersistence.locate(header)`; deletion runs
  with `node:fs/promises.rm` after a short drain delay, guarded to this plugin's own session
  directory (absolute path, `basename(dir) === session id`). A failed removal is logged and the
  close still disposes and succeeds; the orphan never appears in any list.
- **Token cost**: the side session inherits the parent history, so its first request is
  roughly as large as the parent's next request. Stated in the README.

## Rollback

Remove the bundle row (or `dsh plugin remove`), restart DSH. No schema, no persistence
migration, no main-session writes.
