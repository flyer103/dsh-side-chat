/**
 * dsh-side-chat — Client half.
 *
 * Hand-written DSH browser ModuleLoader bundle (no build step).
 *
 * Loader format, verified against DSH 0.2.1-rc.2 `@deepseek-ai/dsh-client-modules`:
 *
 *   window.__ModuleLoader__.load({
 *     id: '<package name>',
 *     factory: (require) => module.exports
 *   })
 *
 * The bundle id MUST be the package name: the module system composes one graph row
 * per package and the Cordis Loader entry imports exactly that id. The factory's
 * synchronous `require` resolves the shell's frozen platform seed table first, so
 * `react`, `react/jsx-runtime` and `@deepseek-ai/dsh-client-ui-primitives` are
 * reachable there (primitives ships inside the shell, not as an npm package).
 *
 * Message data: the DSH 0.2.1 client `sessions` service cannot read a parentless
 * `origin: 'subagent'` session (the host rejects an ordinary session address for
 * subagent-origin sessions and a subagent address requires a durable parent plus a
 * catalog descriptor). The panel therefore uses the host half's own routes: the
 * `/side-chat/api/events` SSE stream (preferred) and `/side-chat/api/snapshot`
 * polling (fallback), folding both into its render model itself; the fork history
 * and the injected boundary message never leave the host floor.
 *
 * Entry point: a native right-sidebar tab type (`side-chat`) plus its body seat,
 * `sidebar.right.pane.tab`. The tab's `visible` flag gates live updates, and
 * closing the tab destroys the side session through the registered close handler.
 * User-facing copy is registered with `ctx.locale` (`zh` + `en`) and read through
 * the bound `t`, so the UI follows the DSH language setting.
 */
