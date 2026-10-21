import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'lib', 'client.js')
const bundleSource = fs.readFileSync(bundlePath, 'utf8')
const API_PREFIX = '/side-chat/api/'
const TYPE_ID = '@flyer103/dsh-side-chat'
const KIND = 'side-chat'
const NS = 'side-chat'
const ERROR_CODES = ['unknown-source', 'not-found', 'empty-prompt', 'create-failed', 'prompt-failed', 'dispose-failed', 'internal']

function createReactStub() {
  const noop = () => {}
  const stub = {
    subscriptions: [],
    createElement: (type, props, ...children) => ({ type, props: props === null ? {} : props, children }),
    Fragment: 'Fragment',
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, noop],
    useEffect: noop,
    useRef: (initial) => ({ current: initial === undefined ? null : initial }),
    useMemo: (factory) => factory(),
    useSyncExternalStore: (subscribe, getSnapshot) => {
      const entry = { subscribe, getSnapshot, notified: 0, unsubscribe: null }
      const value = getSnapshot()
      entry.value = value
      if (typeof subscribe === 'function') {
        entry.unsubscribe = subscribe(() => {
          entry.notified += 1
        })
      }
      stub.subscriptions.push(entry)
      return value
    }
  }
  return stub
}

function createPrimitivesStub() {
  const component = (name) => (props) => ({ type: name, props: props === null ? {} : props })
  return {
    MarkdownText: component('MarkdownText'),
    IconCloseOutlineRegular: component('IconCloseOutlineRegular'),
    IconSendOutlineRegular: component('IconSendOutlineRegular'),
    IconStopFillRegular: component('IconStopFillRegular'),
    IconThinkOutlineRegular: component('IconThinkOutlineRegular'),
    IconCodeOutlineRegular: component('IconCodeOutlineRegular')
  }
}

function createDocumentStub() {
  const appended = []
  const doc = {
    hidden: false,
    head: {
      append(element) {
        appended.push(element)
      }
    },
    createElement(tag) {
      return {
        tagName: tag,
        dataset: {},
        textContent: '',
        removed: false,
        remove() {
          this.removed = true
          const index = appended.indexOf(this)
          if (index >= 0) appended.splice(index, 1)
        }
      }
    },
    addEventListener: () => {},
    removeEventListener: () => {}
  }
  return { doc, appended }
}

function createLocaleStub(initial = 'zh') {
  const dictionaries = new Map()
  const listeners = new Set()
  let active = initial
  let revision = 0
  function dictionariesOf(namespace) {
    let byLocale = dictionaries.get(namespace)
    if (byLocale === undefined) {
      byLocale = new Map()
      dictionaries.set(namespace, byLocale)
    }
    return byLocale
  }
  function lookup(namespace, key) {
    const byLocale = dictionaries.get(namespace)
    if (byLocale === undefined) return undefined
    for (const locale of [active, 'en']) {
      const value = byLocale.get(locale)
      if (value !== undefined && value[key] !== undefined) return value[key]
    }
    return undefined
  }
  return {
    register(namespace, localeOrDicts, dict) {
      const pairs = typeof localeOrDicts === 'string' ? [[localeOrDicts, dict]] : Object.entries(localeOrDicts)
      const byLocale = dictionariesOf(namespace)
      for (const [locale, entries] of pairs) byLocale.set(locale, entries)
      revision += 1
      return () => {
        for (const [locale, entries] of pairs) {
          if (byLocale.get(locale) === entries) byLocale.delete(locale)
        }
      }
    },
    bind(namespace) {
      return (key, params) => {
        const template = lookup(namespace, key)
        const value = template === undefined ? key : template
        if (params === undefined || params === null) return value
        return value.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      }
    },
    getSnapshot() {
      return { active, revision, locales: [] }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setLocale(locale) {
      if (active === locale) return
      active = locale
      revision += 1
      for (const listener of [...listeners]) listener()
    },
    getLocale() {
      return active
    },
    dictionary(namespace, locale) {
      return dictionaries.get(namespace)?.get(locale)
    }
  }
}

function loadBundle(options = {}) {
  const loadCalls = []
  const fakeWindow = {
    __ModuleLoader__: {
      load(registration) {
        loadCalls.push(registration)
      }
    }
  }
  new Function('window', bundleSource)(fakeWindow)
  assert.equal(loadCalls.length, 1, 'bundle must register exactly one factory')
  const registration = loadCalls[0]
  const react = createReactStub()
  const primitives = options.primitives === true ? createPrimitivesStub() : null
  const requireImpl = (specifier) => {
    if (specifier === 'react') return react
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
      if (primitives === null) throw new Error('Cannot find module: ' + specifier)
      return primitives
    }
    throw new Error('Cannot find module: ' + specifier)
  }
  const exportsObject = registration.factory(requireImpl)
  return { registration, exports: exportsObject, react }
}

function createCtxStub() {
  const disposers = []
  const registered = []
  const injected = []
  const tabTypes = []
  const closeHandlers = []
  const locale = createLocaleStub()
  const ctx = {
    locale,
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return typeof dispose === 'function' ? dispose : () => {}
    },
    slots: {
      inject(name, callback) {
        injected.push(name)
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      }
    },
    sidebarRightTabs: {
      register(definition) {
        tabTypes.push(definition)
        return () => {}
      }
    },
    sidebarRight: {
      registerCloseHandler(kind, handler) {
        closeHandlers.push({ kind, handler })
        return () => {}
      }
    }
  }
  return { ctx, disposers, registered, injected, tabTypes, closeHandlers, locale }
}

function applyBundle(exports) {
  const stub = createCtxStub()
  const { doc, appended } = createDocumentStub()
  const previous = globalThis.document
  globalThis.document = doc
  try {
    exports.apply(stub.ctx)
  } finally {
    globalThis.document = previous
  }
  return { ...stub, doc, appended }
}

function createSchedulerStub() {
  let nextId = 1
  const timers = new Map()
  return {
    setTimeout(fn, ms) {
      const id = nextId
      nextId += 1
      timers.set(id, { fn, ms })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    pending() {
      return timers.size
    },
    runAll() {
      const pending = [...timers.values()]
      timers.clear()
      for (const timer of pending) timer.fn()
    }
  }
}

function createFetchStub(responses) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const body = init === undefined ? {} : JSON.parse(init.body)
    calls.push({ url, body, method: init === undefined ? undefined : init.method })
    const name = url.startsWith(API_PREFIX) ? url.slice(API_PREFIX.length) : url
    const handler = responses[name]
    const payload = typeof handler === 'function' ? handler(body) : (handler === undefined ? { ok: true } : handler)
    return {
      ok: true,
      status: 200,
      json: async () => payload
    }
  }
  return { fetchImpl, calls }
}

function createRuntimeWith(fetchStub, options = {}) {
  const { exports } = loadBundle({ primitives: options.primitives === true })
  const scheduler = createSchedulerStub()
  const runtime = exports.createRuntime({
    fetch: fetchStub.fetchImpl,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    document: null,
    pollRunningMs: 5,
    pollIdleMs: 5,
    ...(options.config === undefined ? {} : options.config)
  })
  return { exports, scheduler, runtime }
}

/** A pushable stream body: tests decide when (and whether) the next SSE chunk exists. */
function createChunkQueue() {
  const encoder = new TextEncoder()
  const queue = []
  const waiters = []
  let closed = false
  function settleWaiters(result) {
    const pending = waiters.splice(0)
    for (const resolve of pending) resolve(result)
  }
  const reader = {
    read() {
      if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift() })
      if (closed === true) return Promise.resolve({ done: true, value: undefined })
      return new Promise((resolve) => {
        waiters.push(resolve)
      })
    },
    cancel() {
      closed = true
      settleWaiters({ done: true, value: undefined })
      return Promise.resolve()
    }
  }
  return {
    reader,
    push(text) {
      if (closed === true) return
      const value = encoder.encode(text)
      const waiter = waiters.shift()
      if (waiter !== undefined) waiter({ done: false, value })
      else queue.push(value)
    },
    close() {
      if (closed === true) return
      closed = true
      settleWaiters({ done: true, value: undefined })
    },
    isClosed() {
      return closed
    }
  }
}

function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * Fetch stub that can answer /events with a controlled SSE stream (`stream`), a JSON
 * document without a body (`json`), a body that only contains JSON (`json-body`), or a
 * body whose reads never resolve (`hanging`).
 */
