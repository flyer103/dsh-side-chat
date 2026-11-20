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
    const COMPOSER_MIN_HEIGHT_PX = 26
    const COMPOSER_MAX_HEIGHT_PX = 336
    const COMPOSER_MAX_HEIGHT_SHARE = 0.5
    const IMAGE_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
    const IMAGE_MEDIA_TYPE_SET = new Set(IMAGE_MEDIA_TYPES)
    const IMAGE_ACCEPT = IMAGE_MEDIA_TYPES.join(',')

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
      'dock.tokens': '{count} tok',
      'dock.cacheHit': '缓存命中 {percent}%',
      'dock.contextAria': '上下文已用 {percent}',
      'dock.contextTitle': '约 {used} / {window} tok',
      'dock.usageTitle': '未缓存输入 {input} · 缓存读取 {cacheRead} · 输出 {output}',
      'dock.usageTitleWithWrite': '未缓存输入 {input} · 缓存读取 {cacheRead} · 缓存写入 {cacheWrite} · 输出 {output}',
      'dock.thousand': '{value}K',
      'dock.million': '{value}M',
      'dock.groupSeparator': ',',
      'empty.title': '侧边会话',
      'empty.metaBlank': '发送第一条消息时创建侧边会话，继承当前会话上下文',
      'empty.metaCreated': '已创建侧边会话，等待回复…',
      'empty.hint': 'Enter 发送，Shift+Enter 换行',
      'restore.title': '恢复已保存的侧边对话',
      'composer.placeholder': '输入消息…',
      'composer.placeholderBlank': '描述你想了解什么…',
      'composer.send': '发送',
      'composer.stop': '停止生成',
      'reference.menu': '引用',
      'reference.files': '文件与文件夹',
      'reference.sessions': '会话',
      'reference.loading': '正在搜索…',
      'reference.empty': '没有匹配的引用',
      'reference.noCwd': '（无工作目录）',
      'reference.timeNow': '刚刚',
      'reference.timeMinutes': '{n}分钟',
      'reference.timeHours': '{n}小时',
      'reference.timeDays': '{n}天',
      'reference.timeMonths': '{n}个月',
      'reference.timeYears': '{n}年',
      'thinking': '思考中…',
      'sending': '发送中…',
      'fold.reasoning': '思考',
      'process.worked': '已完成',
      'process.took': '已完成，用时 ',
      'process.failed': '处理失败',
      'process.stopped': '已停止',
      'fold.tools': '工具调用 {count}',
      'markdown.copy': '复制',
      'markdown.copied': '复制成功',
      'markdown.tableCopy': '复制表格',
      'markdown.tableCopied': '已复制',
      'markdown.codeBlock.title': '代码块',
      'markdown.codeBlock.wrap': '自动换行',
      'markdown.codeBlock.unwrap': '取消自动换行',
      'markdown.footnotes': '脚注',
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
      'tool.showOutput': '显示输出',
      'tool.hideOutput': '隐藏输出',
      'image.add': '添加图片',
      'image.alt': '图片',
      'image.dropHint': '松开以添加图片',
      'image.uploading': '上传中…',
      'image.failed': '图片不可用',
      'image.remove': '移除图片',
      'image.retry': '重试上传',
      'image.queueLabel': '图片',
      'image.reason.UNSUPPORTED_IMAGE_TYPE': '不支持的图片格式（仅支持 PNG/JPEG/WebP/GIF）',
      'image.reason.IMAGE_TOO_LARGE': '图片超过大小限制',
      'image.reason.IMAGE_TOO_MANY_PIXELS': '图片像素过多',
      'image.reason.IMAGE_DIMENSION_TOO_LARGE': '图片尺寸过大',
      'image.reason.IMAGE_TYPE_MISMATCH': '图片内容与声明格式不符',
      'image.reason.INVALID_IMAGE': '图片无法解析',
      'image.reason.TOO_MANY_IMAGES': '单条消息的图片数量超出限制',
      'image.reason.IMAGES_TOO_LARGE': '单条消息的图片总量超出限制',
      'image.reason.ATTACHMENT_NOT_FOUND': '图片已失效，请重新添加',
      'image.reason.ATTACHMENT_CORRUPT': '图片已损坏',
      'image.reason.ATTACHMENT_WRITE_FAILED': '图片保存失败',
      'image.reason.MODEL_DOES_NOT_SUPPORT_IMAGES': '当前模型不支持图片输入',
      'image.reason.unknown': '图片处理失败',
      'error.attachmentRejected': '图片处理失败',
      'error.unknownSource': '原会话已不在，无法创建侧边会话',
      'error.notFound': '侧边会话已不存在（可能已被销毁）',
      'error.emptyPrompt': '消息为空',
      'error.createFailed': '创建侧边会话失败',
      'error.promptFailed': '发送消息失败',
      'error.disposeFailed': '销毁侧边会话失败',
      'error.internal': '侧边会话内部错误',
      'error.unknown': '出错了',
      'question.title': '主会话正在提出的问题',
      'question.discuss': '在侧边对话里讨论',
      'question.dismiss': '隐藏'
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
      'dock.tokens': '{count} tok',
      'dock.cacheHit': 'Cache hit {percent}%',
      'dock.contextAria': '{percent} of context used',
      'dock.contextTitle': '~{used} / {window} tok',
      'dock.usageTitle': 'Uncached {input} · cached {cacheRead} · output {output}',
      'dock.usageTitleWithWrite': 'Uncached {input} · cached {cacheRead} · cache write {cacheWrite} · output {output}',
      'dock.thousand': '{value}K',
      'dock.million': '{value}M',
      'dock.groupSeparator': ',',
      'empty.title': 'Side chat',
      'empty.metaBlank': 'The side conversation is created when you send the first message and inherits this session’s context',
      'empty.metaCreated': 'Side conversation created. Waiting for a reply…',
      'empty.hint': 'Enter to send, Shift+Enter for a new line',
      'restore.title': 'Restore a saved side chat',
      'composer.placeholder': 'Type a message…',
      'composer.placeholderBlank': 'Ask anything about this session…',
      'composer.send': 'Send message',
      'composer.stop': 'Stop generating',
      'reference.menu': 'References',
      'reference.files': 'Files & folders',
      'reference.sessions': 'Sessions',
      'reference.loading': 'Searching…',
      'reference.empty': 'No matching references',
      'reference.noCwd': '(no cwd)',
      'reference.timeNow': 'now',
      'reference.timeMinutes': '{n}min',
      'reference.timeHours': '{n}h',
      'reference.timeDays': '{n}d',
      'reference.timeMonths': '{n}mo',
      'reference.timeYears': '{n}y',
      'thinking': 'Thinking…',
      'sending': 'Sending…',
      'fold.reasoning': 'Reasoning',
      'process.worked': 'Completed',
      'process.took': 'Completed in ',
      'process.failed': 'Failed',
      'process.stopped': 'Stopped',
      'fold.tools': 'Tool calls ({count})',
      'markdown.copy': 'Copy',
      'markdown.copied': 'Copied',
      'markdown.tableCopy': 'Copy table',
      'markdown.tableCopied': 'Copied',
      'markdown.codeBlock.title': 'Code block',
      'markdown.codeBlock.wrap': 'Wrap lines',
      'markdown.codeBlock.unwrap': 'Do not wrap lines',
      'markdown.footnotes': 'Footnotes',
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
      'tool.showOutput': 'Show output',
      'tool.hideOutput': 'Hide output',
      'image.add': 'Add image',
      'image.alt': 'Image',
      'image.dropHint': 'Drop to add images',
      'image.uploading': 'Uploading…',
      'image.failed': 'Image unavailable',
      'image.remove': 'Remove image',
      'image.retry': 'Retry upload',
      'image.queueLabel': 'Image',
      'image.reason.UNSUPPORTED_IMAGE_TYPE': 'Unsupported image format (PNG/JPEG/WebP/GIF only)',
      'image.reason.IMAGE_TOO_LARGE': 'The image exceeds the size limit',
      'image.reason.IMAGE_TOO_MANY_PIXELS': 'The image has too many pixels',
      'image.reason.IMAGE_DIMENSION_TOO_LARGE': 'The image dimensions are too large',
      'image.reason.IMAGE_TYPE_MISMATCH': 'The image bytes do not match the declared type',
      'image.reason.INVALID_IMAGE': 'The image could not be decoded',
      'image.reason.TOO_MANY_IMAGES': 'Too many images in one message',
      'image.reason.IMAGES_TOO_LARGE': 'The images in one message are too large in total',
      'image.reason.ATTACHMENT_NOT_FOUND': 'The image is no longer available; add it again',
      'image.reason.ATTACHMENT_CORRUPT': 'The stored image is corrupt',
      'image.reason.ATTACHMENT_WRITE_FAILED': 'The image could not be stored',
      'image.reason.MODEL_DOES_NOT_SUPPORT_IMAGES': 'The current model does not accept image input',
      'image.reason.unknown': 'Image processing failed',
      'error.attachmentRejected': 'Image processing failed',
      'error.unknownSource': 'The source session is gone; the side conversation cannot be created',
      'error.notFound': 'The side conversation no longer exists (it may have been destroyed)',
      'error.emptyPrompt': 'The message is empty',
      'error.createFailed': 'Could not create the side conversation',
      'error.promptFailed': 'Could not send the message',
      'error.disposeFailed': 'Could not destroy the side conversation',
      'error.internal': 'Side conversation internal error',
      'error.unknown': 'Something went wrong',
      'question.title': 'The main conversation is asking',
      'question.discuss': 'Discuss in side chat',
      'question.dismiss': 'Dismiss'
    }

    const CONTEXT_TAGS = new Set(['skill', 'steering', 'sessionReference', 'agentInstructions', 'compactCheckpoint', 'generic'])

    const ERROR_KEYS = {
      'unknown-source': 'error.unknownSource',
      'not-found': 'error.notFound',
      'empty-prompt': 'error.emptyPrompt',
      'create-failed': 'error.createFailed',
      'prompt-failed': 'error.promptFailed',
      'dispose-failed': 'error.disposeFailed',
      'attachment-rejected': 'error.attachmentRejected',
      'internal': 'error.internal'
    }

    /** Stable attachment rejection reasons with localized copy (unknown falls back). */
    const IMAGE_REASON_KEYS = {
      UNSUPPORTED_IMAGE_TYPE: 'image.reason.UNSUPPORTED_IMAGE_TYPE',
      IMAGE_TOO_LARGE: 'image.reason.IMAGE_TOO_LARGE',
      IMAGE_TOO_MANY_PIXELS: 'image.reason.IMAGE_TOO_MANY_PIXELS',
      IMAGE_DIMENSION_TOO_LARGE: 'image.reason.IMAGE_DIMENSION_TOO_LARGE',
      IMAGE_TYPE_MISMATCH: 'image.reason.IMAGE_TYPE_MISMATCH',
      INVALID_IMAGE: 'image.reason.INVALID_IMAGE',
      INVALID_IMAGE_BASE64: 'image.reason.INVALID_IMAGE',
      TOO_MANY_IMAGES: 'image.reason.TOO_MANY_IMAGES',
      IMAGES_TOO_LARGE: 'image.reason.IMAGES_TOO_LARGE',
      ATTACHMENT_NOT_FOUND: 'image.reason.ATTACHMENT_NOT_FOUND',
      ATTACHMENT_CORRUPT: 'image.reason.ATTACHMENT_CORRUPT',
      ATTACHMENT_WRITE_FAILED: 'image.reason.ATTACHMENT_WRITE_FAILED',
      MODEL_DOES_NOT_SUPPORT_IMAGES: 'image.reason.MODEL_DOES_NOT_SUPPORT_IMAGES'
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
      const reason = typeof error.reason === 'string' && error.reason !== '' ? error.reason : undefined
      return { code, message, params, ...(reason === undefined ? {} : { reason }) }
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
      const title = record.code === 'attachment-rejected' && record.reason !== undefined
        ? t(imageReasonKey(record.reason))
        : t(errorKeyOf(record.code), record.params)
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

    // Status-dock metrics. The panel only ever receives events above the fork
    // floor, so folding those entries yields what this side chat itself spent:
    // the parent's own historical usage events are never re-counted. Context
    // occupancy is absolute — the inherited prefix really is in the next prompt.

    const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']

    /**
     * Normalize one provider usage record into billing buckets.
     * @param value - `TokenUsage`-shaped value from an event or stream chunk.
     * @returns buckets, or null when the value carries no recognizable figure.
     */
    function usageBucketsOf(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
      const buckets = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
      let recognized = false
      for (const field of USAGE_FIELDS) {
        const raw = value[field]
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) continue
        recognized = true
        buckets[field === 'inputTokens' ? 'uncachedInputTokens' : field] = raw
      }
      return recognized ? buckets : null
    }

    /** Usage carried by the last `usage` chunk of one compact assistant stream, if any. */
    function streamUsageOf(stream) {
      if (!Array.isArray(stream)) return null
      for (let index = stream.length - 1; index >= 0; index -= 1) {
        const record = stream[index]
        if (record === null || typeof record !== 'object' || record.type !== 'chunk') continue
        const chunk = record.chunk
        if (chunk === null || typeof chunk !== 'object' || chunk.type !== 'usage') continue
        const buckets = usageBucketsOf(chunk.usage)
        if (buckets !== null) return buckets
      }
      return null
    }

    /** Usage of one settled assistant event: the settlement field, else its stream chunk. */
    function usageOfEntry(event) {
      if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return null
      const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
      const direct = usageBucketsOf(data.usage)
      if (direct !== null) return direct
      return streamUsageOf(data.stream)
    }

    /**
     * Fold the panel's visible entries into the dock readings.
     *
     * Mirrors the `tokenUsage` / `contextPressure` fold semantics the main chat
     * uses, over the side chat's own events only: a re-settled turn/step replaces
     * its previous sample, `llm/retry-started` closes the replacement slot, and
     * the newest sample supplies the prompt-side pressure. The context-window
     * denominator comes from the newest `request/context` in the fold; the host
     * baseline supplies it when the side session inherited the parent's.
     * @param entries - snapshot/SSE entries.
     * @param inheritedEventCount - fork floor; inherited entries are ignored.
     * @returns the readings, or null when the side chat has no usage sample.
     */
    function metricsOf(entries, inheritedEventCount) {
      const totals = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
      let last = null
      let pressureTokens = null
      let contextWindow = null
      for (const event of asArray(entries)) {
        if (event === null || typeof event !== 'object') continue
        if (isInheritedEvent(event, inheritedEventCount)) continue
        if (event.type === 'request/context') {
          const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
          const window = data.contextWindow
          if (typeof window === 'number' && Number.isFinite(window) && window > 0) contextWindow = window
          continue
        }
        if (event.type === 'llm/retry-started') {
          const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
          if (last !== null && last.turn === data.turn && last.step === data.step) last = null
          continue
        }
        const buckets = usageOfEntry(event)
        if (buckets === null) continue
        const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
        const turn = typeof data.turn === 'number' ? data.turn : null
        const step = typeof data.step === 'number' ? data.step : null
        if (turn !== null && step !== null && last !== null && last.turn === turn && last.step === step) {
          for (const field of Object.keys(totals)) totals[field] -= last.buckets[field]
        }
        for (const field of Object.keys(totals)) totals[field] += buckets[field]
        last = turn === null || step === null ? null : { turn, step, buckets }
        pressureTokens = buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens
      }
      const billedInputTokens = totals.uncachedInputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
      const totalTokens = billedInputTokens + totals.outputTokens
      if (billedInputTokens === 0 && totalTokens === 0) return null
      return {
        ...totals,
        billedInputTokens,
        totalTokens,
        pressureTokens,
        cacheHitPercent: cacheHitText(totals.cacheReadTokens, billedInputTokens),
        contextWindow
      }
    }

    /**
     * Cache-hit percentage as display text. A partial hit never rounds up to
     * 100%: the value falls back to one decimal from 99.9, and only an exact
     * full hit reads 100.
     * @param cacheReadTokens - cache-read prompt tokens.
     * @param billedInputTokens - prompt-side tokens (uncached + cache read + cache write).
     * @returns percent text, or null when nothing was billed.
     */
    function cacheHitText(cacheReadTokens, billedInputTokens) {
      if (!(billedInputTokens > 0)) return null
      if (cacheReadTokens >= billedInputTokens) return '100'
      const percent = cacheReadTokens / billedInputTokens * 100
      const whole = Math.round(percent)
      if (whole < 100) return String(whole)
      return String(Math.floor(percent * 10) / 10)
    }

    /**
     * Context occupancy for one metrics record: `min(100, round(used / window))`.
     * The window prefers the entry fold's own `request/context` and falls back to
     * the host baseline (a seeded session inherits the parent's context record).
     * @param metrics - `metricsOf` result.
     * @param baselineContextWindow - host-reported window, if any.
     * @returns `{ percent, usedTokens, contextWindow }`, or null until both exist.
     */
    function occupancyOf(metrics, baselineContextWindow) {
      if (metrics === null || metrics === undefined || typeof metrics !== 'object') return null
      const usedTokens = metrics.pressureTokens
      const contextWindow = typeof metrics.contextWindow === 'number' && metrics.contextWindow > 0
        ? metrics.contextWindow
        : (typeof baselineContextWindow === 'number' && baselineContextWindow > 0 ? baselineContextWindow : null)
      if (typeof usedTokens !== 'number' || !Number.isFinite(usedTokens) || usedTokens < 0) return null
      if (contextWindow === null) return null
      return {
        percent: Math.min(100, Math.round(usedTokens / contextWindow * 100)),
        usedTokens,
        contextWindow
      }
    }

    /** Compact token count: 517 / 12.2K / 517K / 1.2M (locale owns the suffix). */
    function formatTokenCount(t, value) {
      const scaled = (candidate) => candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10)
      if (!(value > 0)) return '0'
      if (value < 1000) return String(Math.round(value))
      if (value < 1000000) return t('dock.thousand', { value: scaled(value / 1000) })
      return t('dock.million', { value: scaled(value / 1000000) })
    }

    /** Exact token count with locale-owned digit grouping. */
    function formatExactTokenCount(t, value) {
      const digits = String(Math.max(0, Math.round(value)))
      const groups = []
      for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end))
      return groups.join(t('dock.groupSeparator'))
    }


    /** Shell components may be plain functions or `memo` / `forwardRef` objects ($$typeof). */
    function isComponentType(value) {
      if (typeof value === 'function') return true
      return typeof value === 'object' && value !== null && value.$$typeof !== undefined
    }

    const MarkdownText = primitives !== null && isComponentType(primitives.MarkdownText)
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

    function positiveIntegerOf(value) {
      const number = typeof value === 'number' ? value : Number(value)
      return Number.isSafeInteger(number) && number > 0 ? number : undefined
    }

    function isImageMediaType(value) {
      return typeof value === 'string' && IMAGE_MEDIA_TYPE_SET.has(value)
    }

    /** Normalize one image reference from an event block or an upload answer. */
    function imageRefOf(value) {
      if (value === null || typeof value !== 'object') return undefined
      const attachmentId = typeof value.attachmentId === 'string' ? value.attachmentId : ''
      if (!/^sha256:[a-f0-9]{64}$/.test(attachmentId)) return undefined
      const mediaType = typeof value.mediaType === 'string' ? value.mediaType : ''
      if (mediaType === '') return undefined
      const width = positiveIntegerOf(value.width)
      const height = positiveIntegerOf(value.height)
      const bytes = positiveIntegerOf(value.bytes)
      if (width === undefined || height === undefined || bytes === undefined) return undefined
      const ref = { attachmentId, mediaType, width, height, bytes }
      if (typeof value.name === 'string' && value.name.trim() !== '') ref.name = value.name.trim()
      return ref
    }

    /** Durable images carried by one message content list, in message order. */
    function imageRefsOfContent(content) {
      const refs = []
      for (const block of blocksOf(content)) {
        if (block.type !== 'image') continue
        const ref = imageRefOf(block.attachment)
        if (ref !== undefined) refs.push(ref)
      }
      return refs
    }

    /** `<img>` source of one durable image; the host serves bytes for these params. */
    function imageUrlOf(sessionId, ref) {
      const query = [
        ['sessionId', typeof sessionId === 'string' ? sessionId : ''],
        ['attachmentId', ref.attachmentId],
        ['mediaType', ref.mediaType],
        ['width', String(ref.width)],
        ['height', String(ref.height)],
        ['bytes', String(ref.bytes)]
      ]
      return apiPath('image') + '?' + query
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&')
    }

    function imageReasonKey(reason) {
      return typeof reason === 'string' && IMAGE_REASON_KEYS[reason] !== undefined
        ? IMAGE_REASON_KEYS[reason]
        : 'image.reason.unknown'
    }

    /** Localized copy for one attachment rejection record. */
    function imageReasonText(t, failure) {
      const record = failureOf(failure)
      return t(imageReasonKey(record.reason))
    }

    /** Image files of a `DataTransfer` / clipboard payload, in payload order. */
    function imageFilesOf(source) {
      const files = []
      if (source === null || typeof source !== 'object') return files
      const items = source.items
      if (items !== null && items !== undefined && typeof items.length === 'number') {
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index]
          if (item === null || typeof item !== 'object' || item.kind !== 'file') continue
          const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null
          if (imageFileOf(file) !== undefined) files.push(file)
        }
        if (files.length > 0) return files
      }
      const list = source.files
      if (list !== null && list !== undefined && typeof list.length === 'number') {
        for (let index = 0; index < list.length; index += 1) {
          const file = list[index]
          if (imageFileOf(file) !== undefined) files.push(file)
        }
      }
      return files
    }

    function imageFileOf(file) {
      if (file === null || typeof file !== 'object') return undefined
      if (!isImageMediaType(file.type)) return undefined
      if (typeof file.size === 'number' && file.size === 0) return undefined
      return file
    }

    function imageNameOf(file) {
      return typeof file?.name === 'string' ? file.name : ''
    }

    /** Local preview URL for a picked file; undefined when the environment has no object URLs. */
    function previewUrlOf(file) {
      try {
        if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return undefined
        return URL.createObjectURL(file)
      } catch (error) {
        return undefined
      }
    }

    function revokePreviewUrl(url) {
      if (typeof url !== 'string' || url === '') return
      try {
        if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url)
      } catch (error) {
        // A revoked or foreign URL must never break the panel.
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
      /** turn number (or 'current') -> lifecycle and its one process node. */
      const turns = new Map()
      let currentTurn = null
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
        if (event.type === 'turn/start') {
          const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
          const number = typeof data.turn === 'number' ? data.turn : null
          const turn = { number, start: event.time, end: undefined, reason: undefined, node: null }
          turns.set(number === null ? 'current' : number, turn)
          currentTurn = turn
          continue
        }
        if (event.type === 'turn/end') {
          const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
          const number = typeof data.turn === 'number' ? data.turn : null
          const key = number === null
            ? (currentTurn !== null && currentTurn.number !== null ? currentTurn.number : 'current')
            : number
          const turn = turns.get(key)
          if (turn !== undefined) {
            turn.end = event.time
            turn.reason = data.reason !== null && data.reason !== undefined && typeof data.reason === 'object' ? data.reason.kind : undefined
            if (turn.node !== null) {
              turn.node.end = turn.end
              turn.node.reason = turn.reason
            }
          }
          continue
        }
        if (event.type === 'user/message') {
          if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') continue
          const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
          const text = textOfContent(data.content)
          if (isBoundaryMessage(data.source, text)) continue
          const images = imageRefsOfContent(data.content)
          if (text === '' && images.length === 0) continue
          const source = data.source !== null && typeof data.source === 'object' ? data.source : {}
          if (source.kind === 'user' || source.kind === undefined) {
            nodes.push({ kind: 'user', seq: event.seq, time: event.time, text, images })
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
          const number = typeof data.turn === 'number' ? data.turn : null
          const key = number === null
            ? (currentTurn !== null && currentTurn.number !== null ? currentTurn.number : 'current')
            : number
          let turn = turns.get(key)
          if (turn === undefined) {
            turn = { number, start: undefined, end: undefined, reason: undefined, node: null }
            turns.set(key, turn)
          }
          // Process blocks (reasoning, tool calls) fold into one collapsible row per
          // turn, like the main transcript; only text stays in the assistant row.
          if (turn.node === null) {
            turn.node = { kind: 'process', seq: event.seq, time: event.time, turn: number, start: turn.start, end: turn.end, reason: turn.reason, blocks: [] }
            nodes.push(turn.node)
          }
          for (const block of blocks) {
            if (block.kind === 'text') continue
            turn.node.blocks.push(block)
          }
          const textBlocks = blocks.filter((block) => block.kind === 'text')
          if (textBlocks.length > 0) nodes.push({ kind: 'assistant', seq: event.seq, time: event.time, blocks: textBlocks })
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
          if (node.kind !== 'assistant' && node.kind !== 'process') continue
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

    /**
     * Split one GFM table row into trimmed cells. A `\|` sequence is a literal pipe
     * inside a cell, not a separator; leading and trailing delimiter pipes are dropped.
     */
    function splitTableRow(line) {
      const source = line.trim()
      const start = source.startsWith('|') ? 1 : 0
      let end = source.length
      if (end > start && source[end - 1] === '|' && source[end - 2] !== '\\') end -= 1
      const cells = []
      let current = ''
      for (let position = start; position < end; position += 1) {
        const character = source[position]
        if (character === '\\' && source[position + 1] === '|') {
          current += '|'
          position += 1
          continue
        }
        if (character === '|') {
          cells.push(current.trim())
          current = ''
          continue
        }
        current += character
      }
      cells.push(current.trim())
      return cells
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
          const parsed = rows
            .filter((unused, rowIndex) => rowIndex !== 1)
            .map((row) => splitTableRow(row))
          const width = parsed.length === 0 ? 0 : parsed[0].length
          const cells = parsed.map((row) => {
            const normalized = row.slice(0, width)
            while (normalized.length < width) normalized.push('')
            return normalized
          })
          blocks.push(h('div', { key: `${keyBase}-t${blocks.length}`, className: 'sc-md-table-wrap' },
            h('table', { className: 'sc-md-table' },
              h('tbody', null, cells.map((row, rowIndex) => h('tr', { key: rowIndex },
                row.map((cell, cellIndex) => h(rowIndex === 0 ? 'th' : 'td', { key: cellIndex },
                  renderInline(cell, `${keyBase}-t${blocks.length}-${rowIndex}-${cellIndex}`)))))))))
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

    // The shell renderer enters math only at `$`, `$$`, `\(` and a line-start
    // `\[`, so a bare display environment (`\begin{align}…\end{align}`) stays
    // literal even though KaTeX supports it. Wrap the supported ones into a
    // display-math fence before the settled text reaches the shell renderer.

    const TEX_DISPLAY_ENVIRONMENTS = new Set([
      'CD', 'align', 'align*', 'aligned', 'alignedat', 'alignat', 'alignat*',
      'array', 'bmatrix', 'bmatrix*', 'Bmatrix', 'Bmatrix*', 'cases', 'darray',
      'dcases', 'drcases', 'equation', 'equation*', 'gather', 'gather*', 'gathered',
      'matrix', 'matrix*', 'pmatrix', 'pmatrix*', 'rcases', 'smallmatrix', 'split',
      'subarray', 'vmatrix', 'vmatrix*', 'Vmatrix', 'Vmatrix*'
    ])

    function texFenceAt(line) {
      const match = /^ {0,3}(`{3,}|~{3,})/.exec(line)
      if (match === null) return null
      return { marker: match[1][0], length: match[1].length }
    }

    function texFenceCloses(line, fence) {
      const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
      return match !== null && match[1][0] === fence.marker && match[1].length >= fence.length
    }

    function texMathModeOf(line) {
      if (/^ {0,3}\$\$\s*$/.test(line)) return '$$'
      const bracket = /^ {0,3}\\\[/.exec(line)
      if (bracket !== null && line.indexOf('\\]', bracket[0].length) < 0) return '\\]'
      const parenthesis = /^ {0,3}\\\(/.exec(line)
      if (parenthesis !== null && line.indexOf('\\)', parenthesis[0].length) < 0) return '\\)'
      return null
    }

    function texMathCloses(line, marker) {
      if (marker === '$$') return /^ {0,3}\$\$\s*$/.test(line)
      if (marker === '\\]') return /^ {0,3}\\\]\s*$/.test(line)
      return line.indexOf('\\)') >= 0
    }

    function bareTexEnvironmentOf(line) {
      const match = /^\\begin\{([A-Za-z]+\*?)\}/.exec(line)
      if (match === null || !TEX_DISPLAY_ENVIRONMENTS.has(match[1])) return null
      return { name: match[1], length: match[0].length }
    }

    /**
     * Wrap a column-0 bare display environment into a `$$` block. Code fences,
     * existing math, unknown environments, an unclosed environment, a closing
     * tag with trailing text and every indented environment stay literal.
     */
    function normalizeBareTexEnvironments(text) {
      if (typeof text !== 'string' || text.indexOf('\\begin{') < 0) return text
      const lines = text.split('\n')
      const output = []
      let fence = null
      let math = null
      let index = 0
      while (index < lines.length) {
        const line = lines[index]
        if (fence !== null) {
          output.push(line)
          if (texFenceCloses(line, fence)) fence = null
          index += 1
          continue
        }
        if (math !== null) {
          output.push(line)
          if (texMathCloses(line, math)) math = null
          index += 1
          continue
        }
        const openedFence = texFenceAt(line)
        if (openedFence !== null) {
          fence = openedFence
          output.push(line)
          index += 1
          continue
        }
        const openedMath = texMathModeOf(line)
        if (openedMath !== null) {
          math = openedMath
          output.push(line)
          index += 1
          continue
        }
        const environment = bareTexEnvironmentOf(line)
        if (environment === null) {
          output.push(line)
          index += 1
          continue
        }
        const close = `\\end{${environment.name}}`
        let end = -1
        for (let cursor = index; cursor < lines.length; cursor += 1) {
          const from = cursor === index ? line.indexOf(close, environment.length) : lines[cursor].indexOf(close)
          if (from < 0) continue
          if (lines[cursor].slice(from + close.length).trim() !== '') break
          end = cursor
          break
        }
        if (end < 0) {
          output.push(line)
          index += 1
          continue
        }
        output.push('$$')
        for (let cursor = index; cursor <= end; cursor += 1) output.push(lines[cursor])
        output.push('$$')
        index = end + 1
      }
      return output.join('\n')
    }

    // Copy affordances for committed Markdown. The shell renderer owns code
    // cards (their toolbar already copies) but exposes no per-table control, so
    // tables are decorated in the DOM after commit: one chip per table appended
    // to its scroll container, re-synced as the stream mutates the subtree. The
    // fallback renderer's code fences are decorated too, since nothing copies
    // them otherwise.

    const COPY_CHIP_CLASS = 'sc-copy-chip'
    const COPY_HOST_CLASS = 'sc-copy-host'
    const COPY_FEEDBACK_MS = 1200

    /** Collapse whitespace so one cell stays one clipboard field. */
    function normalizeCellText(value) {
      return String(value === undefined || value === null ? '' : value).replace(/\s+/gu, ' ').trim()
    }

    /** Rendered cells of one table: normalized text plus whether the cell is a header. */
    function tableCellsOfElement(table) {
      const rows = table !== null && table !== undefined && table.rows !== undefined
        ? Array.from(table.rows)
        : []
      return rows.map((row) => (row.cells === undefined ? [] : Array.from(row.cells).map((cell) => ({
        text: normalizeCellText(cell.textContent),
        header: typeof cell.tagName === 'string' && cell.tagName.toUpperCase() === 'TH'
      }))))
    }

    /**
     * Tab-separated payload of rendered rows: one line per row, one tab per
     * column, so a paste into a spreadsheet splits back into the same grid.
     * @param rows - cell text, already flattened from the render tree.
     */
    function tableToTsv(rows) {
      const lines = Array.isArray(rows) ? rows : []
      return lines
        .map((row) => (Array.isArray(row) ? row.map(normalizeCellText).join('\t') : ''))
        .join('\n')
    }

    const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }

    /** Escape one cell's text for the clipboard HTML fragment. */
    function escapeHtmlText(value) {
      return String(value).replace(/[&<>"]/gu, (character) => HTML_ESCAPES[character])
    }

    /**
     * HTML table of rendered rows. Rich-text targets rebuild a table only from
     * `text/html`; the same payload as `text/plain` TSV pastes as one run of
     * text there, which is why both flavours travel together.
     * @param rows - `{ text, header }` cells read from the rendered table.
     */
    function tableToHtml(rows) {
      const lines = Array.isArray(rows) ? rows : []
      if (lines.length === 0) return ''
      const rowHtml = (row) => `<tr>${(Array.isArray(row) ? row : []).map((cell) => {
        const source = cell !== null && typeof cell === 'object' ? cell : { text: cell }
        const tag = source.header === true ? 'th' : 'td'
        return `<${tag}>${escapeHtmlText(normalizeCellText(source.text))}</${tag}>`
      }).join('')}</tr>`
      const firstRow = Array.isArray(lines[0]) ? lines[0] : []
      const leadingHeader = firstRow.length > 0 && firstRow.every((cell) => cell !== null
        && typeof cell === 'object' && cell.header === true)
      const head = leadingHeader ? `<thead>${rowHtml(lines[0])}</thead>` : ''
      const bodyRows = leadingHeader ? lines.slice(1) : lines
      const body = bodyRows.length === 0 ? '' : `<tbody>${bodyRows.map(rowHtml).join('')}</tbody>`
      return `<table>${head}${body}</table>`
    }

    /** Clipboard write: async API first, the legacy textarea path when it is absent. */
    function copyTextToClipboard(text) {
      if (typeof navigator !== 'undefined' && navigator !== null
        && navigator.clipboard !== undefined && navigator.clipboard !== null
        && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(text).then(() => true, () => false)
      }
      if (typeof document === 'undefined' || document === null || typeof document.execCommand !== 'function') {
        return Promise.resolve(false)
      }
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.left = '-9999px'
      document.body.appendChild(area)
      area.select()
      let copied = false
      try {
        copied = document.execCommand('copy') === true
      } catch (error) {
        copied = false
      } finally {
        if (typeof area.remove === 'function') area.remove()
      }
      return Promise.resolve(copied)
    }

    /** One `ClipboardItem` carrying the payload as HTML and as plain text. */
    function clipboardDataOf(text, html) {
      if (typeof Blob !== 'function') return { 'text/plain': text, 'text/html': html }
      return {
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' })
      }
    }

    /**
     * Write one table payload. The async API carries both flavours in a single
     * item, so a rich-text target still sees a table; when it is missing or
     * rejects the item, fall back to the TSV text so spreadsheets keep working.
     */
    function copyPayloadToClipboard(payload) {
      const text = payload !== null && payload !== undefined && typeof payload.text === 'string' ? payload.text : ''
      const html = payload !== null && payload !== undefined && typeof payload.html === 'string' ? payload.html : ''
      const clipboard = typeof navigator === 'undefined' || navigator === null ? undefined : navigator.clipboard
      if (html !== '' && clipboard !== undefined && clipboard !== null
        && typeof clipboard.write === 'function' && typeof ClipboardItem === 'function') {
        try {
          const item = new ClipboardItem(clipboardDataOf(text, html))
          return clipboard.write([item]).then(() => true, () => copyTextToClipboard(text))
        } catch (error) {
          return copyTextToClipboard(text)
        }
      }
      return copyTextToClipboard(text)
    }

    /** Text of one host minus the appended chip (the chip is a child of the pre). */
    function textWithoutCopyChip(host) {
      const nodes = host.childNodes !== undefined
        ? Array.from(host.childNodes)
        : (host.children === undefined ? [] : Array.from(host.children))
      let text = ''
      for (const node of nodes) {
        if (node.classList !== undefined && typeof node.classList.contains === 'function'
          && node.classList.contains(COPY_CHIP_CLASS)) continue
        if (node.textContent !== undefined && node.textContent !== null) text += String(node.textContent)
      }
      return text
    }

    /** The chip already appended to one copy host, or null. */
    function copyChipOf(host) {
      const children = host.children === undefined ? [] : Array.from(host.children)
      for (const child of children) {
        if (child.classList !== undefined && typeof child.classList.contains === 'function'
          && child.classList.contains(COPY_CHIP_CLASS)) return child
      }
      return null
    }

    /** Localized label sync; an in-flight confirmation keeps its own label. */
    function syncCopyChip(chip, labels) {
      chip.scLabels = labels
      const label = chip.scCopying === true ? labels.copied : labels.copy
      if (chip.textContent !== label) chip.textContent = label
      if (chip.title !== label) chip.title = label
      if (typeof chip.setAttribute === 'function' && chip.getAttribute('aria-label') !== label) {
        chip.setAttribute('aria-label', label)
      }
    }

    function copyChipFor(host, readPayload, labels) {
      const existing = copyChipOf(host)
      if (existing !== null) return existing
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = COPY_CHIP_CLASS
      chip.addEventListener('click', () => {
        void copyPayloadToClipboard(readPayload()).then((copied) => {
          if (copied !== true) return
          chip.scCopying = true
          syncCopyChip(chip, chip.scLabels === undefined ? labels : chip.scLabels)
          setTimeout(() => {
            chip.scCopying = false
            syncCopyChip(chip, chip.scLabels === undefined ? labels : chip.scLabels)
          }, COPY_FEEDBACK_MS)
        })
      })
      if (host.classList !== undefined && typeof host.classList.add === 'function'
        && !host.classList.contains(COPY_HOST_CLASS)) {
        host.classList.add(COPY_HOST_CLASS)
      }
      host.appendChild(chip)
      return chip
    }

    /**
     * Decorate every copy target under one committed Markdown root. Idempotent:
     * an existing chip is reused by class, so stream mutations only re-sync the
     * localized label.
     * @param root - the element housing rendered Markdown.
     * @param labels - `{ table: { copy, copied }, code: { copy, copied } }`.
     */
    function decorateCopyChips(root, labels) {
      if (root === null || root === undefined || typeof root.querySelectorAll !== 'function') return
      if (typeof document === 'undefined' || document === null) return
      for (const table of Array.from(root.querySelectorAll('table'))) {
        const host = table.parentElement
        if (host === null || host === undefined) continue
        if (host.classList !== undefined && typeof host.classList.contains === 'function'
          && host.classList.contains('sc-md')) continue
        const readTable = () => {
          const current = typeof host.querySelector === 'function' ? host.querySelector('table') : null
          const cells = current === null || current === undefined ? [] : tableCellsOfElement(current)
          return {
            text: tableToTsv(cells.map((row) => row.map((cell) => cell.text))),
            html: tableToHtml(cells)
          }
        }
        syncCopyChip(copyChipFor(host, readTable, labels.table), labels.table)
      }
      for (const fence of Array.from(root.querySelectorAll('pre.sc-md-code'))) {
        syncCopyChip(copyChipFor(fence, () => ({ text: textWithoutCopyChip(fence) }), labels.code), labels.code)
      }
    }

    /** Keep one assistant row's tables and fallback fences copyable across stream chunks. */
    function useCopyChips(ref, t, enabled) {
      React.useEffect(() => {
        if (enabled !== true) return undefined
        const root = ref.current
        if (root === null || root === undefined) return undefined
        if (typeof MutationObserver !== 'function') return undefined
        const labels = {
          table: { copy: t('markdown.tableCopy'), copied: t('markdown.tableCopied') },
          code: { copy: t('markdown.copy'), copied: t('markdown.copied') }
        }
        const decorate = () => decorateCopyChips(root, labels)
        decorate()
        const observer = new MutationObserver(decorate)
        observer.observe(root, { childList: true, subtree: true })
        return () => observer.disconnect()
      }, [t, enabled])
    }

    const MARKDOWN_LABELS = new WeakMap()
    const IDENTITY_T = (key) => key

    /**
     * Markdown chrome copy for one locale seat. The shell renderer requires a
     * reference-stable object, else a streaming message drops its render cache
     * on every chunk; a locale switch replaces `t` and therefore the labels.
     */
    function markdownLabelsOf(t) {
      const cached = MARKDOWN_LABELS.get(t)
      if (cached !== undefined) return cached
      const labels = {
        code: {
          copyLabel: t('markdown.copy'),
          copiedLabel: t('markdown.copied'),
          toolbarLabels: {
            codeLabel: t('markdown.codeBlock.title'),
            wrapLabel: t('markdown.codeBlock.wrap'),
            unwrapLabel: t('markdown.codeBlock.unwrap')
          }
        },
        footnotes: t('markdown.footnotes')
      }
      MARKDOWN_LABELS.set(t, labels)
      return labels
    }

    function Markdown(props) {
      if (typeof props.text !== 'string' || props.text === '') return null
      if (MarkdownText !== null) {
        const t = typeof props.t === 'function' ? props.t : IDENTITY_T
        const streaming = props.streaming === true
        return h(MarkdownText, {
          text: streaming ? props.text : normalizeBareTexEnvironments(props.text),
          streaming,
          labels: markdownLabelsOf(t)
        })
      }
      return h('div', { className: 'sc-md' }, renderMarkdownFallback(props.text, props.keyBase || 'md'))
    }

    // `@` completion grammar replicated from DSH's browser-safe
    // `@deepseek-ai/dsh-file-reference/grammar`
    // (packages/context/file-reference/src/grammar.ts); the hand-written bundle cannot
    // require that package. The chip splitter mirrors
    // `@deepseek-ai/dsh-client-ui-reference/client/user-text-rules.ts`; the session
    // mention spelling and label escaping mirror
    // `@deepseek-ai/dsh-session-reference/uri` (`formatSessionReferenceMention`).

    const REFERENCE_DEBOUNCE_MS = 120
    const REFERENCE_MENU_PREFIX = 'sc-ref-menu'
    const REFERENCE_QUERY_MAX_CHARS = 512
    const REFERENCE_TRAILING_PUNCTUATION_RE = /[.,;:!?\uFF0C\u3002\uFF1B\uFF1A\uFF01\uFF1F]+$/u
    const REFERENCE_UNSAFE_PATH_RE = /[\u0000-\u001f\u007f-\u009f"]/u
    const REFERENCE_UNSAFE_LABEL_RE = /[\u0000-\u001f\u007f-\u009f]+/gu
    // One canonical session mention at the start of a slice.
    const SESSION_MENTION_AT_RE = /^@\[((?:\\.|[^\]\n])*)\]\(dsh-session:[A-Za-z0-9_-]+\)/u
    // The whole value must be exactly one canonical session mention.
    const SESSION_MENTION_WHOLE_RE = /^@\[((?:\\.|[^\]\n])*)\]\(dsh-session:[A-Za-z0-9_-]+\)$/u
    // One file/folder token anchored at a known `@`, with the primary's boundary rule.
    const FILE_TOKEN_AT_RE = /(?<!\S)(@"[^"\n]+"|@[^\s]+)/uy

    /**
     * Extract the `@` token ending at `cursorCol` of one editor line. An `@`
     * inside another token (an email address) is not a completion trigger.
     * @returns `{ prefix, query, quoted }`, or undefined outside an `@` token.
     */
    function activeAtToken(line, cursorCol) {
      if (typeof line !== 'string') return undefined
      const limit = typeof cursorCol === 'number' && Number.isFinite(cursorCol) ? Math.trunc(cursorCol) : line.length
      const beforeCursor = line.slice(0, Math.max(0, Math.min(limit, line.length)))
      const quoted = /(?:^|\s)(@"([^"]*))$/u.exec(beforeCursor)
      if (quoted !== null && quoted[1] !== undefined && quoted[2] !== undefined) {
        return { prefix: quoted[1], query: quoted[2], quoted: true }
      }
      const plain = /(?:^|\s)(@([^\s]*))$/u.exec(beforeCursor)
      if (plain === null || plain[1] === undefined || plain[2] === undefined) return undefined
      // A bracketed token is a picked session reference (or a pasted canonical
      // mention), not a path query — including while its caret sits inside it.
      if (plain[1].startsWith('@[')) return undefined
      return { prefix: plain[1], query: plain[2], quoted: false }
    }

    /**
     * The active token with its absolute start offset in a multi-line draft.
     * @returns `{ start, prefix, query, quoted }`, or undefined outside an `@` token.
     */
    function activeTokenAt(text, caret) {
      if (typeof text !== 'string') return undefined
      const limit = typeof caret === 'number' && Number.isFinite(caret) ? Math.trunc(caret) : text.length
      const pos = Math.max(0, Math.min(limit, text.length))
      const lineStart = pos === 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1
      let lineEnd = text.indexOf('\n', pos)
      if (lineEnd < 0) lineEnd = text.length
      const token = activeAtToken(text.slice(lineStart, lineEnd), pos - lineStart)
      if (token === undefined) return undefined
      return { start: pos - token.prefix.length, prefix: token.prefix, query: token.query, quoted: token.quoted }
    }

    /**
     * The prompt spelling of a picked candidate: whitespace (or an explicitly
     * opened quote) uses the quoted grammar; a quoted directory keeps its quote
     * open after the trailing slash so completion can descend.
     * @returns the mention, or undefined for a path the grammar cannot represent.
     */
    function formatFileMention(candidate, preserveQuote) {
      if (candidate === null || typeof candidate !== 'object' || typeof candidate.path !== 'string') return undefined
      const path = candidate.kind === 'directory' ? `${candidate.path}/` : candidate.path
      if (REFERENCE_UNSAFE_PATH_RE.test(path)) return undefined
      const quoted = preserveQuote === true || /\s/u.test(path)
      if (!quoted) return `@${path}`
      if (candidate.kind === 'directory') return `@"${path}`
      return `@"${path}"`
    }

    /**
     * The readable draft spelling of a picked session title: `@[title]`, with
     * `\` and `]` escaped so the token round-trips through the chip splitter.
     * The canonical `dsh-session:` mention is added at send time, not here.
     * @returns the token, or undefined for a title that cannot be represented.
     */
    function formatSessionReferenceToken(label) {
      if (typeof label !== 'string' || label === '') return undefined
      const text = label.replace(REFERENCE_UNSAFE_LABEL_RE, ' ').trim()
      if (text === '') return undefined
      return `@[${text.replace(/[\\\]]/gu, (match) => `\\${match}`)}]`
    }

    function unescapeSessionLabel(label) {
      return label.replace(/\\(.)/gu, '$1')
    }

    /**
     * Expand every recorded readable session token in outgoing text to the
     * canonical mention the host returned. The first exact occurrence of each
     * token is replaced, so duplicate picks consume successive occurrences; a
     * token the user edited or removed is skipped rather than guessed at, and
     * an occurrence already followed by `(dsh-session:` belongs to a mention
     * and is never expanded twice.
     * @returns the text with canonical mentions, or the input unchanged.
     */
    function expandSessionReferences(text, references) {
      if (typeof text !== 'string' || text === '') return text
      if (!Array.isArray(references) || references.length === 0) return text
      let expanded = text
      for (const reference of references) {
        if (reference === null || typeof reference !== 'object') continue
        if (typeof reference.token !== 'string' || reference.token === '') continue
        if (typeof reference.mention !== 'string' || !SESSION_MENTION_WHOLE_RE.test(reference.mention)) continue
        let index = expanded.indexOf(reference.token)
        while (index >= 0 && expanded.startsWith('(dsh-session:', index + reference.token.length)) {
          index = expanded.indexOf(reference.token, index + reference.token.length)
        }
        if (index < 0) continue
        expanded = expanded.slice(0, index) + reference.mention + expanded.slice(index + reference.token.length)
      }
      return expanded
    }

    /**
     * Replace `[token.start, caret]` with the picked candidate's mention.
     * @returns `{ text, caret, kind, token }` for the new draft (a directory keeps
     * the continuation token), or null when the pick cannot be represented.
     */
    function applyReferencePick(draft, caret, token, candidate, preserveQuote) {
      if (typeof draft !== 'string') return null
      if (token === null || typeof token !== 'object') return null
      if (candidate === null || typeof candidate !== 'object') return null
      const limit = typeof caret === 'number' && Number.isFinite(caret) ? Math.trunc(caret) : draft.length
      const pos = Math.max(0, Math.min(limit, draft.length))
      const rawStart = typeof token.start === 'number' && Number.isFinite(token.start) ? Math.trunc(token.start) : 0
      const start = Math.max(0, Math.min(rawStart, pos))
      if (candidate.kind === 'session') {
        if (typeof candidate.mention !== 'string' || !SESSION_MENTION_WHOLE_RE.test(candidate.mention)) return null
        const readable = formatSessionReferenceToken(candidate.label)
        if (readable === undefined) return null
        const text = draft.slice(0, start) + readable + draft.slice(pos)
        return {
          text,
          caret: start + readable.length,
          kind: 'session',
          token: undefined,
          readable,
          mention: candidate.mention
        }
      }
      const mention = formatFileMention(candidate, preserveQuote === true || token.quoted === true)
      if (mention === undefined) return null
      const text = draft.slice(0, start) + mention + draft.slice(pos)
      const nextCaret = start + mention.length
      const kind = candidate.kind === 'directory' ? 'directory' : 'file'
      const nextToken = kind === 'directory' ? activeTokenAt(text, nextCaret) : undefined
      return { text, caret: nextCaret, kind, token: nextToken }
    }

    /**
     * One file/folder token anchored at a known `@`: the primary's boundary rule
     * (start or whitespace before the token) plus trailing punctuation trimming
     * for unquoted paths.
     * @returns the token length and decoded path, or undefined.
     */
    function fileTokenAt(text, start) {
      FILE_TOKEN_AT_RE.lastIndex = start
      const match = FILE_TOKEN_AT_RE.exec(text)
      if (match === null || match.index !== start) return undefined
      const token = match[0]
      const quoted = token.startsWith('@"')
      const raw = quoted ? token : token.replace(REFERENCE_TRAILING_PUNCTUATION_RE, '')
      if (raw.length <= 1) return undefined
      // A bracketed token is a readable session reference or a canonical
      // mention; it is never a path, even when the reference was not expanded.
      if (raw.startsWith('@[') && raw.includes(']')) return undefined
      const path = raw.slice(1).replace(/^"|"$/gu, '')
      if (path === '') return undefined
      return { length: raw.length, path }
    }

    /** One canonical session mention anchored at a known `@`. */
    function sessionMentionAt(text, start) {
      const match = SESSION_MENTION_AT_RE.exec(text.slice(start))
      if (match === null) return undefined
      return { length: match[0].length, label: unescapeSessionLabel(match[1]), mention: match[0] }
    }

    /**
     * A bracketed span such as a readable (`@[title]`) or malformed session
     * token. It is presentation text, never a file path, so the splitter steps
     * over it instead of chipping its first whitespace-delimited fragment.
     */
    function readableReferenceSpanAt(text, start) {
      if (!text.startsWith('@[', start)) return undefined
      for (let index = start + 2; index < text.length; index += 1) {
        const char = text[index]
        if (char === '\n') return undefined
        if (char === '\\') {
          index += 1
          continue
        }
        if (char === ']') return { length: index - start + 1 }
      }
      return undefined
    }

    /**
     * Split committed user text into text and reference segments: canonical
     * session mentions first, then file/folder tokens with the primary's
     * trailing-punctuation rule. References carry presentation data only.
     * @returns ordered `{ kind: 'text', text }` / `{ kind: 'reference', referenceKind, path?, label, mention? }` segments.
     */
    function splitReferenceText(text) {
      if (typeof text !== 'string' || text === '') return []
      const segments = []
      let cursor = 0
      let index = 0
      while (index < text.length) {
        const at = text.indexOf('@', index)
        if (at < 0) break
        const session = sessionMentionAt(text, at)
        if (session !== undefined) {
          if (at > cursor) segments.push({ kind: 'text', text: text.slice(cursor, at) })
          segments.push({
            kind: 'reference',
            referenceKind: 'session',
            label: session.label,
            mention: session.mention
          })
          cursor = at + session.length
          index = cursor
          continue
        }
        const readable = readableReferenceSpanAt(text, at)
        if (readable !== undefined) {
          index = at + readable.length
          continue
        }
        const file = fileTokenAt(text, at)
        if (file !== undefined) {
          if (at > cursor) segments.push({ kind: 'text', text: text.slice(cursor, at) })
          const parts = file.path.split(/[\\/]/u).filter((part) => part !== '')
          segments.push({
            kind: 'reference',
            referenceKind: file.path.endsWith('/') ? 'directory' : 'file',
            path: file.path,
            label: parts.length > 0 ? parts[parts.length - 1] : file.path
          })
          cursor = at + file.length
          index = cursor
          continue
        }
        index = at + 1
      }
      if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
      return segments
    }

    /**
     * Key routing while the reference menu is open; pick, send and close are
     * mutually exclusive, and a composing Enter reaches none of them. `open`
     * keeps a loading or empty menu visible; `pickable` requires a selectable
     * row, so Enter submits (and closes the menu) when there is nothing to pick.
     * @returns `'pick' | 'submit' | 'newline' | 'next' | 'prev' | 'close' | 'none'`.
     */
    function editorKeyAction(event, options) {
      const config = options !== null && typeof options === 'object' ? options : {}
      if (config.composing === true) return 'none'
      if (event === null || typeof event !== 'object') return 'none'
      if (event.isComposing === true || event.keyCode === 229) return 'none'
      const open = config.open === true
      const pickable = open && config.pickable === true
      const key = event.key
      if (key === 'Enter') {
        if (event.shiftKey === true) return 'newline'
        return pickable ? 'pick' : 'submit'
      }
      if (key === 'Tab') return pickable ? 'pick' : 'none'
      if (key === 'Escape') return open ? 'close' : 'none'
      if (key === 'ArrowDown') return pickable ? 'next' : 'none'
      if (key === 'ArrowUp') return pickable ? 'prev' : 'none'
      return 'none'
    }

    /**
     * Height cap for the composer draft: the primary composer's 14-line cap, never more
     * than half the panel it sits in, so a long draft cannot swallow the transcript.
     * @param root - the panel root whose `clientHeight` bounds the composer, or null.
     */
    function composerHeightLimit(root) {
      const height = root !== null && typeof root === 'object' && typeof root.clientHeight === 'number'
        ? root.clientHeight
        : 0
      if (!(height > 0)) return COMPOSER_MAX_HEIGHT_PX
      return Math.max(COMPOSER_MIN_HEIGHT_PX, Math.min(COMPOSER_MAX_HEIGHT_PX, Math.round(height * COMPOSER_MAX_HEIGHT_SHARE)))
    }

    /**
     * Own the textarea's height from its content: grow line by line up to the cap and
     * scroll inside the box only past it. A box without layout metrics (unmounted or
     * hidden) is left on its stylesheet height, which still scrolls.
     * @param element - the composer textarea, or null before it mounts.
     * @param root - the panel root that bounds the cap.
     * @returns the applied height in CSS pixels, or null when nothing was measured.
     */
    function fitComposerHeight(element, root) {
      if (element === null || typeof element !== 'object') return null
      const style = element.style
      if (style === null || style === undefined || typeof style !== 'object') return null
      if (typeof element.scrollHeight !== 'number') return null
      style.height = 'auto'
      const natural = element.scrollHeight
      if (!(natural > 0)) return null
      const limit = composerHeightLimit(root)
      const height = Math.max(COMPOSER_MIN_HEIGHT_PX, Math.min(natural, limit))
      style.height = `${height}px`
      style.overflowY = natural > limit ? 'auto' : 'hidden'
      return height
    }

    function referenceMenuOpen(reference) {
      if (reference === null || typeof reference !== 'object') return false
      if (reference.token === null || reference.token === undefined) return false
      if (reference.status === 'closed' || reference.status === 'unavailable') return false
      return true
    }

    /** Wrap-around menu cursor. */
    function nextReferenceIndex(count, index, delta) {
      if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return 0
      const size = Math.trunc(count)
      const current = typeof index === 'number' && Number.isFinite(index) ? Math.trunc(index) : 0
      const step = typeof delta === 'number' && Number.isFinite(delta) ? Math.trunc(delta) : 1
      return (((current + step) % size) + size) % size
    }

    function referenceCandidatesOf(value) {
      if (!Array.isArray(value)) return []
      const candidates = []
      for (const entry of value) {
        if (entry === null || typeof entry !== 'object') continue
        if (entry.kind === 'session') {
          if (typeof entry.label !== 'string' || entry.label === '') continue
          if (typeof entry.mention !== 'string' || !SESSION_MENTION_WHOLE_RE.test(entry.mention)) continue
          const candidate = {
            kind: 'session',
            label: entry.label,
            mention: entry.mention
          }
          if (entry.location === null) candidate.location = null
          else if (typeof entry.location === 'string' && entry.location !== '') candidate.location = entry.location
          if (typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)) candidate.createdAt = entry.createdAt
          candidates.push(candidate)
          continue
        }
        if (typeof entry.path !== 'string' || entry.path === '') continue
        candidates.push({ path: entry.path, kind: entry.kind === 'directory' ? 'directory' : 'file' })
      }
      return candidates
    }

    function referenceLabelOf(candidate) {
      if (candidate === null || typeof candidate !== 'object') return ''
      if (candidate.kind === 'session') return typeof candidate.label === 'string' ? candidate.label : ''
      if (typeof candidate.path !== 'string') return ''
      const parts = candidate.path.split(/[\\/]/u).filter((part) => part !== '')
      const label = parts.length > 0 ? parts[parts.length - 1] : candidate.path
      return candidate.kind === 'directory' ? `${label}/` : label
    }

    /** The parent directory a row shows to tell same-named paths apart, or ''. */
    function referenceParentOf(candidate) {
      if (candidate === null || typeof candidate !== 'object' || typeof candidate.path !== 'string') return ''
      const parts = candidate.path.split(/[\\/]/u).filter((part) => part !== '')
      if (parts.length <= 1) return ''
      return `${parts.slice(0, -1).join('/')}/`
    }

    /** The primary composer's relative-time buckets for a session row. */
    function relativeReferenceAge(at, now, translate) {
      const minute = 60_000
      const hour = 3_600_000
      const day = 86_400_000
      const diff = Math.max(0, now - at)
      if (diff < minute) return translate('reference.timeNow')
      if (diff < hour) return translate('reference.timeMinutes', { n: Math.floor(diff / minute) })
      if (diff < day) return translate('reference.timeHours', { n: Math.floor(diff / hour) })
      if (diff < 30 * day) return translate('reference.timeDays', { n: Math.floor(diff / day) })
      if (diff < 365 * day) return translate('reference.timeMonths', { n: Math.floor(diff / (30 * day)) })
      return translate('reference.timeYears', { n: Math.floor(diff / (365 * day)) })
    }

    /** The right-aligned secondary text of one row: a file's parent or a session's location + age. */
    function referenceDescriptionOf(candidate, translate, now) {
      if (candidate === null || typeof candidate !== 'object') return ''
      if (candidate.kind !== 'session') return referenceParentOf(candidate)
      const parts = []
      if (candidate.location === null) parts.push(translate('reference.noCwd'))
      else if (typeof candidate.location === 'string' && candidate.location !== '') parts.push(candidate.location)
      if (typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt) && candidate.createdAt > 0) {
        parts.push(relativeReferenceAge(candidate.createdAt, now, translate))
      }
      return parts.join(' · ')
    }

    const EMPTY_REFERENCE = Object.freeze({
      status: 'closed',
      candidates: [],
      activeIndex: 0,
      token: null,
      composing: false,
      requestId: 0,
      controller: null,
      timer: null,
      caret: 0,
      caretRequest: 0
    })

    function createReferenceState() {
      return {
        status: 'closed',
        candidates: [],
        activeIndex: 0,
        token: null,
        composing: false,
        requestId: 0,
        controller: null,
        timer: null,
        caret: 0,
        caretRequest: 0
      }
    }

    function referenceStateOf(state) {
      if (state === null || state === undefined) return EMPTY_REFERENCE
      const reference = state.reference
      if (reference === null || typeof reference !== 'object') return EMPTY_REFERENCE
      return reference
    }

    /** The listbox rendered above the composer; rows exist only while the menu is open. */
    function referenceMenuOf(t, reference, menuId, pick, now) {
      if (!referenceMenuOpen(reference)) return null
      const translate = typeof t === 'function' ? t : keyTranslator
      const onPick = typeof pick === 'function' ? pick : null
      const id = typeof menuId === 'string' && menuId !== '' ? menuId : REFERENCE_MENU_PREFIX
      const referenceNow = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
      const rows = []
      if (reference.status === 'loading') {
        rows.push(h('div', { key: 'loading', className: 'sc-ref-status' }, translate('reference.loading')))
      } else if (reference.status === 'empty') {
        rows.push(h('div', { key: 'empty', className: 'sc-ref-status' }, translate('reference.empty')))
      } else {
        let group = ''
        for (let index = 0; index < reference.candidates.length; index += 1) {
          const candidate = reference.candidates[index]
          const nextGroup = candidate.kind === 'session' ? 'session' : 'file'
          if (nextGroup !== group) {
            group = nextGroup
            rows.push(h('div', {
              key: `group-${nextGroup}-${index}`,
              className: 'sc-ref-group',
              role: 'presentation'
            }, translate(nextGroup === 'session' ? 'reference.sessions' : 'reference.files')))
          }
          const active = index === reference.activeIndex
          const description = referenceDescriptionOf(candidate, translate, referenceNow)
          rows.push(h('div', {
            key: `option-${index}`,
            id: `${id}-option-${index}`,
            role: 'option',
            'aria-selected': active,
            className: active ? 'sc-ref-option sc-ref-option-active' : 'sc-ref-option',
            title: candidate.kind === 'session' ? candidate.label : candidate.path,
            onMouseDown: (event) => {
              if (event !== null && typeof event === 'object' && typeof event.preventDefault === 'function') event.preventDefault()
              if (onPick !== null) onPick(index)
            }
          },
          h('span', {
            className: 'sc-ref-kind',
            'aria-hidden': 'true'
          }, candidate.kind === 'session' ? '◉' : candidate.kind === 'directory' ? '▸' : '·'),
          h('span', { className: 'sc-ref-label' }, referenceLabelOf(candidate)),
          description === ''
            ? null
            : h('span', { className: 'sc-ref-dir' }, description)))
        }
      }
      return h('div', {
        className: 'sc-ref-menu',
        id,
        role: 'listbox',
        'aria-label': translate('reference.menu')
      }, rows)
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
      /** Parent session id -> latest forwarded user-question request observed by the client. */
      const questions = new Map()
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

      /** Remember one forwarded user-question request for its parent session. */
      function setQuestion(sessionId, request) {
        if (typeof sessionId !== 'string' || sessionId === '') return
        if (request === null || request === undefined || typeof request !== 'object') return
        const questionsOfRequest = Array.isArray(request.questions) ? request.questions : []
        if (questionsOfRequest.length === 0) return
        questions.set(sessionId, { ...request, questions: questionsOfRequest })
        emit()
      }

      /** Latest observed question for a parent session, or null. */
      function getQuestion(sessionId) {
        if (typeof sessionId !== 'string' || sessionId === '') return null
        return questions.has(sessionId) ? questions.get(sessionId) : null
      }

      /** Drop the observed question card; the main conversation keeps its own copy. */
      function clearQuestion(sessionId) {
        if (typeof sessionId !== 'string' || sessionId === '') return
        if (!questions.delete(sessionId)) return
        emit()
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
          /** Composer image rail entries (per tab): uploading / ready / error. */
          images: [],
          /** Menus, debounce timer and in-flight lookup of this tab's `@` completion. */
          reference: createReferenceState(),
          /** Picked session titles of the current draft: `{ token, mention }` pairs. */
          sessionRefs: [],
          composerCaret: 0,
          pending: [],
          live: null,
          /** Dock readings folded from the visible entries; null until a usage sample. */
          metrics: null,
          /** Host-provided context-window baseline (a seeded session inherits its parent's). */
          contextWindow: null,
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

      async function api(name, args, signal) {
        const init = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args === undefined || args === null ? {} : args)
        }
        if (signal !== undefined && signal !== null) init.signal = signal
        const response = await fetchImpl(apiPath(name), init)
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
          if (payload !== null && typeof payload.reason === 'string') failure.reason = payload.reason
          throw failure
        }
        if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
          const failure = new Error(
            payload !== null && typeof payload.message === 'string' && payload.message !== ''
              ? payload.message
              : (payload !== null && typeof payload.code === 'string' ? payload.code : 'request failed')
          )
          if (payload !== null && typeof payload.code === 'string') failure.code = payload.code
          if (payload !== null && typeof payload.reason === 'string') failure.reason = payload.reason
          throw failure
        }
        return payload
      }

      function setManagedTimer(fn, delay) {
        const timer = setTimer(fn, Math.max(0, delay))
        if (timer !== null && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
        return timer
      }

      function clearReferenceTimer(reference) {
        if (reference.timer !== null) {
          clearTimer(reference.timer)
          reference.timer = null
        }
      }

      function abortReference(reference) {
        if (reference.controller === null) return
        const controller = reference.controller
        reference.controller = null
        if (typeof controller.abort === 'function') controller.abort()
      }

      /** Cancel the pending lookup and close the menu; `unavailable` stays cached per tab. */
      function resetReference(panel) {
        const reference = panel.reference
        clearReferenceTimer(reference)
        abortReference(reference)
        reference.requestId += 1
        reference.status = reference.status === 'unavailable' ? 'unavailable' : 'closed'
        reference.candidates = []
        reference.activeIndex = 0
        reference.token = null
      }

      function scheduleReferenceQuery(panel, delay) {
        const reference = panel.reference
        clearReferenceTimer(reference)
        abortReference(reference)
        reference.status = 'loading'
        reference.candidates = []
        reference.activeIndex = 0
        reference.requestId += 1
        const requestId = reference.requestId
        const wait = typeof delay === 'number' && Number.isFinite(delay) && delay >= 0 ? delay : REFERENCE_DEBOUNCE_MS
        reference.timer = setManagedTimer(() => {
          reference.timer = null
          void queryReferences(panel, requestId)
        }, wait)
      }

      async function queryReferences(panel, requestId) {
        const reference = panel.reference
        if (!panels.has(panel.mainId)) return
        if (reference.requestId !== requestId) return
        const token = reference.token
        if (token === null) return
        const body = { query: token.query }
        if (token.quoted === true) body.quoted = true
        if (panel.sessionId !== null) body.sessionId = panel.sessionId
        else body.sourceId = panel.sourceId
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        reference.controller = controller
        try {
          const payload = await api('references', body, controller === null ? undefined : controller.signal)
          if (reference.requestId !== requestId) return
          if (!panels.has(panel.mainId)) return
          reference.controller = null
          reference.candidates = referenceCandidatesOf(payload.candidates)
          reference.activeIndex = 0
          reference.status = reference.candidates.length > 0 ? 'ready' : 'empty'
          emit()
        } catch (error) {
          if (reference.requestId !== requestId) return
          if (!panels.has(panel.mainId)) return
          reference.controller = null
          if (controller !== null && controller.signal.aborted === true) return
          if (failureOf(error).code === 'unavailable') {
            reference.status = 'unavailable'
            reference.candidates = []
            reference.activeIndex = 0
            reference.token = null
            emit()
            return
          }
          resetReference(panel)
          emit()
        }
      }

      function composeDraft(mainId, text, caret) {
        const panel = panels.get(mainId)
        if (panel === undefined) return
        const value = typeof text === 'string' ? text : ''
        const limit = typeof caret === 'number' && Number.isFinite(caret) ? Math.trunc(caret) : value.length
        panel.draft = value
        panel.composerCaret = Math.max(0, Math.min(limit, value.length))
        const reference = panel.reference
        if (reference.composing === true || reference.status === 'unavailable') {
          emit()
          return
        }
        const token = activeTokenAt(value, panel.composerCaret)
        if (token === undefined || token.query.length > REFERENCE_QUERY_MAX_CHARS) {
          const hadMenu = reference.status !== 'closed' || reference.timer !== null
            || reference.controller !== null || reference.token !== null
          if (hadMenu) resetReference(panel)
          emit()
          return
        }
        const same = reference.token !== null
          && reference.token.start === token.start
          && reference.token.query === token.query
          && reference.token.quoted === token.quoted
        reference.token = token
        if (!same) scheduleReferenceQuery(panel, REFERENCE_DEBOUNCE_MS)
        emit()
      }

      function setComposing(mainId, composing) {
        const panel = panels.get(mainId)
        if (panel === undefined) return
        const next = composing === true
        if (panel.reference.composing === next) return
        panel.reference.composing = next
        if (next) resetReference(panel)
        emit()
      }

      function moveReference(mainId, delta) {
        const panel = panels.get(mainId)
        if (panel === undefined) return
        const reference = panel.reference
        if (!referenceMenuOpen(reference) || reference.candidates.length === 0) return
        const next = nextReferenceIndex(reference.candidates.length, reference.activeIndex, delta)
        if (next === reference.activeIndex) return
        reference.activeIndex = next
        emit()
      }

      function pickReference(mainId, index) {
        const panel = panels.get(mainId)
        if (panel === undefined) return
        const reference = panel.reference
        if (!referenceMenuOpen(reference) || reference.token === null) return
        const position = typeof index === 'number' && Number.isFinite(index) ? Math.trunc(index) : reference.activeIndex
        const candidate = reference.candidates[position]
        if (candidate === undefined) return
        const applied = applyReferencePick(panel.draft, panel.composerCaret, reference.token, candidate, reference.token.quoted === true)
        if (applied === null) {
          resetReference(panel)
          emit()
          return
        }
        panel.draft = applied.text
        panel.composerCaret = applied.caret
        reference.caret = applied.caret
        reference.caretRequest += 1
        if (applied.kind === 'session' && typeof applied.readable === 'string' && typeof applied.mention === 'string') {
          panel.sessionRefs = [...panel.sessionRefs, { token: applied.readable, mention: applied.mention }]
        }
        if (applied.kind === 'directory' && applied.token !== undefined) {
          reference.token = applied.token
          scheduleReferenceQuery(panel, 0)
        } else {
          resetReference(panel)
        }
        emit()
      }

      function closeReferences(mainId) {
        const panel = panels.get(mainId)
        if (panel === undefined) return
        const reference = panel.reference
        const active = reference.status !== 'closed' || reference.timer !== null
          || reference.controller !== null || reference.token !== null
        resetReference(panel)
        if (active) emit()
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
          panel.metrics = metricsOf(panel.entries, panel.inheritedEventCount === null ? 0 : panel.inheritedEventCount)
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

      /** Whether a committed user row carries exactly the pending row's image ids. */
      function samePendingImages(node, pending) {
        const wanted = Array.isArray(pending.images) ? pending.images : []
        const actual = Array.isArray(node.images) ? node.images : []
        if (wanted.length !== actual.length) return false
        for (let index = 0; index < wanted.length; index += 1) {
          if (wanted[index].attachmentId !== actual[index].attachmentId) return false
        }
        return true
      }

      function reconcilePending(panel) {
        if (panel.pending.length === 0) return
        const used = new Set()
        const remaining = []
        let retired = false
        for (const pending of panel.pending) {
          const baseline = pending.seen instanceof Set ? pending.seen : null
          const match = panel.nodes.find((node) =>
            node.kind === 'user' &&
            node.text === pending.text &&
            samePendingImages(node, pending) &&
            !used.has(node.seq) &&
            (baseline === null || !baseline.has(node.seq)))
          if (match === undefined) {
            remaining.push(pending)
            continue
          }
          used.add(match.seq)
          retired = true
          for (const image of Array.isArray(pending.images) ? pending.images : []) revokePreviewUrl(image.previewUrl)
        }
        if (retired) panel.pending = remaining
      }

      /**
       * Learn the context-window denominator from a host baseline payload. The
       * panel's own `request/context` entries (above the fork floor) override it
       * when a later model switch appends one.
       */
      function applyContextWindow(panel, payload) {
        if (payload === null || typeof payload !== 'object') return
        const value = payload.contextWindow
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) panel.contextWindow = value
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
          applyContextWindow(panel, payload)
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
          applyContextWindow(panel, payload)
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
          resetReference(panel)
        }
        emit()
      }

      function imageKeyOf() {
        return `img${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
      }

      /** Upload one rail entry; the answer replaces its status and reference. */
      async function uploadImage(panel, entry) {
        const query = [['mime', entry.mediaType]]
        if (panel.sessionId !== null) query.push(['sessionId', panel.sessionId])
        else query.push(['sourceId', panel.sourceId])
        if (entry.name !== '') query.push(['name', entry.name])
        const url = apiPath('attachment') + '?' + query
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
          .join('&')
        let payload = null
        try {
          const response = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': entry.mediaType },
            body: entry.file
          })
          try {
            payload = await response.json()
          } catch (error) {
            payload = null
          }
        } catch (error) {
          payload = null
        }
        entry.status = 'error'
        entry.error = { code: 'unknown', message: '' }
        if (payload !== null && typeof payload === 'object' && payload.ok === true) {
          const ref = imageRefOf(payload.attachment)
          if (ref !== undefined) {
            entry.ref = ref
            entry.status = 'ready'
            entry.error = null
          } else {
            entry.error = { code: 'attachment-rejected', reason: 'ATTACHMENT_CORRUPT', message: '' }
          }
        } else if (payload !== null && typeof payload === 'object') {
          entry.error = {
            code: typeof payload.code === 'string' && payload.code !== '' ? payload.code : 'unknown',
            message: typeof payload.message === 'string' ? payload.message : '',
            ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {})
          }
        }
        emit()
      }

      /** Add pasted / dropped / picked files to one tab's rail and start uploading. */
      function addImages(mainId, files) {
        const panel = panels.get(mainId)
        if (panel === undefined) return
        const list = Array.isArray(files) ? files : Array.from(files ?? [])
        let added = 0
        for (const candidate of list) {
          const file = imageFileOf(candidate)
          if (file === undefined) continue
          const entry = {
            key: imageKeyOf(),
            name: imageNameOf(file),
            mediaType: file.type,
            previewUrl: previewUrlOf(file),
            status: 'uploading',
            error: null,
            file,
            ref: null
          }
          panel.images = [...panel.images, entry]
          added += 1
          void uploadImage(panel, entry)
        }
        if (added > 0) emit()
      }

      function removeImage(mainId, key) {
        const panel = panels.get(mainId)
        if (panel === undefined) return
        const entry = panel.images.find((image) => image.key === key)
        if (entry === undefined) return
        revokePreviewUrl(entry.previewUrl)
        panel.images = panel.images.filter((image) => image.key !== key)
        emit()
      }

      function retryImage(mainId, key) {
        const panel = panels.get(mainId)
        if (panel === undefined) return
        const entry = panel.images.find((image) => image.key === key)
        if (entry === undefined || entry.file === null || entry.status === 'uploading') return
        entry.status = 'uploading'
        entry.error = null
        void uploadImage(panel, entry)
        emit()
      }

      /** Release every object URL a tab holds (rail entries and pending rows). */
      function revokePanelImages(panel) {
        for (const image of panel.images) revokePreviewUrl(image.previewUrl)
        for (const pending of panel.pending) {
          for (const image of Array.isArray(pending.images) ? pending.images : []) revokePreviewUrl(image.previewUrl)
        }
        panel.images = []
      }

      function setDraft(mainId, text) {
        const panel = panels.get(mainId)
        if (panel === undefined) return
        panel.draft = typeof text === 'string' ? text : ''
        panel.composerCaret = panel.draft.length
        resetReference(panel)
        emit()
      }

      async function send(mainId, text) {
        const panel = panels.get(mainId)
        if (panel === undefined) return
        if (panel.sending) return
        const draft = typeof text === 'string' ? text : panel.draft
        const trimmed = draft.trim()
        // Session picks stay readable in the draft and become DSH's canonical
        // mention only on the wire; the pending row shows the same wire text.
        const wireText = expandSessionReferences(trimmed, panel.sessionRefs)
        const ready = panel.images.filter((image) => image.status === 'ready' && image.ref !== null)
        if (trimmed === '' && ready.length === 0) return
        panel.sending = true
        panel.error = null
        panel.draft = ''
        panel.composerCaret = 0
        resetReference(panel)
        const pendingId = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
        const seen = new Set()
        for (const node of panel.nodes) {
          if (node.kind === 'user') seen.add(node.seq)
        }
        // Ready images move into the optimistic row; still-uploading and failed
        // ones stay in the rail so the user can retry or remove them.
        const pendingImages = ready.map((image) => ({
          attachmentId: image.ref.attachmentId,
          mediaType: image.ref.mediaType,
          width: image.ref.width,
          height: image.ref.height,
          bytes: image.ref.bytes,
          ...(image.ref.name === undefined ? {} : { name: image.ref.name }),
          previewUrl: image.previewUrl,
          entry: image
        }))
        panel.images = panel.images.filter((image) => !ready.includes(image))
        panel.pending = [...panel.pending, {
          id: pendingId,
          text: wireText,
          time: Date.now(),
          seen,
          images: pendingImages
        }]
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
            panel.metrics = null
            panel.contextWindow = null
            attachVisibility(panel)
            scheduleUpdate(panel, 0)
          }
          await api('prompt', {
            sessionId: target,
            text: wireText,
            ...(pendingImages.length === 0 ? {} : { attachments: pendingImages.map((image) => image.attachmentId) })
          })
          if (!panels.has(mainId)) return
          panel.sending = false
          panel.error = null
          panel.sessionRefs = []
          emit()
          scheduleUpdate(panel, 0)
        } catch (error) {
          if (!panels.has(mainId)) return
          panel.sending = false
          const failed = panel.pending.find((pending) => pending.id === pendingId)
          panel.pending = panel.pending.filter((pending) => pending.id !== pendingId)
          if (failed !== undefined && Array.isArray(failed.images)) {
            const restored = failed.images.map((image) => image.entry).filter((entry) => entry !== undefined)
            if (restored.length > 0) panel.images = [...restored, ...panel.images]
          }
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
        resetReference(panel)
        revokePanelImages(panel)
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

      /**
       * Persisted side chats that can be resumed into this tab after a restart.
       * The host filters to `side-chat-*` session logs it no longer owns.
       * @param mainId - tab occurrence key.
       * @returns newest-first restore candidates.
       */
      async function restorable(mainId) {
        const panel = panels.get(mainId)
        if (panel === undefined) return []
        try {
          const result = await api('list', { sourceId: panel.sourceId })
          return result !== null && typeof result === 'object' && Array.isArray(result.restorable)
            ? result.restorable
            : []
        } catch (error) {
          return []
        }
      }

      /**
       * Attach this tab to one cold side session and start its snapshot loop.
       * The next host snapshot replaces the empty transcript with the persisted
       * one; sending then continues the same agent instead of creating a new one.
       * @param mainId - tab occurrence key.
       * @param sessionId - persisted `side-chat-*` session id.
       * @returns whether the tab now owns that session.
       */
      async function resume(mainId, sessionId) {
        const panel = panels.get(mainId)
        if (panel === undefined || panel.sessionId !== null) return false
        if (typeof sessionId !== 'string' || !sessionId.startsWith('side-chat-')) return false
        try {
          const resumed = await api('resume', { sessionId, sourceId: panel.sourceId, instanceKey: panel.mainId })
          if (!panels.has(mainId)) return false
          panel.sessionId = typeof resumed.sessionId === 'string' ? resumed.sessionId : sessionId
          panel.inheritedEventCount = Number.isSafeInteger(resumed.inheritedEventCount) ? resumed.inheritedEventCount : 0
          panel.nextSeq = panel.inheritedEventCount
          panel.entries = []
          panel.seqs = new Set()
          panel.nodes = []
          panel.metrics = null
          panel.contextWindow = null
          panel.error = null
          attachVisibility(panel)
          scheduleUpdate(panel, 0)
          emit()
          return true
        } catch (error) {
          if (!panels.has(mainId)) return false
          panel.error = failureOf(error)
          emit()
          return false
        }
      }

      function dispose() {
        for (const panel of panels.values()) {
          stopUpdate(panel)
          detachVisibility(panel)
          resetReference(panel)
          revokePanelImages(panel)
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
        setQuestion,
        getQuestion,
        clearQuestion,
        open,
        setVisible,
        setDraft,
        composeDraft,
        setComposing,
        moveReference,
        pickReference,
        closeReferences,
        send,
        addImages,
        removeImage,
        retryImage,
        cancel,
        close,
        labelOf,
        connectStream,
        pollOnce,
        restorable,
        resume,
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
    /**
     * Latest forwarded user question, shown above the side-chat transcript so the
     * pending decision can be discussed without leaving the main flow untouched.
     * The card only observes: it never claims or answers the request.
     * @param props - the request, the translator, and the discuss/dismiss actions.
     */
    function QuestionCard(props) {
      const t = typeof props.t === 'function' ? props.t : keyTranslator
      const request = props.question
      const questions = request !== null && request !== undefined && Array.isArray(request.questions)
        ? request.questions
        : []
      if (questions.length === 0) return null
      return h('div', { className: 'sc-question', 'data-role': 'question-card' },
        h('div', { className: 'sc-question-head' },
          h('span', { className: 'sc-question-title' }, t('question.title')),
          h('button', {
            type: 'button',
            className: 'sc-question-dismiss',
            'aria-label': t('question.dismiss'),
            onClick: () => {
              if (typeof props.onDismiss === 'function') props.onDismiss()
            }
          }, '×')),
        questions.map((item, index) => h('div', { className: 'sc-question-item', key: `${item.id ?? index}` },
          h('div', { className: 'sc-question-text' }, item.question),
          item.detail === undefined || item.detail === '' ? null : h('div', { className: 'sc-question-detail' }, item.detail),
          Array.isArray(item.options) && item.options.length > 0
            ? h('ul', { className: 'sc-question-options' }, item.options.map((option, optionIndex) => h('li', { key: `${optionIndex}` },
                h('span', { className: 'sc-question-label' }, option.label),
                option.description === undefined || option.description === '' ? null : h('span', { className: 'sc-question-option-detail' }, ' — ' + option.description))))
            : null)),
        h('button', {
          type: 'button',
          className: 'sc-question-discuss',
          onClick: () => {
            if (typeof props.onDiscuss === 'function') props.onDiscuss(questions)
          }
        }, t('question.discuss')))
    }

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
      const question = typeof runtime.getQuestion === 'function' ? runtime.getQuestion(sessionId) : null
      const onQuestionDiscuss = typeof runtime.setDraft === 'function'
        ? (questions) => { runtime.setDraft(panelId, questionDraftText(questions)) }
        : null
      const onQuestionDismiss = typeof runtime.clearQuestion === 'function'
        ? () => { runtime.clearQuestion(sessionId) }
        : null
      return h(PanelBody, { runtime, state, t, onNew, question, onQuestionDiscuss, onQuestionDismiss })
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

    /**
     * The one-line gist of a tool call's arguments, like the main cards show:
     * the command for bash, the path for file tools, a short description
     * otherwise, and the raw JSON only as a last resort.
     * @param raw - the recorded arguments JSON.
     * @returns a compact summary, or an empty string.
     */
    function toolArgsSummary(raw) {
      if (typeof raw !== 'string' || raw.trim() === '') return ''
      try {
        const parsed = JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          if (typeof parsed.command === 'string' && parsed.command.trim() !== '') return truncateInline(parsed.command)
          if (typeof parsed.path === 'string' && parsed.path.trim() !== '') return truncateInline(parsed.path)
          if (typeof parsed.description === 'string' && parsed.description.trim() !== '') return truncateInline(parsed.description)
          for (const value of Object.values(parsed)) {
            if (typeof value === 'string' && value.trim() !== '') return truncateInline(value)
          }
          return ''
        }
      } catch (error) {
        // Not JSON: fall through to the raw one-liner.
      }
      return truncateInline(raw)
    }

    function truncateInline(text) {
      const line = text.replace(/\s+/g, ' ').trim()
      return line.length > 160 ? `${line.slice(0, 160)}…` : line
    }

    /** One tool call as the main transcript's compact row: gist + collapsible output. */
    function ToolBlock(props) {
      const block = props.block
      const t = props.t
      const result = block.result
      const summary = toolArgsSummary(block.argsRaw)
      const failed = result !== null && typeof result === 'object' && result.isError === true
      const output = result !== null && typeof result === 'object'
        ? (typeof result.text === 'string' && result.text !== '' ? result.text : t('tool.emptyOutput'))
        : ''
      const disclosed = React.useState(false)
      const open = disclosed[0] === true
      return h('div', { className: 'sc-tool' },
        h('div', { className: 'sc-tool-head' },
          h('span', { className: 'sc-tool-name' }, block.name === '' ? t('tool.fallbackName') : block.name),
          summary !== '' ? h('code', { className: 'sc-tool-summary', title: summary }, summary) : null,
          failed ? h('span', { className: 'sc-tool-error' }, t('tool.failed')) : null,
          output !== ''
            ? h('button', {
                type: 'button',
                className: 'sc-tool-toggle',
                'aria-expanded': open,
                onClick: () => disclosed[1]((value) => value !== true)
              }, open ? t('tool.hideOutput') : t('tool.showOutput'))
            : null),
        open && output !== '' ? h('pre', { className: 'sc-tool-output' }, output) : null)
    }

    /** Main-transcript-style elapsed label: 42s, 4m 33s. */
    function formatTurnDuration(milliseconds) {
      const total = Math.max(1, Math.round(milliseconds / 1000))
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
    }

    /**
     * One settled turn's process disclosure, shaped like the main transcript's
     * turn-process row: a chevron row with the duration, folding this turn's
     * reasoning and tool calls; the assistant text stays outside it.
     * @param props - the folded process node and the translator.
     */
    function ProcessRow(props) {
      const node = props.node
      const t = props.t
      const opened = React.useState(false)
      const open = opened[0] === true
      const blocks = Array.isArray(node.blocks) ? node.blocks : []
      const hasContent = blocks.length > 0
      const stopped = node.reason === 'aborted' || node.reason === 'interrupted'
      const failed = node.reason === 'error'
      const duration = typeof node.start === 'number' && typeof node.end === 'number'
        ? formatTurnDuration(node.end - node.start)
        : ''
      const label = stopped ? t('process.stopped')
        : failed ? t('process.failed')
          : duration === '' ? t('process.worked')
            : `${t('process.took')}${duration}`
      return h('div', { className: 'sc-turn' },
        h('button', {
          type: 'button',
          className: 'sc-process',
          'data-open': open ? true : undefined,
          disabled: !hasContent,
          'aria-expanded': hasContent ? open : undefined,
          onClick: () => { if (hasContent) opened[1]((value) => value !== true) }
        },
        h('span', { className: 'sc-process-label' }, label),
        hasContent ? h('span', { className: 'sc-process-chevron', 'aria-hidden': 'true' }, '▾') : null),
        open && hasContent
          ? h('div', { className: 'sc-process-body' }, blocks.map((block, index) =>
              block.kind === 'reasoning'
                ? h(Disclosure, {
                    key: index,
                    icon: IconThink,
                    title: t('fold.reasoning'),
                    preview: block.text.length > 80 ? `${block.text.slice(0, 80)}…` : block.text
                  }, h('div', { className: 'sc-reasoning' }, block.text))
                : h(ToolBlock, { key: index, block, t })))
          : null)
    }

    function AssistantRow(props) {
      const blocks = props.blocks
      const t = props.t
      const reasoning = blocks.filter((block) => block.kind === 'reasoning').map((block) => block.text).join('\n\n')
      const texts = blocks.filter((block) => block.kind === 'text')
      const tools = blocks.filter((block) => block.kind === 'tool-call')
      const markdownRef = React.useRef(null)
      useCopyChips(markdownRef, t, texts.length > 0)
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
          ? h('div', { className: 'sc-md-block', ref: markdownRef }, texts.map((block, index) =>
              h(Markdown, {
                key: index,
                text: block.text,
                keyBase: `a${props.seq}-${index}`,
                streaming: props.streaming === true,
                t
              })))
          : null)
    }

    /**
     * One durable image thumbnail. The host route re-verifies the stored object
     * and answers bytes; a non-200 swaps to the failed placeholder instead of
     * retrying forever.
     */
    function ImageThumb(props) {
      const t = props.t
      const ref = props.image
      const sessionId = props.sessionId
      const failed = React.useState(false)
      const broken = failed[0] === true
      if (broken || typeof sessionId !== 'string' || sessionId === '') {
        return h('span', { className: 'sc-image-failed', title: t('image.failed') }, t('image.failed'))
      }
      const src = imageUrlOf(sessionId, ref)
      const label = typeof ref.name === 'string' && ref.name !== '' ? ref.name : t('image.alt')
      return h('a', {
        className: 'sc-image-link',
        href: src,
        target: '_blank',
        rel: 'noreferrer',
        title: label
      }, h('img', {
        className: 'sc-image-thumb',
        src,
        alt: label,
        loading: 'lazy',
        onError: () => failed[1](true)
      }))
    }

    function ImageRailItem(props) {
      const image = props.image
      const t = props.t
      const failed = image.status === 'error'
      const uploading = image.status === 'uploading'
      const reason = failed ? imageReasonText(t, image.error === null ? { code: 'unknown' } : image.error) : ''
      const thumb = typeof image.previewUrl === 'string' && image.previewUrl !== ''
        ? h('img', {
            className: 'sc-image-thumb',
            src: image.previewUrl,
            alt: image.name === '' ? t('image.alt') : image.name
          })
        : h('span', { className: 'sc-image-thumb sc-image-thumb-placeholder', 'aria-hidden': 'true' })
      return h('div', {
        className: failed ? 'sc-rail-item sc-rail-item-error' : uploading ? 'sc-rail-item sc-rail-item-uploading' : 'sc-rail-item'
      },
      thumb,
      uploading ? h('span', { className: 'sc-rail-spinner', 'aria-hidden': 'true' }) : null,
      failed ? h('span', { className: 'sc-rail-error', role: 'img', title: reason, 'aria-label': reason }, '!') : null,
      h('button', {
        type: 'button',
        className: 'sc-rail-remove',
        title: t('image.remove'),
        'aria-label': t('image.remove'),
        onClick: () => props.onRemove(image.key)
      }, '×'),
      failed
        ? h('button', {
            type: 'button',
            className: 'sc-rail-retry',
            title: t('image.retry'),
            'aria-label': t('image.retry'),
            onClick: () => props.onRetry(image.key)
          }, '↻')
        : null)
    }

    /** User text with file/folder/session references as inert chips. */
    function referenceNodes(text) {
      const segments = splitReferenceText(text)
      const nodes = []
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index]
        if (segment.kind !== 'reference') {
          nodes.push(segment.text)
          continue
        }
        const className = segment.referenceKind === 'directory'
          ? 'sc-ref-chip sc-ref-chip-dir'
          : segment.referenceKind === 'session' ? 'sc-ref-chip sc-ref-chip-session' : 'sc-ref-chip'
        nodes.push(h('span', {
          key: `ref-${index}`,
          className,
          title: segment.referenceKind === 'session' ? segment.mention : segment.path
        }, segment.label))
      }
      return nodes
    }

    function UserRow(props) {
      const content = referenceNodes(props.text)
      const images = Array.isArray(props.images) ? props.images : []
      if (images.length === 0) {
        return h('div', { className: 'sc-row sc-row-user' },
          h('div', { className: 'sc-user-stack' },
            h('div', { className: 'sc-bubble' }, content),
            props.time === ''
              ? null
              : h('div', { className: 'sc-meta' }, props.time)))
      }
      const bubbleChildren = [
        h('div', { key: 'images', className: 'sc-bubble-images' }, images.map((image, index) =>
          h(ImageThumb, {
            key: `image-${index}`,
            image,
            sessionId: props.sessionId,
            t: props.t
          })))
      ]
      if (props.text !== '') bubbleChildren.push(h('div', { key: 'text', className: 'sc-bubble-text' }, content))
      return h('div', { className: 'sc-row sc-row-user' },
        h('div', { className: 'sc-user-stack' },
          h('div', { className: 'sc-bubble' }, bubbleChildren),
          props.time === ''
            ? null
            : h('div', { className: 'sc-meta' }, props.time)))
    }

    function PendingRow(props) {
      const pending = props.pending
      const t = props.t
      const images = Array.isArray(pending.images) ? pending.images : []
      if (images.length === 0) {
        return h('div', { className: 'sc-row sc-row-user' },
          h('div', { className: 'sc-user-stack' },
            h('div', { className: 'sc-bubble sc-bubble-pending' }, referenceNodes(pending.text)),
            h('div', { className: 'sc-meta' }, props.time === ''
              ? props.label
              : `${props.time} · ${props.label}`)))
      }
      const bubbleChildren = []
      if (images.length > 0) {
        bubbleChildren.push(h('div', { key: 'images', className: 'sc-bubble-images' }, images.map((image, index) =>
          typeof image.previewUrl === 'string' && image.previewUrl !== ''
            ? h('img', {
                key: `image-${index}`,
                className: 'sc-image-thumb',
                src: image.previewUrl,
                alt: typeof image.name === 'string' && image.name !== '' ? image.name : t('image.alt')
              })
            : h('span', { key: `image-${index}`, className: 'sc-image-thumb sc-image-thumb-placeholder', 'aria-hidden': 'true' }))))
      }
      bubbleChildren.push(h('div', { key: 'text', className: 'sc-bubble-text' },
        pending.text === '' ? t('image.queueLabel') : referenceNodes(pending.text)))
      return h('div', { className: 'sc-row sc-row-user' },
        h('div', { className: 'sc-user-stack' },
          h('div', { className: 'sc-bubble sc-bubble-pending' }, bubbleChildren),
          h('div', { className: 'sc-meta' }, props.time === ''
            ? props.label
            : `${props.time} · ${props.label}`)))
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

    /**
     * Bottom dock under the composer: this side chat's spend (tokens, cache hit)
     * and its absolute context occupancy. Hidden until a usage sample exists; the
     * context reading appears once the window is known (own `request/context` or
     * the host baseline). No dialogs — the exact billing buckets and
     * `~used / window` live in native `title` tooltips.
     */
    function statusDockOf(t, metrics, baselineContextWindow) {
      if (metrics === null || metrics === undefined || typeof metrics !== 'object') return null
      const occupancy = occupancyOf(metrics, baselineContextWindow)
      const cacheWriteTokens = typeof metrics.cacheWriteTokens === 'number' && metrics.cacheWriteTokens > 0
        ? metrics.cacheWriteTokens
        : 0
      const exactUsage = t(cacheWriteTokens > 0 ? 'dock.usageTitleWithWrite' : 'dock.usageTitle', {
        input: formatExactTokenCount(t, metrics.uncachedInputTokens),
        cacheRead: formatExactTokenCount(t, metrics.cacheReadTokens),
        cacheWrite: formatExactTokenCount(t, cacheWriteTokens),
        output: formatExactTokenCount(t, metrics.outputTokens)
      })
      const readings = [
        h('span', { key: 'tokens', className: 'sc-dock-stat', title: exactUsage },
          t('dock.tokens', { count: formatTokenCount(t, metrics.totalTokens) }))
      ]
      if (metrics.cacheHitPercent !== null && metrics.cacheHitPercent !== undefined) {
        readings.push(h('span', { key: 'cache', className: 'sc-dock-stat', title: exactUsage },
          t('dock.cacheHit', { percent: metrics.cacheHitPercent })))
      }
      if (occupancy !== null) {
        const circumference = 2 * Math.PI * 5.5
        readings.push(h('span', {
          key: 'context',
          className: 'sc-dock-context',
          role: 'img',
          title: t('dock.contextTitle', {
            used: formatExactTokenCount(t, occupancy.usedTokens),
            window: formatExactTokenCount(t, occupancy.contextWindow)
          }),
          'aria-label': t('dock.contextAria', { percent: `${occupancy.percent}%` })
        },
        h('svg', {
          className: 'sc-dock-ring',
          viewBox: '0 0 14 14',
          width: 13,
          height: 13,
          'aria-hidden': 'true'
        },
        h('circle', { className: 'sc-dock-ring-track', cx: 7, cy: 7, r: 5.5 }),
        h('circle', {
          className: 'sc-dock-ring-fill',
          cx: 7,
          cy: 7,
          r: 5.5,
          transform: 'rotate(-90 7 7)',
          strokeDasharray: `${circumference * occupancy.percent / 100} ${circumference}`
        })),
        h('span', null, `${occupancy.percent}%`)))
      }
      const children = []
      for (let index = 0; index < readings.length; index += 1) {
        if (index > 0) {
          children.push(h('span', { key: `sep-${index}`, className: 'sc-dock-sep', 'aria-hidden': 'true' }, '·'))
        }
        children.push(readings[index])
      }
      return h('div', { className: 'sc-dock' }, children)
    }

    /**
     * Empty-tab restore list: when the tab has no session yet, offer the side
     * chats whose logs survived a Host restart. A pick resumes that session.
     */
    function RestoreSection(props) {
      const runtime = props.runtime
      const t = props.t
      const mainId = props.mainId
      const listed = React.useState(null)
      React.useEffect(() => {
        let alive = true
        Promise.resolve(runtime.restorable(mainId))
          .then((items) => { if (alive) listed[1](Array.isArray(items) ? items : []) })
          .catch(() => { if (alive) listed[1]([]) })
        return () => { alive = false }
      }, [mainId])
      const items = listed[0]
      if (items === null || items.length === 0) return null
      return h('div', { className: 'sc-restore' },
        h('div', { className: 'sc-restore-title' }, t('restore.title')),
        items.map((item) => h('button', {
          key: item.sessionId,
          type: 'button',
          className: 'sc-restore-item',
          onClick: () => { void runtime.resume(mainId, item.sessionId) }
        },
        h('span', { className: 'sc-restore-time' },
          item.createdAt === null || item.createdAt === undefined ? '' : new Date(item.createdAt).toLocaleString()),
        h('span', { className: 'sc-restore-id' }, item.sessionId.slice(0, 'side-chat-'.length + 8)))))
    }

    function PanelBody(props) {
      const runtime = props.runtime
      const state = props.state
      const question = props.question !== null && props.question !== undefined ? props.question : null
      const t = typeof props.t === 'function' ? props.t : keyTranslator
      const onNew = typeof props.onNew === 'function' ? props.onNew : null
      const reference = referenceStateOf(state)
      const menuOpen = referenceMenuOpen(reference)
      const pickable = menuOpen && reference.candidates.length > 0
      const textareaRef = React.useRef(null)
      const fileInputRef = React.useRef(null)
      const dragState = React.useState(false)
      const dragging = dragState[0] === true
      const caretRequest = reference.caretRequest
      const bodyRef = React.useRef(null)
      const rootRef = React.useRef(null)
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
      React.useEffect(() => {
        const element = textareaRef.current
        if (element === null || element === undefined) return
        if (typeof element.setSelectionRange !== 'function') return
        if (typeof caretRequest !== 'number' || caretRequest <= 0) return
        if (typeof element.focus === 'function') element.focus()
        element.setSelectionRange(reference.caret, reference.caret)
      }, [caretRequest, reference.caret])
      const followBody = () => {
        const body = bodyRef.current
        if (body === null || !stickRef.current) return
        body.scrollTop = body.scrollHeight
      }
      React.useEffect(() => {
        if (fitComposerHeight(textareaRef.current, rootRef.current) === null) return
        followBody()
      }, [state.draft])
      React.useEffect(() => {
        const root = rootRef.current
        const element = textareaRef.current
        if (root === null || element === null || typeof ResizeObserver !== 'function') return undefined
        let size = `${root.clientWidth}x${root.clientHeight}`
        const observer = new ResizeObserver(() => {
          const next = `${root.clientWidth}x${root.clientHeight}`
          if (next === size) return
          size = next
          if (fitComposerHeight(element, root) === null) return
          followBody()
        })
        observer.observe(root)
        return () => observer.disconnect()
      }, [])

      const running = state.running === true
      const sending = state.sending === true
      const busy = running || sending
      const hasDraft = typeof state.draft === 'string' && state.draft.trim() !== ''
      const railImages = Array.isArray(state.images) ? state.images : []
      const readyImageCount = railImages.filter((image) => image.status === 'ready' && image.ref !== null).length
      const canSend = hasDraft || readyImageCount > 0
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
          rows.push(h(UserRow, {
            key: `u${node.seq}-${index}`,
            text: node.text,
            images: node.images,
            sessionId: state.sessionId,
            time: clockOf(node.time),
            t
          }))
        } else if (node.kind === 'process') {
          // Match the main transcript: a turn's process row appears only once the
          // turn settles; while it runs, the live attempt below carries the state.
          if (typeof node.end !== 'number') continue
          rows.push(h(ProcessRow, { key: `p${node.seq}-${index}`, node, t }))
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
        t,
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
      const restore = hasSession ? null : h(RestoreSection, { key: 'restore', runtime, t, mainId: state.mainId })
      const body = h('div', { className: 'sc-body', ref: bodyRef },
        empty ? [restore, emptyBlock] : rows,
        pendingRows,
        showThinking ? thinking : null,
        h(ErrorStrip, { error: errorView }),
        h(ErrorStrip, { error: lastErrorView }))
      const sendIcon = canSend || !busy ? IconSend : IconStop
      const sendTitle = canSend ? t('composer.send') : busy ? t('composer.stop') : t('composer.send')
      const menuId = `${REFERENCE_MENU_PREFIX}-${state.mainId}`
      const activeOptionId = menuOpen && reference.candidates.length > 0
        ? `${menuId}-option-${reference.activeIndex}`
        : undefined
      const menu = referenceMenuOf(t, reference, menuId, (index) => {
        if (typeof runtime.pickReference === 'function') runtime.pickReference(state.mainId, index)
      })
      const rail = railImages.length > 0
        ? h('div', { className: 'sc-image-rail' }, railImages.map((image) => h(ImageRailItem, {
            key: image.key,
            image,
            t,
            onRemove: (key) => {
              if (typeof runtime.removeImage === 'function') runtime.removeImage(state.mainId, key)
            },
            onRetry: (key) => {
              if (typeof runtime.retryImage === 'function') runtime.retryImage(state.mainId, key)
            }
          })))
        : null
      const addFiles = (files) => {
        if (files.length === 0) return
        if (typeof runtime.addImages === 'function') runtime.addImages(state.mainId, files)
      }
      const dragCarriesFiles = (dataTransfer) => {
        if (dataTransfer === null || dataTransfer === undefined || typeof dataTransfer !== 'object') return false
        const types = dataTransfer.types
        if (types !== null && types !== undefined && typeof types.length === 'number') {
          for (let index = 0; index < types.length; index += 1) {
            if (types[index] === 'Files') return true
          }
        }
        return imageFilesOf(dataTransfer).length > 0
      }
      const onDragOver = (event) => {
        // Accept any file drag so the drop does not fall through to the browser's
        // "open this file" navigation; only image files reach the rail.
        if (!dragCarriesFiles(event.dataTransfer)) return
        event.preventDefault()
        if (!dragging && imageFilesOf(event.dataTransfer).length > 0) dragState[1](true)
      }
      const onDragLeave = () => {
        if (dragging) dragState[1](false)
      }
      const onDrop = (event) => {
        const files = imageFilesOf(event.dataTransfer)
        const carriesFiles = dragCarriesFiles(event.dataTransfer)
        dragState[1](false)
        if (!carriesFiles) return
        event.preventDefault()
        addFiles(files)
      }
      const onPaste = (event) => {
        const files = imageFilesOf(event.clipboardData)
        if (files.length === 0) return
        addFiles(files)
      }
      const attachButton = h('button', {
        type: 'button',
        className: 'sc-attach',
        title: t('image.add'),
        'aria-label': t('image.add'),
        onClick: () => {
          const input = fileInputRef.current
          if (input !== null && input !== undefined && typeof input.click === 'function') input.click()
        }
      }, h('svg', {
        className: 'sc-attach-icon',
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        'aria-hidden': 'true'
      }, h('path', {
        d: 'M6.4 9.6 10.5 5.5a2.1 2.1 0 0 0-3-3L3.8 6.2a3.4 3.4 0 0 0 4.8 4.8l3.5-3.5',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.4,
        'stroke-linecap': 'round'
      })))
      const fileInput = h('input', {
        ref: fileInputRef,
        className: 'sc-file-input',
        type: 'file',
        accept: IMAGE_ACCEPT,
        multiple: true,
        onChange: (event) => {
          const input = event.target
          addFiles(imageFilesOf({ files: input.files }))
          input.value = ''
        }
      })
      const composerMiddle = []
      if (rail !== null) composerMiddle.push(rail)
      if (dragging) composerMiddle.push(h('div', { className: 'sc-drop-hint' }, t('image.dropHint')))
      const composer = h('div', {
        className: dragging ? 'sc-composer sc-composer-drop' : 'sc-composer',
        onDragOver,
        onDragLeave,
        onDrop
      },
        menu,
        ...composerMiddle,
        h('textarea', {
          ref: textareaRef,
          className: 'sc-textarea',
          value: state.draft,
          rows: 1,
          placeholder: hasSession ? t('composer.placeholder') : t('composer.placeholderBlank'),
          role: 'combobox',
          'aria-autocomplete': 'list',
          'aria-expanded': menuOpen,
          'aria-controls': menuOpen ? menuId : undefined,
          'aria-activedescendant': activeOptionId,
          onChange: (event) => {
            const target = event.target
            const value = target.value
            const caret = typeof target.selectionStart === 'number' ? target.selectionStart : value.length
            if (typeof runtime.composeDraft === 'function') runtime.composeDraft(state.mainId, value, caret)
            else runtime.setDraft(state.mainId, value)
          },
          onPaste: (event) => {
            onPaste(event)
          },
          onCompositionStart: () => {
            if (typeof runtime.setComposing === 'function') runtime.setComposing(state.mainId, true)
          },
          onCompositionEnd: (event) => {
            if (typeof runtime.setComposing === 'function') runtime.setComposing(state.mainId, false)
            const target = event !== null && typeof event === 'object' ? event.target : null
            const value = target !== null && typeof target === 'object' && typeof target.value === 'string'
              ? target.value
              : state.draft
            const caret = target !== null && typeof target === 'object' && typeof target.selectionStart === 'number'
              ? target.selectionStart
              : value.length
            if (typeof runtime.composeDraft === 'function') runtime.composeDraft(state.mainId, value, caret)
          },
          onBlur: () => {
            if (typeof runtime.closeReferences === 'function') runtime.closeReferences(state.mainId)
          },
          onKeyDown: (event) => {
            const action = editorKeyAction(event, {
              open: menuOpen,
              pickable,
              composing: reference.composing === true
            })
            if (action === 'newline' || action === 'none') return
            event.preventDefault()
            if (action === 'submit') {
              if (typeof runtime.closeReferences === 'function') runtime.closeReferences(state.mainId)
              void runtime.send(state.mainId)
              return
            }
            if (action === 'pick') {
              if (typeof runtime.pickReference === 'function') runtime.pickReference(state.mainId, reference.activeIndex)
              return
            }
            if (action === 'next') {
              if (typeof runtime.moveReference === 'function') runtime.moveReference(state.mainId, 1)
              return
            }
            if (action === 'prev') {
              if (typeof runtime.moveReference === 'function') runtime.moveReference(state.mainId, -1)
              return
            }
            if (action === 'close' && typeof runtime.closeReferences === 'function') runtime.closeReferences(state.mainId)
          }
        }),
        h('div', { className: 'sc-actions' },
          attachButton,
          fileInput,
          h('button', {
            type: 'button',
            className: canSend ? 'sc-send' : 'sc-send sc-send-stop',
            disabled: !canSend && !busy,
            title: sendTitle,
            'aria-label': sendTitle,
            onClick: () => {
              if (canSend) void runtime.send(state.mainId)
              else if (busy) void runtime.cancel(state.mainId)
            }
          }, icon(sendIcon))))
      const dock = statusDockOf(t, state.metrics, state.contextWindow)
      const footer = h('div', { className: 'sc-footer' }, composer, dock)
      const questionView = question === null
        ? null
        : h(QuestionCard, { question, t, onDiscuss: props.onQuestionDiscuss, onDismiss: props.onQuestionDismiss })
      const panelChildren = [statusbar]
      if (questionView !== null) panelChildren.push(questionView)
      panelChildren.push(body, footer)
      return h('div', { className: 'sc-root', role: 'tabpanel', ref: rootRef, 'aria-label': t('tab.title') }, ...panelChildren)
    }

    /** Format a question request as plain composer text for the discuss action. */
    function questionDraftText(questions) {
      const lines = []
      for (const item of Array.isArray(questions) ? questions : []) {
        if (item === null || item === undefined || typeof item.question !== 'string') continue
        lines.push(item.question)
        if (typeof item.detail === 'string' && item.detail !== '') lines.push(item.detail)
        for (const option of Array.isArray(item.options) ? item.options : []) {
          if (option !== null && option !== undefined && typeof option.label === 'string') lines.push(`- ${option.label}`)
        }
        lines.push('')
      }
      return lines.join('\n').trim()
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
      if (ctx.remote !== null && ctx.remote !== undefined && typeof ctx.remote.$on === 'function'
        && ctx.sessions !== null && ctx.sessions !== undefined && typeof ctx.sessions.scopeOf === 'function') ctx.effect(() => ctx.remote.$on('user-questions/request', function (request, next) {
        try {
          const sessionId = typeof ctx.sessions.scopeOf === 'function' ? ctx.sessions.scopeOf(this) : undefined
          if (typeof sessionId === 'string' && sessionId !== '') runtime.setQuestion(sessionId, request)
        } catch (error) {
          // Observation must never break the question waterfall.
        }
        return typeof next === 'function' ? next() : undefined
      }), 'dsh-side-chat: question observer')
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
.sc-turn {
  display: flex;
  flex-direction: column;
}
.sc-process {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  height: 33px;
  padding: 0 0 8px;
  border: none;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  background: none;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition: color 100ms ease;
}
.sc-process:disabled {
  cursor: default;
}
@media (hover: hover) {
  .sc-process:hover:not(:disabled) {
    color: var(--dsw-alias-label-secondary, #61666b);
  }
}
.sc-process-label {
  min-width: 0;
  overflow: hidden;
  line-height: 24px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sc-process-chevron {
  flex: none;
  margin-left: 4px;
  font-size: 12px;
  line-height: 1;
  transition: transform 100ms ease;
}
.sc-process[data-open] .sc-process-chevron {
  transform: rotate(180deg);
}
.sc-process-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 0 2px;
}
.sc-question {
  flex: none;
  margin: 8px 14px 0;
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.16));
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #fafafa);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}
.sc-question-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.sc-question-title {
  font-size: 11px;
  line-height: 18px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, #61666b);
}
.sc-question-dismiss {
  padding: 0 2px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font: inherit;
  font-size: 14px;
  line-height: 18px;
  cursor: pointer;
}
.sc-question-item {
  margin-top: 4px;
}
.sc-question-text {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary, #0f1115);
}
.sc-question-detail {
  margin-top: 2px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary, #81858c);
}
.sc-question-options {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #61666b);
}
.sc-question-label {
  color: var(--dsw-alias-label-primary, #0f1115);
}
.sc-question-option-detail {
  color: var(--dsw-alias-label-tertiary, #81858c);
}
.sc-question-discuss {
  margin-top: 6px;
  height: 24px;
  padding: 0 9px;
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.16));
  border-radius: 7px;
  background: var(--dsw-alias-interactive-bg-hover, #f0f0f0);
  color: var(--dsw-alias-label-primary, #0f1115);
  font: inherit;
  font-size: 11px;
  line-height: 22px;
  cursor: pointer;
}
.sc-question-discuss:hover {
  border-color: transparent;
  background: var(--dsw-alias-brand-primary, #4d6bfe);
  color: #ffffff;
}
.sc-question-dismiss:focus-visible,
.sc-question-discuss:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: 1px;
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
.sc-restore {
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 12px 0 4px;
}
.sc-restore-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary, #81858c);
}
.sc-restore-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  padding: 7px 10px;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #fafafa);
  color: var(--dsw-alias-label-secondary, #61666b);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.sc-restore-item:hover {
  background: var(--dsw-alias-bg-layer-2, #f0f0f0);
}
.sc-restore-time {
  flex: none;
  color: var(--dsw-alias-label-tertiary, #81858c);
}
.sc-restore-id {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 11.5px;
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
.sc-md-table-wrap {
  max-width: 100%;
  overflow-x: auto;
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
.sc-copy-host {
  position: relative;
}
.sc-copy-chip {
  position: absolute;
  top: 4px;
  right: 2px;
  z-index: 1;
  padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-tertiary, #81858c);
  font: inherit;
  font-size: 11px;
  line-height: 18px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 120ms ease;
}
.sc-copy-host:hover > .sc-copy-chip,
.sc-copy-host:focus-within > .sc-copy-chip,
.sc-copy-chip:focus-visible {
  opacity: 1;
}
@media (hover: none) {
  .sc-copy-chip {
    opacity: 1;
  }
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
  gap: 6px;
  min-width: 0;
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #fafafa);
}
.sc-tool-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.sc-tool-name {
  flex: none;
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #0f1115);
}
.sc-tool-summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, #81858c);
}
.sc-tool-error {
  flex: none;
  margin-left: auto;
  font-size: 11px;
  padding: 0 6px;
  border-radius: 999px;
  color: var(--dsw-alias-state-error-primary, #c0392b);
  background: var(--dsw-alias-state-error-secondary, rgba(192, 57, 43, 0.12));
}
.sc-tool-toggle {
  flex: none;
  margin-left: auto;
  padding: 0 2px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.sc-tool-toggle:hover {
  color: var(--dsw-alias-label-secondary, #61666b);
}
.sc-tool-output {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  background: var(--dsw-alias-bg-base, #ffffff);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary, #61666b);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
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
.sc-dock {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding-top: 6px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-variant-numeric: tabular-nums;
}
.sc-dock-stat,
.sc-dock-context {
  flex: none;
  white-space: nowrap;
}
.sc-dock-context {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.sc-dock-sep {
  flex: none;
  color: var(--dsw-alias-separator-primary, rgba(0, 0, 0, 0.16));
}
.sc-dock-ring {
  flex: none;
}
.sc-dock-ring-track {
  fill: none;
  stroke: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.14));
  stroke-width: 2;
}
.sc-dock-ring-fill {
  fill: none;
  stroke: var(--dsw-alias-label-tertiary, #81858c);
  stroke-width: 2;
  stroke-linecap: round;
}
.sc-ref-menu {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 220px;
  margin-bottom: 6px;
  padding: 4px;
  overflow-y: auto;
  border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  background: var(--dsw-alias-bg-layer-1, #fafafa);
}
.sc-ref-option {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 5px 8px;
  border-radius: 8px;
  color: var(--dsw-alias-label-primary, #0f1115);
  font-size: 13px;
  line-height: 18px;
  cursor: pointer;
}
.sc-ref-option-active {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
}
.sc-ref-group {
  padding: 5px 8px 2px;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  letter-spacing: 0.02em;
}
.sc-ref-kind {
  flex: none;
  width: 12px;
  color: var(--dsw-alias-label-tertiary, #81858c);
  text-align: center;
}
.sc-ref-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sc-ref-dir {
  flex: 0 1 auto;
  min-width: 0;
  margin-left: auto;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sc-ref-status {
  padding: 5px 8px;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-size: 12.5px;
  line-height: 18px;
}
.sc-ref-chip {
  display: inline;
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.06));
  color: var(--dsw-alias-label-secondary, #61666b);
  font-size: 0.88em;
  white-space: nowrap;
}
.sc-ref-chip-dir {
  font-weight: 500;
}
.sc-ref-chip-session {
  font-weight: 500;
  background: var(--dsw-alias-bg-layer-3, rgba(0, 0, 0, 0.08));
}
.sc-textarea {
  width: 100%;
  flex: none;
  min-height: 26px;
  overflow-y: auto;
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
.sc-file-input {
  display: none;
}
.sc-attach {
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #81858c);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.sc-attach:hover {
  background: var(--dsw-alias-interactive-bg-hover, #e4e7ec);
  color: var(--dsw-alias-label-primary, #0f1115);
}
.sc-composer-drop {
  border-style: dashed;
  border-color: var(--dsw-alias-brand-primary, #4d6bfe);
}
.sc-drop-hint {
  padding: 6px 8px;
  border-radius: 10px;
  background: var(--dsw-alias-interactive-bg-hover, #eef1f7);
  color: var(--dsw-alias-label-secondary, #4b5058);
  font-size: 13px;
  line-height: 18px;
  text-align: center;
}
.sc-image-rail {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 4px 0;
}
.sc-rail-item {
  position: relative;
  width: 56px;
  height: 56px;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  background: var(--dsw-alias-bg-layer-1, #fafafa);
}
.sc-rail-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.sc-rail-item-error {
  border-color: var(--dsw-alias-state-error-primary, #d54941);
}
.sc-rail-item-error img {
  opacity: 0.45;
}
.sc-rail-item-uploading img {
  opacity: 0.7;
}
.sc-rail-spinner {
  position: absolute;
  inset: 0;
  background: var(--dsw-alias-button-primary-fill, rgb(65, 118, 230));
  opacity: 0.25;
  animation: sc-pulse 1s ease-in-out infinite;
}
.sc-rail-error {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--dsw-alias-state-error-primary, #d54941);
  font-size: 20px;
  font-weight: 700;
}
.sc-rail-remove,
.sc-rail-retry {
  position: absolute;
  top: 3px;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 999px;
  display: grid;
  place-items: center;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  background: var(--dsw-alias-button-contrast-fill, rgba(15, 17, 21, 0.72));
  color: var(--dsw-alias-label-primary-inverted, #ffffff);
}
.sc-rail-remove {
  right: 3px;
}
.sc-rail-retry {
  left: 3px;
  background: var(--dsw-alias-state-error-primary, #d54941);
}
.sc-bubble-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 1px 0 6px;
}
.sc-image-link {
  display: block;
  line-height: 0;
}
.sc-image-thumb {
  width: 64px;
  height: 64px;
  object-fit: cover;
  border-radius: 10px;
  display: block;
  background: var(--dsw-alias-bg-layer-1, #eef0f3);
}
.sc-image-thumb-placeholder {
  display: inline-block;
  border: 1px dashed var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.16));
}
.sc-image-failed {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  padding: 4px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #eef0f3);
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-size: 11px;
  line-height: 14px;
  text-align: center;
}
.sc-bubble-text {
  white-space: pre-wrap;
  word-break: break-word;
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
    exports.inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'locale', 'remote', 'sessions']
    exports.apply = apply
    exports.createRuntime = createRuntime
    exports.foldEntries = foldEntries
    exports.toolArgsSummary = toolArgsSummary
    exports.formatTurnDuration = formatTurnDuration
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
    exports.normalizeBareTexEnvironments = normalizeBareTexEnvironments
    exports.normalizeCellText = normalizeCellText
    exports.tableCellsOfElement = tableCellsOfElement
    exports.tableToTsv = tableToTsv
    exports.tableToHtml = tableToHtml
    exports.decorateCopyChips = decorateCopyChips
    exports.COPY_CHIP_CLASS = COPY_CHIP_CLASS
    exports.COPY_FEEDBACK_MS = COPY_FEEDBACK_MS
    exports.SIDE_CHAT_TYPE_ID = SIDE_CHAT_TYPE_ID
    exports.questionDraftText = questionDraftText
    exports.SIDE_CHAT_KIND = SIDE_CHAT_KIND
    exports.LOCALE_NS = LOCALE_NS
    exports.ZH_DICT = ZH_DICT
    exports.EN_DICT = EN_DICT
    exports.formatError = formatError
    exports.imageRefOf = imageRefOf
    exports.imageRefsOfContent = imageRefsOfContent
    exports.imageUrlOf = imageUrlOf
    exports.imageFilesOf = imageFilesOf
    exports.imageFileOf = imageFileOf
    exports.isImageMediaType = isImageMediaType
    exports.imageReasonKey = imageReasonKey
    exports.imageReasonText = imageReasonText
    exports.IMAGE_MEDIA_TYPES = IMAGE_MEDIA_TYPES
    exports.IMAGE_ACCEPT = IMAGE_ACCEPT
    exports.statusLabel = statusLabel
    exports.pendingLabel = pendingLabel
    exports.contextLabel = contextLabel
    exports.usageBucketsOf = usageBucketsOf
    exports.streamUsageOf = streamUsageOf
    exports.metricsOf = metricsOf
    exports.cacheHitText = cacheHitText
    exports.occupancyOf = occupancyOf
    exports.formatTokenCount = formatTokenCount
    exports.formatExactTokenCount = formatExactTokenCount
    exports.statusDockOf = statusDockOf
    exports.activeAtToken = activeAtToken
    exports.activeTokenAt = activeTokenAt
    exports.formatFileMention = formatFileMention
    exports.formatSessionReferenceToken = formatSessionReferenceToken
    exports.expandSessionReferences = expandSessionReferences
    exports.applyReferencePick = applyReferencePick
    exports.splitReferenceText = splitReferenceText
    exports.referenceNodes = referenceNodes
    exports.editorKeyAction = editorKeyAction
    exports.composerHeightLimit = composerHeightLimit
    exports.fitComposerHeight = fitComposerHeight
    exports.referenceMenuOpen = referenceMenuOpen
    exports.nextReferenceIndex = nextReferenceIndex
    exports.referenceCandidatesOf = referenceCandidatesOf
    exports.referenceDescriptionOf = referenceDescriptionOf
    exports.relativeReferenceAge = relativeReferenceAge
    exports.referenceMenuOf = referenceMenuOf
    exports.referenceStateOf = referenceStateOf
    exports.REFERENCE_DEBOUNCE_MS = REFERENCE_DEBOUNCE_MS
    exports.REFERENCE_QUERY_MAX_CHARS = REFERENCE_QUERY_MAX_CHARS
    exports.PANEL_CSS = PANEL_CSS

    return module.exports
  }
})