window.__ModuleLoader__.load({
  id: '@flyer103/dsh-side-chat',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (error) {
      primitives = null
    }

    const h = React.createElement

    const API_PREFIX = '/side-chat/api/'
    const BOUNDARY_FIRST_LINE = 'Side conversation boundary.'
    const STYLE_ATTR = 'dsh-side-chat'
    const SIDE_CHAT_TYPE_ID = '@flyer103/dsh-side-chat'
    const SIDE_CHAT_KIND = 'side-chat'
    const POLL_RUNNING_MS = 400
    const POLL_IDLE_MS = 1500
    const STREAM_HELLO_MS = 2500
    const STREAM_RETRY_MS = [500, 1000, 2000, 4000, 8000]
    const STICK_THRESHOLD_PX = 40

    const LOCALE_NS = 'side-chat'
    const ZH_DICT = {
      'tab.title': '侧边会话',
      'tab.titleIndexed': '侧边会话 {index}',
      'tab.new': '新建侧边会话',
      'guide.title': '侧边会话',
      'guide.description': '临时侧边会话：继承当前会话上下文，可真实修改文件，关闭即销毁',
      'status.notCreated': '尚未创建',
      'status.running': '运行中',
      'status.sending': '发送中',
      'status.idle': '空闲',
      'status.pending': '{count} 条待发送',
      'empty.title': '侧边会话',
      'empty.metaBlank': '发送第一条消息时创建侧边会话，继承当前会话上下文',
      'empty.metaCreated': '已创建侧边会话，等待回复…',
      'empty.hint': 'Enter 发送，Shift+Enter 换行',
      'composer.placeholder': '输入消息…',
      'composer.placeholderBlank': '描述你想了解什么…',
      'composer.send': '发送',
      'composer.stop': '停止生成',
      'thinking': '思考中…',
      'sending': '发送中…',
      'fold.reasoning': '思考',
      'fold.tools': '工具调用 {count}',
      'pending.queued': '排队中…',
      'pending.sent': '已发送',
      'context.skill': '技能',
      'context.skillNamed': '技能 {name}',
      'context.steering': '插话',
      'context.sessionReference': '会话引用',
      'context.agentInstructions': '代理指令',
      'context.compactCheckpoint': '压缩检查点',
      'context.generic': '上下文',
      'tool.fallbackName': '工具调用',
      'tool.failed': '失败',
      'tool.emptyOutput': '(无输出)',
      'error.unknownSource': '原会话已不在，无法创建侧边会话',
      'error.notFound': '侧边会话已不存在（可能已被销毁）',
      'error.emptyPrompt': '消息为空',
      'error.createFailed': '创建侧边会话失败',
      'error.promptFailed': '发送消息失败',
      'error.disposeFailed': '销毁侧边会话失败',
      'error.internal': '侧边会话内部错误',
      'error.unknown': '出错了'
    }
    const EN_DICT = {
      'tab.title': 'Side chat',
      'tab.titleIndexed': 'Side chat {index}',
      'tab.new': 'New side chat',
      'guide.title': 'Side chat',
      'guide.description': 'Temporary side conversation that inherits this session’s context and can really modify files; closing it destroys it',
      'status.notCreated': 'Not created yet',
      'status.running': 'Running…',
      'status.sending': 'Sending…',
      'status.idle': 'Idle',
      'status.pending': '{count} queued',
      'empty.title': 'Side chat',
      'empty.metaBlank': 'The side conversation is created when you send the first message and inherits this session’s context',
      'empty.metaCreated': 'Side conversation created. Waiting for a reply…',
      'empty.hint': 'Enter to send, Shift+Enter for a new line',
      'composer.placeholder': 'Type a message…',
      'composer.placeholderBlank': 'Ask anything about this session…',
      'composer.send': 'Send message',
      'composer.stop': 'Stop generating',
      'thinking': 'Thinking…',
      'sending': 'Sending…',
      'fold.reasoning': 'Reasoning',
      'fold.tools': 'Tool calls ({count})',
      'pending.queued': 'Queued…',
      'pending.sent': 'Sent',
      'context.skill': 'Skill',
      'context.skillNamed': 'Skill: {name}',
      'context.steering': 'Steering',
      'context.sessionReference': 'Session reference',
      'context.agentInstructions': 'Agent instructions',
      'context.compactCheckpoint': 'Compaction checkpoint',
      'context.generic': 'Context',
      'tool.fallbackName': 'Tool call',
      'tool.failed': 'Failed',
      'tool.emptyOutput': '(no output)',
      'error.unknownSource': 'The source session is gone; the side conversation cannot be created',
      'error.notFound': 'The side conversation no longer exists (it may have been destroyed)',
      'error.emptyPrompt': 'The message is empty',
      'error.createFailed': 'Could not create the side conversation',
      'error.promptFailed': 'Could not send the message',
      'error.disposeFailed': 'Could not destroy the side conversation',
      'error.internal': 'Side conversation internal error',
      'error.unknown': 'Something went wrong'
    }

    const CONTEXT_TAGS = new Set(['skill', 'steering', 'sessionReference', 'agentInstructions', 'compactCheckpoint', 'generic'])

    const ERROR_KEYS = {
      'unknown-source': 'error.unknownSource',
      'not-found': 'error.notFound',
      'empty-prompt': 'error.emptyPrompt',
      'create-failed': 'error.createFailed',
      'prompt-failed': 'error.promptFailed',
      'dispose-failed': 'error.disposeFailed',
      'internal': 'error.internal'
    }

    /** Stable technical failure record: the code drives localized copy, the raw host message stays as detail. */
    function failureOf(error) {
      if (error === null || error === undefined) return { code: 'unknown', message: '' }
      if (typeof error === 'string') {
        if (ERROR_KEYS[error] !== undefined) return { code: error, message: '', params: {} }
        return { code: 'unknown', message: error }
      }
      if (typeof error !== 'object') return { code: 'unknown', message: String(error) }
      const code = typeof error.code === 'string' && error.code !== '' ? error.code : 'unknown'
      const message = typeof error.message === 'string' ? error.message : ''
      const params = error.params !== null && typeof error.params === 'object' ? error.params : {}
      return { code, message, params }
    }

    function errorKeyOf(code) {
      return ERROR_KEYS[code] !== undefined ? ERROR_KEYS[code] : 'error.unknown'
    }

    /**
     * Localized error strip: a translated title plus the untouched host message as
     * a monospace technical detail line (dropped when it would only repeat the code).
     */
    function formatError(t, failure) {
      if (failure === null || failure === undefined) return null
      const record = failureOf(failure)
      const title = t(errorKeyOf(record.code), record.params)
      const message = record.message
      const detail = message === '' || message === record.code || message === title ? '' : message
      return { title, detail }
    }

    function statusLabel(t, state) {
      if (state.sessionId === null || state.sessionId === undefined) return t('status.notCreated')
      if (state.running === true) return t('status.running')
      if (state.sending === true) return t('status.sending')
      return t('status.idle')
    }

    function pendingLabel(t, busy) {
      return busy ? t('pending.queued') : t('pending.sent')
    }

    function contextLabel(t, node) {
      const raw = typeof node.tag === 'string' && node.tag !== '' ? node.tag : 'generic'
      const tag = CONTEXT_TAGS.has(raw) ? raw : 'generic'
      const name = typeof node.name === 'string' && node.name !== '' ? node.name : ''
      if (tag === 'skill') return name === '' ? t('context.skill') : t('context.skillNamed', { name })
      return t(`context.${tag}`)
    }


    const MarkdownText = primitives !== null && typeof primitives.MarkdownText === 'function'
      ? primitives.MarkdownText
      : null
    const IconClose = pickIcon('IconCloseOutlineRegular', 'IconCloseOutline16', '✕')
    const IconSend = pickIcon('IconSendOutlineRegular', 'IconSendOutline16', '↑')
    const IconStop = pickIcon('IconStopFillRegular', 'IconStopFill16', '■')
    const IconThink = pickIcon('IconThinkOutlineRegular', 'IconThinkOutline16', '◌')
    const IconCode = pickIcon('IconCodeOutlineRegular', 'IconCodeOutline16', '⌘')

    function pickIcon(name, legacyName, fallback) {
      if (primitives !== null) {
        if (typeof primitives[name] === 'function') return primitives[name]
        if (typeof primitives[legacyName] === 'function') return primitives[legacyName]
      }
      return fallback
    }

    function icon(node, props) {
      if (typeof node === 'function') return h(node, props || {})
      return h('span', { className: 'sc-icon', 'aria-hidden': 'true' }, String(node))
    }

    // Pure helpers (exported below for tests; keep them free of React and DOM state).

    function apiPath(name) {
      return API_PREFIX + name
    }

    /**
     * Runtime record key of one side-chat tab. The sidebar pane can hold several
     * side-chat tabs of the same parent session, so a tab occurrence — not the
     * parent session — owns one side conversation. The parent id stays part of the
     * key because dockkit tab ids repeat across sessions.
     */
    function instanceKeyOf(sessionId, tabId) {
      if (typeof sessionId !== 'string' || sessionId === '') return ''
      if (typeof tabId === 'string' && tabId !== '') return `${sessionId}#${tabId}`
      return sessionId
    }

    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    function blocksOf(content) {
      return asArray(content).filter((block) => block !== null && typeof block === 'object')
    }

    function textOfContent(content) {
      return blocksOf(content)
        .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
        .filter((text) => text !== '')
        .join('\n')
    }

    function textOfToolContent(content) {
      const text = textOfContent(content)
      if (text !== '') return text
      const blocks = blocksOf(content)
      if (blocks.length === 0) return ''
      try {
        return blocks.map((block) => JSON.stringify(block)).join('\n').slice(0, 4000)
      } catch (error) {
        return ''
      }
    }

    function firstLine(text) {
      if (typeof text !== 'string') return ''
      const index = text.indexOf('\n')
      return (index < 0 ? text : text.slice(0, index)).trim()
    }

    /** Boundary marker: the plugin source kind, or the exact first line the host writes. */
    function isBoundaryMessage(source, text) {
      if (source !== null && typeof source === 'object') {
        if (source.kind === 'plugin:side-chat') return true
        if (source.kind === 'plugin' && source.plugin === 'side-chat') return true
      }
      return firstLine(text) === BOUNDARY_FIRST_LINE
    }

    function isBoundaryEvent(event) {
      if (event === null || typeof event !== 'object') return false
      if (event.type !== 'user/message') return false
      const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
      return isBoundaryMessage(data.source, textOfContent(data.content))
    }

    /** Forked history never renders: those events have seq below inheritedEventCount. */
    function isInheritedEvent(event, inheritedEventCount) {
      if (event === null || typeof event !== 'object') return false
      if (typeof inheritedEventCount !== 'number') return false
      return typeof event.seq === 'number' && event.seq < inheritedEventCount
    }

    function clockOf(time) {
      if (typeof time === 'number' && Number.isFinite(time)) {
        const date = new Date(time)
        if (!Number.isNaN(date.getTime())) {
          const hh = String(date.getHours()).padStart(2, '0')
          const mm = String(date.getMinutes()).padStart(2, '0')
          return `${hh}:${mm}`
        }
      }
      if (typeof time === 'string' && time.length >= 16) return time.slice(11, 16)
      return ''
    }

    function toAssistantBlock(block) {
      if (block === null || typeof block !== 'object') return null
      if (block.type === 'text') {
        if (typeof block.text !== 'string' || block.text === '') return null
        return { kind: 'text', text: block.text }
      }
      if (block.type === 'reasoning') {
        if (typeof block.text !== 'string' || block.text === '') return null
        return { kind: 'reasoning', text: block.text }
      }
      if (block.type === 'tool-call') {
        return {
          kind: 'tool-call',
          callId: block.id === undefined ? '' : String(block.id),
          name: typeof block.name === 'string' ? block.name : '',
          argsRaw: typeof block.arguments === 'string' ? block.arguments : '',
          result: null
        }
      }
      return null
    }

    function toAssistantBlocks(content) {
      const blocks = []
      for (const block of blocksOf(content)) {
        const mapped = toAssistantBlock(block)
        if (mapped !== null) blocks.push(mapped)
      }
      return blocks
    }

    function contextTagOf(source) {
      const kind = source !== null && typeof source === 'object' && typeof source.kind === 'string'
        ? source.kind
        : ''
      if (kind === 'skill-invocation') {
        return typeof source.name === 'string' && source.name !== ''
          ? { tag: 'skill', name: source.name }
          : { tag: 'skill' }
      }
      if (kind === 'session-reference') return { tag: 'sessionReference' }
      if (kind === 'agent-instructions') return { tag: 'agentInstructions' }
      if (kind === 'compact-checkpoint') return { tag: 'compactCheckpoint' }
      if (kind === 'steering') return { tag: 'steering' }
      return { tag: 'generic' }
    }

    /**
     * Fold committed session events into the small render model the panel uses.
     * Unknown event kinds, replacement surface ops and tool calls that duplicate an
     * assistant message's own blocks are ignored; a committed `tool/result` is
     * attached to the matching `tool-call` block by callId.
     * @param entries - snapshot entries shaped `{ seq, type, time, data, surfaceOp? }`.
     * @param inheritedEventCount - fork floor; events below it never render.
     * @returns nodes: `user`, `assistant`, `context`.
     */
    function foldEntries(entries, inheritedEventCount) {
      const nodes = []
      const toolResults = new Map()
      const list = asArray(entries)
      const sorted = list.slice().sort((left, right) => {
        const a = left !== null && typeof left === 'object' && typeof left.seq === 'number' ? left.seq : 0
        const b = right !== null && typeof right === 'object' && typeof right.seq === 'number' ? right.seq : 0
        return a - b
      })
      for (const event of sorted) {
        if (event === null || typeof event !== 'object') continue
        if (isInheritedEvent(event, inheritedEventCount)) continue
        if (typeof event.type !== 'string') continue
        if (event.type === 'user/message') {
          if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') continue
          const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
          const text = textOfContent(data.content)
          if (isBoundaryMessage(data.source, text)) continue
          if (text === '') continue
          const source = data.source !== null && typeof data.source === 'object' ? data.source : {}
          if (source.kind === 'user' || source.kind === undefined) {
            nodes.push({ kind: 'user', seq: event.seq, time: event.time, text })
          } else {
            nodes.push({
              kind: 'context',
              seq: event.seq,
              time: event.time,
              text: text.slice(0, 2000),
              ...contextTagOf(source)
            })
          }
          continue
        }
        if (event.type === 'assistant/message') {
          if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') continue
          const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
          const message = data.message !== null && typeof data.message === 'object' ? data.message : {}
          const blocks = toAssistantBlocks(message.content)
          if (blocks.length === 0) continue
          nodes.push({ kind: 'assistant', seq: event.seq, time: event.time, blocks })
          continue
        }
        if (event.type === 'tool/result') {
          const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
          const message = data.message !== null && typeof data.message === 'object' ? data.message : {}
          const source = message.source !== null && typeof message.source === 'object' ? message.source : {}
          const rawId = source.callId !== undefined ? source.callId : data.callId
          if (rawId === undefined || rawId === null) continue
          toolResults.set(String(rawId), {
            text: textOfToolContent(message.content).slice(0, 4000),
            isError: message.isError === true
          })
          continue
        }
        // `tool/call` duplicates the block already carried by `assistant/message`;
        // turn/step lifecycle and unknown kinds carry nothing to render.
      }
      if (toolResults.size > 0) {
        for (const node of nodes) {
          if (node.kind !== 'assistant') continue
          for (const block of node.blocks) {
            if (block.kind !== 'tool-call') continue
            const result = toolResults.get(block.callId)
            if (result !== undefined) block.result = result
          }
        }
      }
      return nodes
    }

    /**
     * Host live object: `null` or `{ revision, activeAttempt }`. `activeAttempt` is
     * `null` or `{ attemptId, turn, step, nextIndex, blocks }` where `blocks` carry the
     * same renderable shape as the committed assistant blocks.
     */
    function normalizeLive(value) {
      if (value === null || value === undefined) return null
      if (typeof value !== 'object' || Array.isArray(value)) return null
      return value
    }

    function liveAttemptOf(state) {
      if (state === null || state === undefined || typeof state !== 'object') return null
      const live = normalizeLive(state.live)
      if (live === null) return null
      const attempt = live.activeAttempt
      if (attempt === null || attempt === undefined || typeof attempt !== 'object') return null
      return attempt
    }

    function toLiveBlock(block) {
      if (block === null || typeof block !== 'object') return null
      if (block.kind === 'text') {
        return typeof block.text === 'string' && block.text !== '' ? { kind: 'text', text: block.text } : null
      }
      if (block.kind === 'reasoning') {
        return typeof block.text === 'string' && block.text !== ''
          ? { kind: 'reasoning', text: block.text }
          : null
      }
      if (block.kind === 'tool-call') {
        return {
          kind: 'tool-call',
          callId: block.callId === undefined || block.callId === null ? '' : String(block.callId),
          name: typeof block.name === 'string' ? block.name : '',
          argsRaw: typeof block.argsRaw === 'string' ? block.argsRaw : '',
          result: block.result === undefined ? null : block.result
        }
      }
      return null
    }

    /** Renderable live blocks for the current attempt; empty when no attempt is active. */
    function liveBlocksOf(state) {
      const attempt = liveAttemptOf(state)
      if (attempt === null) return []
      const blocks = []
      for (const block of asArray(attempt.blocks)) {
        const mapped = toLiveBlock(block)
        if (mapped !== null) blocks.push(mapped)
      }
      return blocks
    }

    /** A committed assistant settlement for the attempt the host is currently streaming. */
    function isCommittedSettlement(attempt, event) {
      if (attempt === null || attempt === undefined || typeof attempt !== 'object') return false
      if (event === null || typeof event !== 'object') return false
      if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return false
      if (attempt.turn === undefined || attempt.turn === null) return false
      if (attempt.step === undefined || attempt.step === null) return false
      const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
      return data.turn === attempt.turn && data.step === attempt.step
    }

    /**
     * Incremental Server-Sent Events parser. Feed decoded text chunks, collect the
     * frames completed by each chunk: blank lines separate frames, `event:` names the
     * frame (default `message`), `data:` lines are joined and JSON-parsed, and `:`
     * comment lines (heartbeats) are ignored.
     * @returns `{ push(chunk): frames, reset() }`, a frame being `{ event, data }`.
     */
    function createSseParser() {
      let buffer = ''
      function parseBlock(block) {
        let event = 'message'
        const dataLines = []
        let hasData = false
        for (const line of block.split('\n')) {
          if (line === '' || line.startsWith(':')) continue
          const colon = line.indexOf(':')
          const field = colon < 0 ? line : line.slice(0, colon)
          let value = colon < 0 ? '' : line.slice(colon + 1)
          if (value.startsWith(' ')) value = value.slice(1)
          if (field === 'event') event = value
          else if (field === 'data') {
            dataLines.push(value)
            hasData = true
          }
        }
        if (!hasData) return null
        const raw = dataLines.join('\n')
        let data = raw
        try {
          data = JSON.parse(raw)
        } catch (error) {
          data = raw
        }
        return { event, data }
      }
      function push(chunk) {
        buffer += typeof chunk === 'string' ? chunk : ''
        if (buffer.indexOf('\r') >= 0) buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        const frames = []
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const frame = parseBlock(block)
          if (frame !== null) frames.push(frame)
          boundary = buffer.indexOf('\n\n')
        }
        return frames
      }
      function reset() {
        buffer = ''
      }
      return { push, reset }
    }

    // Fallback inline Markdown used only when the shell's MarkdownText is absent.

    function renderInline(text, keyBase) {
      const out = []
      let rest = typeof text === 'string' ? text : ''
      let index = 0
      while (rest.length > 0 && index < 200) {
        index += 1
        const candidates = []
        const code = rest.indexOf('`')
        const bold = rest.indexOf('**')
        const link = rest.indexOf('[')
        if (code >= 0) candidates.push({ pos: code, kind: 'code' })
        if (bold >= 0) candidates.push({ pos: bold, kind: 'bold' })
        if (link >= 0) candidates.push({ pos: link, kind: 'link' })
        candidates.sort((a, b) => a.pos - b.pos)
        if (candidates.length === 0) {
          out.push(rest)
          break
        }
        const next = candidates[0]
        if (next.pos > 0) {
          out.push(rest.slice(0, next.pos))
          rest = rest.slice(next.pos)
        }
        let consumed = false
        if (next.kind === 'code') {
          const end = rest.indexOf('`', 1)
          if (end > 0) {
            out.push(h('code', { key: `${keyBase}-c${index}`, className: 'sc-inline-code' }, rest.slice(1, end)))
            rest = rest.slice(end + 1)
            consumed = true
          }
        } else if (next.kind === 'bold') {
          const end = rest.indexOf('**', 2)
          if (end > 0) {
            out.push(h('strong', { key: `${keyBase}-b${index}` }, renderInline(rest.slice(2, end), `${keyBase}-b${index}`)))
            rest = rest.slice(end + 2)
            consumed = true
          }
        } else if (next.kind === 'link') {
          const close = rest.indexOf(']', 1)
          const paren = close > 0 ? rest.indexOf('(', close + 1) : -1
          const end = paren > 0 ? rest.indexOf(')', paren + 1) : -1
          if (close > 0 && paren === close + 1 && end > paren) {
            const label = rest.slice(1, close)
            const href = rest.slice(paren + 1, end)
            out.push(h('a', {
              key: `${keyBase}-l${index}`,
              className: 'sc-md-a',
              href,
              target: '_blank',
              rel: 'noreferrer'
            }, renderInline(label, `${keyBase}-l${index}`)))
            rest = rest.slice(end + 1)
            consumed = true
          }
        }
        if (!consumed) {
          out.push(rest[0])
          rest = rest.slice(1)
        }
      }
      return out
    }

    function renderMarkdownFallback(text, keyBase) {
      const lines = (typeof text === 'string' ? text : '').split('\n')
      const blocks = []
      let index = 0
      while (index < lines.length) {
        const line = lines[index]
        const fence = /^```([\w+-]*)\s*$/.exec(line)
        if (fence !== null) {
          const code = []
          index += 1
          while (index < lines.length && !/^```\s*$/.test(lines[index])) {
            code.push(lines[index])
            index += 1
          }
          index += 1
          blocks.push(h('pre', { key: `${keyBase}-code${blocks.length}`, className: 'sc-md-code' },
            h('code', null, code.join('\n'))))
          continue
        }
        const heading = /^(#{1,4})\s+(.*)$/.exec(line)
        if (heading !== null) {
          blocks.push(h('div', {
            key: `${keyBase}-h${blocks.length}`,
            className: `sc-md-h${heading[1].length}`
          }, renderInline(heading[2], `${keyBase}-h${blocks.length}`)))
          index += 1
          continue
        }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
          blocks.push(h('hr', { key: `${keyBase}-hr${blocks.length}`, className: 'sc-md-hr' }))
          index += 1
          continue
        }
        if (/^>\s?/.test(line)) {
          const quote = []
          while (index < lines.length && /^>\s?/.test(lines[index])) {
            quote.push(lines[index].replace(/^>\s?/, ''))
            index += 1
          }
          blocks.push(h('div', { key: `${keyBase}-q${blocks.length}`, className: 'sc-md-quote' },
            renderInline(quote.join('\n'), `${keyBase}-q${blocks.length}`)))
          continue
        }
        const listMatch = /^\s*([-*+]|\d+[.)])\s+/.exec(line)
        if (listMatch !== null) {
          const ordered = /^\s*\d+/.test(listMatch[1])
          const items = []
          while (index < lines.length) {
            const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index])
            if (item === null) break
            items.push(item[2])
            index += 1
          }
          blocks.push(h(ordered ? 'ol' : 'ul', {
            key: `${keyBase}-l${blocks.length}`,
            className: ordered ? 'sc-md-ol' : 'sc-md-ul'
          }, items.map((item, itemIndex) => h('li', { key: itemIndex },
            renderInline(item, `${keyBase}-l${blocks.length}-${itemIndex}`)))))
          continue
        }
        if (/^\s*\|.*\|\s*$/.test(line) && index + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[index + 1])) {
          const rows = []
          while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
            rows.push(lines[index])
            index += 1
          }
          const cells = rows
            .filter((unused, rowIndex) => rowIndex !== 1)
            .map((row) => row.split('|').slice(1, -1).map((cell) => cell.trim()))
          blocks.push(h('table', { key: `${keyBase}-t${blocks.length}`, className: 'sc-md-table' },
            h('tbody', null, cells.map((row, rowIndex) => h('tr', { key: rowIndex },
              row.map((cell, cellIndex) => h(rowIndex === 0 ? 'th' : 'td', { key: cellIndex },
                renderInline(cell, `${keyBase}-t${blocks.length}-${rowIndex}-${cellIndex}`))))))))
          continue
        }
        if (line.trim() === '') {
          index += 1
          continue
        }
        const paragraph = [line]
        index += 1
        while (
          index < lines.length &&
          lines[index].trim() !== '' &&
          !/^(```|#{1,4}\s|>\s?|[-*+]\s|\d+[.)]\s|\s*\|)/.test(lines[index])
        ) {
          paragraph.push(lines[index])
          index += 1
        }
        blocks.push(h('div', { key: `${keyBase}-p${blocks.length}`, className: 'sc-md-p' },
          renderInline(paragraph.join('\n'), `${keyBase}-p${blocks.length}`)))
      }
      return blocks
    }

    function Markdown(props) {
      if (typeof props.text !== 'string' || props.text === '') return null
      if (MarkdownText !== null) {
        return h(MarkdownText, { text: props.text, streaming: props.streaming === true })
      }
      return h('div', { className: 'sc-md' }, renderMarkdownFallback(props.text, props.keyBase || 'md'))
    }

    // Runtime: one record per side-chat tab occurrence (see `instanceKeyOf`), so one
    // parent session can drive several independent side conversations at once.

    function createRuntime(options) {
      const config = options !== null && typeof options === 'object' ? options : {}
      const fetchImpl = typeof config.fetch === 'function'
        ? config.fetch
        : (input, init) => fetch(input, init)
      const setTimer = typeof config.setTimeout === 'function' ? config.setTimeout : (fn, ms) => setTimeout(fn, ms)
      const clearTimer = typeof config.clearTimeout === 'function' ? config.clearTimeout : (id) => clearTimeout(id)
      const doc = config.document !== undefined
        ? config.document
        : (typeof document !== 'undefined' ? document : null)
      const runningMs = typeof config.pollRunningMs === 'number' ? config.pollRunningMs : POLL_RUNNING_MS
      const idleMs = typeof config.pollIdleMs === 'number' ? config.pollIdleMs : POLL_IDLE_MS
      const streamEnabled = config.stream !== false
      const streamHelloMs = typeof config.streamHelloMs === 'number' ? config.streamHelloMs : STREAM_HELLO_MS
      const streamRetryMs = Array.isArray(config.streamRetryMs)
        ? config.streamRetryMs.filter((delay) => typeof delay === 'number' && Number.isFinite(delay) && delay >= 0)
        : STREAM_RETRY_MS
      const panels = new Map()
      /** Parent session id -> next tab ordinal, so chips of one session can be told apart. */
      const labelCounts = new Map()
      let version = 0
      const listeners = new Set()

      function emit() {
        version += 1
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            // A broken subscriber must not break state publication.
          }
        }
      }

      function subscribe(listener) {
        if (typeof listener !== 'function') return () => {}
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }

      function getVersion() {
        return version
      }

      function getState(mainId) {
        return panels.has(mainId) ? panels.get(mainId) : null
      }

      function createPanel(mainId, sourceId) {
        const nextLabel = (labelCounts.get(sourceId) ?? 0) + 1
        labelCounts.set(sourceId, nextLabel)
        return {
          mainId,
          sourceId,
          label: nextLabel,
          sessionId: null,
          inheritedEventCount: null,
          nextSeq: null,
          entries: [],
          seqs: new Set(),
          nodes: [],
          visible: false,
          running: false,
          status: 'idle',
          lastError: null,
          error: null,
          pollError: null,
          sending: false,
          draft: '',
          pending: [],
          live: null,
          streamMode: streamEnabled ? 'unknown' : 'poll',
          stream: null,
          streaming: false,
          streamFailures: 0,
          streamRetryIndex: 0,
          catchUp: false,
          timer: null,
          onVisibility: null
        }
      }

      async function api(name, args) {
        const response = await fetchImpl(apiPath(name), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args === undefined || args === null ? {} : args)
        })
        let payload = null
        try {
          payload = await response.json()
        } catch (error) {
          payload = null
        }
        if (response.ok !== true) {
          const failure = new Error(
            payload !== null && typeof payload.message === 'string' && payload.message !== ''
              ? payload.message
              : `HTTP ${response.status}`
          )
          if (payload !== null && typeof payload.code === 'string') failure.code = payload.code
          throw failure
        }
        if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
          const failure = new Error(
            payload !== null && typeof payload.message === 'string' && payload.message !== ''
              ? payload.message
              : (payload !== null && typeof payload.code === 'string' ? payload.code : 'request failed')
          )
          if (payload !== null && typeof payload.code === 'string') failure.code = payload.code
          throw failure
        }
        return payload
      }

      function setManagedTimer(fn, delay) {
        const timer = setTimer(fn, Math.max(0, delay))
        if (timer !== null && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
        return timer
      }

      function cursorOf(panel) {
        if (panel.nextSeq !== null) return panel.nextSeq
        if (panel.inheritedEventCount !== null && panel.inheritedEventCount !== undefined) return panel.inheritedEventCount
        return 0
      }

      function stopPolling(panel) {
        if (panel.timer !== null) {
          clearTimer(panel.timer)
          panel.timer = null
        }
      }

      /** Stop whichever update path is armed/open: the timer and any stream request. */
      function stopUpdate(panel) {
        stopPolling(panel)
        abortStream(panel)
      }

      function detachVisibility(panel) {
        if (panel.onVisibility === null) return
        if (doc !== null && typeof doc.removeEventListener === 'function') {
          doc.removeEventListener('visibilitychange', panel.onVisibility)
        }
        panel.onVisibility = null
      }

      function attachVisibility(panel) {
        if (panel.onVisibility !== null) return
        if (doc === null || typeof doc.addEventListener !== 'function') return
        const handler = () => {
          if (!panels.has(panel.mainId)) return
          if (doc.hidden === true) {
            stopUpdate(panel)
            return
          }
          if (panel.visible === true) scheduleUpdate(panel, 0)
        }
        doc.addEventListener('visibilitychange', handler)
        panel.onVisibility = handler
      }

      function schedulePoll(panel, delay) {
        if (!panels.has(panel.mainId)) return
        if (panel.sessionId === null) return
        if (panel.visible !== true) return
        if (panel.stream !== null) return
        if (panel.timer !== null) clearTimer(panel.timer)
        const timer = setManagedTimer(() => {
          panel.timer = null
          void poll(panel)
        }, delay)
        panel.timer = timer
      }

      function scheduleStream(panel, delay) {
        if (!panels.has(panel.mainId)) return
        if (panel.sessionId === null) return
        if (panel.visible !== true) return
        if (panel.stream !== null) return
        if (panel.timer !== null) clearTimer(panel.timer)
        const timer = setManagedTimer(() => {
          panel.timer = null
          void openStream(panel)
        }, delay)
        panel.timer = timer
      }

      /** One armed update path at a time: a stream connection unless streaming is unavailable. */
      function scheduleUpdate(panel, delay) {
        if (!panels.has(panel.mainId)) return
        if (panel.sessionId === null) return
        if (panel.visible !== true) return
        if (panel.stream !== null) return
        if (streamEnabled === true && panel.streamMode !== 'poll') {
          scheduleStream(panel, delay)
          return
        }
        schedulePoll(panel, delay)
      }

      function scheduleStreamRetry(panel) {
        if (!panels.has(panel.mainId)) return
        if (panel.visible !== true) return
        const list = streamRetryMs.length > 0 ? streamRetryMs : [1000]
        const index = Math.min(panel.streamRetryIndex, list.length - 1)
        const delay = list[index]
        panel.streamRetryIndex = Math.min(panel.streamRetryIndex + 1, list.length)
        scheduleStream(panel, delay)
      }

      function mergeEntries(panel, entries) {
        let added = false
        for (const event of asArray(entries)) {
          if (event === null || typeof event !== 'object') continue
          const seq = typeof event.seq === 'number' ? event.seq : null
          if (seq === null || panel.seqs.has(seq)) continue
          panel.seqs.add(seq)
          panel.entries.push(event)
          if (panel.nextSeq === null || seq + 1 > panel.nextSeq) panel.nextSeq = seq + 1
          added = true
        }
        if (added) {
          panel.nodes = foldEntries(panel.entries, panel.inheritedEventCount === null ? 0 : panel.inheritedEventCount)
          reconcilePending(panel)
          settleLive(panel, entries)
        }
      }

      /** A committed settlement is authoritative: drop the live attempt it renders. */
      function settleLive(panel, entries) {
        const attempt = liveAttemptOf(panel)
        if (attempt === null) return
        for (const event of asArray(entries)) {
          if (isCommittedSettlement(attempt, event)) {
            panel.live = null
            return
          }
        }
      }

      function reconcilePending(panel) {
        if (panel.pending.length === 0) return
        const used = new Set()
        const remaining = []
        for (const pending of panel.pending) {
          const baseline = pending.seen instanceof Set ? pending.seen : null
          const match = panel.nodes.find((node) =>
            node.kind === 'user' &&
            node.text === pending.text &&
            !used.has(node.seq) &&
            (baseline === null || !baseline.has(node.seq)))
          if (match === undefined) remaining.push(pending)
          else used.add(match.seq)
        }
        if (remaining.length !== panel.pending.length) panel.pending = remaining
      }

      /** Pull one incremental snapshot window. Callers own scheduling and visibility gating. */
      async function fetchSnapshot(panel) {
        if (!panels.has(panel.mainId)) return false
        if (panel.sessionId === null) return false
        try {
          const payload = await api('snapshot', {
            sessionId: panel.sessionId,
            fromSeq: cursorOf(panel)
          })
          if (!panels.has(panel.mainId)) return false
          if (typeof payload.inheritedEventCount === 'number') panel.inheritedEventCount = payload.inheritedEventCount
          mergeEntries(panel, payload.entries)
          if (payload.live !== undefined) panel.live = normalizeLive(payload.live)
          panel.running = payload.running === true || payload.status === 'running'
          panel.status = typeof payload.status === 'string'
            ? payload.status
            : (panel.running ? 'running' : 'idle')
          panel.lastError = payload.lastError === undefined || payload.lastError === null ? null : String(payload.lastError)
          panel.pollError = null
          emit()
          return true
        } catch (error) {
          if (!panels.has(panel.mainId)) return false
          panel.pollError = failureOf(error)
          emit()
          if (error !== null && typeof error === 'object' && error.code === 'not-found') {
            stopUpdate(panel)
            return false
          }
          return true
        }
      }

      async function poll(panel) {
        if (!panels.has(panel.mainId)) return
        if (panel.sessionId === null) return
        if (panel.visible !== true) return
        if (panel.stream !== null) return
        if (doc !== null && doc.hidden === true) return
        const alive = await fetchSnapshot(panel)
        if (!alive) return
        if (panel.visible !== true) return
        schedulePoll(panel, panel.running ? runningMs : idleMs)
      }

      /** One-shot snapshot catch-up: never lose a settlement the stream may have missed. */
      function catchUpSnapshot(panel) {
        if (panel.catchUp === true) return
        panel.catchUp = true
        void fetchSnapshot(panel).then(() => {
          panel.catchUp = false
        }, () => {
          panel.catchUp = false
        })
      }

      function closeStream(panel, stream) {
        if (stream === null || stream === undefined || stream.closed === true) return
        stream.closed = true
        if (stream.helloTimer !== null && stream.helloTimer !== undefined) {
          clearTimer(stream.helloTimer)
          stream.helloTimer = null
        }
        if (stream.reader !== null && stream.reader !== undefined) {
          const reader = stream.reader
          stream.reader = null
          try {
            void reader.cancel()
          } catch (error) {
            // The transport may already have closed the reader.
          }
        }
        if (stream.controller !== null && stream.controller !== undefined) {
          try {
            stream.controller.abort()
          } catch (error) {
            // Aborting twice is harmless.
          }
        }
        if (panel.stream === stream) {
          panel.stream = null
          panel.streaming = false
        }
        emit()
      }

      function abortStream(panel) {
        const stream = panel.stream
        if (stream === null) return
        closeStream(panel, stream)
      }

      function failureOfPayload(payload) {
        if (payload === null || typeof payload !== 'object') return null
        if (payload.ok === true) return null
        const code = typeof payload.code === 'string' && payload.code !== '' ? payload.code : 'unknown'
        const message = typeof payload.message === 'string' ? payload.message : ''
        return { code, message }
      }

      function tryParseJson(text) {
        const trimmed = typeof text === 'string' ? text.trim() : ''
        if (trimmed === '' || trimmed[0] !== '{') return null
        try {
          const value = JSON.parse(trimmed)
          return value !== null && typeof value === 'object' ? value : null
        } catch (error) {
          return null
        }
      }

      async function readPayload(response) {
        if (response === null || typeof response !== 'object') return null
        if (typeof response.json !== 'function') return null
        try {
          const payload = await response.json()
          return payload !== null && typeof payload === 'object' ? payload : null
        } catch (error) {
          return null
        }
      }

      /** The events route answered with a plain JSON document, so streaming is unavailable. */
      function nonStreamResponse(panel, stream, payload) {
        closeStream(panel, stream)
        if (!panels.has(panel.mainId)) return
        panel.streamMode = 'poll'
        panel.streaming = false
        const failure = failureOfPayload(payload)
        if (failure !== null && failure.code === 'not-found') {
          panel.pollError = failureOf(failure)
          stopUpdate(panel)
          emit()
          return
        }
        void degradeToPoll(panel, failure)
      }

      /** Permanent transport fallback: poll from now on, starting with one immediate snapshot. */
      async function degradeToPoll(panel, failure) {
        if (!panels.has(panel.mainId)) return
        panel.streamMode = 'poll'
        panel.streaming = false
        if (failure !== null && failure !== undefined && failure.code === 'not-found') {
          panel.pollError = failureOf(failure)
          stopUpdate(panel)
          emit()
          return
        }
        emit()
        const alive = await fetchSnapshot(panel)
        if (!alive) return
        if (panel.visible !== true) return
        schedulePoll(panel, panel.running ? runningMs : idleMs)
      }

      async function streamFailed(panel, stream, error) {
        if (panel.stream !== stream) return
        const gotHello = stream.gotHello === true
        closeStream(panel, stream)
        if (!panels.has(panel.mainId)) return
        const failure = failureOf(error)
        if (failure.code === 'not-found') {
          panel.pollError = failure
          stopUpdate(panel)
          emit()
          return
        }
        if (gotHello === true) {
          panel.streamMode = 'stream'
          catchUpSnapshot(panel)
          scheduleStreamRetry(panel)
          return
        }
        panel.streamFailures += 1
        if (panel.streamFailures >= 2) {
          await degradeToPoll(panel, failure)
          return
        }
        scheduleStreamRetry(panel)
      }

      function handleHelloFrame(panel, stream, payload) {
        if (payload !== null && typeof payload === 'object') {
          if (typeof payload.inheritedEventCount === 'number') panel.inheritedEventCount = payload.inheritedEventCount
          mergeEntries(panel, payload.entries)
          if (payload.live !== undefined) panel.live = normalizeLive(payload.live)
          panel.running = payload.running === true || payload.status === 'running'
          panel.status = typeof payload.status === 'string' ? payload.status : (panel.running ? 'running' : 'idle')
          panel.lastError = payload.lastError === undefined || payload.lastError === null ? null : String(payload.lastError)
          panel.pollError = null
        }
        stream.gotHello = true
        if (stream.helloTimer !== null && stream.helloTimer !== undefined) {
          clearTimer(stream.helloTimer)
          stream.helloTimer = null
        }
        panel.streamMode = 'stream'
        panel.streamFailures = 0
        panel.streamRetryIndex = 0
        emit()
      }

      function handleEventFrame(panel, payload) {
        if (payload === null || typeof payload !== 'object') return
        const entry = payload.entry
        if (entry === null || entry === undefined || typeof entry !== 'object') return
        mergeEntries(panel, [entry])
        emit()
      }

      function handleLiveFrame(panel, payload) {
        const previous = liveAttemptOf(panel)
        panel.live = payload !== null && typeof payload === 'object' ? normalizeLive(payload.live) : null
        if (previous !== null && liveAttemptOf(panel) === null) catchUpSnapshot(panel)
        emit()
      }

      function handleStatusFrame(panel, payload) {
        if (payload === null || typeof payload !== 'object') return
        panel.running = payload.running === true || payload.status === 'running'
        panel.status = typeof payload.status === 'string' ? payload.status : (panel.running ? 'running' : 'idle')
        emit()
      }

      function handleErrorFrame(panel, payload) {
        if (payload === null || typeof payload !== 'object') return
        panel.lastError = payload.message === undefined || payload.message === null ? null : String(payload.message)
        emit()
      }

      function handleFrame(panel, stream, frame) {
        if (frame === null || typeof frame !== 'object') return
        const payload = frame.data !== null && typeof frame.data === 'object' ? frame.data : null
        if (frame.event === 'hello') handleHelloFrame(panel, stream, payload)
        else if (frame.event === 'event') handleEventFrame(panel, payload)
        else if (frame.event === 'live') handleLiveFrame(panel, payload)
        else if (frame.event === 'status') handleStatusFrame(panel, payload)
        else if (frame.event === 'error') handleErrorFrame(panel, payload)
      }

      function openStream(panel) {
        if (!panels.has(panel.mainId)) return Promise.resolve()
        if (panel.sessionId === null) return Promise.resolve()
        if (panel.visible !== true) return Promise.resolve()
        if (streamEnabled !== true) return Promise.resolve()
        if (panel.stream !== null) return Promise.resolve()
        if (doc !== null && doc.hidden === true) return Promise.resolve()
        if (panel.timer !== null) {
          clearTimer(panel.timer)
          panel.timer = null
        }
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        const stream = {
          controller,
          reader: null,
          helloTimer: null,
          gotHello: false,
          closed: false,
          raw: ''
        }
        panel.stream = stream
        panel.streaming = true
        emit()
        if (streamHelloMs > 0) {
          stream.helloTimer = setManagedTimer(() => {
            stream.helloTimer = null
            if (panel.stream !== stream) return
            if (stream.gotHello === true) return
            closeStream(panel, stream)
            void degradeToPoll(panel, { code: 'stream-timeout', message: '' })
          }, streamHelloMs)
        }
        return runStream(panel, stream)
      }

      async function runStream(panel, stream) {
        try {
          let response
          try {
            response = await fetchImpl(apiPath('events'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId: panel.sessionId, fromSeq: cursorOf(panel) }),
              signal: stream.controller === null ? undefined : stream.controller.signal
            })
          } catch (error) {
            await streamFailed(panel, stream, error)
            return
          }
          if (panel.stream !== stream) return
          if (response === null || typeof response !== 'object') {
            await streamFailed(panel, stream, new Error('invalid stream response'))
            return
          }
          if (response.ok !== true) {
            const payload = await readPayload(response)
            if (panel.stream !== stream) return
            const failure = failureOfPayload(payload)
            const status = typeof response.status === 'number' && response.status > 0 ? `HTTP ${response.status}` : 'stream request failed'
            await streamFailed(panel, stream, failure !== null ? failure : { code: 'unknown', message: status })
            return
          }
          const body = response.body
          if (body === null || body === undefined || typeof body.getReader !== 'function') {
            const payload = await readPayload(response)
            if (panel.stream !== stream) return
            nonStreamResponse(panel, stream, payload)
            return
          }
          const reader = body.getReader()
          stream.reader = reader
          const decoder = typeof TextDecoder === 'function' ? new TextDecoder() : null
          const parser = createSseParser()
          while (true) {
            const result = await reader.read()
            if (panel.stream !== stream) return
            if (result === null || result === undefined || result.done === true) break
            let text = ''
            const value = result.value
            if (typeof value === 'string') text = value
            else if (value !== null && value !== undefined) {
              if (decoder === null) continue
              text = decoder.decode(value, { stream: true })
            }
            if (text === '') continue
            if (stream.gotHello !== true) {
              // A JSON body instead of an SSE stream is the documented "cannot stream" answer.
              if (stream.raw.length < 8192) stream.raw += text
              if (stream.raw.trimStart().startsWith('{')) {
                const payload = tryParseJson(stream.raw)
                if (payload !== null) {
                  if (panel.stream !== stream) return
                  nonStreamResponse(panel, stream, payload)
                  return
                }
                continue
              }
            }
            for (const frame of parser.push(text)) {
              handleFrame(panel, stream, frame)
              if (panel.stream !== stream) return
            }
          }
          if (panel.stream !== stream) return
          if (stream.gotHello === true) {
            closeStream(panel, stream)
            catchUpSnapshot(panel)
            scheduleStreamRetry(panel)
            return
          }
          const payload = tryParseJson(stream.raw)
          closeStream(panel, stream)
          const failure = failureOfPayload(payload)
          if (failure !== null && failure.code === 'not-found') {
            panel.pollError = failureOf(failure)
            stopUpdate(panel)
            emit()
            return
          }
          await degradeToPoll(panel, failure)
        } catch (error) {
          await streamFailed(panel, stream, error)
        }
      }

      /**
       * Ensure the runtime record for one side-chat tab exists (the tab body
       * mounting). `mainId` is the tab occurrence key; `sourceId` is the parent
       * session the side conversation forks from and defaults to the key.
       */
      function open(mainId, sourceId) {
        if (typeof mainId !== 'string' || mainId === '') return
        const parentId = typeof sourceId === 'string' && sourceId !== '' ? sourceId : mainId
        if (!panels.has(mainId)) panels.set(mainId, createPanel(mainId, parentId))
        attachVisibility(panels.get(mainId))
        emit()
      }

      /** Ordinal of one side-chat tab within its parent session (0 when unknown). */
      function labelOf(mainId) {
        const panel = panels.get(mainId)
        return panel === undefined ? 0 : panel.label
      }

      /** Tab visibility gate: hidden aborts the stream; visible reconnects from the existing fromSeq. */
      function setVisible(mainId, visible) {
        const panel = panels.get(mainId)
        if (panel === undefined) return
        const next = visible === true
        if (panel.visible === next) return
        panel.visible = next
        if (next) {
          scheduleUpdate(panel, 0)
        } else {
          stopUpdate(panel)
        }
        emit()
      }

      function setDraft(mainId, text) {
        const panel = panels.get(mainId)
        if (panel === undefined) return
        panel.draft = typeof text === 'string' ? text : ''
        emit()
      }

      async function send(mainId, text) {
        const panel = panels.get(mainId)
        if (panel === undefined) return
        if (panel.sending) return
        const draft = typeof text === 'string' ? text : panel.draft
        const trimmed = draft.trim()
        if (trimmed === '') return
        panel.sending = true
        panel.error = null
        panel.draft = ''
        const pendingId = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
        const seen = new Set()
        for (const node of panel.nodes) {
          if (node.kind === 'user') seen.add(node.seq)
        }
        panel.pending = [...panel.pending, { id: pendingId, text: trimmed, time: Date.now(), seen }]
        emit()
        try {
          let target = panel.sessionId
          if (target === null) {
            const created = await api('create', { sourceId: panel.sourceId, instanceKey: panel.mainId })
            if (typeof created.sessionId !== 'string' || created.sessionId === '') {
              throw new Error('create returned no session id')
            }
            target = created.sessionId
            if (!panels.has(mainId)) {
              void api('close', { sessionId: target }).catch(() => {})
              return
            }
            panel.sessionId = target
            panel.inheritedEventCount = typeof created.inheritedEventCount === 'number'
              ? created.inheritedEventCount
              : 0
            panel.nextSeq = panel.inheritedEventCount
            panel.nodes = []
            attachVisibility(panel)
            scheduleUpdate(panel, 0)
          }
          await api('prompt', { sessionId: target, text: trimmed })
          if (!panels.has(mainId)) return
          panel.sending = false
          panel.error = null
          emit()
          scheduleUpdate(panel, 0)
        } catch (error) {
          if (!panels.has(mainId)) return
          panel.sending = false
          panel.pending = panel.pending.filter((pending) => pending.id !== pendingId)
          if (panel.draft === '') panel.draft = trimmed
          panel.error = failureOf(error)
          emit()
        }
      }

      async function cancel(mainId) {
        const panel = panels.get(mainId)
        if (panel === undefined || panel.sessionId === null) return
        try {
          await api('cancel', { sessionId: panel.sessionId })
          panel.sending = false
          emit()
        } catch (error) {
          panel.error = failureOf(error)
          emit()
        }
      }

      async function close(mainId) {
        const panel = panels.get(mainId)
        if (panel === undefined) return
        stopUpdate(panel)
        detachVisibility(panel)
        const sessionId = panel.sessionId
        const sourceId = panel.sourceId
        panels.delete(mainId)
        // The last tab of a parent session releases its ordinal, so a fresh first
        // side chat starts at the plain title again.
        let siblings = 0
        for (const other of panels.values()) {
          if (other.sourceId === sourceId) siblings += 1
        }
        if (siblings === 0) labelCounts.delete(sourceId)
        emit()
        if (sessionId === null) return
        try {
          await api('close', { sessionId })
        } catch (error) {
          // The tab is gone; the host also disposes on unload.
          if (typeof console !== 'undefined' && typeof console.warn === 'function') {
            const failure = failureOf(error)
            console.warn('dsh-side-chat: close failed:', failure.message !== '' ? failure.message : failure.code)
          }
        }
      }

      /** Explicit stream connection (used by the scheduling path and by tests). */
      function connectStream(mainId) {
        const panel = panels.get(mainId)
        if (panel === undefined) return
        void openStream(panel)
      }

      /** Deterministic single pull for tests; does not schedule or require visibility. */
      async function pollOnce(mainId) {
        const panel = panels.get(mainId)
        if (panel === undefined) return
        await fetchSnapshot(panel)
      }

      function dispose() {
        for (const panel of panels.values()) {
          stopUpdate(panel)
          detachVisibility(panel)
        }
        panels.clear()
        labelCounts.clear()
        listeners.clear()
        version += 1
      }

      return {
        subscribe,
        getVersion,
        getState,
        open,
        setVisible,
        setDraft,
        send,
        cancel,
        close,
        labelOf,
        connectStream,
        pollOnce,
        dispose
      }
    }

    // React components.

    const EMPTY_LOCALE_SNAPSHOT = Object.freeze({ active: 'en', locales: [], revision: 0 })
    function noopSubscribe() {
      return () => {}
    }

    function emptyLocaleSnapshot() {
      return EMPTY_LOCALE_SNAPSHOT
    }

    function keyTranslator(key) {
      return key
    }

    /** Sidebar tab body: one panel record per tab occurrence, polling gated by tab visibility. */
    function SideChatBody(props) {
      const runtime = props.runtime
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const t = typeof props.t === 'function' ? props.t : keyTranslator
      const locale = props.locale !== undefined && props.locale !== null ? props.locale : null
      const subscribeLocale = React.useMemo(
        () => (locale !== null && typeof locale.subscribe === 'function'
          ? (listener) => locale.subscribe(listener)
          : noopSubscribe),
        [locale]
      )
      const readLocaleSnapshot = React.useMemo(
        () => (locale !== null && typeof locale.getSnapshot === 'function'
          ? () => locale.getSnapshot()
          : emptyLocaleSnapshot),
        [locale]
      )
      React.useSyncExternalStore(subscribeLocale, readLocaleSnapshot)
      React.useSyncExternalStore(runtime.subscribe, runtime.getVersion)
      const tabInfo = typeof props.useTabInfo === 'function' ? props.useTabInfo() : null
      const tab = tabInfo !== null && tabInfo !== undefined && tabInfo.tab !== undefined && tabInfo.tab !== null
        ? tabInfo.tab
        : null
      const panelId = instanceKeyOf(sessionId, tab !== null ? tab.id : undefined)
      const visible = tab !== null ? tab.visible === true : true
      const tabActions = tab !== null && tab.actions !== undefined && tab.actions !== null
        && typeof tab.actions === 'object' ? tab.actions : null
      const onNew = tabActions !== null && typeof tabActions.openTab === 'function'
        ? () => { tabActions.openTab(SIDE_CHAT_KIND) }
        : null
      React.useEffect(() => {
        if (panelId === '') return undefined
        runtime.open(panelId, sessionId)
        return undefined
      }, [runtime, panelId, sessionId])
      React.useEffect(() => {
        if (panelId === '') return undefined
        runtime.setVisible(panelId, visible)
        return () => runtime.setVisible(panelId, false)
      }, [runtime, panelId, visible])
      const state = panelId === '' ? null : runtime.getState(panelId)
      if (state === null) return null
      return h(PanelBody, { runtime, state, t, onNew })
    }

    /**
     * Live tab chip title: the outlet re-renders on locale changes, so the thunk
     * copy follows the switch; later side chats of one session carry their ordinal
     * so several identical tabs stay distinguishable.
     */
    function SideChatTabTitle(props) {
      const t = typeof props.t === 'function' ? props.t : keyTranslator
      const runtime = props.runtime !== undefined && props.runtime !== null ? props.runtime : null
      const subscribe = runtime !== null && typeof runtime.subscribe === 'function'
        ? runtime.subscribe
        : noopSubscribe
      const getVersion = runtime !== null && typeof runtime.getVersion === 'function'
        ? runtime.getVersion
        : () => 0
      React.useSyncExternalStore(subscribe, getVersion)
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const tabInfo = typeof props.useTabInfo === 'function' ? props.useTabInfo() : null
      const tabId = tabInfo !== null && tabInfo !== undefined && tabInfo.tab !== undefined && tabInfo.tab !== null
        ? tabInfo.tab.id
        : undefined
      const label = runtime !== null && typeof runtime.labelOf === 'function'
        ? runtime.labelOf(instanceKeyOf(sessionId, tabId))
        : 0
      return h('span', null, label > 1 ? t('tab.titleIndexed', { index: label }) : t('tab.title'))
    }

    function Disclosure(props) {
      const [open, setOpen] = React.useState(false)
      return h('div', { className: 'sc-fold' },
        h('button', {
          type: 'button',
          className: 'sc-fold-head',
          onClick: () => setOpen((value) => !value),
          'aria-expanded': open
        },
        h('span', { className: 'sc-fold-chevron' + (open ? ' sc-fold-chevron-open' : ''), 'aria-hidden': 'true' }, '▸'),
        icon(props.icon, { className: 'sc-fold-icon' }),
        h('span', { className: 'sc-fold-title' }, props.title),
        props.preview === undefined || props.preview === ''
          ? null
          : h('span', { className: 'sc-fold-preview' }, props.preview)),
        open ? h('div', { className: 'sc-fold-body' }, props.children) : null)
    }

    function ToolBlock(props) {
      const block = props.block
      const t = props.t
      const result = block.result
      const args = typeof block.argsRaw === 'string' && block.argsRaw !== ''
        ? block.argsRaw.length > 400 ? `${block.argsRaw.slice(0, 400)}…` : block.argsRaw
        : ''
      return h('div', { className: 'sc-tool' },
        h('div', { className: 'sc-tool-head' },
          h('span', { className: 'sc-tool-name' }, block.name === '' ? t('tool.fallbackName') : block.name),
          result !== null && result.isError === true
            ? h('span', { className: 'sc-tool-error' }, t('tool.failed'))
            : null),
        args !== '' ? h('div', { className: 'sc-tool-args' }, args) : null,
        result !== null && typeof result === 'object'
          ? h('div', { className: 'sc-tool-result' }, result.text === '' ? t('tool.emptyOutput') : result.text)
          : null)
    }

    function AssistantRow(props) {
      const blocks = props.blocks
      const t = props.t
      const reasoning = blocks.filter((block) => block.kind === 'reasoning').map((block) => block.text).join('\n\n')
      const texts = blocks.filter((block) => block.kind === 'text')
      const tools = blocks.filter((block) => block.kind === 'tool-call')
      return h('div', { className: 'sc-row sc-row-assistant' },
        reasoning !== ''
          ? h(Disclosure, {
              icon: IconThink,
              title: t('fold.reasoning'),
              preview: reasoning.length > 80 ? `${reasoning.slice(0, 80)}…` : reasoning
            }, h('div', { className: 'sc-reasoning' }, reasoning))
          : null,
        tools.length > 0
          ? h(Disclosure, {
              icon: IconCode,
              title: t('fold.tools', { count: tools.length }),
              preview: tools.map((tool) => tool.name).filter((name) => name !== '').join(', ')
            }, tools.map((tool, index) => h(ToolBlock, { key: index, block: tool, t })))
          : null,
        texts.length > 0
          ? h('div', { className: 'sc-md-block' }, texts.map((block, index) =>
              h(Markdown, {
                key: index,
                text: block.text,
                keyBase: `a${props.seq}-${index}`,
                streaming: props.streaming === true
              })))
          : null)
    }

    function UserRow(props) {
      return h('div', { className: 'sc-row sc-row-user' },
        h('div', { className: 'sc-user-stack' },
          h('div', { className: 'sc-bubble' }, props.text),
          props.time === ''
            ? null
            : h('div', { className: 'sc-meta' }, props.time)))
    }

    function PendingRow(props) {
      const pending = props.pending
      return h('div', { className: 'sc-row sc-row-user' },
        h('div', { className: 'sc-user-stack' },
          h('div', { className: 'sc-bubble sc-bubble-pending' }, pending.text),
          h('div', { className: 'sc-meta' }, pending.time === ''
            ? props.label
            : `${pending.time} · ${props.label}`)))
    }

    function ErrorStrip(props) {
      const error = props.error
      if (error === null || error === undefined) return null
      return h('div', { className: 'sc-error' },
        h('div', { className: 'sc-error-title' }, error.title),
        error.detail === ''
          ? null
          : h('div', { className: 'sc-error-detail' }, error.detail))
    }

    function PanelBody(props) {
      const runtime = props.runtime
      const state = props.state
      const t = typeof props.t === 'function' ? props.t : keyTranslator
      const onNew = typeof props.onNew === 'function' ? props.onNew : null
      const bodyRef = React.useRef(null)
      const stickRef = React.useRef(true)
      React.useEffect(() => {
        const element = bodyRef.current
        if (element === null) return undefined
        const onScroll = () => {
          stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_THRESHOLD_PX
        }
        element.addEventListener('scroll', onScroll, { passive: true })
        return () => element.removeEventListener('scroll', onScroll)
      }, [])
      React.useEffect(() => {
        const element = bodyRef.current
        if (element !== null && stickRef.current) element.scrollTop = element.scrollHeight
      }, [state.nodes, state.pending.length, state.running, state.sending, state.lastError, state.live])

      const running = state.running === true
      const sending = state.sending === true
      const busy = running || sending
      const hasDraft = typeof state.draft === 'string' && state.draft.trim() !== ''
      const hasSession = state.sessionId !== null
      const liveBlocks = liveBlocksOf(state)
      const errorView = formatError(t, state.error !== null ? state.error : state.pollError)
      const lastErrorView = state.lastError === null || state.lastError === undefined
        ? null
        : formatError(t, { code: 'unknown', message: String(state.lastError) })
      const rows = []
      for (let index = 0; index < state.nodes.length; index += 1) {
        const node = state.nodes[index]
        if (node.kind === 'user') {
          rows.push(h(UserRow, { key: `u${node.seq}-${index}`, text: node.text, time: clockOf(node.time) }))
        } else if (node.kind === 'assistant') {
          rows.push(h(AssistantRow, { key: `a${node.seq}-${index}`, seq: node.seq, blocks: node.blocks, t }))
        } else if (node.kind === 'context') {
          rows.push(h('div', { key: `c${node.seq}-${index}`, className: 'sc-context' }, contextLabel(t, node)))
        }
      }
      if (liveBlocks.length > 0) {
        rows.push(h(AssistantRow, {
          key: 'live',
          seq: 'live',
          blocks: liveBlocks,
          streaming: true,
          t
        }))
      }
      const pendingRows = state.pending.map((pending) => h(PendingRow, {
        key: pending.id,
        pending,
        time: clockOf(pending.time),
        label: pendingLabel(t, busy)
      }))
      const empty = rows.length === 0 && pendingRows.length === 0 && errorView === null && lastErrorView === null
      const status = statusLabel(t, state)
      const newTitle = t('tab.new')
      const statusbar = h('div', { className: 'sc-statusbar' },
        h('span', { className: running ? 'sc-dot sc-dot-running' : 'sc-dot', title: status }),
        h('span', { className: 'sc-status' }, status),
        state.pending.length > 0
          ? h('span', { className: 'sc-status-extra' }, t('status.pending', { count: state.pending.length }))
          : null,
        onNew === null
          ? null
          : h('button', {
              type: 'button',
              className: 'sc-new',
              title: newTitle,
              'aria-label': newTitle,
              onClick: onNew
            }, '+'))
      const emptyBlock = h('div', { className: 'sc-empty' },
        h('div', { className: 'sc-empty-title' }, t('empty.title')),
        h('div', { className: 'sc-empty-meta' }, hasSession ? t('empty.metaCreated') : t('empty.metaBlank')),
        h('div', { className: 'sc-empty-hint' }, t('empty.hint')))
      const thinking = h('div', { className: 'sc-thinking' },
        h('span', { className: 'sc-dots', 'aria-hidden': 'true' },
          h('span', null), h('span', null), h('span', null)),
        h('span', null, sending ? t('sending') : t('thinking')))
      const showThinking = busy && liveBlocks.length === 0
      const body = h('div', { className: 'sc-body', ref: bodyRef },
        empty ? emptyBlock : rows,
        pendingRows,
        showThinking ? thinking : null,
        h(ErrorStrip, { error: errorView }),
        h(ErrorStrip, { error: lastErrorView }))
      const sendIcon = hasDraft || !busy ? IconSend : IconStop
      const sendTitle = hasDraft ? t('composer.send') : busy ? t('composer.stop') : t('composer.send')
      const composer = h('div', { className: 'sc-composer' },
        h('textarea', {
          className: 'sc-textarea',
          value: state.draft,
          rows: 1,
          placeholder: hasSession ? t('composer.placeholder') : t('composer.placeholderBlank'),
          onChange: (event) => runtime.setDraft(state.mainId, event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void runtime.send(state.mainId)
            }
          }
        }),
        h('div', { className: 'sc-actions' },
          h('button', {
            type: 'button',
            className: hasDraft ? 'sc-send' : 'sc-send sc-send-stop',
            disabled: !hasDraft && !busy,
            title: sendTitle,
            'aria-label': sendTitle,
            onClick: () => {
              if (hasDraft) void runtime.send(state.mainId)
              else if (busy) void runtime.cancel(state.mainId)
            }
          }, icon(sendIcon))))
      const footer = h('div', { className: 'sc-footer' }, composer)
      return h('div', { className: 'sc-root', role: 'tabpanel', 'aria-label': t('tab.title') },
        statusbar,
        body,
        footer)
    }

    function injectStyle() {
      if (typeof document === 'undefined' || document === null) return null
      if (typeof document.createElement !== 'function' || typeof document.head === 'undefined') return null
      const style = document.createElement('style')
      style.dataset.dyn = STYLE_ATTR
      style.textContent = PANEL_CSS
      document.head.append(style)
      return style
    }

    function apply(ctx) {
      const runtime = createRuntime()
      const t = ctx.locale.bind(LOCALE_NS)
      ctx.effect(() => {
        const disposeZh = ctx.locale.register(LOCALE_NS, 'zh', ZH_DICT)
        const disposeEn = ctx.locale.register(LOCALE_NS, 'en', EN_DICT)
        return () => {
          disposeEn()
          disposeZh()
        }
      }, 'dsh-side-chat: copy')
      ctx.effect(() => {
        const style = injectStyle()
        return () => {
          if (style !== null && typeof style.remove === 'function') style.remove()
        }
      }, 'dsh-side-chat: panel stylesheet')
      ctx.effect(() => () => runtime.dispose(), 'dsh-side-chat: panel runtime')
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: SIDE_CHAT_TYPE_ID,
        kind: SIDE_CHAT_KIND,
        priority: 'extension',
        title: () => t('tab.title'),
        guide: [{
          id: 'side-chat',
          order: 10,
          title: () => t('guide.title'),
          description: () => t('guide.description')
        }],
        keepMounted: true,
        // One tab occurrence owns one side conversation: opening the kind again
        // (guide card, the tab strip's add control, or the in-tab new button)
        // mints a new tab instead of focusing the existing one.
        multiple: true
      }), 'dsh-side-chat: sidebar tab type')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: SIDE_CHAT_TYPE_ID,
        locale: LOCALE_NS,
        inject: (sessionId) => ({ runtime, sessionId, t, locale: ctx.locale })
      }, SideChatBody)), 'dsh-side-chat: sidebar tab body')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: SIDE_CHAT_TYPE_ID,
        locale: LOCALE_NS,
        inject: (sessionId) => ({ runtime, sessionId, t })
      }, SideChatTabTitle)), 'dsh-side-chat: sidebar tab title')
      ctx.effect(() => ctx.sidebarRight.registerCloseHandler(SIDE_CHAT_KIND, (sessionId, tab) => {
        const tabId = tab !== null && tab !== undefined && typeof tab.id === 'string' ? tab.id : undefined
        void runtime.close(instanceKeyOf(sessionId, tabId))
      }), 'dsh-side-chat: sidebar tab close')
    }

    const PANEL_CSS = `
.sc-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  width: 100%;
  background: var(--dsw-alias-bg-base, #ffffff);
  color: var(--dsw-alias-label-primary, #0f1115);
  font-size: 15px;
  line-height: 1.5;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
}
.sc-statusbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  background: var(--dsw-alias-bg-layer-1, #fafafa);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary, #81858c);
}
.sc-status {
  flex: none;
}
.sc-status-extra {
  flex: 1;
  min-width: 0;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sc-new {
  flex: none;
  margin-left: auto;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #61666b);
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  cursor: pointer;
}
.sc-new:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
}
.sc-dot {
  flex: none;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--dsw-alias-state-idle-primary, #b0b4ba);
}
.sc-dot-running {
  background: var(--dsw-alias-state-success-primary, #2f9e63);
  animation: sc-pulse 1.4s ease-in-out infinite;
}
.sc-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
.sc-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.sc-empty {
  margin: auto;
  max-width: 360px;
  padding: 32px 12px;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 10px;
  color: var(--dsw-alias-label-secondary, #61666b);
}
.sc-empty-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #0f1115);
}
.sc-empty-meta {
  font-size: 13px;
  line-height: 20px;
}
.sc-empty-hint {
  font-size: 12px;
  color: var(--dsw-alias-label-quaternary, #9aa0a6);
}
.sc-row {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.sc-row-user {
  align-items: flex-end;
}
.sc-row-assistant {
  align-items: flex-start;
  gap: 8px;
  width: 100%;
}
.sc-user-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  min-width: 0;
  max-width: 86%;
}
.sc-bubble {
  max-width: 100%;
  padding: 9px 14px;
  border-radius: 18px;
  background: var(--dsw-specific-bubble, #edf3fe);
  color: var(--dsw-alias-label-primary, #0f1115);
  font-size: 15px;
  line-height: 23px;
  white-space: pre-wrap;
  word-break: break-word;
}
.sc-bubble-pending {
  opacity: 0.72;
}
.sc-meta {
  margin: 0 4px;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-variant-numeric: tabular-nums;
}
.sc-md-block {
  width: 100%;
  min-width: 0;
  font-size: 15px;
  line-height: 24px;
  color: var(--dsw-alias-label-primary, #0f1115);
  word-break: break-word;
}
.sc-md-block > * + * {
  margin-top: 8px;
}
.sc-md {
  width: 100%;
  min-width: 0;
}
.sc-md-p,
.sc-md-quote,
.sc-md-ul,
.sc-md-ol {
  margin: 0;
}
.sc-md-p {
  white-space: pre-wrap;
}
.sc-md-p + .sc-md-p {
  margin-top: 8px;
}
.sc-md-h1,
.sc-md-h2,
.sc-md-h3,
.sc-md-h4 {
  margin: 10px 0 4px;
  font-weight: 600;
  line-height: 1.35;
}
.sc-md-h1 { font-size: 20px; }
.sc-md-h2 { font-size: 18px; }
.sc-md-h3 { font-size: 16px; }
.sc-md-h4 { font-size: 15px; }
.sc-md-ul,
.sc-md-ol {
  padding-left: 22px;
}
.sc-md-quote {
  padding: 2px 10px;
  border-left: 3px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  color: var(--dsw-alias-label-secondary, #61666b);
}
.sc-md-hr {
  border: none;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  margin: 12px 0;
}
.sc-md-code {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-2, #f3f4f6);
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06));
  overflow-x: auto;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre;
}
.sc-inline-code {
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--dsw-alias-bg-layer-2, #f3f4f6);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 0.9em;
}
.sc-md-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.sc-md-table th,
.sc-md-table td {
  padding: 5px 8px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
  text-align: left;
  vertical-align: top;
}
.sc-md-table th {
  background: var(--dsw-alias-bg-layer-1, #fafafa);
  font-weight: 600;
}
.sc-md-a {
  color: var(--dsw-alias-label-primary-bluish, #2563eb);
  text-decoration: none;
}
.sc-md-a:hover {
  text-decoration: underline;
}
.sc-fold {
  width: 100%;
  min-width: 0;
}
.sc-fold-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  padding: 3px 2px;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #61666b);
  font: inherit;
  font-size: 12.5px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
  border-radius: var(--dsw-radius-sm, 6px);
}
.sc-fold-head:hover {
  color: var(--dsw-alias-label-primary, #0f1115);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04));
}
.sc-fold-chevron {
  flex: none;
  display: inline-block;
  transition: transform 0.12s ease;
  color: var(--dsw-alias-label-tertiary, #81858c);
}
.sc-fold-chevron-open {
  transform: rotate(90deg);
}
.sc-fold-icon {
  flex: none;
}
.sc-fold-title {
  flex: none;
  font-weight: 500;
}
.sc-fold-preview {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary, #81858c);
}
.sc-fold-body {
  margin: 4px 0 2px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-1, #f5f5f6);
}
.sc-reasoning {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--dsw-alias-label-secondary, #61666b);
}
.sc-tool {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.sc-tool-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sc-tool-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #0f1115);
}
.sc-tool-error {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 999px;
  color: var(--dsw-alias-state-error-primary, #c0392b);
  background: var(--dsw-alias-state-error-secondary, rgba(192, 57, 43, 0.12));
}
.sc-tool-args {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--dsw-alias-label-tertiary, #81858c);
  white-space: pre-wrap;
  word-break: break-word;
}
.sc-tool-result {
  padding: 7px 9px;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  background: var(--dsw-alias-bg-base, #ffffff);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary, #61666b);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
}
.sc-context {
  align-self: center;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-size: 11.5px;
  line-height: 18px;
}
.sc-thinking {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 2px 4px;
  color: var(--dsw-alias-label-secondary, #61666b);
  font-size: 12.5px;
}
.sc-dots span {
  display: inline-block;
  width: 5px;
  height: 5px;
  margin-right: 3px;
  border-radius: 50%;
  background: currentColor;
  animation: sc-blink 1.2s infinite;
}
.sc-dots span:nth-child(2) { animation-delay: 0.2s; }
.sc-dots span:nth-child(3) { animation-delay: 0.4s; }
.sc-error {
  align-self: stretch;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-md, 8px);
  border: 1px solid var(--dsw-alias-state-error-secondary, rgba(192, 57, 43, 0.35));
  background: var(--dsw-alias-state-error-tertiary, rgba(192, 57, 43, 0.08));
  color: var(--dsw-alias-state-error-primary, #c0392b);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.sc-error-title {
  font-weight: 500;
}
.sc-error-detail {
  margin-top: 4px;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary, #61666b);
  white-space: pre-wrap;
  word-break: break-word;
}
.sc-footer {
  flex: none;
  padding: 0 14px 12px;
  background: var(--dsw-alias-bg-base, #ffffff);
}
.sc-composer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px 10px 8px;
  border-radius: 20px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  box-shadow: var(--dsw-elevation-soft, 0 1px 6px rgba(0, 0, 0, 0.05));
}
.sc-textarea {
  width: 100%;
  min-height: 26px;
  max-height: 150px;
  padding: 2px 8px 0;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 15px;
  line-height: 23px;
}
.sc-textarea::placeholder {
  color: var(--dsw-alias-label-quaternary, #9aa0a6);
}
.sc-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}
.sc-send {
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: var(--dsw-alias-button-primary-fill, rgb(65, 118, 230));
  color: var(--dsw-alias-label-primary-inverted, #ffffff);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 15px;
}
.sc-send:hover {
  background: var(--dsw-alias-button-primary-hover, rgb(52, 102, 210));
}
.sc-send:disabled {
  opacity: 0.45;
  cursor: default;
}
.sc-send-stop {
  background: var(--dsw-alias-button-elevated-fill, #eef0f3);
  color: var(--dsw-alias-label-primary, #0f1115);
}
.sc-send-stop:hover {
  background: var(--dsw-alias-interactive-bg-hover, #e4e7ec);
}
@keyframes sc-blink {
  0%, 80%, 100% { opacity: 0.2; }
  40% { opacity: 1; }
}
@keyframes sc-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
`

    exports.name = 'dsh-side-chat'
    exports.inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'locale']
    exports.apply = apply
    exports.createRuntime = createRuntime
    exports.foldEntries = foldEntries
    exports.createSseParser = createSseParser
    exports.normalizeLive = normalizeLive
    exports.liveAttemptOf = liveAttemptOf
    exports.liveBlocksOf = liveBlocksOf
    exports.isCommittedSettlement = isCommittedSettlement
    exports.isBoundaryMessage = isBoundaryMessage
    exports.isBoundaryEvent = isBoundaryEvent
    exports.isInheritedEvent = isInheritedEvent
    exports.isBoundaryText = (text) => isBoundaryMessage(null, text)
    exports.apiPath = apiPath
    exports.instanceKeyOf = instanceKeyOf
    exports.clockOf = clockOf
    exports.renderMarkdownFallback = renderMarkdownFallback
    exports.SIDE_CHAT_TYPE_ID = SIDE_CHAT_TYPE_ID
    exports.SIDE_CHAT_KIND = SIDE_CHAT_KIND
    exports.LOCALE_NS = LOCALE_NS
    exports.ZH_DICT = ZH_DICT
    exports.EN_DICT = EN_DICT
    exports.formatError = formatError
    exports.statusLabel = statusLabel
    exports.pendingLabel = pendingLabel
    exports.contextLabel = contextLabel
    exports.PANEL_CSS = PANEL_CSS

    return module.exports
  }
})