function createStreamingFetchStub(options = {}) {
  const calls = []
  const streams = []
  const handlers = options.handlers === undefined ? {} : options.handlers
  const eventsMode = options.eventsMode === undefined ? 'stream' : options.eventsMode
  function payloadOf(name, body) {
    const handler = handlers[name]
    if (typeof handler === 'function') return handler(body)
    if (handler === undefined) return { ok: true }
    return handler
  }
  const fetchImpl = async (url, init) => {
    const name = url.startsWith(API_PREFIX) ? url.slice(API_PREFIX.length) : url
    const body = init === undefined || init.body === undefined ? {} : JSON.parse(init.body)
    calls.push({ url, body, method: init === undefined ? undefined : init.method, init })
    if (name !== 'events') {
      return { ok: true, status: 200, json: async () => payloadOf(name, body) }
    }
    if (eventsMode === 'json' || eventsMode === 'json-body') {
      const payload = payloadOf('events', body)
      if (eventsMode === 'json') return { ok: true, status: 200, json: async () => payload }
      const queue = createChunkQueue()
      queue.push(JSON.stringify(payload))
      queue.close()
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json; charset=utf-8' },
        body: { getReader: () => queue.reader }
      }
    }
    if (eventsMode === 'hanging') {
      const readers = []
      const reader = {
        read() {
          return new Promise((resolve) => {
            readers.push(resolve)
          })
        },
        cancel() {
          const pending = readers.splice(0)
          for (const resolve of pending) resolve({ done: true, value: undefined })
          return Promise.resolve()
        }
      }
      streams.push({ init, queue: null, response: null })
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream; charset=utf-8' },
        body: { getReader: () => reader }
      }
    }
    const queue = createChunkQueue()
    const response = {
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream; charset=utf-8' },
      body: { getReader: () => queue.reader }
    }
    streams.push({ init, queue, response })
    return response
  }
  return { fetchImpl, calls, streams }
}

/** Live + committed messages used by the streaming tests. */
function streamingHandlers(extra = {}) {
  return {
    create: { ok: true, sessionId: 'side-1', inheritedEventCount: 0 },
    prompt: { ok: true },
    snapshot: {
      ok: true,
      inheritedEventCount: 0,
      running: false,
      status: 'idle',
      lastError: null,
      entries: [],
      live: null
    },
    ...extra
  }
}

/** Open the panel on a visible tab, send one message, then run the scheduled connection. */
async function openConnectedStream(fetchStub, options = {}) {
  const created = createRuntimeWith(fetchStub, options)
  created.runtime.open('main-1')
  created.runtime.setVisible('main-1', true)
  await created.runtime.send('main-1', 'hello side chat')
  created.scheduler.runAll()
  await flush()
  return created
}

function collectElements(tree, visit) {
  if (tree === null || tree === undefined) return
  if (Array.isArray(tree)) {
    for (const item of tree) collectElements(item, visit)
    return
  }
  if (typeof tree !== 'object') return
  visit(tree)
  collectElements(tree.children, visit)
}

function findElement(tree, predicate) {
  let found
  collectElements(tree, (element) => {
    if (found === undefined && predicate(element)) found = element
  })
  return found
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function userEntry(seq, text, source = { kind: 'user' }) {
  return {
    seq,
    type: 'user/message',
    time: 1700000000000 + seq * 1000,
    surfaceOp: 'append',
    data: {
      id: `user-${seq}`,
      source,
      content: [{ type: 'text', text }]
    }
  }
}

function boundaryEntry(seq) {
  return {
    seq,
    type: 'user/message',
    time: 1700000000000 + seq * 1000,
    surfaceOp: 'append',
    data: {
      id: `boundary-${seq}`,
      source: { kind: 'plugin:side-chat' },
      content: [{ type: 'text', text: 'Side conversation boundary.\n\ninherited context' }]
    }
  }
}

function assistantEntry(seq, content) {
  return {
    seq,
    type: 'assistant/message',
    time: 1700000000000 + seq * 1000,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: { id: `assistant-${seq}`, content },
      usage: {}
    }
  }
}

function toolResultEntry(seq, callId, text, isError = false) {
  return {
    seq,
    type: 'tool/result',
    time: 1700000000000 + seq * 1000,
    surfaceOp: 'append',
    data: {
      message: {
        source: { callId },
        content: [{ type: 'text', text }],
        isError
      }
    }
  }
}

test('bundle registers the package id and exports the sidebar plugin face', () => {
  const { registration, exports } = loadBundle()
  assert.equal(registration.id, '@flyer103/dsh-side-chat')
  assert.equal(typeof registration.factory, 'function')
  assert.equal(exports.name, 'dsh-side-chat')
  assert.deepEqual(exports.inject, ['slots', 'sidebarRight', 'sidebarRightTabs', 'locale'])
  assert.equal(typeof exports.apply, 'function')
})

test('zh and en dictionaries share the same non-empty key set', () => {
  const { exports } = loadBundle()
  const zh = exports.ZH_DICT
  const en = exports.EN_DICT
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(zhKeys, enKeys)
  assert.ok(zhKeys.length >= 38, `expected a complete key set, got ${zhKeys.length}`)
  for (const key of zhKeys) {
    assert.equal(typeof zh[key], 'string', `zh.${key} must be a string`)
    assert.notEqual(zh[key].trim(), '', `zh.${key} must not be empty`)
    assert.equal(typeof en[key], 'string', `en.${key} must be a string`)
    assert.notEqual(en[key].trim(), '', `en.${key} must not be empty`)
  }
  assert.equal(exports.LOCALE_NS, NS)
  assert.match(zh['status.pending'], /\{count\}/)
  assert.match(en['status.pending'], /\{count\}/)
})

test('apply registers the sidebar tab type, the localized body slot and the close handler', () => {
  const { exports } = loadBundle()
  const { registered, injected, tabTypes, closeHandlers, locale } = applyBundle(exports)

  assert.deepEqual(injected, ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'])
  assert.equal(registered.length, 2)
  const body = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
  const title = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab.title')
  assert.ok(body !== undefined, 'tab body slot must be registered')
  assert.ok(title !== undefined, 'tab title slot must be registered')
  assert.equal(title.options.key, TYPE_ID)
  assert.equal(title.options.locale, NS)
  assert.equal(typeof title.component, 'function')
  assert.equal(body.options.name, 'sidebar.right.pane.tab')
  assert.equal(body.options.key, TYPE_ID)
  assert.equal(body.options.locale, NS)
  assert.equal(typeof body.component, 'function')
  assert.deepEqual(locale.dictionary(NS, 'zh'), exports.ZH_DICT)
  assert.deepEqual(locale.dictionary(NS, 'en'), exports.EN_DICT)

  assert.equal(tabTypes.length, 1)
  const type = tabTypes[0]
  assert.equal(type.id, TYPE_ID)
  assert.equal(type.kind, KIND)
  assert.equal(type.priority, 'extension')
  assert.equal(type.keepMounted, true)
  assert.equal(type.title(), '侧边会话')
  assert.equal(type.multiple, true)
  assert.equal(type.guide.length, 1)
  assert.equal(type.guide[0].id, 'side-chat')
  assert.equal(type.guide[0].order, 10)
  assert.equal(type.guide[0].title(), '侧边会话')
  assert.ok(type.guide[0].description().includes('关闭即销毁'))

  assert.equal(closeHandlers.length, 1)
  assert.equal(closeHandlers[0].kind, KIND)
  assert.equal(typeof closeHandlers[0].handler, 'function')
})

test('apply no longer registers the header button or the shell overlay', () => {
  const { exports } = loadBundle()
  const { registered, injected } = applyBundle(exports)
  assert.equal(injected.includes('conversation.session.header.actions'), false)
  assert.equal(injected.includes('shell.overlay'), false)
  assert.equal(registered.some((entry) => entry.options.id === 'side-chat.toggle'), false)
  assert.equal(registered.some((entry) => entry.options.id === 'side-chat.panel'), false)
})

test('the injected tab body props carry the runtime, translator and locale face', () => {
  const { exports } = loadBundle()
  const { registered, locale } = applyBundle(exports)
  const inject = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab').options.inject
  assert.equal(typeof inject, 'function')
  const props = inject('session-1')
  assert.equal(props.sessionId, 'session-1')
  assert.equal(typeof props.runtime.open, 'function')
  assert.equal(typeof props.runtime.setVisible, 'function')
  assert.equal(typeof props.t, 'function')
  assert.equal(props.locale, locale)
  assert.equal(props.t('status.running'), '运行中')
})

test('tab title and guide copy follow the active locale through thunks', () => {
  const { exports } = loadBundle()
  const { tabTypes, locale, registered } = applyBundle(exports)
  const type = tabTypes[0]
  assert.equal(type.title(), '侧边会话')
  assert.equal(type.guide[0].title(), '侧边会话')
  assert.ok(type.guide[0].description().startsWith('临时侧边会话'))

  locale.setLocale('en')
  assert.equal(type.title(), 'Side chat')
  assert.equal(type.guide[0].title(), 'Side chat')
  assert.ok(type.guide[0].description().startsWith('Temporary side conversation'))

  const titleComponent = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab.title').component
  const titleProps = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab').options.inject('session-1')
  assert.equal(titleComponent({ t: titleProps.t }).children[0], 'Side chat')

  locale.setLocale('zh')
  assert.equal(type.title(), '侧边会话')
  assert.equal(titleComponent({ t: titleProps.t }).children[0], '侧边会话')
})

test('status, pending, context and error copy follow the active locale', () => {
  const { exports } = loadBundle()
  const { registered, locale } = applyBundle(exports)
  const t = registered[0].options.inject('session-1').t
  const notCreated = { sessionId: null, running: false, sending: false, pending: [] }
  const idle = { sessionId: 'side-1', running: false, sending: false, pending: [] }
  const running = { sessionId: 'side-1', running: true, sending: false, pending: [] }
  const sending = { sessionId: 'side-1', running: false, sending: true, pending: [] }

  assert.equal(exports.statusLabel(t, notCreated), '尚未创建')
  assert.equal(exports.statusLabel(t, idle), '空闲')
  assert.equal(exports.statusLabel(t, running), '运行中')
  assert.equal(exports.statusLabel(t, sending), '发送中')
  assert.equal(exports.pendingLabel(t, true), '排队中…')
  assert.equal(exports.pendingLabel(t, false), '已发送')
  assert.equal(exports.contextLabel(t, { tag: 'skill', name: 'agent-experience' }), '技能 agent-experience')
  assert.equal(exports.contextLabel(t, { tag: 'skill' }), '技能')
  assert.equal(exports.contextLabel(t, { tag: 'generic' }), '上下文')
  assert.equal(exports.contextLabel(t, { tag: 'not-a-tag' }), '上下文')
  assert.equal(t('status.pending', { count: 2 }), '2 条待发送')
  for (const code of ERROR_CODES) {
    const failure = exports.formatError(t, { code, message: 'raw host detail' })
    assert.notEqual(failure.title, code, `error.${code} must be localized`)
    assert.notEqual(failure.title, '')
    assert.equal(failure.detail, 'raw host detail', 'the raw host message stays as technical detail')
  }
  assert.equal(exports.formatError(t, { code: 'create-failed', message: '' }).detail, '')
  assert.equal(exports.formatError(t, { code: 'create-failed', message: 'create-failed' }).detail, '', 'a message equal to the code is redundant')
  assert.equal(exports.formatError(t, { code: 'not-a-real-code', message: 'boom' }).title, '出错了')
  assert.equal(exports.formatError(t, null), null)

  locale.setLocale('en')
  assert.equal(exports.statusLabel(t, notCreated), 'Not created yet')
  assert.equal(exports.statusLabel(t, idle), 'Idle')
  assert.equal(exports.statusLabel(t, running), 'Running…')
  assert.equal(exports.statusLabel(t, sending), 'Sending…')
  assert.equal(exports.pendingLabel(t, true), 'Queued…')
  assert.equal(exports.pendingLabel(t, false), 'Sent')
  assert.equal(exports.contextLabel(t, { tag: 'skill', name: 'agent-experience' }), 'Skill: agent-experience')
  assert.equal(exports.contextLabel(t, { tag: 'skill' }), 'Skill')
  assert.equal(t('status.pending', { count: 2 }), '2 queued')
  assert.equal(exports.contextLabel(t, { tag: 'not-a-tag' }), 'Context')
  assert.equal(t('composer.placeholderBlank'), 'Ask anything about this session…')
  assert.equal(t('composer.send'), 'Send message')
  assert.equal(t('composer.stop'), 'Stop generating')
  assert.equal(t('thinking'), 'Thinking…')
  assert.equal(t('fold.reasoning'), 'Reasoning')
  assert.equal(t('fold.tools', { count: 2 }), 'Tool calls (2)')
  assert.equal(t('empty.hint'), 'Enter to send, Shift+Enter for a new line')
  assert.equal(exports.formatError(t, { code: 'create-failed', message: 'fork failed' }).title, 'Could not create the side conversation')
  assert.equal(exports.formatError(t, { code: 'not-found', message: 'gone' }).title, 'The side conversation no longer exists (it may have been destroyed)')
})

test('a mounted tab body re-renders when the locale changes', () => {
  const { exports, react } = loadBundle()
  const { registered, locale } = applyBundle(exports)
  const bodyRegistration = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
  const inject = bodyRegistration.options.inject
  const props = inject('session-1')
  react.subscriptions.length = 0
  bodyRegistration.component({
    ...props,
    sessionId: 'session-1',
    useTabInfo: () => ({ tab: { visible: true, title: 'tab' } })
  })
  const localeSubscription = react.subscriptions.find((entry) => {
    const value = entry.getSnapshot()
    return value !== null && typeof value === 'object' && typeof value.revision === 'number'
  })
  assert.ok(localeSubscription !== undefined, 'the tab body subscribes to the locale face')
  const before = localeSubscription.getSnapshot()
  assert.equal(before.active, 'zh')
  locale.setLocale('en')
  assert.equal(localeSubscription.notified, 1, 'a locale switch notifies the mounted component')
  const after = localeSubscription.getSnapshot()
  assert.equal(after.active, 'en')
  assert.notEqual(after.revision, before.revision)
  assert.equal(props.t('tab.title'), 'Side chat')
})

test('apply injects the stylesheet with the dsh-side-chat marker and sc- classes only', () => {
  const { exports } = loadBundle()
  const { appended } = applyBundle(exports)
  assert.equal(appended.length, 1)
  const style = appended[0]
  assert.equal(style.tagName, 'style')
  assert.equal(style.dataset.dyn, 'dsh-side-chat')
  assert.ok(style.textContent.includes('.sc-root'))
  assert.ok(style.textContent.includes('.sc-statusbar'))
  assert.ok(style.textContent.includes('.sc-error-detail'))
  assert.equal(style.textContent.includes('.sc-panel'), false, 'the floating panel root must be gone')
  assert.equal(style.textContent.includes('position: fixed'), false, 'no floating positioning in the tab body')
  assert.equal(style.textContent.includes('min(460px'), false, 'no floating width in the tab body')
  assert.equal(style.textContent.includes('.sc-toggle'), false, 'the header toggle style must be gone')
  const classTokens = [...style.textContent.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)].map((match) => match[1])
  assert.ok(classTokens.length > 10)
  for (const token of classTokens) {
    assert.ok(token.startsWith('sc-'), `non sc- class in panel CSS: ${token}`)
  }
})

test('Chinese characters live only inside the ZH dictionary literal', () => {
  const cjk = /[\u4e00-\u9fff]/
  const zhStart = bundleSource.indexOf('const ZH_DICT = {')
  assert.ok(zhStart > 0, 'ZH_DICT literal must exist')
  const zhEnd = bundleSource.indexOf('\n    }\n', zhStart)
  assert.ok(zhEnd > zhStart)
  assert.ok(cjk.test(bundleSource.slice(zhStart, zhEnd)), 'ZH_DICT must contain the Chinese copy')
  assert.equal(cjk.test(bundleSource.slice(0, zhStart)), false, 'Chinese must not appear before ZH_DICT')
  assert.equal(cjk.test(bundleSource.slice(zhEnd)), false, 'Chinese must not appear after ZH_DICT')
  const enStart = bundleSource.indexOf('const EN_DICT = {')
  const enEnd = bundleSource.indexOf('\n    }\n', enStart)
  assert.ok(enStart > 0 && enEnd > enStart)
  assert.equal(cjk.test(bundleSource.slice(enStart, enEnd)), false, 'EN_DICT must stay free of Chinese')
})

test('the close handler destroys a created side session through /side-chat/api/close', async () => {
  const { exports } = loadBundle()
  const { ctx, registered, closeHandlers } = createCtxStub()
  const { doc } = createDocumentStub()
  const { fetchImpl, calls } = createFetchStub({
    create: { ok: true, sessionId: 'side-1', inheritedEventCount: 0 },
    prompt: { ok: true },
    close: { ok: true }
  })
  const previousDocument = globalThis.document
  const previousFetch = globalThis.fetch
  globalThis.document = doc
  globalThis.fetch = fetchImpl
  try {
    exports.apply(ctx)
    const runtime = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab').options.inject('session-1').runtime
    runtime.open('session-1')
    runtime.setVisible('session-1', true)
    await runtime.send('session-1', 'hello')
    assert.equal(runtime.getState('session-1').sessionId, 'side-1')
    const closeCallsBeforeHandler = calls.length
    closeHandlers[0].handler('session-1', { kind: KIND })
    await flush()
    assert.equal(calls.length, closeCallsBeforeHandler + 1)
    assert.equal(calls.at(-1).url, `${API_PREFIX}close`)
    assert.equal(calls.at(-1).body.sessionId, 'side-1')
    assert.equal(runtime.getState('session-1'), null)
  } finally {
    globalThis.document = previousDocument
    globalThis.fetch = previousFetch
  }
})

test('the close handler is a no-op before the side session is created', async () => {
  const { exports } = loadBundle()
  const { ctx, closeHandlers } = createCtxStub()
  const { doc } = createDocumentStub()
  const { fetchImpl, calls } = createFetchStub({})
  const previousDocument = globalThis.document
  const previousFetch = globalThis.fetch
  globalThis.document = doc
  globalThis.fetch = fetchImpl
  try {
    exports.apply(ctx)
  } finally {
    globalThis.document = previousDocument
    globalThis.fetch = previousFetch
  }
  closeHandlers[0].handler('session-1', { kind: KIND })
  await flush()
  assert.equal(calls.length, 0)
})

test('apiPath is rooted at /side-chat/api/', () => {
  const { exports } = loadBundle()
  assert.equal(exports.apiPath('create'), '/side-chat/api/create')
  assert.equal(exports.apiPath('snapshot'), '/side-chat/api/snapshot')
  assert.equal(exports.apiPath('close'), '/side-chat/api/close')
})

test('boundary detection accepts the plugin source kind and the exact first line', () => {
  const { exports } = loadBundle()
  assert.equal(exports.isBoundaryMessage({ kind: 'plugin:side-chat' }, 'anything'), true)
  assert.equal(exports.isBoundaryMessage({ kind: 'plugin', plugin: 'side-chat' }, 'anything'), true)
  assert.equal(exports.isBoundaryMessage({ kind: 'user' }, 'Side conversation boundary.'), true)
  assert.equal(exports.isBoundaryMessage({ kind: 'user' }, 'Side conversation boundary.\n\nmore'), true)
  assert.equal(exports.isBoundaryMessage({ kind: 'user' }, '  Side conversation boundary.  \r\ntext'), true)
  assert.equal(exports.isBoundaryMessage({ kind: 'user' }, 'The Side conversation boundary.'), false)
  assert.equal(exports.isBoundaryMessage({ kind: 'user' }, 'hello'), false)
  assert.equal(exports.isBoundaryMessage({ kind: 'plugin:other' }, 'hello'), false)
  assert.equal(exports.isBoundaryText('Side conversation boundary.\nbody'), true)
  assert.equal(exports.isBoundaryEvent(boundaryEntry(1)), true)
  assert.equal(exports.isBoundaryEvent(userEntry(1, 'Side conversation boundary.\nbody')), true)
  assert.equal(exports.isBoundaryEvent(userEntry(1, 'hello')), false)
  assert.equal(exports.isBoundaryEvent({ seq: 1, type: 'assistant/message', data: {} }), false)
})

test('isInheritedEvent flags forked history below inheritedEventCount', () => {
  const { exports } = loadBundle()
  assert.equal(exports.isInheritedEvent({ seq: 2 }, 3), true)
  assert.equal(exports.isInheritedEvent({ seq: 3 }, 3), false)
  assert.equal(exports.isInheritedEvent({ seq: 9 }, 3), false)
  assert.equal(exports.isInheritedEvent({}, 3), false)
  assert.equal(exports.isInheritedEvent({ seq: 1 }, null), false)
})

test('foldEntries hides inherited history and the boundary message', () => {
  const { exports } = loadBundle()
  const entries = [
    userEntry(0, 'inherited question'),
    userEntry(1, 'inherited answer context'),
    boundaryEntry(2),
    userEntry(3, 'first real question'),
    userEntry(4, 'second real question')
  ]
  const nodes = exports.foldEntries(entries, 3)
  assert.deepEqual(nodes.map((node) => node.kind), ['user', 'user'])
  assert.deepEqual(nodes.map((node) => node.text), ['first real question', 'second real question'])
  assert.deepEqual(nodes.map((node) => node.seq), [3, 4])
})

test('the boundary message is hidden even when it sits exactly at the snapshot floor', () => {
  const { exports } = loadBundle()
  const entries = [boundaryEntry(3), userEntry(4, 'real question'), boundaryEntry(5)]
  const nodes = exports.foldEntries(entries, 3)
  assert.deepEqual(nodes.map((node) => node.text), ['real question'])
})

test('foldEntries renders assistant blocks and attaches tool results by callId', () => {
  const { exports } = loadBundle()
  const entries = [
    userEntry(3, 'run the tests'),
    assistantEntry(4, [
      { type: 'reasoning', text: 'think first' },
      { type: 'text', text: 'Running them.' },
      { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"node --test"}' }
    ]),
    toolResultEntry(5, 'call-1', 'all tests passed'),
    { seq: 6, type: 'turn/start', time: 1700000000000, data: { turn: 1 } },
    { seq: 7, type: 'plugin:unknown/event', time: 1700000000000, data: {} }
  ]
  const nodes = exports.foldEntries(entries, 3)
  assert.equal(nodes.length, 2)
  assert.equal(nodes[0].kind, 'user')
  assert.equal(nodes[1].kind, 'assistant')
  const blocks = nodes[1].blocks
  assert.equal(blocks.length, 3)
  assert.deepEqual(blocks.map((block) => block.kind), ['reasoning', 'text', 'tool-call'])
  assert.equal(blocks[0].text, 'think first')
  assert.equal(blocks[1].text, 'Running them.')
  assert.equal(blocks[2].callId, 'call-1')
  assert.equal(blocks[2].name, 'bash')
  assert.equal(blocks[2].result.text, 'all tests passed')
  assert.equal(blocks[2].result.isError, false)
})

test('foldEntries classifies injected context into localizable tags and ignores replacement surfaces', () => {
  const { exports } = loadBundle()
  const entries = [
    userEntry(3, 'hello'),
    userEntry(4, 'skill loaded', { kind: 'skill-invocation', name: 'agent-experience' }),
    userEntry(5, 'from another session', { kind: 'session-reference' }),
    { ...assistantEntry(6, [{ type: 'text', text: 'replaced' }]), surfaceOp: 'replace' },
    { ...userEntry(7, 'replaced user'), surfaceOp: 'replace' }
  ]
  const nodes = exports.foldEntries(entries, 0)
  assert.deepEqual(nodes.map((node) => node.kind), ['user', 'context', 'context'])
  assert.deepEqual(nodes[1], { kind: 'context', seq: 4, time: 1700000004000, text: 'skill loaded', tag: 'skill', name: 'agent-experience' })
  assert.equal(nodes[2].tag, 'sessionReference')
})

test('foldEntries tolerates empty and malformed input', () => {
  const { exports } = loadBundle()
  assert.deepEqual(exports.foldEntries(undefined, 0), [])
  assert.deepEqual(exports.foldEntries(null, 0), [])
  assert.deepEqual(exports.foldEntries([null, 7, {}, { type: 'user/message' }], 0), [])
})

test('runtime sends through /side-chat/api/, pulls on demand and removes the optimistic row on echo', async () => {
  const echoed = userEntry(3, 'hello side chat')
  const fetchStub = createFetchStub({
    create: { ok: true, sessionId: 'side-1', inheritedEventCount: 3 },
    prompt: { ok: true },
    snapshot: {
      ok: true,
      inheritedEventCount: 3,
      running: false,
      status: 'idle',
      lastError: null,
      entries: [echoed]
    }
  })
  const { scheduler, runtime } = createRuntimeWith(fetchStub)
  runtime.open('main-1')
  assert.equal(runtime.getState('main-1').sessionId, null)
  runtime.setVisible('main-1', true)

  await runtime.send('main-1', 'hello side chat')
  assert.deepEqual(fetchStub.calls.map((call) => call.url), [
    `${API_PREFIX}create`,
    `${API_PREFIX}prompt`
  ])
  for (const call of fetchStub.calls) assert.ok(call.url.startsWith(API_PREFIX), call.url)
  assert.equal(fetchStub.calls[0].body.sourceId, 'main-1')
  assert.equal(fetchStub.calls[1].body.sessionId, 'side-1')
  assert.equal(fetchStub.calls[1].body.text, 'hello side chat')
  const afterSend = runtime.getState('main-1')
  assert.equal(afterSend.sessionId, 'side-1')
  assert.equal(afterSend.inheritedEventCount, 3)
  assert.equal(afterSend.pending.length, 1)
  assert.equal(afterSend.draft, '')
  assert.ok(scheduler.pending() >= 1, 'polling must be scheduled for a visible tab')

  await runtime.pollOnce('main-1')
  const afterPoll = runtime.getState('main-1')
  assert.equal(afterPoll.pending.length, 0)
  assert.equal(afterPoll.nodes.length, 1)
  assert.equal(afterPoll.nodes[0].text, 'hello side chat')
  assert.equal(afterPoll.error, null)

  await runtime.cancel('main-1')
  assert.equal(fetchStub.calls.at(-1).url, `${API_PREFIX}cancel`)
  assert.equal(fetchStub.calls.at(-1).body.sessionId, 'side-1')

  await runtime.close('main-1')
  assert.equal(fetchStub.calls.at(-1).url, `${API_PREFIX}close`)
  assert.equal(fetchStub.calls.at(-1).body.sessionId, 'side-1')
  assert.equal(runtime.getState('main-1'), null)
  assert.equal(scheduler.pending(), 0, 'closing the tab must clear the poll timer')
})

test('tab visibility pauses polling and keeps the fromSeq cursor for the resume', async () => {
  const fetchStub = createFetchStub({
    create: { ok: true, sessionId: 'side-1', inheritedEventCount: 3 },
    prompt: { ok: true },
    snapshot: (body) => ({
      ok: true,
      inheritedEventCount: 3,
      running: false,
      status: 'idle',
      lastError: null,
      entries: body.fromSeq <= 3 ? [userEntry(3, 'hello')] : []
    })
  })
  const { scheduler, runtime } = createRuntimeWith(fetchStub)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  await runtime.send('main-1', 'hello')
  assert.equal(scheduler.pending(), 1, 'the visible tab schedules the next poll')

  runtime.setVisible('main-1', false)
  assert.equal(scheduler.pending(), 0, 'a hidden tab clears the poll timer')
  const callsWhileHidden = fetchStub.calls.length
  scheduler.runAll()
  await flush()
  assert.equal(fetchStub.calls.length, callsWhileHidden, 'a hidden tab must not fetch')

  runtime.setVisible('main-1', true)
  assert.equal(scheduler.pending(), 1, 'becoming visible resumes polling')
  scheduler.runAll()
  await flush()
  const snapshotCalls = fetchStub.calls.filter((call) => call.url === `${API_PREFIX}snapshot`)
  assert.equal(snapshotCalls.length, 1)
  assert.equal(snapshotCalls[0].body.fromSeq, 3, 'the resume continues from the saved cursor')

  runtime.setVisible('main-1', false)
  await runtime.close('main-1')
  assert.equal(scheduler.pending(), 0)
})

test('a repeated message text does not retire a new optimistic row early', async () => {
  const available = [userEntry(3, 'hello')]
  const fetched = createFetchStub({
    create: { ok: true, sessionId: 'side-1', inheritedEventCount: 0 },
    prompt: { ok: true },
    snapshot: (body) => ({
      ok: true,
      inheritedEventCount: 0,
      running: false,
      status: 'idle',
      lastError: null,
      entries: available.filter((entry) => entry.seq >= (body.fromSeq ?? 0))
    })
  })
  const { runtime } = createRuntimeWith(fetched)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  await runtime.send('main-1', 'hello')
  await runtime.pollOnce('main-1')
  assert.equal(runtime.getState('main-1').pending.length, 0)

  await runtime.send('main-1', 'hello')
  assert.equal(runtime.getState('main-1').pending.length, 1)
  await runtime.pollOnce('main-1')
  assert.equal(runtime.getState('main-1').pending.length, 1, 'the old echo must not retire the new row')

  available.push(userEntry(4, 'hello'))
  await runtime.pollOnce('main-1')
  assert.equal(runtime.getState('main-1').pending.length, 0)
  assert.equal(runtime.getState('main-1').nodes.filter((node) => node.kind === 'user').length, 2)
  await runtime.close('main-1')
})

test('closing a tab before the first message never calls the host close route', async () => {
  const fetchStub = createFetchStub({})
  const { runtime } = createRuntimeWith(fetchStub)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  await runtime.close('main-1')
  assert.equal(fetchStub.calls.length, 0)
  assert.equal(runtime.getState('main-1'), null)
})

test('create failure stores a localizable failure record and restores the draft', async () => {
  const fetchStub = createFetchStub({
    create: { ok: false, code: 'create-failed', message: 'fork failed' }
  })
  const { runtime } = createRuntimeWith(fetchStub)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  await runtime.send('main-1', 'hello')
  const state = runtime.getState('main-1')
  assert.equal(state.sessionId, null)
  assert.equal(state.pending.length, 0)
  assert.equal(state.draft, 'hello')
  assert.deepEqual(state.error, { code: 'create-failed', message: 'fork failed', params: {} })
  assert.equal(fetchStub.calls.length, 1)
})

test('prompt failure keeps the session and reports a localizable failure instead of dropping it', async () => {
  const fetched = createFetchStub({
    create: { ok: true, sessionId: 'side-1', inheritedEventCount: 0 },
    prompt: { ok: false, code: 'prompt-failed', message: 'agent busy' }
  })
  const { runtime } = createRuntimeWith(fetched)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  await runtime.send('main-1', 'hello')
  const state = runtime.getState('main-1')
  assert.equal(state.sessionId, 'side-1')
  assert.deepEqual(state.error, { code: 'prompt-failed', message: 'agent busy', params: {} })
  assert.equal(state.pending.length, 0)
  assert.equal(state.draft, 'hello')
})

test('a not-found snapshot stops polling and records the polling failure', async () => {
  const fetched = createFetchStub({
    create: { ok: true, sessionId: 'side-1', inheritedEventCount: 0 },
    prompt: { ok: true },
    snapshot: { ok: false, code: 'not-found', message: 'unknown side session' }
  })
  const { runtime, scheduler } = createRuntimeWith(fetched)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  await runtime.send('main-1', 'hello')
  assert.ok(scheduler.pending() >= 1)
  await runtime.pollOnce('main-1')
  const state = runtime.getState('main-1')
  assert.deepEqual(state.pollError, { code: 'not-found', message: 'unknown side session', params: {} })
  assert.equal(scheduler.pending(), 0, 'not-found must stop the poll loop')
})

test('draft and stop controls route through the runtime', async () => {
  const fetched = createFetchStub({
    create: { ok: true, sessionId: 'side-1', inheritedEventCount: 0 },
    prompt: { ok: true },
    cancel: { ok: true }
  })
  const { runtime } = createRuntimeWith(fetched)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  runtime.setDraft('main-1', 'typed draft')
  assert.equal(runtime.getState('main-1').draft, 'typed draft')
  await runtime.send('main-1')
  assert.equal(fetched.calls[1].body.text, 'typed draft')
  await runtime.cancel('main-1')
  assert.equal(fetched.calls.at(-1).url, `${API_PREFIX}cancel`)
})

test('fallback markdown covers code fences, headings, lists, tables and inline marks', () => {
  const { exports } = loadBundle()
  const text = [
    '# Title',
    '',
    'Inline `code`, **bold** and [link](https://example.com).',
    '',
    '```js',
    'const a = 1',
    '```',
    '',
    '- one',
    '- two',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |'
  ].join('\n')
  const blocks = exports.renderMarkdownFallback(text, 'md')
  const types = blocks.map((block) => block.type)
  assert.ok(types.includes('div'), 'heading/paragraph blocks are divs')
  assert.ok(types.includes('pre'), 'code fence renders a pre block')
  assert.ok(types.includes('ul'), 'unordered list renders a ul')
  assert.ok(types.includes('table'), 'table renders a table')
  const code = blocks.find((block) => block.type === 'pre')
  assert.equal(code.children[0].children[0], 'const a = 1')
  const flat = JSON.stringify(blocks)
  assert.ok(flat.includes('sc-inline-code'))
  assert.ok(flat.includes('strong'))
  assert.ok(flat.includes('sc-md-a'))
})

test('bundle also materializes when the primitives seed module is present', () => {
  const { exports } = loadBundle({ primitives: true })
  const { registered } = applyBundle(exports)
  assert.equal(typeof exports.foldEntries, 'function')
  const body = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
  assert.equal(body.options.locale, NS)
})

test('a live SSE stream renders the assistant attempt and reconciles with the committed settlement', async () => {
  const fetchStub = createStreamingFetchStub({
    handlers: streamingHandlers({
      snapshot: {
        ok: true,
        inheritedEventCount: 3,
        running: false,
        status: 'idle',
        lastError: null,
        entries: [],
        live: null
      }
    })
  })
  const { exports, scheduler, runtime } = createRuntimeWith(fetchStub)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  await runtime.send('main-1', 'hello side chat')
  scheduler.runAll()
  await flush()

  assert.equal(fetchStub.streams.length, 1, 'the visible panel opens exactly one stream')
  assert.equal(fetchStub.streams[0].init.method, 'POST')
  const eventsCall = fetchStub.calls.find((call) => call.url === `${API_PREFIX}events`)
  assert.deepEqual(eventsCall.body, { sessionId: 'side-1', fromSeq: 0 })
  assert.equal(runtime.getState('main-1').streaming, true)
  assert.equal(runtime.getState('main-1').streamMode, 'unknown', 'the mode is decided by hello')

  fetchStub.streams[0].queue.push(sseFrame('hello', {
    ok: true,
    inheritedEventCount: 3,
    status: 'running',
    running: true,
    lastError: null,
    entries: [userEntry(3, 'hello side chat')],
    truncated: false,
    live: {
      revision: 1,
      activeAttempt: { attemptId: 'attempt-1', turn: 1, step: 1, nextIndex: 1, blocks: [{ kind: 'text', text: 'Hel' }] }
    }
  }))
  await flush()
  let state = runtime.getState('main-1')
  assert.equal(state.streamMode, 'stream')
  assert.equal(state.inheritedEventCount, 3)
  assert.equal(state.nextSeq, 4)
  assert.equal(state.running, true)
  assert.equal(state.status, 'running')
  assert.equal(state.lastError, null)
  assert.equal(state.pollError, null)
  assert.deepEqual(state.nodes.map((node) => node.kind), ['user'])
  assert.equal(state.nodes[0].text, 'hello side chat')
  assert.equal(exports.liveAttemptOf(state), state.live.activeAttempt)
  assert.deepEqual(exports.liveBlocksOf(state), [{ kind: 'text', text: 'Hel' }])

  fetchStub.streams[0].queue.push(sseFrame('live', {
    live: {
      revision: 2,
      activeAttempt: {
        attemptId: 'attempt-1',
        turn: 1,
        step: 1,
        nextIndex: 3,
        blocks: [
          { kind: 'reasoning', text: 'thinking about it' },
          { kind: 'text', text: 'Hello world' },
          { kind: 'tool-call', callId: 'call-1', name: 'bash', argsRaw: '{"command":"ls"}' }
        ]
      }
    }
  }))
  await flush()
  state = runtime.getState('main-1')
  const blocks = exports.liveBlocksOf(state)
  assert.deepEqual(blocks.map((block) => block.kind), ['reasoning', 'text', 'tool-call'])
  assert.equal(blocks[1].text, 'Hello world')
  assert.equal(blocks[2].callId, 'call-1')
  assert.equal(blocks[2].name, 'bash')
  assert.equal(blocks[2].result, null)

  fetchStub.streams[0].queue.push(sseFrame('live', { live: null }))
  await flush()
  state = runtime.getState('main-1')
  assert.equal(state.live, null, 'an authoritative live frame clears the attempt')
  assert.equal(
    fetchStub.calls.filter((call) => call.url === `${API_PREFIX}snapshot`).length,
    1,
    'clearing an active live attempt triggers one catch-up snapshot'
  )

  fetchStub.streams[0].queue.push(sseFrame('live', {
    live: {
      revision: 3,
      activeAttempt: {
        attemptId: 'attempt-1',
        turn: 1,
        step: 1,
        nextIndex: 3,
        blocks: [{ kind: 'text', text: 'Hello world' }]
      }
    }
  }))
  await flush()

  fetchStub.streams[0].queue.push(sseFrame('event', {
    entry: assistantEntry(4, [{ type: 'text', text: 'Hello world' }])
  }))
  await flush()
  state = runtime.getState('main-1')
  assert.equal(state.live, null, 'the committed settlement clears the live attempt')
  assert.equal(state.nextSeq, 5)
  assert.deepEqual(state.nodes.map((node) => node.kind), ['user', 'assistant'])
  assert.equal(state.nodes[1].blocks[0].text, 'Hello world')
  assert.equal(exports.liveAttemptOf(state), null)
  assert.deepEqual(exports.liveBlocksOf(state), [])
  assert.equal(state.streaming, true, 'the stream stays open after the settlement')

  runtime.setVisible('main-1', false)
  assert.equal(fetchStub.streams[0].init.signal.aborted, true)
  await runtime.close('main-1')
  assert.equal(scheduler.pending(), 0)
})

test('the SSE parser handles split frames, multiple frames per read, comments and data-only JSON', () => {
  const { exports } = loadBundle()
  const parser = exports.createSseParser()
  assert.deepEqual(parser.push('event: hello\nda'), [])
  assert.deepEqual(parser.push('ta: {"ok":true,"n":1}\n'), [])
  assert.deepEqual(parser.push('\n'), [{ event: 'hello', data: { ok: true, n: 1 } }])

  assert.deepEqual(parser.push(': ping\n\n'), [], 'comment-only frames are heartbeats, not events')

  const multiple = parser.push('event: event\ndata: {"a":1}\n\nevent: live\ndata: {"live":null}\n\n')
  assert.deepEqual(multiple.map((frame) => frame.event), ['event', 'live'])
  assert.deepEqual(multiple[1].data, { live: null })

  const dataOnly = parser.push('data: {"k":"v"}\n\n')
  assert.equal(dataOnly.length, 1)
  assert.equal(dataOnly[0].event, 'message', 'a data-only frame keeps the default event name')
  assert.deepEqual(dataOnly[0].data, { k: 'v' })

  const crlf = parser.push('event: status\r\ndata: {"running":false}\r\n\r\n')
  assert.deepEqual(crlf, [{ event: 'status', data: { running: false } }])

  parser.reset()
  assert.deepEqual(parser.push('event: hello\ndata: {}\n\n'), [{ event: 'hello', data: {} }])
})

test('hiding the tab aborts the stream and becoming visible reconnects from the saved fromSeq', async () => {
  const fetchStub = createStreamingFetchStub({ handlers: streamingHandlers() })
  const { scheduler, runtime } = createRuntimeWith(fetchStub)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  await runtime.send('main-1', 'hi')
  scheduler.runAll()
  await flush()

  assert.equal(fetchStub.streams.length, 1)
  assert.equal(fetchStub.streams[0].init.signal.aborted, false)
  fetchStub.streams[0].queue.push(sseFrame('hello', {
    ok: true,
    inheritedEventCount: 0,
    status: 'running',
    running: true,
    lastError: null,
    entries: [userEntry(0, 'hi')],
    live: null
  }))
  await flush()
  assert.equal(runtime.getState('main-1').nextSeq, 1)

  runtime.setVisible('main-1', false)
  assert.equal(fetchStub.streams[0].init.signal.aborted, true, 'hiding aborts the open stream')
  assert.equal(runtime.getState('main-1').streaming, false)
  assert.equal(scheduler.pending(), 0, 'hiding clears every update timer')

  runtime.setVisible('main-1', true)
  assert.equal(scheduler.pending(), 1, 'becoming visible reconnects immediately')
  scheduler.runAll()
  await flush()
  assert.equal(fetchStub.streams.length, 2)
  const eventsCalls = fetchStub.calls.filter((call) => call.url === `${API_PREFIX}events`)
  assert.equal(eventsCalls.at(-1).body.fromSeq, 1, 'the reconnect resumes from the saved cursor')
  assert.equal(eventsCalls.at(-1).body.sessionId, 'side-1')

  runtime.setVisible('main-1', false)
  await runtime.close('main-1')
  assert.equal(scheduler.pending(), 0)
})

test('a non-streaming transport degrades to snapshot polling and keeps polling', async () => {
  const fetchStub = createFetchStub({
    create: { ok: true, sessionId: 'side-1', inheritedEventCount: 0 },
    prompt: { ok: true },
    snapshot: {
      ok: true,
      inheritedEventCount: 0,
      running: false,
      status: 'idle',
      lastError: null,
      entries: [userEntry(0, 'hi')],
      live: null
    }
  })
  const { scheduler, runtime } = createRuntimeWith(fetchStub)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  await runtime.send('main-1', 'hi')
  scheduler.runAll()
  await flush()

  const snapshotCalls = () => fetchStub.calls.filter((call) => call.url === `${API_PREFIX}snapshot`)
  let state = runtime.getState('main-1')
  assert.equal(state.streamMode, 'poll', 'no readable body permanently degrades to polling')
  assert.equal(state.streaming, false)
  assert.equal(fetchStub.calls.filter((call) => call.url === `${API_PREFIX}events`).length, 1)
  assert.equal(snapshotCalls().length, 1, 'the fallback pulls one snapshot immediately')
  assert.equal(snapshotCalls()[0].body.fromSeq, 0)
  assert.equal(scheduler.pending(), 1, 'polling continues after the fallback')

  scheduler.runAll()
  await flush()
  assert.equal(snapshotCalls().length, 2, 'the poll loop keeps pulling')
  state = runtime.getState('main-1')
  assert.equal(state.nodes.length, 1)
  runtime.setVisible('main-1', false)
  await runtime.close('main-1')
})

test('stream: false forces snapshot polling without touching the events route', async () => {
  const fetchStub = createFetchStub({
    create: { ok: true, sessionId: 'side-1', inheritedEventCount: 0 },
    prompt: { ok: true },
    snapshot: {
      ok: true,
      inheritedEventCount: 0,
      running: false,
      status: 'idle',
      lastError: null,
      entries: [],
      live: null
    }
  })
  const { scheduler, runtime } = createRuntimeWith(fetchStub, { config: { stream: false } })
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  await runtime.send('main-1', 'hi')
  assert.equal(runtime.getState('main-1').streamMode, 'poll')
  scheduler.runAll()
  await flush()
  assert.equal(fetchStub.calls.filter((call) => call.url === `${API_PREFIX}events`).length, 0)
  assert.equal(fetchStub.calls.filter((call) => call.url === `${API_PREFIX}snapshot`).length, 1)
  assert.equal(scheduler.pending(), 1)
  runtime.setVisible('main-1', false)
  await runtime.close('main-1')
})

test('a JSON not-found answer from the events route records the polling failure and stops', async () => {
  const fetchStub = createStreamingFetchStub({
    eventsMode: 'json',
    handlers: streamingHandlers({
      events: { ok: false, code: 'not-found', message: 'unknown side session' }
    })
  })
  const { scheduler, runtime } = createRuntimeWith(fetchStub)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  await runtime.send('main-1', 'hi')
  scheduler.runAll()
  await flush()

  const state = runtime.getState('main-1')
  assert.deepEqual(state.pollError, { code: 'not-found', message: 'unknown side session', params: {} })
  assert.equal(state.streamMode, 'poll')
  assert.equal(scheduler.pending(), 0, 'not-found stops all updates')
  assert.equal(fetchStub.calls.filter((call) => call.url === `${API_PREFIX}snapshot`).length, 0)
  await runtime.close('main-1')
})

test('a JSON body instead of an SSE stream counts as a failed connect and falls back', async () => {
  const fetchStub = createStreamingFetchStub({
    eventsMode: 'json-body',
    handlers: streamingHandlers({
      events: { ok: false, code: 'stream-unavailable', message: 'no stream here' }
    })
  })
  const { scheduler, runtime } = createRuntimeWith(fetchStub)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  await runtime.send('main-1', 'hi')
  scheduler.runAll()
  await flush()

  const state = runtime.getState('main-1')
  assert.equal(state.streamMode, 'poll')
  assert.equal(fetchStub.calls.filter((call) => call.url === `${API_PREFIX}snapshot`).length, 1)
  assert.equal(scheduler.pending(), 1)
  runtime.setVisible('main-1', false)
  await runtime.close('main-1')
})

test('a silent stream falls back to polling after streamHelloMs instead of hanging', async () => {
  const fetchStub = createStreamingFetchStub({ eventsMode: 'hanging', handlers: streamingHandlers() })
  const { scheduler, runtime } = createRuntimeWith(fetchStub, { config: { streamHelloMs: 5 } })
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  await runtime.send('main-1', 'hi')
  scheduler.runAll()
  await flush()
  assert.equal(fetchStub.streams.length, 1)
  assert.equal(scheduler.pending(), 1, 'the hello deadline is armed')

  scheduler.runAll()
  await flush()
  const state = runtime.getState('main-1')
  assert.equal(fetchStub.streams[0].init.signal.aborted, true, 'the buffering stream is aborted')
  assert.equal(state.streamMode, 'poll')
  assert.equal(state.streaming, false)
  assert.equal(fetchStub.calls.filter((call) => call.url === `${API_PREFIX}snapshot`).length, 1)
  assert.equal(scheduler.pending(), 1, 'polling takes over')
  runtime.setVisible('main-1', false)
  await runtime.close('main-1')
})

test('status and error frames update the panel the way a snapshot would', async () => {
  const fetchStub = createStreamingFetchStub({ handlers: streamingHandlers() })
  const { scheduler, runtime } = createRuntimeWith(fetchStub)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  await runtime.send('main-1', 'hi')
  scheduler.runAll()
  await flush()

  fetchStub.streams[0].queue.push(sseFrame('hello', {
    ok: true,
    inheritedEventCount: 0,
    status: 'running',
    running: true,
    lastError: null,
    entries: [],
    live: null
  }))
  await flush()
  assert.equal(runtime.getState('main-1').running, true)

  fetchStub.streams[0].queue.push(sseFrame('status', { status: 'idle', running: false }))
  await flush()
  let state = runtime.getState('main-1')
  assert.equal(state.running, false)
  assert.equal(state.status, 'idle')

  fetchStub.streams[0].queue.push(sseFrame('error', { message: 'turn failed' }))
  await flush()
  state = runtime.getState('main-1')
  assert.equal(state.lastError, 'turn failed')

  runtime.setVisible('main-1', false)
  await runtime.close('main-1')
})

test('a stream EOF after hello catches up by snapshot and reconnects with backoff', async () => {
  const fetchStub = createStreamingFetchStub({ handlers: streamingHandlers() })
  const { scheduler, runtime } = createRuntimeWith(fetchStub)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  await runtime.send('main-1', 'hi')
  scheduler.runAll()
  await flush()

  fetchStub.streams[0].queue.push(sseFrame('hello', {
    ok: true,
    inheritedEventCount: 0,
    status: 'running',
    running: true,
    lastError: null,
    entries: [userEntry(0, 'hi')],
    live: null
  }))
  await flush()
  fetchStub.streams[0].queue.close()
  await flush()

  assert.equal(fetchStub.calls.filter((call) => call.url === `${API_PREFIX}snapshot`).length, 1, 'EOF triggers one catch-up snapshot')
  assert.equal(scheduler.pending(), 1, 'EOF arms a reconnect timer')
  assert.equal(runtime.getState('main-1').streaming, false)

  scheduler.runAll()
  await flush()
  assert.equal(fetchStub.streams.length, 2, 'the stream reconnects after EOF')
  const eventsCalls = fetchStub.calls.filter((call) => call.url === `${API_PREFIX}events`)
  assert.equal(eventsCalls.at(-1).body.fromSeq, 1)
  runtime.setVisible('main-1', false)
  await runtime.close('main-1')
})

test('the panel renders the live attempt after committed rows with streaming markdown and no thinking indicator', () => {
  const { exports } = loadBundle({ primitives: true })
  const { registered } = applyBundle(exports)
  const bodyRegistration = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
  const t = (key) => key
  const state = {
    mainId: 'main-1',
    sessionId: 'side-1',
    inheritedEventCount: 0,
    nextSeq: 5,
    entries: [],
    nodes: [
      { kind: 'user', seq: 0, time: 1700000000000, text: 'question' },
      { kind: 'assistant', seq: 1, time: 1700000001000, blocks: [{ kind: 'text', text: 'committed answer' }] }
    ],
    visible: true,
    running: true,
    status: 'running',
    lastError: null,
    error: null,
    pollError: null,
    sending: false,
    draft: '',
    pending: [],
    live: {
      revision: 3,
      activeAttempt: {
        attemptId: 'attempt-1',
        turn: 1,
        step: 1,
        nextIndex: 2,
        blocks: [
          { kind: 'reasoning', text: 'why' },
          { kind: 'text', text: 'streaming answer' },
          { kind: 'tool-call', callId: 'call-1', name: 'bash', argsRaw: '{}' }
        ]
      }
    },
    streamMode: 'stream',
    streaming: true,
    timer: null,
    onVisibility: null
  }
  const runtime = {
    subscribe: () => () => {},
    getVersion: () => 0,
    open: () => {},
    setVisible: () => {},
    getState: (id) => (id === 'main-1' ? state : null),
    setDraft: () => {},
    send: async () => {},
    cancel: async () => {}
  }
  const bodyElement = bodyRegistration.component({
    runtime,
    sessionId: 'main-1',
    t,
    useTabInfo: () => ({ tab: { visible: true } })
  })
  assert.equal(typeof bodyElement.type, 'function', 'the tab body renders the panel component')
  const tree = bodyElement.type(bodyElement.props)
  const body = findElement(tree, (element) => element.props !== undefined && element.props.className === 'sc-body')
  assert.ok(body !== undefined, 'the panel body renders')
  const rows = body.children[0]
  assert.equal(rows.length, 3, 'committed rows plus the live assistant row')
  assert.equal(rows[0].props.text, 'question')
  assert.equal(rows[1].props.blocks[0].text, 'committed answer')
  assert.equal(rows[1].props.streaming, undefined, 'committed rows are not streaming')
  assert.equal(rows[2].props.key, 'live', 'the live attempt renders after the committed rows')
  assert.equal(rows[2].props.streaming, true)
  assert.deepEqual(rows[2].props.blocks.map((block) => block.kind), ['reasoning', 'text', 'tool-call'])
  assert.equal(body.children[2], null, 'thinking is suppressed while live blocks render')

  const committedRow = rows[1].type(rows[1].props)
  const committedMarkdown = findElement(committedRow, (element) => element.props !== undefined && element.props.text === 'committed answer')
  assert.ok(committedMarkdown !== undefined)
  const committedMarkdownText = committedMarkdown.type(committedMarkdown.props)
  assert.equal(committedMarkdownText.props.streaming, false)

  const liveRow = rows[2].type(rows[2].props)
  const liveMarkdown = findElement(liveRow, (element) => element.props !== undefined && element.props.text === 'streaming answer')
  assert.ok(liveMarkdown !== undefined)
  const liveMarkdownText = liveMarkdown.type(liveMarkdown.props)
  assert.equal(liveMarkdownText.props.streaming, true, 'the shell Markdown renderer receives streaming: true')

  state.live = null
  const settledTree = bodyElement.type(bodyElement.props)
  const settledBody = findElement(settledTree, (element) => element.props !== undefined && element.props.className === 'sc-body')
  assert.equal(settledBody.children[0].length, 2, 'the live row disappears with the settlement')
  assert.ok(settledBody.children[2] !== null, 'the thinking indicator returns without live blocks')
  assert.equal(settledBody.children[2].props.className, 'sc-thinking')
})

test('pollOnce stays a deterministic snapshot pull and applies the live field', async () => {
  const fetchStub = createFetchStub({
    create: { ok: true, sessionId: 'side-1', inheritedEventCount: 0 },
    prompt: { ok: true },
    snapshot: {
      ok: true,
      inheritedEventCount: 0,
      running: true,
      status: 'running',
      lastError: null,
      entries: [],
      live: {
        revision: 7,
        activeAttempt: {
          attemptId: 'attempt-1',
          turn: 1,
          step: 1,
          nextIndex: 1,
          blocks: [{ kind: 'text', text: 'tok' }]
        }
      }
    }
  })
  const { exports, scheduler, runtime } = createRuntimeWith(fetchStub)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  await runtime.send('main-1', 'hi')
  assert.equal(scheduler.pending(), 1, 'the stream connection is only scheduled, never run')
  await runtime.pollOnce('main-1')
  const state = runtime.getState('main-1')
  assert.equal(state.live.revision, 7)
  assert.equal(state.running, true)
  assert.deepEqual(exports.liveBlocksOf(state), [{ kind: 'text', text: 'tok' }])
  assert.equal(fetchStub.calls.filter((call) => call.url === `${API_PREFIX}snapshot`).length, 1)
  await runtime.close('main-1')
})

test('instanceKeyOf keys one runtime record per tab occurrence of a parent session', () => {
  const { exports } = loadBundle()
  assert.equal(exports.instanceKeyOf('session-1', 'tab-a'), 'session-1#tab-a')
  assert.equal(exports.instanceKeyOf('session-1', 'tab-b'), 'session-1#tab-b')
  assert.equal(exports.instanceKeyOf('session-1', undefined), 'session-1')
  assert.equal(exports.instanceKeyOf('session-1', ''), 'session-1')
  assert.equal(exports.instanceKeyOf('', 'tab-a'), '')
})

test('one parent session drives one independent side conversation per side-chat tab', async () => {
  const { exports } = loadBundle()
  const fetchStub = createFetchStub({
    create: (body) => ({ ok: true, sessionId: `side-${String(body.instanceKey).slice(-1)}`, inheritedEventCount: 2 }),
    prompt: { ok: true },
    close: { ok: true },
    snapshot: { ok: true, inheritedEventCount: 2, running: false, status: 'idle', lastError: null, entries: [] }
  })
  const { scheduler, runtime } = createRuntimeWith(fetchStub)
  const first = exports.instanceKeyOf('main-1', 'tab-a')
  const second = exports.instanceKeyOf('main-1', 'tab-b')
  runtime.open(first, 'main-1')
  runtime.open(second, 'main-1')

  assert.equal(runtime.getState(first).sourceId, 'main-1')
  assert.equal(runtime.getState(second).sourceId, 'main-1')
  assert.equal(runtime.labelOf(first), 1)
  assert.equal(runtime.labelOf(second), 2)

  runtime.setVisible(first, true)
  runtime.setVisible(second, true)
  await runtime.send(first, 'hello first')
  await runtime.send(second, 'hello second')

  assert.deepEqual(fetchStub.calls.filter((call) => call.url === `${API_PREFIX}create`).map((call) => call.body), [
    { sourceId: 'main-1', instanceKey: first },
    { sourceId: 'main-1', instanceKey: second }
  ])
  assert.equal(runtime.getState(first).sessionId, 'side-a')
  assert.equal(runtime.getState(second).sessionId, 'side-b')
  assert.equal(runtime.getState(first).sending, false)
  assert.equal(runtime.getState(second).sending, false)
  assert.ok(scheduler.pending() >= 1)

  await runtime.close(first)
  assert.equal(runtime.getState(first), null)
  assert.equal(runtime.getState(second).sessionId, 'side-b', 'closing one tab keeps the other side chat')
  assert.equal(runtime.labelOf(second), 2, 'the surviving chip keeps its ordinal')
  assert.deepEqual(fetchStub.calls.filter((call) => call.url === `${API_PREFIX}close`).map((call) => call.body), [
    { sessionId: 'side-a' }
  ])

  await runtime.close(second)
  assert.equal(runtime.labelOf(first), 0)
  runtime.open(exports.instanceKeyOf('main-1', 'tab-c'), 'main-1')
  assert.equal(runtime.labelOf('main-1#tab-c'), 1, 'a fresh first side chat starts at the plain title again')
  assert.equal(scheduler.pending(), 0)
})

test('later side-chat tabs of one session get a numbered chip title', () => {
  const { exports } = loadBundle()
  const { registered, locale } = applyBundle(exports)
  const bodyProps = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab').options.inject('session-1')
  const title = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab.title').component
  const runtime = exports.createRuntime({
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    document: null,
    stream: false
  })
  const titleFor = (tabId) => title({
    runtime,
    sessionId: 'session-1',
    t: bodyProps.t,
    useTabInfo: () => ({ tab: { id: tabId, visible: true } })
  })
  runtime.open(exports.instanceKeyOf('session-1', 'tab-1'), 'session-1')
  runtime.open(exports.instanceKeyOf('session-1', 'tab-2'), 'session-1')
  assert.deepEqual(titleFor('tab-1').children, ['侧边会话'])
  assert.deepEqual(titleFor('tab-2').children, ['侧边会话 2'])
  locale.setLocale('en')
  assert.deepEqual(titleFor('tab-1').children, ['Side chat'])
  assert.deepEqual(titleFor('tab-2').children, ['Side chat 2'])
})

test('the tab status bar offers a new side chat through the tab actions', () => {
  const { exports } = loadBundle()
  const { registered } = applyBundle(exports)
  const bodyRegistration = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
  const props = bodyRegistration.options.inject('session-1')
  const opened = []
  const tab = {
    id: 'tab-1',
    visible: true,
    actions: { openTab: (kind, options) => opened.push({ kind, options }) }
  }
  props.runtime.open(exports.instanceKeyOf('session-1', 'tab-1'), 'session-1')
  const bodyElement = bodyRegistration.component({ ...props, useTabInfo: () => ({ tab }) })
  assert.equal(typeof bodyElement.type, 'function', 'the tab body renders the panel component')
  const tree = bodyElement.type(bodyElement.props)
  const button = findElement(tree, (element) => element.props !== undefined && element.props.className === 'sc-new')
  assert.ok(button !== undefined, 'the new-side-chat control renders in the status bar')
  assert.equal(button.props['aria-label'], '新建侧边会话')
  button.props.onClick()
  assert.deepEqual(opened, [{ kind: KIND, options: undefined }])
})

test('the close handler destroys only the side conversation of the closed tab occurrence', async () => {
  const { exports } = loadBundle()
  const { ctx, registered, closeHandlers } = createCtxStub()
  const { doc } = createDocumentStub()
  const { fetchImpl, calls } = createFetchStub({
    create: (body) => ({ ok: true, sessionId: `side-${String(body.instanceKey).slice(-1)}`, inheritedEventCount: 0 }),
    prompt: { ok: true },
    close: { ok: true }
  })
  const previousDocument = globalThis.document
  const previousFetch = globalThis.fetch
  globalThis.document = doc
  globalThis.fetch = fetchImpl
  try {
    exports.apply(ctx)
    const runtime = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab').options.inject('session-1').runtime
    const first = exports.instanceKeyOf('session-1', 'tab-a')
    const second = exports.instanceKeyOf('session-1', 'tab-b')
    runtime.open(first, 'session-1')
    runtime.open(second, 'session-1')
    await runtime.send(first, 'hello first')
    await runtime.send(second, 'hello second')
    assert.equal(runtime.getState(first).sessionId, 'side-a')
    assert.equal(runtime.getState(second).sessionId, 'side-b')

    closeHandlers[0].handler('session-1', { id: 'tab-b', kind: KIND })
    await flush()
    assert.equal(runtime.getState(second), null)
    assert.equal(runtime.getState(first).sessionId, 'side-a', 'the other side chat stays alive')
    assert.deepEqual(calls.filter((call) => call.url === `${API_PREFIX}close`).map((call) => call.body), [
      { sessionId: 'side-b' }
    ])
  } finally {
    globalThis.document = previousDocument
    globalThis.fetch = previousFetch
  }
})
