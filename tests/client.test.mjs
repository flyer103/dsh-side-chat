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
  // The shell exports `MarkdownText` as a `React.memo` component: an object with
  // `$$typeof`, not a function. Keep the stub shaped like the real seed module.
  const MarkdownText = { $$typeof: Symbol.for('react.memo'), type: component('MarkdownText'), compare: null }
  return {
    MarkdownText,
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

/** Render one element through the function or `memo` component behind its type. */
function expandElement(element) {
  assert.ok(element !== null && element !== undefined, 'element must exist')
  const type = element.type
  const component = typeof type === 'function'
    ? type
    : (type !== null && typeof type === 'object' ? type.type : undefined)
  assert.equal(typeof component, 'function', 'element type must be renderable')
  return component(element.props)
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

/** One settled assistant event carrying provider usage directly on `data.usage`. */
function usageEntry(seq, turn, step, usage) {
  return {
    seq,
    type: 'assistant/message',
    time: 1700000000000 + seq * 1000,
    surfaceOp: 'append',
    data: {
      turn,
      step,
      message: { id: `assistant-${seq}`, content: [] },
      usage
    }
  }
}

/** One settled assistant event whose usage only exists in its compact stream chunk. */
function streamUsageEntry(seq, turn, step, usage) {
  return {
    seq,
    type: 'assistant/attempt',
    time: 1700000000000 + seq * 1000,
    surfaceOp: 'append',
    data: {
      turn,
      step,
      stream: [
        { type: 'chunk', chunk: { type: 'text-delta', text: 'answer' } },
        { type: 'chunk', chunk: { type: 'usage', usage } }
      ]
    }
  }
}

function retryStartedEntry(seq, turn, step) {
  return {
    seq,
    type: 'llm/retry-started',
    time: 1700000000000 + seq * 1000,
    surfaceOp: 'append',
    data: { turn, step }
  }
}

function requestContextEntry(seq, contextWindow) {
  return {
    seq,
    type: 'request/context',
    time: 1700000000000 + seq * 1000,
    surfaceOp: 'append',
    data: { contextWindow }
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
  assert.deepEqual(nodes.map((node) => node.kind), ['user', 'process', 'assistant'])
  const process = nodes[1]
  assert.equal(process.turn, 1)
  assert.deepEqual(process.blocks.map((block) => block.kind), ['reasoning', 'tool-call'])
  assert.equal(process.blocks[0].text, 'think first')
  assert.equal(process.blocks[1].callId, 'call-1')
  assert.equal(process.blocks[1].name, 'bash')
  assert.equal(process.blocks[1].result.text, 'all tests passed')
  assert.equal(process.blocks[1].result.isError, false)
  assert.deepEqual(nodes[2].blocks.map((block) => block.kind), ['text'])
  assert.equal(nodes[2].blocks[0].text, 'Running them.')
})

test('toolArgsSummary shows the command or path gist, not raw JSON', () => {
  const { exports } = loadBundle()
  assert.equal(exports.toolArgsSummary(JSON.stringify({ command: 'ls -la', description: 'list' })), 'ls -la')
  assert.equal(exports.toolArgsSummary(JSON.stringify({ path: '/tmp/a.txt', content: 'x' })), '/tmp/a.txt')
  assert.equal(exports.toolArgsSummary(JSON.stringify({ description: 'Read the file' })), 'Read the file')
  assert.equal(exports.toolArgsSummary('not json'), 'not json')
  assert.equal(exports.toolArgsSummary(''), '')
  assert.equal(exports.toolArgsSummary(undefined), '')
  assert.equal(exports.toolArgsSummary(JSON.stringify({ a: 'x'.repeat(400) })).endsWith('…'), true)
})

test('foldEntries groups one turn\'s reasoning and tools into a single process node', () => {
  const { exports } = loadBundle()
  const entries = [
    { seq: 1, type: 'turn/start', time: 1000, data: { turn: 1 } },
    assistantEntry(2, [
      { type: 'reasoning', text: 'first thought' },
      { type: 'text', text: 'first step' }
    ]),
    assistantEntry(3, [
      { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' },
      { type: 'text', text: 'second step' }
    ]),
    { seq: 4, type: 'turn/end', time: 5000, data: { turn: 1, reason: { kind: 'completed' } } }
  ]
  const nodes = exports.foldEntries(entries, 0)
  assert.deepEqual(nodes.map((node) => node.kind), ['process', 'assistant', 'assistant'])
  const process = nodes[0]
  assert.equal(process.turn, 1)
  assert.equal(process.start, 1000)
  assert.equal(process.end, 5000)
  assert.equal(process.reason, 'completed')
  assert.deepEqual(process.blocks.map((block) => block.kind), ['reasoning', 'tool-call'])
  assert.deepEqual(nodes.slice(1).map((node) => node.blocks[0].text), ['first step', 'second step'])
})

test('the turn process row says Working while the turn has no end yet', () => {
  const { bodyRegistration } = panelRenderer()
  const state = panelState({
    sessionId: 'side-1',
    nodes: [{ kind: 'process', seq: 2, turn: 1, start: 1000, end: undefined, blocks: [{ kind: 'reasoning', text: 'thinking' }] }]
  })
  let tree = bodyRegistration.component({
    runtime: panelRuntime(state),
    sessionId: 'main-1',
    t: (key) => key,
    useTabInfo: () => ({ tab: { visible: true } })
  })
  for (let depth = 0; depth < 3 && tree !== null && tree !== undefined && typeof tree.type === 'function'; depth += 1) tree = tree.type(tree.props)
  const processElement = findElement(tree, (element) => typeof element.type === 'function'
    && element.props !== undefined && element.props.node !== undefined && element.props.node.kind === 'process')
  const rowTree = processElement.type(processElement.props)
  const label = findElement(rowTree, (element) => element.props !== undefined && element.props.className === 'sc-process-label')
  assert.equal(label.children[0], 'process.working')
})

test('formatTurnDuration uses seconds and minutes like the main transcript', () => {
  const { exports } = loadBundle()
  assert.equal(exports.formatTurnDuration(400), '1s')
  assert.equal(exports.formatTurnDuration(42000), '42s')
  assert.equal(exports.formatTurnDuration(273000), '4m 33s')
  assert.equal(exports.formatTurnDuration(3600000), '60m 0s')
})

test('the panel renders the collapsed turn process row with its duration', () => {
  const { bodyRegistration } = panelRenderer()
  const state = panelState({
    sessionId: 'side-1',
    nodes: [{
      kind: 'process', seq: 2, turn: 1, start: 1000, end: 5000, reason: 'completed',
      blocks: [{ kind: 'reasoning', text: 'thought' }, { kind: 'tool-call', callId: 'c1', name: 'bash', argsRaw: '{}', result: null }]
    }]
  })
  const bodyElement = bodyRegistration.component({
    runtime: panelRuntime(state),
    sessionId: 'main-1',
    t: (key) => key,
    useTabInfo: () => ({ tab: { visible: true } })
  })
  let tree = bodyElement
  for (let depth = 0; depth < 3 && tree !== null && tree !== undefined && typeof tree.type === 'function'; depth += 1) {
    tree = tree.type(tree.props)
  }
  const processElement = findElement(tree, (element) => typeof element.type === 'function'
    && element.props !== undefined && element.props.node !== undefined && element.props.node.kind === 'process')
  assert.ok(processElement !== undefined, 'the panel renders a process row element')
  const rowTree = processElement.type(processElement.props)
  const label = findElement(rowTree, (element) => element.props !== undefined && element.props.className === 'sc-process-label')
  assert.ok(label !== undefined, 'the process row renders')
  assert.equal(label.children[0], 'process.took4s')
  const button = findElement(rowTree, (element) => element.props !== undefined && element.props.className === 'sc-process')
  assert.equal(button.props.disabled, false, 'a row with reasoning/tools is foldable')
  assert.equal(button.props['aria-expanded'], false, 'it starts collapsed like the main transcript')
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
  const wrapper = blocks.find((block) => block.props !== undefined && block.props.className === 'sc-md-table-wrap')
  assert.ok(wrapper !== undefined, 'a table renders inside its copy-chip host wrapper')
  assert.equal(wrapper.children[0].type, 'table', 'the wrapper holds the table')
  const code = blocks.find((block) => block.type === 'pre')
  assert.equal(code.children[0].children[0], 'const a = 1')
  const flat = JSON.stringify(blocks)
  assert.ok(flat.includes('sc-inline-code'))
  assert.ok(flat.includes('strong'))
  assert.ok(flat.includes('sc-md-a'))
})

test('fallback markdown keeps a GFM escaped pipe inside one table cell and normalizes columns', () => {
  const { exports } = loadBundle()
  const text = [
    '| 位置 | 改动 |',
    '| --- | --- |',
    '| §2 编辑矩阵 | 新增行：`单元格多行 \\| 同一 <p> 内用 <br/> 分行` |',
    '| §3 验证第 6 条 | 短 |'
  ].join('\n')
  const table = exports.renderMarkdownFallback(text, 'md')
    .find((block) => block.props !== undefined && block.props.className === 'sc-md-table-wrap')
    .children[0]
  assert.ok(table !== undefined, 'the escaped pipe must not break the table block')
  const rows = table.children[0].children[0]
  assert.equal(rows.length, 3, 'header plus two body rows')
  for (const row of rows) {
    assert.equal(row.children[0].length, 2, 'every row keeps the header column count')
  }
  const cellText = (cell) => cell.children[0]
    .map((node) => (typeof node === 'string' ? node : node.children[0]))
    .join('')
  assert.equal(cellText(rows[1].children[0][1]), '新增行：单元格多行 | 同一 <p> 内用 <br/> 分行')
  const codeNode = rows[1].children[0][1].children[0].find((node) => node !== null && typeof node === 'object')
  assert.ok(codeNode !== undefined, 'the inline code span still renders as code')
  assert.equal(codeNode.children[0], '单元格多行 | 同一 <p> 内用 <br/> 分行', 'the escape backslash is dropped')
})

/** Minimal element face the copy-chip decorator touches; the suite has no DOM. */
function createFakeElement(tagName) {
  const listeners = new Map()
  const element = {
    tagName: tagName.toUpperCase(),
    className: '',
    textContent: '',
    title: '',
    attributes: {},
    children: [],
    parentElement: null,
    style: {},
    classList: {
      add(name) {
        const names = new Set(element.className.split(/\s+/).filter((entry) => entry !== ''))
        names.add(name)
        element.className = Array.from(names).join(' ')
      },
      contains(name) {
        return element.className.split(/\s+/).includes(name)
      }
    },
    appendChild(child) {
      child.parentElement = element
      element.children.push(child)
      return child
    },
    addEventListener(type, handler) {
      listeners.set(type, handler)
    },
    setAttribute(name, value) {
      element.attributes[name] = String(value)
    },
    getAttribute(name) {
      return element.attributes[name] === undefined ? null : element.attributes[name]
    },
    click() {
      const handler = listeners.get('click')
      if (handler !== undefined) handler()
    },
    querySelector(selector) {
      for (const child of element.children) {
        if (selector === 'table' && child.tagName === 'TABLE') return child
      }
      return null
    }
  }
  return element
}

function createTableElement(rows) {
  const table = createFakeElement('table')
  table.rows = rows.map((cells, rowIndex) => ({
    cells: cells.map((text) => ({ textContent: text, tagName: rowIndex === 0 ? 'TH' : 'TD' }))
  }))
  return table
}

/** One rendered table and one fallback code fence under a fake Markdown root. */
function createCopyTargets() {
  const table = createTableElement([['位置', '改动'], ['§1', 'a\tb']])
  const tableHost = createFakeElement('div')
  tableHost.className = 'tableScroll'
  tableHost.appendChild(table)
  const fence = createFakeElement('pre')
  fence.className = 'sc-md-code'
  const code = createFakeElement('code')
  code.textContent = 'const a = 1'
  fence.appendChild(code)
  return {
    tableHost,
    fence,
    root: {
      querySelectorAll(selector) {
        if (selector === 'table') return [table]
        if (selector === 'pre.sc-md-code') return [fence]
        return []
      }
    }
  }
}

/** Install the document/navigator face a copy click needs; returns a restore function. */
function installCopyGlobals(writeText, write) {
  const previousDocument = globalThis.document
  // Node 21+ exposes `navigator` as a getter-only global, so an assignment throws.
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const previousClipboardItem = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem')
  globalThis.document = { createElement: (tag) => createFakeElement(tag) }
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: write === undefined ? { writeText } : { writeText, write } },
    configurable: true,
    writable: true
  })
  if (write !== undefined) {
    globalThis.ClipboardItem = class {
      constructor(data) { this.data = data }
    }
  }
  return () => {
    globalThis.document = previousDocument
    if (previousClipboardItem === undefined) delete globalThis.ClipboardItem
    else Object.defineProperty(globalThis, 'ClipboardItem', previousClipboardItem)
    if (previousNavigator === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', previousNavigator)
  }
}

test('copy helpers flatten cells, rows and whitespace into a TSV payload', () => {
  const { exports } = loadBundle()
  assert.equal(exports.normalizeCellText('  a\n\tb  '), 'a b')
  assert.equal(exports.normalizeCellText(undefined), '')
  assert.equal(exports.tableToTsv([['a', ' b '], ['1\n2', null]]), 'a\tb\n1 2\t')
  assert.equal(exports.tableToTsv([]), '')
})

test('copy helpers render the same grid as an escaped HTML table', () => {
  const { exports } = loadBundle()
  assert.equal(exports.tableToHtml([]), '')
  assert.equal(
    exports.tableToHtml([
      [{ text: '位置', header: true }, { text: '改动', header: true }],
      [{ text: '<a> & "b"', header: false }, { text: '1\n2', header: false }]
    ]),
    '<table><thead><tr><th>位置</th><th>改动</th></tr></thead>'
      + '<tbody><tr><td>&lt;a&gt; &amp; &quot;b&quot;</td><td>1 2</td></tr></tbody></table>'
  )
  assert.equal(
    exports.tableToHtml([[{ text: 'x', header: true }], [{ text: 'y', header: true }]]),
    '<table><thead><tr><th>x</th></tr></thead><tbody><tr><th>y</th></tr></tbody></table>',
    'only a leading all-header row becomes thead'
  )
})

test('the table chip writes an HTML table beside the TSV payload', async (t) => {
  const { exports } = loadBundle()
  const { root, tableHost } = createCopyTargets()
  const items = []
  let textWrites = 0
  const restore = installCopyGlobals(
    async () => { textWrites += 1 },
    async (batch) => { items.push(...batch) }
  )
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const labels = { table: { copy: '复制表格', copied: '已复制' }, code: { copy: '复制', copied: '复制成功' } }
    exports.decorateCopyChips(root, labels)
    const chip = tableHost.children[1]
    chip.click()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(textWrites, 0, 'the rich payload is not downgraded to writeText')
    assert.equal(items.length, 1)
    assert.equal(items[0].data['text/plain'].type, 'text/plain')
    assert.equal(items[0].data['text/html'].type, 'text/html')
    assert.equal(await items[0].data['text/plain'].text(), '位置\t改动\n§1\ta b')
    assert.equal(
      await items[0].data['text/html'].text(),
      '<table><thead><tr><th>位置</th><th>改动</th></tr></thead>'
        + '<tbody><tr><td>§1</td><td>a b</td></tr></tbody></table>'
    )
    assert.equal(chip.textContent, '已复制')
    t.mock.timers.tick(exports.COPY_FEEDBACK_MS)
  } finally {
    t.mock.timers.reset()
    restore()
  }
})

test('a clipboard item the browser rejects falls back to the TSV text', async (t) => {
  const { exports } = loadBundle()
  const { root, tableHost } = createCopyTargets()
  const writes = []
  const restore = installCopyGlobals(
    async (text) => { writes.push(text) },
    async () => { throw new Error('html denied') }
  )
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const labels = { table: { copy: '复制表格', copied: '已复制' }, code: { copy: '复制', copied: '复制成功' } }
    exports.decorateCopyChips(root, labels)
    const chip = tableHost.children[1]
    chip.click()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(writes, ['位置\t改动\n§1\ta b'])
    assert.equal(chip.textContent, '已复制', 'the TSV fallback still confirms the copy')
    t.mock.timers.tick(exports.COPY_FEEDBACK_MS)
  } finally {
    t.mock.timers.reset()
    restore()
  }
})

test('decorateCopyChips adds one localized chip per table and copies TSV', async (t) => {
  const { exports } = loadBundle()
  const { root, tableHost, fence } = createCopyTargets()
  const writes = []
  const restore = installCopyGlobals(async (text) => { writes.push(text) })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const labels = { table: { copy: '复制表格', copied: '已复制' }, code: { copy: '复制', copied: '复制成功' } }
    exports.decorateCopyChips(root, labels)
    exports.decorateCopyChips(root, labels)
    assert.equal(tableHost.children.length, 2, 'a table keeps exactly one chip across repeated decoration')
    assert.equal(fence.children.length, 2, 'a fallback fence gets its own chip')
    assert.ok(tableHost.classList.contains('sc-copy-host'), 'the table scroll container becomes the chip host')
    const tableChip = tableHost.children[1]
    const fenceChip = fence.children[1]
    assert.equal(tableChip.className, 'sc-copy-chip')
    assert.equal(tableChip.textContent, '复制表格')
    assert.equal(tableChip.getAttribute('aria-label'), '复制表格')
    assert.equal(fenceChip.textContent, '复制')

    tableChip.click()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(writes, ['位置\t改动\n§1\ta b'], 'clicks copy the rendered grid, tabs preserved')
    assert.equal(tableChip.textContent, '已复制', 'the chip confirms the write')
    t.mock.timers.tick(exports.COPY_FEEDBACK_MS)
    assert.equal(tableChip.textContent, '复制表格', 'the confirmation reverts after the feedback window')

    exports.decorateCopyChips(root, { table: { copy: 'Copy table', copied: 'Copied' }, code: { copy: 'Copy', copied: 'Copied' } })
    assert.equal(tableChip.textContent, 'Copy table', 'a locale switch re-syncs an idle chip')
    assert.equal(fenceChip.textContent, 'Copy')

    fenceChip.click()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(writes, ['位置\t改动\n§1\ta b', 'const a = 1'], 'a fence copies only its code, never the chip label')

    tableChip.click()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(tableChip.textContent, 'Copied', 'the confirmation uses the locale active at click time')
    t.mock.timers.tick(exports.COPY_FEEDBACK_MS)
    assert.equal(tableChip.textContent, 'Copy table')

    const replacement = createTableElement([['x', 'y'], ['3', '4']])
    tableHost.children[0] = replacement
    replacement.parentElement = tableHost
    exports.decorateCopyChips({ querySelectorAll: (selector) => (selector === 'table' ? [replacement] : []) }, labels)
    assert.equal(tableHost.children.length, 2, 'stream re-render reuses the chip beside the replaced table')
    tableChip.click()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(writes.at(-1), 'x\ty\n3\t4', 'the chip reads the table that is mounted at click time')
  } finally {
    t.mock.timers.reset()
    restore()
  }
})

test('a rejected clipboard write leaves the chip label untouched', async () => {
  const { exports } = loadBundle()
  const { root, tableHost } = createCopyTargets()
  const restore = installCopyGlobals(async () => {
    throw new Error('denied')
  })
  try {
    const labels = { table: { copy: '复制表格', copied: '已复制' }, code: { copy: '复制', copied: '复制成功' } }
    exports.decorateCopyChips(root, labels)
    tableHost.children[1].click()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(tableHost.children[1].textContent, '复制表格')
    assert.equal(tableHost.children[1].getAttribute('aria-label'), '复制表格')
  } finally {
    restore()
  }
})

/** One assistant row whose single text block is `text`, on a settled panel state. */
function assistantPanelState(text) {
  return {
    mainId: 'main-1',
    sessionId: 'side-1',
    inheritedEventCount: 0,
    nextSeq: 2,
    entries: [],
    nodes: [
      { kind: 'user', seq: 0, time: 1700000000000, text: 'question' },
      { kind: 'assistant', seq: 1, time: 1700000001000, blocks: [{ kind: 'text', text }] }
    ],
    visible: true,
    running: false,
    status: 'idle',
    lastError: null,
    error: null,
    pollError: null,
    sending: false,
    draft: '',
    pending: [],
    live: null,
    streamMode: 'poll',
    streaming: false,
    timer: null,
    onVisibility: null
  }
}

function renderAssistantPanel(text, options = {}) {
  const { exports } = loadBundle({ primitives: options.primitives === true })
  const { registered, locale } = applyBundle(exports)
  const body = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
  const t = options.t === undefined ? locale.bind(NS) : options.t
  const panel = renderPanel(body, {}, assistantPanelState(text), t)
  const row = findElement(panel, (element) =>
    element.props !== undefined &&
    Array.isArray(element.props.blocks) &&
    element.props.blocks.length === 1 &&
    element.props.blocks[0].text === text)
  assert.ok(row !== undefined, 'the assistant row renders')
  const tree = expandElement(row)
  const markdown = findElement(tree, (element) => element.props !== undefined && element.props.text === text)
  assert.ok(markdown !== undefined, 'assistant text renders one Markdown element')
  return { tree, markdown, t }
}

test('the panel renders assistant Markdown through the shell memo component', () => {
  const text = '| a | b |\n| --- | --- |\n| 1 | 2 |'
  const { tree, markdown } = renderAssistantPanel(text, { primitives: true })
  const shell = expandElement(markdown)
  assert.equal(typeof shell.type, 'object', 'the shell MarkdownText is a memo component, not a function')
  assert.equal(shell.type.$$typeof, Symbol.for('react.memo'))
  assert.equal(shell.props.text, text)
  assert.equal(shell.props.streaming, false)
  assert.deepEqual(shell.props.labels, {
    code: {
      copyLabel: '复制',
      copiedLabel: '复制成功',
      toolbarLabels: { codeLabel: '代码块', wrapLabel: '自动换行', unwrapLabel: '取消自动换行' }
    },
    footnotes: '脚注'
  })
  assert.equal(
    findElement(tree, (element) => element.props !== undefined && element.props.className === 'sc-md'),
    undefined,
    'the built-in fallback is not used while the shell renderer is available'
  )
  assert.equal(expandElement(markdown).props.labels, shell.props.labels, 'labels stay reference-stable for one locale seat')
})

test('without the shell MarkdownText the panel falls back to the built-in renderer', () => {
  const text = '**bold** answer'
  const { markdown } = renderAssistantPanel(text)
  const fallback = expandElement(markdown)
  assert.equal(fallback.type, 'div')
  assert.equal(fallback.props.className, 'sc-md')
})

test('a bare TeX display environment is wrapped into display math', () => {
  const { exports } = loadBundle({ primitives: true })
  const source = [
    '结论：',
    '\\begin{align}',
    'a &= b \\\\',
    'c &= d',
    '\\end{align}',
    '结束'
  ].join('\n')
  assert.equal(exports.normalizeBareTexEnvironments(source), [
    '结论：',
    '$$',
    '\\begin{align}',
    'a &= b \\\\',
    'c &= d',
    '\\end{align}',
    '$$',
    '结束'
  ].join('\n'))
})

test('bare environment wrapping is idempotent', () => {
  const { exports } = loadBundle({ primitives: true })
  const wrapped = exports.normalizeBareTexEnvironments('\\begin{cases}\nx\n\\end{cases}')
  assert.equal(wrapped, '$$\n\\begin{cases}\nx\n\\end{cases}\n$$')
  assert.equal(exports.normalizeBareTexEnvironments(wrapped), wrapped)
})

test('bare environment wrapping leaves unsupported or unsafe shapes literal', () => {
  const { exports } = loadBundle({ primitives: true })
  const normalize = exports.normalizeBareTexEnvironments
  const untouched = [
    '```\n\\begin{align}\na\n\\end{align}\n```',
    '~~~latex\n\\begin{align}\na\n\\end{align}\n~~~',
    '$$\n\\begin{align}\na\n\\end{align}\n$$',
    '\\[\n\\begin{align}\na\n\\end{align}\n\\]',
    '\\(\n\\begin{cases}\na\n\\end{cases}\n\\)',
    '  \\begin{align}\na\n\\end{align}',
    '\\begin{document}\nx\n\\end{document}',
    '\\begin{align}\na',
    '\\begin{align}\na\n\\end{align} tail',
    'text \\begin{align} a \\end{align}'
  ]
  for (const source of untouched) assert.equal(normalize(source), source, source)
  assert.equal(normalize(undefined), undefined)
  assert.equal(normalize(''), '')
})

test('the shell renderer receives a settled bare environment as display math', () => {
  const text = '\\begin{align}\na &= b\n\\end{align}'
  const { markdown } = renderAssistantPanel(text, { primitives: true })
  const shell = expandElement(markdown)
  assert.equal(shell.type.$$typeof, Symbol.for('react.memo'))
  assert.equal(shell.props.text, '$$\n\\begin{align}\na &= b\n\\end{align}\n$$')
  assert.equal(shell.props.streaming, false)
})

test('streaming text reaches the shell renderer unnormalized', () => {
  const text = '\\begin{align}\na &= b\n\\end{align}'
  const { markdown } = renderAssistantPanel(text, { primitives: true })
  const shell = markdown.type({ ...markdown.props, streaming: true })
  assert.equal(shell.props.text, text)
  assert.equal(shell.props.streaming, true)
})

test('the built-in fallback renderer never sees the display-math wrapper', () => {
  const text = '\\begin{align}\na &= b\n\\end{align}'
  const { markdown } = renderAssistantPanel(text)
  const fallback = expandElement(markdown)
  const serialized = JSON.stringify(fallback)
  assert.equal(serialized.includes('$$'), false)
  assert.equal(serialized.includes('begin{align}'), true)
  assert.equal(serialized.includes('a &= b'), true)
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
  assert.deepEqual(state.nodes.map((node) => node.kind), ['user', 'process', 'assistant'])
  assert.deepEqual(state.nodes[1].blocks, [], 'a text-only turn folds an empty process row')
  assert.equal(state.nodes[2].blocks[0].text, 'Hello world')
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

// --- status dock metrics and rendering -------------------------------------

test('usageBucketsOf and streamUsageOf normalize provider usage records defensively', () => {
  const { exports } = loadBundle()
  assert.deepEqual(exports.usageBucketsOf({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 }), {
    uncachedInputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 3,
    cacheWriteTokens: 2
  })
  assert.deepEqual(
    exports.usageBucketsOf({ outputTokens: 7, inputTokens: -1, cacheReadTokens: Number.NaN, cacheWriteTokens: '3' }),
    { uncachedInputTokens: 0, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
    'negative, non-finite and non-numeric fields are ignored'
  )
  assert.equal(exports.usageBucketsOf({}), null)
  assert.equal(exports.usageBucketsOf(null), null)
  assert.equal(exports.usageBucketsOf([]), null)
  assert.equal(exports.usageBucketsOf('usage'), null)

  const stream = [
    { type: 'chunk', chunk: { type: 'text-delta', text: 'hi' } },
    { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } } },
    { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 8, outputTokens: 9, cacheReadTokens: 4 } } }
  ]
  assert.deepEqual(exports.streamUsageOf(stream), {
    uncachedInputTokens: 8,
    outputTokens: 9,
    cacheReadTokens: 4,
    cacheWriteTokens: 0
  }, 'the last usable usage chunk wins')
  assert.deepEqual(
    exports.streamUsageOf([
      { type: 'chunk', chunk: { type: 'usage', usage: { outputTokens: 3 } } },
      { type: 'chunk', chunk: { type: 'usage', usage: {} } }
    ]),
    { uncachedInputTokens: 0, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
    'a trailing empty usage record falls back to the previous usable one'
  )
  assert.equal(exports.streamUsageOf([{ type: 'chunk', chunk: { type: 'usage', usage: {} } }]), null)
  assert.equal(exports.streamUsageOf(undefined), null)
  assert.equal(exports.streamUsageOf('stream'), null)
})

test('metricsOf folds only side-chat usage and replaces a re-settled turn step', () => {
  const { exports } = loadBundle()
  const entries = [
    requestContextEntry(0, 64000),
    usageEntry(1, 1, 1, { inputTokens: 800, outputTokens: 400, cacheReadTokens: 800 }),
    usageEntry(3, 1, 1, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10 }),
    usageEntry(4, 1, 1, { inputTokens: 40, outputTokens: 8 }),
    streamUsageEntry(5, 2, 1, { inputTokens: 7, outputTokens: 2, cacheWriteTokens: 3 }),
    requestContextEntry(6, 8000)
  ]
  assert.deepEqual(exports.metricsOf(entries, 3), {
    uncachedInputTokens: 47,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 3,
    billedInputTokens: 50,
    totalTokens: 60,
    pressureTokens: 10,
    cacheHitPercent: '0',
    contextWindow: 8000
  })
  assert.equal(exports.metricsOf([], 0), null, 'no usage sample means no dock')
  assert.equal(exports.metricsOf(null, 0), null)
  assert.equal(exports.metricsOf([null, 7, {}], 0), null, 'malformed entries are tolerated')
  assert.equal(exports.metricsOf([requestContextEntry(0, 64000)], 0), null, 'a request window alone is not usage')
  assert.equal(exports.metricsOf([usageEntry(2, 1, 1, { inputTokens: 0, outputTokens: 0 })], 0), null)
  assert.equal(
    exports.metricsOf([usageEntry(1, 1, 1, { inputTokens: 10, outputTokens: 2 })], 5),
    null,
    'inherited history below the fork floor is never billed to the side chat'
  )
})

test('metricsOf closes the replaceable slot on llm/retry-started and tracks the newest pressure and window', () => {
  const { exports } = loadBundle()
  const entries = [
    requestContextEntry(3, 64000),
    usageEntry(4, 1, 1, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 100 }),
    retryStartedEntry(5, 1, 1),
    usageEntry(6, 1, 1, { inputTokens: 10, outputTokens: 5 }),
    requestContextEntry(7, 128000),
    requestContextEntry(8, -4),
    requestContextEntry(9, '64000')
  ]
  const metrics = exports.metricsOf(entries, 0)
  assert.equal(metrics.uncachedInputTokens, 110, 'the retried attempt is kept, the replacement slot is closed')
  assert.equal(metrics.outputTokens, 55)
  assert.equal(metrics.cacheReadTokens, 100)
  assert.equal(metrics.billedInputTokens, 210)
  assert.equal(metrics.totalTokens, 265)
  assert.equal(metrics.pressureTokens, 10, 'the newest sample supplies the prompt-side pressure')
  assert.equal(metrics.cacheHitPercent, '48', '100 / 210 rounds to 48')
  assert.equal(metrics.contextWindow, 128000, 'the newest positive request/context wins')
})

test('cacheHitText never rounds a partial hit up to 100 percent', () => {
  const { exports } = loadBundle()
  assert.equal(exports.cacheHitText(0, 0), null)
  assert.equal(exports.cacheHitText(50, 0), null, 'nothing billed means no reading')
  assert.equal(exports.cacheHitText(100, 100), '100')
  assert.equal(exports.cacheHitText(120, 100), '100', 'a full hit caps at 100')
  assert.equal(exports.cacheHitText(0, 100), '0')
  assert.equal(exports.cacheHitText(50, 100), '50')
  assert.equal(exports.cacheHitText(1, 3), '33')
  assert.equal(exports.cacheHitText(9960, 10000), '99.6', 'a partial hit stays below 100')
  assert.equal(exports.cacheHitText(9990, 10000), '99.9')
})

test('occupancyOf needs pressure and a window and prefers the entries window', () => {
  const { exports } = loadBundle()
  assert.equal(exports.occupancyOf(null, 1000), null)
  assert.equal(exports.occupancyOf(undefined, 1000), null)
  assert.equal(exports.occupancyOf({ pressureTokens: null, contextWindow: 1000 }, 1000), null)
  assert.equal(exports.occupancyOf({ pressureTokens: 500, contextWindow: null }, null), null)
  assert.equal(exports.occupancyOf({ pressureTokens: 500, contextWindow: null }, 0), null)
  assert.deepEqual(exports.occupancyOf({ pressureTokens: 500, contextWindow: null }, 2000), {
    percent: 25,
    usedTokens: 500,
    contextWindow: 2000
  })
  assert.deepEqual(exports.occupancyOf({ pressureTokens: 300, contextWindow: 1000 }, 2000), {
    percent: 30,
    usedTokens: 300,
    contextWindow: 1000
  }, 'the fold window beats the host baseline')
  assert.deepEqual(exports.occupancyOf({ pressureTokens: 5000, contextWindow: 1000 }, null), {
    percent: 100,
    usedTokens: 5000,
    contextWindow: 1000
  }, 'occupancy is capped at 100')
  assert.deepEqual(exports.occupancyOf({ pressureTokens: 0, contextWindow: null }, 1000), {
    percent: 0,
    usedTokens: 0,
    contextWindow: 1000
  })
  assert.deepEqual(exports.occupancyOf({ pressureTokens: 1, contextWindow: 3 }, null), {
    percent: 33,
    usedTokens: 1,
    contextWindow: 3
  })
})

test('formatTokenCount and formatExactTokenCount use the dock locale keys', () => {
  const { exports } = loadBundle()
  const { registered, locale } = applyBundle(exports)
  const t = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab').options.inject('session-1').t
  const DOCK_KEYS = [
    'dock.tokens',
    'dock.cacheHit',
    'dock.contextAria',
    'dock.contextTitle',
    'dock.usageTitle',
    'dock.usageTitleWithWrite',
    'dock.thousand',
    'dock.million',
    'dock.groupSeparator'
  ]
  for (const key of DOCK_KEYS) {
    assert.equal(typeof exports.ZH_DICT[key], 'string', `zh.${key} must exist`)
    assert.notEqual(exports.ZH_DICT[key].trim(), '', `zh.${key} must not be empty`)
    assert.equal(typeof exports.EN_DICT[key], 'string', `en.${key} must exist`)
    assert.notEqual(exports.EN_DICT[key].trim(), '', `en.${key} must not be empty`)
  }
  assert.match(exports.ZH_DICT['dock.usageTitleWithWrite'], /\{cacheWrite\}/)
  assert.match(exports.EN_DICT['dock.usageTitleWithWrite'], /\{cacheWrite\}/)
  assert.equal(exports.ZH_DICT['dock.groupSeparator'], exports.EN_DICT['dock.groupSeparator'])

  assert.equal(exports.formatTokenCount(t, 999), '999')
  assert.equal(exports.formatTokenCount(t, 1234), '1.2K')
  assert.equal(exports.formatTokenCount(t, 12345), '12.3K')
  assert.equal(exports.formatTokenCount(t, 517000), '517K')
  assert.equal(exports.formatTokenCount(t, 12_345_678), '12.3M')
  assert.equal(exports.formatTokenCount(t, 0), '0')
  assert.equal(exports.formatTokenCount(t, -5), '0')
  assert.equal(exports.formatTokenCount(t, undefined), '0')
  assert.equal(exports.formatExactTokenCount(t, 999), '999')
  assert.equal(exports.formatExactTokenCount(t, 1234), '1,234')
  assert.equal(exports.formatExactTokenCount(t, 1_234_567), '1,234,567')
  assert.equal(exports.formatExactTokenCount(t, -3), '0')

  locale.setLocale('en')
  assert.match(t('dock.usageTitleWithWrite', { input: '1', cacheRead: '2', cacheWrite: '3', output: '4' }), /cache write 3/)
  assert.equal(exports.formatTokenCount(t, 1234), '1.2K')
  assert.equal(exports.formatExactTokenCount(t, 1234), '1,234')
})

test('statusDockOf renders token, cache-hit and context readings inside one sc-dock row', () => {
  const { exports } = loadBundle()
  const { registered } = applyBundle(exports)
  const t = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab').options.inject('session-1').t
  const metrics = {
    uncachedInputTokens: 1000,
    outputTokens: 234,
    cacheReadTokens: 3000,
    cacheWriteTokens: 0,
    billedInputTokens: 4000,
    totalTokens: 4234,
    pressureTokens: 4000,
    cacheHitPercent: '75',
    contextWindow: null
  }
  const dock = exports.statusDockOf(t, metrics, 8000)
  assert.ok(dock !== undefined, 'metrics always render the dock')
  assert.equal(dock.type, 'div')
  assert.equal(dock.props.className, 'sc-dock')
  const readings = dock.children[0]
  assert.deepEqual(readings.map((child) => child.props.className), [
    'sc-dock-stat',
    'sc-dock-sep',
    'sc-dock-stat',
    'sc-dock-sep',
    'sc-dock-context'
  ])

  const tokens = readings[0]
  assert.equal(tokens.children[0], '4.2K tok')
  assert.equal(tokens.props.title, '未缓存输入 1,000 · 缓存读取 3,000 · 输出 234', 'a provider without cache write uses the 3-bucket tooltip')
  const cache = readings[2]
  assert.equal(cache.children[0], '缓存命中 75%')
  assert.equal(cache.props.title, tokens.props.title)
  assert.equal(readings[1].children[0], '·')
  assert.equal(readings[3].children[0], '·')

  const context = readings[4]
  assert.equal(context.props.role, 'img')
  assert.equal(context.props['aria-label'], '上下文已用 50%')
  assert.equal(context.props.title, '约 4,000 / 8,000 tok')
  const ring = context.children[0]
  assert.equal(ring.props.className, 'sc-dock-ring')
  const [track, fill] = ring.children
  assert.equal(track.props.className, 'sc-dock-ring-track')
  assert.equal(fill.props.className, 'sc-dock-ring-fill')
  const circumference = 2 * Math.PI * 5.5
  assert.equal(fill.props.strokeDasharray, `${circumference * 50 / 100} ${circumference}`, 'the fill arc is proportional to the percent')
  assert.equal(track.props.strokeDasharray, undefined, 'only the fill is dashed')
  assert.equal(context.children[1].children[0], '50%')

  const withCacheWrite = exports.statusDockOf(t, { ...metrics, cacheWriteTokens: 20 }, null)
  assert.equal(
    withCacheWrite.children[0][0].props.title,
    '未缓存输入 1,000 · 缓存读取 3,000 · 缓存写入 20 · 输出 234',
    'a provider with cache write uses the 4-bucket tooltip'
  )
  assert.equal(withCacheWrite.children[0].length, 3, 'no occupancy reading without a window')

  const withoutCacheHit = exports.statusDockOf(t, { ...metrics, cacheHitPercent: null }, null)
  assert.deepEqual(withoutCacheHit.children[0].map((child) => child.props.className), ['sc-dock-stat'])
  assert.equal(exports.statusDockOf(t, null, 8000), null)
  assert.equal(exports.statusDockOf(t, undefined, 8000), null)
})

test('snapshot polling feeds panel metrics and refreshes the context window without new entries', async () => {
  const usage = { inputTokens: 500, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 0 }
  const fetchStub = createFetchStub({
    create: { ok: true, sessionId: 'side-1', inheritedEventCount: 0 },
    prompt: { ok: true },
    close: { ok: true },
    snapshot: (body) => ({
      ok: true,
      inheritedEventCount: 0,
      running: false,
      status: 'idle',
      lastError: null,
      contextWindow: body.fromSeq === 0 ? 64000 : 128000,
      entries: body.fromSeq === 0 ? [usageEntry(1, 1, 1, usage)] : [],
      live: null
    })
  })
  const { runtime } = createRuntimeWith(fetchStub)
  runtime.open('main-1')
  assert.equal(runtime.getState('main-1').metrics, null, 'the dock stays hidden before any usage sample')
  assert.equal(runtime.getState('main-1').contextWindow, null)
  runtime.setVisible('main-1', true)
  await runtime.send('main-1', 'hello')

  await runtime.pollOnce('main-1')
  let state = runtime.getState('main-1')
  assert.deepEqual(state.metrics, {
    uncachedInputTokens: 500,
    outputTokens: 100,
    cacheReadTokens: 500,
    cacheWriteTokens: 0,
    billedInputTokens: 1000,
    totalTokens: 1100,
    pressureTokens: 1000,
    cacheHitPercent: '50',
    contextWindow: null
  })
  assert.equal(state.contextWindow, 64000, 'the snapshot baseline supplies the window')

  await runtime.pollOnce('main-1')
  state = runtime.getState('main-1')
  assert.equal(state.contextWindow, 128000, 'a snapshot without new entries still refreshes the window')
  assert.equal(state.metrics.totalTokens, 1100, 'the existing usage samples are kept')
  assert.equal(state.metrics.pressureTokens, 1000)

  await runtime.close('main-1')
  runtime.open('main-1')
  const reopened = runtime.getState('main-1')
  assert.equal(reopened.metrics, null, 'a new side session starts without dock readings')
  assert.equal(reopened.contextWindow, null)
})

test('SSE hello and event frames feed panel metrics and the context window', async () => {
  const fetchStub = createStreamingFetchStub({ handlers: streamingHandlers() })
  const { scheduler, runtime } = createRuntimeWith(fetchStub)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  await runtime.send('main-1', 'hi')
  scheduler.runAll()
  await flush()
  assert.equal(fetchStub.streams.length, 1)
  const stream = fetchStub.streams[0]

  stream.queue.push(sseFrame('hello', {
    ok: true,
    inheritedEventCount: 0,
    status: 'idle',
    running: false,
    lastError: null,
    contextWindow: 32000,
    entries: [],
    live: null
  }))
  await flush()
  let state = runtime.getState('main-1')
  assert.equal(state.contextWindow, 32000, 'hello without new entries still teaches the window')
  assert.equal(state.metrics, null, 'hello without usage keeps the dock hidden')

  stream.queue.push(sseFrame('event', {
    entry: usageEntry(0, 1, 1, { inputTokens: 500, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 0 })
  }))
  await flush()
  state = runtime.getState('main-1')
  assert.equal(state.metrics.totalTokens, 1100)
  assert.equal(state.metrics.pressureTokens, 1000)
  assert.equal(state.metrics.cacheHitPercent, '50')
  assert.equal(state.metrics.contextWindow, null, 'no request/context entry appeared in the fold')

  stream.queue.push(sseFrame('event', {
    entry: usageEntry(1, 1, 1, { inputTokens: 40, outputTokens: 8 })
  }))
  await flush()
  state = runtime.getState('main-1')
  assert.equal(state.metrics.totalTokens, 48, 'a re-settled step replaces its earlier sample')
  assert.equal(state.metrics.pressureTokens, 40)

  runtime.setVisible('main-1', false)
  await runtime.close('main-1')
  assert.equal(scheduler.pending(), 0)
})

test('the tab body renders the dock under the composer and hides it without metrics', () => {
  const { exports } = loadBundle({ primitives: true })
  const { registered } = applyBundle(exports)
  const bodyRegistration = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
  const props = bodyRegistration.options.inject('session-1')
  const state = {
    mainId: 'main-1',
    sessionId: 'side-1',
    inheritedEventCount: 0,
    nextSeq: 2,
    entries: [],
    nodes: [],
    visible: true,
    running: false,
    status: 'idle',
    lastError: null,
    error: null,
    pollError: null,
    sending: false,
    draft: '',
    pending: [],
    live: null,
    streamMode: 'poll',
    streaming: false,
    timer: null,
    onVisibility: null,
    metrics: {
      uncachedInputTokens: 500,
      outputTokens: 100,
      cacheReadTokens: 500,
      cacheWriteTokens: 0,
      billedInputTokens: 1000,
      totalTokens: 1100,
      pressureTokens: 1000,
      cacheHitPercent: '50',
      contextWindow: null
    },
    contextWindow: 64000
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
    t: props.t,
    useTabInfo: () => ({ tab: { visible: true } })
  })
  assert.equal(typeof bodyElement.type, 'function')
  const tree = bodyElement.type(bodyElement.props)
  assert.equal(tree.props.className, 'sc-root')
  assert.equal(tree.children.length, 3)
  const footer = tree.children[2]
  assert.equal(footer.props.className, 'sc-footer')
  assert.equal(footer.children[0].props.className, 'sc-composer', 'the composer stays first')
  const dock = footer.children[1]
  assert.equal(dock.props.className, 'sc-dock', 'the dock renders under the composer')
  const dockClasses = []
  collectElements(dock, (element) => {
    if (element.props !== undefined && typeof element.props.className === 'string') dockClasses.push(element.props.className)
  })
  assert.deepEqual(dockClasses, [
    'sc-dock',
    'sc-dock-stat',
    'sc-dock-sep',
    'sc-dock-stat',
    'sc-dock-sep',
    'sc-dock-context',
    'sc-dock-ring',
    'sc-dock-ring-track',
    'sc-dock-ring-fill'
  ])
  const context = findElement(dock, (element) => element.props !== undefined && element.props.className === 'sc-dock-context')
  assert.equal(context.props['aria-label'], '上下文已用 2%')

  state.metrics = null
  const hiddenTree = bodyElement.type(bodyElement.props)
  assert.equal(hiddenTree.children[2].children[1], null, 'no metrics means no dock')

  delete state.metrics
  delete state.contextWindow
  const legacyTree = bodyElement.type(bodyElement.props)
  assert.equal(legacyTree.children[2].children[1], null, 'a fabricated state without dock fields keeps working')
})

// ---- P1a `@file` references ----

function createDeferredReferenceStub(handlers = {}) {
  const calls = []
  const pending = []
  const fetchImpl = async (url, init) => {
    const name = url.startsWith(API_PREFIX) ? url.slice(API_PREFIX.length) : url
    const body = init === undefined || init.body === undefined ? {} : JSON.parse(init.body)
    const signal = init === undefined ? undefined : init.signal
    calls.push({ url, name, body, signal })
    if (name === 'references') {
      return new Promise((resolve) => {
        pending.push({
          body,
          signal,
          resolve(payload) {
            resolve({ ok: true, status: 200, json: async () => payload })
          }
        })
      })
    }
    const handler = handlers[name]
    const payload = typeof handler === 'function' ? handler(body) : (handler === undefined ? { ok: true } : handler)
    return { ok: true, status: 200, json: async () => payload }
  }
  return {
    fetchImpl,
    calls,
    pending,
    referenceCalls: () => calls.filter((call) => call.name === 'references')
  }
}

function panelRenderer() {
  const { exports } = loadBundle({ primitives: true })
  const { registered } = applyBundle(exports)
  const bodyRegistration = registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
  const props = bodyRegistration.options.inject('session-1')
  return { exports, bodyRegistration, props }
}

function panelState(overrides = {}) {
  return {
    mainId: 'main-1',
    sessionId: null,
    inheritedEventCount: null,
    nextSeq: null,
    entries: [],
    nodes: [],
    visible: true,
    running: false,
    status: 'idle',
    lastError: null,
    error: null,
    pollError: null,
    sending: false,
    draft: '',
    pending: [],
    live: null,
    metrics: null,
    contextWindow: null,
    streamMode: 'poll',
    streaming: false,
    timer: null,
    onVisibility: null,
    reference: undefined,
    ...overrides
  }
}

function panelRuntime(state, calls = []) {
  return {
    subscribe: () => () => {},
    getVersion: () => 0,
    open() {},
    setVisible() {},
    getState: () => state,
    setDraft: (id, value) => calls.push(['setDraft', value]),
    composeDraft: (id, value, caret) => calls.push(['composeDraft', value, caret]),
    setComposing: (id, composing) => calls.push(['composing', composing]),
    pickReference: (id, index) => calls.push(['pick', index]),
    moveReference: (id, delta) => calls.push(['move', delta]),
    closeReferences: () => calls.push(['close']),
    send: async () => { calls.push(['send']) },
    cancel: async () => {}
  }
}

function renderPanel(bodyRegistration, props, state, t = (key) => key) {
  const bodyElement = bodyRegistration.component({
    runtime: panelRuntime(state),
    sessionId: 'main-1',
    t,
    useTabInfo: () => ({ tab: { visible: true } })
  })
  return bodyElement.type(bodyElement.props)
}

function composerOf(tree) {
  return findElement(tree, (element) => element.props !== undefined && element.props.className === 'sc-composer')
}

test('activeAtToken replicates the primary composer grammar', () => {
  const { exports } = loadBundle()
  assert.deepEqual(exports.activeAtToken('@', 1), { prefix: '@', query: '', quoted: false })
  assert.deepEqual(exports.activeAtToken('hello @li', 9), { prefix: '@li', query: 'li', quoted: false })
  assert.equal(exports.activeAtToken('mail foo@bar.com', 16), undefined, 'an @ inside an email is not a trigger')
  assert.deepEqual(exports.activeAtToken('a @"path with', 13), { prefix: '@"path with', query: 'path with', quoted: true })
  assert.equal(exports.activeAtToken('@a', 0), undefined)
  assert.equal(exports.activeAtToken('see @a rest', 11), undefined, 'a token must touch the caret')
  assert.equal(exports.activeAtToken('@"a b"', 7), undefined, 'a closed quote ends completion')
  assert.equal(exports.activeAtToken('', 0), undefined)
})

test('activeTokenAt reports the absolute replace range on the current line', () => {
  const { exports } = loadBundle()
  const text = 'first line\nsee @lib/a.js'
  const start = text.indexOf('@lib/a.js')
  assert.deepEqual(exports.activeTokenAt(text, text.length), {
    start,
    prefix: '@lib/a.js',
    query: 'lib/a.js',
    quoted: false
  })
  assert.deepEqual(exports.activeTokenAt('see @lib/a.js', 'see @li'.length), {
    start: 4,
    prefix: '@li',
    query: 'li',
    quoted: false
  })
  assert.equal(exports.activeTokenAt('plain text', 10), undefined)
  assert.equal(exports.activeTokenAt('', 0), undefined)
})

test('formatFileMention spells a pick like the primary composer', () => {
  const { exports } = loadBundle()
  assert.equal(exports.formatFileMention({ path: 'lib/a.js', kind: 'file' }, false), '@lib/a.js')
  assert.equal(exports.formatFileMention({ path: 'my notes.md', kind: 'file' }, false), '@"my notes.md"')
  assert.equal(exports.formatFileMention({ path: 'my notes.md', kind: 'file' }, true), '@"my notes.md"')
  assert.equal(exports.formatFileMention({ path: 'lib', kind: 'directory' }, false), '@lib/')
  assert.equal(exports.formatFileMention({ path: 'lib', kind: 'directory' }, true), '@"lib/')
  assert.equal(exports.formatFileMention({ path: 'my docs', kind: 'directory' }, false), '@"my docs/')
  assert.equal(exports.formatFileMention({ path: 'bad\u0001name', kind: 'file' }, false), undefined)
  assert.equal(exports.formatFileMention({ path: 'say "hi"', kind: 'file' }, false), undefined)
  assert.equal(exports.formatFileMention(null, false), undefined)
})

test('applyReferencePick replaces [token start, caret] and continues inside a directory', () => {
  const { exports } = loadBundle()
  const file = exports.applyReferencePick(
    'see @li rest',
    7,
    { start: 4, query: 'li', quoted: false },
    { path: 'lib/a.js', kind: 'file' },
    false
  )
  assert.deepEqual(file, { text: 'see @lib/a.js rest', caret: 13, kind: 'file', token: undefined })

  const directory = exports.applyReferencePick(
    '@do',
    3,
    { start: 0, query: 'do', quoted: false },
    { path: 'docs', kind: 'directory' },
    false
  )
  assert.deepEqual(directory, {
    text: '@docs/',
    caret: 6,
    kind: 'directory',
    token: { start: 0, prefix: '@docs/', query: 'docs/', quoted: false }
  })

  const quoted = exports.applyReferencePick(
    '@"my do',
    7,
    { start: 0, query: 'my do', quoted: true },
    { path: 'my docs', kind: 'directory' },
    true
  )
  assert.equal(quoted.text, '@"my docs/')
  assert.equal(quoted.caret, 10)
  assert.deepEqual(quoted.token, { start: 0, prefix: '@"my docs/', query: 'my docs/', quoted: true })

  assert.equal(exports.applyReferencePick('@ba', 3, { start: 0, query: 'ba' }, { path: 'bad\u0001', kind: 'file' }, false), null)
  assert.equal(exports.applyReferencePick('', 0, null, { path: 'a', kind: 'file' }, false), null)
})

test('splitReferenceText tokenizes committed references and trims trailing punctuation', () => {
  const { exports } = loadBundle()
  assert.deepEqual(exports.splitReferenceText('plain text'), [{ kind: 'text', text: 'plain text' }])
  assert.deepEqual(exports.splitReferenceText('ping @lib/a.js'), [
    { kind: 'text', text: 'ping ' },
    { kind: 'reference', referenceKind: 'file', path: 'lib/a.js', label: 'a.js' }
  ])
  assert.deepEqual(exports.splitReferenceText('open @lib/a.js, then'), [
    { kind: 'text', text: 'open ' },
    { kind: 'reference', referenceKind: 'file', path: 'lib/a.js', label: 'a.js' },
    { kind: 'text', text: ', then' }
  ])
  assert.deepEqual(exports.splitReferenceText('@docs/ then'), [
    { kind: 'reference', referenceKind: 'directory', path: 'docs/', label: 'docs' },
    { kind: 'text', text: ' then' }
  ])
  assert.deepEqual(exports.splitReferenceText('open @"my notes.md" now'), [
    { kind: 'text', text: 'open ' },
    { kind: 'reference', referenceKind: 'file', path: 'my notes.md', label: 'my notes.md' },
    { kind: 'text', text: ' now' }
  ])
  assert.deepEqual(exports.splitReferenceText('mail foo@bar.com'), [{ kind: 'text', text: 'mail foo@bar.com' }])
  assert.deepEqual(exports.splitReferenceText('per @a.js， then'), [
    { kind: 'text', text: 'per ' },
    { kind: 'reference', referenceKind: 'file', path: 'a.js', label: 'a.js' },
    { kind: 'text', text: '， then' }
  ])
  assert.deepEqual(exports.splitReferenceText('@a.js\n@b/'), [
    { kind: 'reference', referenceKind: 'file', path: 'a.js', label: 'a.js' },
    { kind: 'text', text: '\n' },
    { kind: 'reference', referenceKind: 'directory', path: 'b/', label: 'b' }
  ])
  assert.deepEqual(exports.splitReferenceText(''), [])
})

test('the reference menu state machine arbitrates pick, send and close', () => {
  const { exports } = loadBundle()
  assert.equal(exports.editorKeyAction({ key: 'Enter' }, { open: true, pickable: true }), 'pick')
  assert.equal(exports.editorKeyAction({ key: 'Enter' }, { open: true, pickable: false }), 'submit')
  assert.equal(exports.editorKeyAction({ key: 'Enter' }, { open: false }), 'submit')
  assert.equal(exports.editorKeyAction({ key: 'Enter', shiftKey: true }, { open: true, pickable: true }), 'newline')
  assert.equal(exports.editorKeyAction({ key: 'Enter', shiftKey: true }, { open: false }), 'newline')
  assert.equal(exports.editorKeyAction({ key: 'Enter', isComposing: true }, { open: true, pickable: true }), 'none', 'a composing Enter reaches nothing')
  assert.equal(exports.editorKeyAction({ key: 'Enter', keyCode: 229 }, { open: false }), 'none')
  assert.equal(exports.editorKeyAction({ key: 'Enter' }, { open: false, composing: true }), 'none')
  assert.equal(exports.editorKeyAction({ key: 'Tab' }, { open: true, pickable: true }), 'pick')
  assert.equal(exports.editorKeyAction({ key: 'Tab' }, { open: true, pickable: false }), 'none')
  assert.equal(exports.editorKeyAction({ key: 'Tab' }, { open: false }), 'none')
  assert.equal(exports.editorKeyAction({ key: 'Escape' }, { open: true, pickable: false }), 'close')
  assert.equal(exports.editorKeyAction({ key: 'Escape' }, { open: false }), 'none')
  assert.equal(exports.editorKeyAction({ key: 'ArrowDown' }, { open: true, pickable: true }), 'next')
  assert.equal(exports.editorKeyAction({ key: 'ArrowUp' }, { open: true, pickable: true }), 'prev')
  assert.equal(exports.editorKeyAction({ key: 'ArrowDown' }, { open: true, pickable: false }), 'none')
  assert.equal(exports.editorKeyAction({ key: 'ArrowDown' }, { open: false }), 'none')
  assert.equal(exports.editorKeyAction({ key: 'a' }, { open: true, pickable: true }), 'none')
  assert.equal(exports.editorKeyAction(null, { open: true, pickable: true }), 'none')

  assert.equal(exports.nextReferenceIndex(3, 2, 1), 0)
  assert.equal(exports.nextReferenceIndex(3, 0, -1), 2)
  assert.equal(exports.nextReferenceIndex(2, 0, 2), 0)
  assert.equal(exports.nextReferenceIndex(3, 1, 1), 2)
  assert.equal(exports.nextReferenceIndex(0, 0, 1), 0)

  assert.equal(exports.referenceMenuOpen({ status: 'ready', token: { start: 0 } }), true)
  assert.equal(exports.referenceMenuOpen({ status: 'loading', token: { start: 0 } }), true)
  assert.equal(exports.referenceMenuOpen({ status: 'empty', token: { start: 0 } }), true)
  assert.equal(exports.referenceMenuOpen({ status: 'closed', token: null }), false)
  assert.equal(exports.referenceMenuOpen({ status: 'unavailable', token: { start: 0 } }), false)
  assert.equal(exports.referenceMenuOpen(null), false)
})

test('referenceMenuOf renders a listbox whose mousedown pick keeps textarea focus', () => {
  const { exports } = loadBundle()
  const t = (key) => key
  const picked = []
  const menu = exports.referenceMenuOf(t, {
    status: 'ready',
    token: { start: 0, query: 'l', quoted: false },
    activeIndex: 1,
    candidates: [{ path: 'lib/a.js', kind: 'file' }, { path: 'lib', kind: 'directory' }]
  }, 'sc-ref-menu-main-1', (index) => picked.push(index))
  assert.equal(menu.props.className, 'sc-ref-menu')
  assert.equal(menu.props.id, 'sc-ref-menu-main-1')
  assert.equal(menu.props.role, 'listbox')
  assert.equal(menu.props['aria-label'], 'reference.menu')
  const rows = menu.children[0]
  assert.equal(rows.length, 3)
  assert.equal(rows[0].props.className, 'sc-ref-group')
  assert.equal(rows[0].props.role, 'presentation')
  assert.deepEqual(rows[0].children, ['reference.files'])
  assert.equal(rows[1].props.id, 'sc-ref-menu-main-1-option-0')
  assert.equal(rows[1].props.role, 'option')
  assert.equal(rows[1].props['aria-selected'], false)
  assert.equal(rows[1].props.onClick, undefined, 'rows have no click handler; mousedown keeps focus')
  assert.equal(rows[2].props.className, 'sc-ref-option sc-ref-option-active')
  assert.equal(rows[2].props['aria-selected'], true)
  assert.deepEqual(rows[1].children[1].children, ['a.js'])
  assert.deepEqual(rows[1].children[2].children, ['lib/'], 'a row shows the parent directory that tells same-named paths apart')
  assert.deepEqual(rows[2].children[1].children, ['lib/'])
  assert.equal(rows[2].children[2], null, 'a top-level row carries no parent hint')
  let prevented = 0
  rows[2].props.onMouseDown({ preventDefault: () => { prevented += 1 } })
  assert.equal(prevented, 1)
  assert.deepEqual(picked, [1])

  const loading = exports.referenceMenuOf(t, {
    status: 'loading',
    token: { start: 0 },
    candidates: [],
    activeIndex: 0
  }, 'm', null)
  assert.equal(loading.children[0][0].props.className, 'sc-ref-status')
  assert.deepEqual(loading.children[0][0].children, ['reference.loading'])
  const empty = exports.referenceMenuOf(t, {
    status: 'empty',
    token: { start: 0 },
    candidates: [],
    activeIndex: 0
  }, 'm', null)
  assert.deepEqual(empty.children[0][0].children, ['reference.empty'])
  assert.equal(exports.referenceMenuOf(t, { status: 'closed', token: null }, 'm', null), null)
})

test('composer typing debounces one reference lookup and only sends the latest query', async () => {
  const deferred = createDeferredReferenceStub()
  const { scheduler, runtime } = createRuntimeWith(deferred)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  runtime.composeDraft('main-1', '@a', 2)
  assert.equal(scheduler.pending(), 1, 'the lookup is debounced')
  runtime.composeDraft('main-1', '@ab', 3)
  runtime.composeDraft('main-1', '@abc', 4)
  assert.equal(scheduler.pending(), 1, 'each keystroke reschedules the one debounce timer')
  scheduler.runAll()
  await flush()
  assert.equal(deferred.referenceCalls().length, 1)
  assert.deepEqual(deferred.referenceCalls()[0].body, { query: 'abc', sourceId: 'main-1' })
  assert.equal(runtime.getState('main-1').draft, '@abc')
  assert.equal(runtime.getState('main-1').reference.status, 'loading')
  deferred.pending[0].resolve({ ok: true, candidates: [{ path: 'abc.txt', kind: 'file' }] })
  await flush()
  const reference = runtime.getState('main-1').reference
  assert.equal(reference.status, 'ready')
  assert.deepEqual(reference.candidates, [{ path: 'abc.txt', kind: 'file' }])
  assert.equal(reference.activeIndex, 0)
  await runtime.close('main-1')
})

test('a newer lookup aborts the in-flight one and a late answer is dropped', async () => {
  const deferred = createDeferredReferenceStub()
  const { scheduler, runtime } = createRuntimeWith(deferred)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  runtime.composeDraft('main-1', '@a', 2)
  scheduler.runAll()
  await flush()
  assert.equal(deferred.pending.length, 1)
  const first = deferred.pending[0]
  assert.equal(first.signal.aborted, false)
  runtime.composeDraft('main-1', '@ab', 3)
  assert.equal(first.signal.aborted, true, 'the superseded request is aborted immediately')
  scheduler.runAll()
  await flush()
  assert.equal(deferred.pending.length, 2)
  deferred.pending[1].resolve({ ok: true, candidates: [{ path: 'ab.txt', kind: 'file' }] })
  await flush()
  assert.deepEqual(runtime.getState('main-1').reference.candidates, [{ path: 'ab.txt', kind: 'file' }])
  deferred.pending[0].resolve({ ok: true, candidates: [{ path: 'stale.txt', kind: 'file' }] })
  await flush()
  assert.deepEqual(runtime.getState('main-1').reference.candidates, [{ path: 'ab.txt', kind: 'file' }], 'the stale answer is dropped')
  assert.equal(deferred.referenceCalls().length, 2)
  await runtime.close('main-1')
})

test('an unavailable provider hides the menu for that tab and stops querying', async () => {
  const fetchStub = createFetchStub({ references: { ok: false, code: 'unavailable', message: 'no provider' } })
  const { scheduler, runtime } = createRuntimeWith(fetchStub)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  runtime.composeDraft('main-1', '@a', 2)
  scheduler.runAll()
  await flush()
  const state = runtime.getState('main-1')
  assert.equal(state.reference.status, 'unavailable')
  assert.equal(state.reference.token, null)
  runtime.composeDraft('main-1', '@ab', 3)
  assert.equal(scheduler.pending(), 0, 'no further lookup is scheduled once unavailable')
  assert.equal(fetchStub.calls.filter((call) => call.url === `${API_PREFIX}references`).length, 1)
  await runtime.close('main-1')
})

test('a query longer than the host cap keeps the menu closed and sends nothing to the host', async () => {
  const fetchStub = createFetchStub({ references: { ok: true, candidates: [] } })
  const { scheduler, runtime } = createRuntimeWith(fetchStub)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  const long = `@${'a'.repeat(513)}`
  runtime.composeDraft('main-1', long, long.length)
  assert.equal(scheduler.pending(), 0, 'no lookup is scheduled for an over-long query')
  assert.equal(runtime.getState('main-1').reference.status, 'closed')
  assert.equal(fetchStub.calls.filter((call) => call.url === `${API_PREFIX}references`).length, 0)
  await runtime.close('main-1')
})

test('a rejected lookup closes the menu and keeps the draft', async () => {
  const fetchStub = createFetchStub({ references: { ok: false, code: 'unknown-source' } })
  const { scheduler, runtime } = createRuntimeWith(fetchStub)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  runtime.composeDraft('main-1', '@a', 2)
  scheduler.runAll()
  await flush()
  const state = runtime.getState('main-1')
  assert.equal(state.reference.status, 'closed')
  assert.equal(state.reference.token, null)
  assert.equal(state.draft, '@a')
  await runtime.close('main-1')
})

test('a pick inserts the primary spelling, writes back the caret and keeps a directory menu open', async () => {
  const fetchStub = createFetchStub({
    references: (body) => {
      if (body.query === 'li') return { ok: true, candidates: [{ path: 'lib/a.js', kind: 'file' }] }
      if (body.query === 'my') return { ok: true, candidates: [{ path: 'my notes.md', kind: 'file' }] }
      if (body.query === 'do') return { ok: true, candidates: [{ path: 'docs', kind: 'directory' }] }
      if (body.query === 'docs/') return { ok: true, candidates: [{ path: 'docs/guide.md', kind: 'file' }] }
      return { ok: true, candidates: [] }
    }
  })
  const { scheduler, runtime } = createRuntimeWith(fetchStub)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)

  runtime.composeDraft('main-1', 'see @li', 7)
  scheduler.runAll()
  await flush()
  runtime.pickReference('main-1', 0)
  let state = runtime.getState('main-1')
  assert.equal(state.draft, 'see @lib/a.js')
  assert.equal(state.composerCaret, 13)
  assert.equal(state.reference.status, 'closed')
  assert.equal(state.reference.caret, 13)
  assert.equal(state.reference.caretRequest, 1)

  runtime.composeDraft('main-1', '@"my', 4)
  scheduler.runAll()
  await flush()
  assert.equal(runtime.getState('main-1').reference.token.quoted, true)
  runtime.pickReference('main-1')
  state = runtime.getState('main-1')
  assert.equal(state.draft, '@"my notes.md"')
  assert.equal(state.composerCaret, 14)

  runtime.composeDraft('main-1', '@do', 3)
  scheduler.runAll()
  await flush()
  runtime.pickReference('main-1')
  state = runtime.getState('main-1')
  assert.equal(state.draft, '@docs/')
  assert.equal(state.composerCaret, 6)
  assert.deepEqual(state.reference.token, { start: 0, prefix: '@docs/', query: 'docs/', quoted: false })
  assert.equal(scheduler.pending(), 1, 'the directory continuation is scheduled immediately')
  scheduler.runAll()
  await flush()
  const referenceCalls = fetchStub.calls.filter((call) => call.url === `${API_PREFIX}references`)
  assert.deepEqual(referenceCalls[referenceCalls.length - 1].body, { query: 'docs/', sourceId: 'main-1' })
  assert.deepEqual(runtime.getState('main-1').reference.candidates, [{ path: 'docs/guide.md', kind: 'file' }])
  await runtime.close('main-1')
})

test('the reference lookup sends the parent sourceId until the side session exists', async () => {
  const fetchStub = createFetchStub({
    create: { ok: true, sessionId: 'side-1', inheritedEventCount: 0 },
    prompt: { ok: true },
    snapshot: { ok: true, inheritedEventCount: 0, running: false, status: 'idle', lastError: null, entries: [] },
    references: { ok: true, candidates: [{ path: 'lib/a.js', kind: 'file' }] }
  })
  const { scheduler, runtime } = createRuntimeWith(fetchStub)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  runtime.composeDraft('main-1', '@li', 3)
  scheduler.runAll()
  await flush()
  const referenceCalls = () => fetchStub.calls.filter((call) => call.url === `${API_PREFIX}references`)
  assert.deepEqual(referenceCalls()[0].body, { query: 'li', sourceId: 'main-1' })

  await runtime.send('main-1', 'read @lib/a.js')
  runtime.composeDraft('main-1', '@li', 3)
  scheduler.runAll()
  await flush()
  assert.equal(referenceCalls().length, 2)
  assert.deepEqual(referenceCalls()[1].body, { query: 'li', sessionId: 'side-1' })
  await runtime.close('main-1')
})

test('two tabs keep independent reference menus and their own identity', async () => {
  const deferred = createDeferredReferenceStub()
  const { scheduler, runtime } = createRuntimeWith(deferred)
  runtime.open('tab-1', 'main-1')
  runtime.open('tab-2', 'main-2')
  runtime.setVisible('tab-1', true)
  runtime.setVisible('tab-2', true)
  runtime.composeDraft('tab-1', '@a', 2)
  runtime.composeDraft('tab-2', '@b', 2)
  scheduler.runAll()
  await flush()
  assert.equal(deferred.pending.length, 2)
  assert.deepEqual(deferred.pending[0].body, { query: 'a', sourceId: 'main-1' })
  assert.deepEqual(deferred.pending[1].body, { query: 'b', sourceId: 'main-2' })
  deferred.pending[0].resolve({ ok: false, code: 'unavailable' })
  deferred.pending[1].resolve({ ok: true, candidates: [{ path: 'b.txt', kind: 'file' }] })
  await flush()
  assert.equal(runtime.getState('tab-1').reference.status, 'unavailable')
  assert.equal(runtime.getState('tab-2').reference.status, 'ready')
  assert.deepEqual(runtime.getState('tab-2').reference.candidates, [{ path: 'b.txt', kind: 'file' }])
  runtime.composeDraft('tab-2', '@b2', 3)
  assert.equal(scheduler.pending(), 1, 'only the healthy tab keeps querying')
  await runtime.close('tab-1')
  await runtime.close('tab-2')
})

test('hiding a tab aborts the in-flight lookup and closing drops the pending debounce', async () => {
  const deferred = createDeferredReferenceStub()
  const { scheduler, runtime } = createRuntimeWith(deferred)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  runtime.composeDraft('main-1', '@a', 2)
  scheduler.runAll()
  await flush()
  assert.equal(deferred.pending.length, 1)
  runtime.setVisible('main-1', false)
  assert.equal(deferred.pending[0].signal.aborted, true)
  deferred.pending[0].resolve({ ok: true, candidates: [{ path: 'a.txt', kind: 'file' }] })
  await flush()
  assert.equal(runtime.getState('main-1').reference.status, 'closed')
  assert.deepEqual(runtime.getState('main-1').reference.candidates, [])

  runtime.setVisible('main-1', true)
  runtime.composeDraft('main-1', '@b', 2)
  assert.equal(scheduler.pending(), 1)
  await runtime.close('main-1')
  assert.equal(scheduler.pending(), 0)
  scheduler.runAll()
  await flush()
  assert.equal(deferred.referenceCalls().length, 1, 'a closed tab never sends the debounced lookup')
})

test('an IME composition neither queries nor sends and closes the menu', async () => {
  const fetchStub = createFetchStub({ references: { ok: true, candidates: [{ path: 'a.txt', kind: 'file' }] } })
  const { scheduler, runtime } = createRuntimeWith(fetchStub)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  runtime.composeDraft('main-1', '@a', 2)
  scheduler.runAll()
  await flush()
  assert.equal(runtime.getState('main-1').reference.status, 'ready')

  runtime.setComposing('main-1', true)
  assert.equal(runtime.getState('main-1').reference.composing, true)
  assert.equal(runtime.getState('main-1').reference.status, 'closed', 'composing closes the open menu')
  runtime.composeDraft('main-1', '@中', 2)
  assert.equal(scheduler.pending(), 0, 'no lookup is scheduled while composing')
  assert.equal(fetchStub.calls.filter((call) => call.url === `${API_PREFIX}references`).length, 1)

  runtime.setComposing('main-1', false)
  runtime.composeDraft('main-1', '@中文', 3)
  assert.equal(scheduler.pending(), 1)
  scheduler.runAll()
  await flush()
  assert.equal(fetchStub.calls.filter((call) => call.url === `${API_PREFIX}references`).length, 2)
  await runtime.close('main-1')
})

test('setDraft stays a plain draft writer without scheduling a lookup', () => {
  const fetchStub = createFetchStub({})
  const { scheduler, runtime } = createRuntimeWith(fetchStub)
  runtime.open('main-1')
  runtime.setDraft('main-1', 'see @li')
  assert.equal(runtime.getState('main-1').draft, 'see @li')
  assert.equal(scheduler.pending(), 0)
  assert.equal(fetchStub.calls.length, 0)
  assert.equal(runtime.getState('main-1').reference.status, 'closed')
})

test('the panel renders the menu above the textarea and routes keys without submitting', () => {
  const { bodyRegistration } = panelRenderer()
  const calls = []
  const reference = {
    status: 'ready',
    candidates: [{ path: 'lib/a.js', kind: 'file' }, { path: 'lib', kind: 'directory' }],
    activeIndex: 0,
    token: { start: 4, query: 'li', quoted: false },
    composing: false,
    requestId: 1,
    controller: null,
    timer: null,
    caret: 0,
    caretRequest: 0
  }
  const state = panelState({ draft: 'see @li', reference })
  const runtime = panelRuntime(state, calls)
  const props = bodyRegistration.options.inject('session-1')
  const bodyElement = bodyRegistration.component({
    runtime,
    sessionId: 'main-1',
    t: props.t,
    useTabInfo: () => ({ tab: { visible: true } })
  })
  const tree = bodyElement.type(bodyElement.props)
  const composer = composerOf(tree)
  assert.ok(composer !== undefined, 'the composer renders')
  assert.equal(composer.children[0].props.className, 'sc-ref-menu', 'the menu renders above the textarea')
  assert.equal(composer.children[0].props.role, 'listbox')
  assert.equal(composer.children[0].props['aria-label'], '引用')
  const textarea = composer.children[1]
  assert.equal(textarea.props.className, 'sc-textarea')
  assert.equal(textarea.props['aria-expanded'], true)
  assert.equal(textarea.props['aria-controls'], 'sc-ref-menu-main-1')
  assert.equal(textarea.props['aria-activedescendant'], 'sc-ref-menu-main-1-option-0')

  textarea.props.onChange({ target: { value: 'see @lib', selectionStart: 8 } })
  assert.deepEqual(calls[calls.length - 1], ['composeDraft', 'see @lib', 8])

  textarea.props.onCompositionStart()
  assert.deepEqual(calls[calls.length - 1], ['composing', true])
  textarea.props.onCompositionEnd({ target: { value: 'see @lib', selectionStart: 8 } })
  assert.deepEqual(calls.slice(-2), [['composing', false], ['composeDraft', 'see @lib', 8]], 'the committed composition re-evaluates the token')

  textarea.props.onBlur()
  assert.deepEqual(calls[calls.length - 1], ['close'], 'blurring the composer closes the menu')

  textarea.props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
  assert.deepEqual(calls[calls.length - 1], ['pick', 0], 'Enter picks instead of sending while the menu is open')
  textarea.props.onKeyDown({ key: 'ArrowDown', preventDefault: () => {} })
  assert.deepEqual(calls[calls.length - 1], ['move', 1])
  textarea.props.onKeyDown({ key: 'Escape', preventDefault: () => {} })
  assert.deepEqual(calls[calls.length - 1], ['close'])
  textarea.props.onKeyDown({ key: 'Enter', shiftKey: true, preventDefault: () => {} })
  assert.notEqual(calls[calls.length - 1][0], 'send', 'Shift+Enter keeps a newline')

  reference.status = 'empty'
  reference.candidates = []
  const emptyComposer = composerOf(bodyElement.type(bodyElement.props))
  const emptyTextarea = emptyComposer.children[1]
  emptyTextarea.props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
  assert.deepEqual(calls.slice(-2), [['close'], ['send']], 'Enter with no candidate closes the menu and submits')
  reference.status = 'ready'
  reference.candidates = [{ path: 'lib/a.js', kind: 'file' }, { path: 'lib', kind: 'directory' }]

  reference.status = 'closed'
  reference.token = null
  const closedComposer = composerOf(bodyElement.type(bodyElement.props))
  assert.equal(closedComposer.children[0], null, 'no menu once the token is gone')
  const closedTextarea = closedComposer.children[1]
  assert.equal(closedTextarea.props['aria-expanded'], false)
  assert.equal(closedTextarea.props['aria-controls'], undefined)
  closedTextarea.props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
  assert.deepEqual(calls[calls.length - 1], ['send'], 'Enter without a menu submits')

  reference.status = 'unavailable'
  const unavailableComposer = composerOf(bodyElement.type(bodyElement.props))
  assert.equal(unavailableComposer.children[0], null, 'the menu hides once the provider is unavailable')
})

test('the composer grows with its draft up to the primary cap and half the panel', () => {
  const { exports } = loadBundle()
  assert.equal(exports.composerHeightLimit({ clientHeight: 900 }), 336, 'a tall panel allows the primary 14-line cap')
  assert.equal(exports.composerHeightLimit({ clientHeight: 400 }), 200, 'a short panel cannot give the draft more than half of itself')
  assert.equal(exports.composerHeightLimit({ clientHeight: 40 }), 26, 'the cap never undercuts the one-line floor')
  assert.equal(exports.composerHeightLimit(null), 336, 'an unmeasured panel keeps the primary cap')

  const growing = { style: {}, scrollHeight: 115 }
  assert.equal(exports.fitComposerHeight(growing, { clientHeight: 900 }), 115, 'the box follows a five-line draft')
  assert.equal(growing.style.height, '115px')
  assert.equal(growing.style.overflowY, 'hidden', 'a draft under the cap shows no inner scrollbar')

  const capped = { style: {}, scrollHeight: 900 }
  assert.equal(exports.fitComposerHeight(capped, { clientHeight: 900 }), 336, 'a long draft stops at the cap')
  assert.equal(capped.style.height, '336px')
  assert.equal(capped.style.overflowY, 'auto', 'past the cap the box owns the scroll')

  const shrunk = { style: { height: '336px', overflowY: 'auto' }, scrollHeight: 46 }
  assert.equal(exports.fitComposerHeight(shrunk, { clientHeight: 900 }), 46, 'clearing lines reclaims the height')
  assert.equal(shrunk.style.overflowY, 'hidden')

  const empty = { style: {}, scrollHeight: 18 }
  assert.equal(exports.fitComposerHeight(empty, null), 26, 'the empty draft keeps the one-line floor')
  const hidden = { style: {}, scrollHeight: 0 }
  assert.equal(exports.fitComposerHeight(hidden, null), null, 'a hidden box keeps its stylesheet height and scroll')
  assert.equal(hidden.style.overflowY, undefined, 'a hidden box is not forced to hide its scroll')
  assert.equal(exports.fitComposerHeight({}, null), null, 'an element without layout metrics is left alone')
  assert.equal(exports.fitComposerHeight(null, null), null)
})

test('the panel hands the script the textarea and the root that bounds it', () => {
  const { bodyRegistration, props } = panelRenderer()
  const tree = renderPanel(bodyRegistration, props, panelState({ draft: 'a\nb\nc' }))
  const root = findElement(tree, (element) => element.props !== undefined && element.props.className === 'sc-root')
  const textarea = findElement(tree, (element) => element.props !== undefined && element.props.className === 'sc-textarea')
  assert.ok(root.props.ref !== undefined && root.props.ref !== null, 'the root exposes its own box for the cap')
  assert.ok(textarea.props.ref !== undefined && textarea.props.ref !== null, 'the textarea exposes its box for the fit')
  assert.notEqual(root.props.ref, textarea.props.ref, 'the two measurements stay distinct')
})

test('the draft height is script-owned, not pinned by the stylesheet', () => {
  const { exports } = loadBundle()
  const rule = exports.PANEL_CSS.match(/\.sc-textarea \{[^}]*\}/)
  assert.ok(rule !== null, 'the textarea rule ships')
  assert.ok(!/field-sizing/.test(exports.PANEL_CSS), 'no second height owner competes with the fit')
  assert.ok(!/max-height/.test(rule[0]), 'the stylesheet must not cap the box the script sizes')
})

test('committed user bubbles render file and folder references as inert chips', () => {
  const { bodyRegistration } = panelRenderer()
  const state = panelState({
    nodes: [{
      kind: 'user',
      seq: 1,
      time: 1700000001000,
      text: 'see @lib/a.js, @docs/ and @"my notes.md" then'
    }]
  })
  const tree = renderPanel(bodyRegistration, bodyRegistration.options.inject('session-1'), state)
  const body = findElement(tree, (element) => element.props !== undefined && element.props.className === 'sc-body')
  const userRow = body.children[0][0]
  assert.equal(typeof userRow.type, 'function')
  const bubble = findElement(userRow.type(userRow.props), (element) => element.props !== undefined && element.props.className === 'sc-bubble')
  assert.ok(bubble !== undefined, 'the user bubble renders')
  const chips = []
  collectElements(bubble, (element) => {
    if (element.props !== undefined && typeof element.props.className === 'string' && element.props.className.startsWith('sc-ref-chip')) {
      chips.push(element)
    }
  })
  assert.equal(chips.length, 3)
  assert.deepEqual(chips.map((chip) => chip.children), [['a.js'], ['docs'], ['my notes.md']])
  assert.deepEqual(chips.map((chip) => chip.props.className), [
    'sc-ref-chip',
    'sc-ref-chip sc-ref-chip-dir',
    'sc-ref-chip'
  ])
  assert.deepEqual(chips.map((chip) => chip.props.title), ['lib/a.js', 'docs/', 'my notes.md'])
  for (const chip of chips) {
    assert.equal(chip.props.onClick, undefined, 'a chip carries no click action')
    assert.equal(chip.props.dangerouslySetInnerHTML, undefined, 'a chip never injects HTML')
  }
  const content = bubble.children[0]
  assert.deepEqual(content.filter((part) => typeof part === 'string'), ['see ', ', ', ' and ', ' then'])
})

test('reference copy is localized and the panel stylesheet ships the menu and chip styles', () => {
  const { exports } = loadBundle()
  for (const key of ['reference.menu', 'reference.files', 'reference.sessions', 'reference.loading', 'reference.empty', 'reference.noCwd', 'reference.timeNow', 'reference.timeMinutes', 'reference.timeHours', 'reference.timeDays', 'reference.timeMonths', 'reference.timeYears']) {
    assert.equal(typeof exports.ZH_DICT[key], 'string')
    assert.equal(typeof exports.EN_DICT[key], 'string')
    assert.notEqual(exports.ZH_DICT[key].trim(), '')
    assert.notEqual(exports.EN_DICT[key].trim(), '')
  }
  assert.equal(exports.REFERENCE_DEBOUNCE_MS, 120)
  for (const selector of ['.sc-ref-menu', '.sc-ref-option', '.sc-ref-group', '.sc-ref-status', '.sc-ref-chip', '.sc-ref-chip-dir', '.sc-ref-chip-session']) {
    assert.ok(exports.PANEL_CSS.includes(selector), `${selector} must ship in the panel stylesheet`)
  }
  const { registered, locale } = applyBundle(exports)
  const t = registered[0].options.inject('session-1').t
  assert.equal(t('reference.loading'), '正在搜索…')
  assert.equal(t('reference.empty'), '没有匹配的引用')
  locale.setLocale('en')
  assert.equal(t('reference.loading'), 'Searching…')
  assert.equal(t('reference.empty'), 'No matching references')
})

/* ------------------------------------------------------------------ *
 * P1a-2 `@session` references
 * ------------------------------------------------------------------ */

function sessionMention(sessionId, label) {
  return `@[${label}](dsh-session:${Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')})`
}

test('referenceCandidatesOf accepts canonical session rows and rejects malformed ones', () => {
  const { exports } = loadBundle()
  const mention = sessionMention('session-1', 'Fix login')
  assert.deepEqual(exports.referenceCandidatesOf([
    { path: 'a.js', kind: 'file' },
    { kind: 'session', label: 'Fix login', mention, location: '/other', createdAt: 42 },
    { kind: 'session', label: 'No mention', mention: '@[x](dsh-session:!!)' },
    { kind: 'session', label: '', mention },
    { kind: 'session', label: 'Bad', mention: 'text' },
    null,
  ]), [
    { path: 'a.js', kind: 'file' },
    { kind: 'session', label: 'Fix login', mention, location: '/other', createdAt: 42 },
  ])
  assert.deepEqual(exports.referenceCandidatesOf([
    { kind: 'session', label: 'No cwd', mention, location: null },
    { kind: 'session', label: 'No age', mention },
  ]), [
    { kind: 'session', label: 'No cwd', mention, location: null },
    { kind: 'session', label: 'No age', mention },
  ])
})

test('referenceMenuOf groups files and sessions and describes a session row', () => {
  const { exports } = loadBundle()
  const mention = sessionMention('session-1', 'Fix login')
  const now = 1_000_000_000_000
  const t = (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`)
  const menu = exports.referenceMenuOf(t, {
    status: 'ready',
    token: { start: 0, query: '', quoted: false },
    activeIndex: 1,
    candidates: [
      { path: 'lib/a.js', kind: 'file' },
      { kind: 'session', label: 'Fix login', mention, location: '~/other', createdAt: now - 5 * 60_000 }
    ]
  }, 'm', null, now)
  const rows = menu.children[0]
  assert.equal(rows.length, 4)
  assert.equal(rows[0].props.className, 'sc-ref-group')
  assert.equal(rows[0].props.role, 'presentation')
  assert.deepEqual(rows[0].children, ['reference.files'])
  assert.deepEqual(rows[2].children, ['reference.sessions'])
  assert.equal(rows[3].props['aria-selected'], true)
  assert.equal(rows[3].props.title, 'Fix login')
  assert.deepEqual(rows[3].children[0].children, ['◉'])
  assert.deepEqual(rows[3].children[1].children, ['Fix login'])
  assert.deepEqual(rows[3].children[2].children, ['~/other · reference.timeMinutes:{"n":5}'])
})

test('relativeReferenceAge mirrors the primary buckets and referenceDescriptionOf joins them', () => {
  const { exports } = loadBundle()
  const now = 1_000_000_000_000
  const t = (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`)
  assert.equal(exports.relativeReferenceAge(now, now, t), 'reference.timeNow')
  assert.equal(exports.relativeReferenceAge(now - 5 * 60_000, now, t), 'reference.timeMinutes:{"n":5}')
  assert.equal(exports.relativeReferenceAge(now - 3 * 3_600_000, now, t), 'reference.timeHours:{"n":3}')
  assert.equal(exports.relativeReferenceAge(now - 2 * 86_400_000, now, t), 'reference.timeDays:{"n":2}')
  assert.equal(exports.relativeReferenceAge(now - 40 * 86_400_000, now, t), 'reference.timeMonths:{"n":1}')
  assert.equal(exports.relativeReferenceAge(now - 400 * 86_400_000, now, t), 'reference.timeYears:{"n":1}')
  assert.equal(exports.referenceDescriptionOf({ kind: 'session', createdAt: now - 60_000 }, t, now), 'reference.timeMinutes:{"n":1}')
  assert.equal(exports.referenceDescriptionOf({ kind: 'session', location: null }, t, now), 'reference.noCwd')
  assert.equal(exports.referenceDescriptionOf({ kind: 'session', location: '~/x', createdAt: now }, t, now), '~/x · reference.timeNow')
  assert.equal(exports.referenceDescriptionOf({ path: 'lib/a.js', kind: 'file' }, t, now), 'lib/')
})

test('session tokens stay readable in the draft and expand to canonical mentions on send', () => {
  const { exports } = loadBundle()
  const m1 = sessionMention('session-1', 'A')
  const m2 = sessionMention('session-2', 'A')
  assert.equal(exports.formatSessionReferenceToken('A]B'), '@[A\\]B]')
  assert.equal(exports.formatSessionReferenceToken('  '), undefined)
  assert.equal(exports.formatSessionReferenceToken(''), undefined)
  assert.equal(exports.expandSessionReferences('x @[A] y', [{ token: '@[A]', mention: m1 }]), `x ${m1} y`)
  assert.equal(
    exports.expandSessionReferences('@[A] and @[A]', [{ token: '@[A]', mention: m1 }, { token: '@[A]', mention: m2 }]),
    `${m1} and ${m2}`
  )
  assert.equal(exports.expandSessionReferences('none', [{ token: '@[A]', mention: m1 }]), 'none')
  assert.equal(exports.expandSessionReferences('@[A]', [{ token: '@[A]', mention: 'not-a-mention' }]), '@[A]')
  assert.equal(exports.expandSessionReferences('@[A]', []), '@[A]')
})

test('activeAtToken treats a completed picked session token as inert', () => {
  const { exports } = loadBundle()
  const mention = sessionMention('session-1', 'Fix login')
  assert.equal(exports.activeAtToken('see @[Fix login]', 16), undefined)
  assert.equal(exports.activeAtToken('see @[Fix]x', 12), undefined)
  assert.equal(exports.activeAtToken('see @[Fix', 10), undefined, 'editing inside a picked token opens no path menu')
  assert.equal(exports.activeAtToken(`see ${mention}`, 4 + mention.length), undefined)
  assert.deepEqual(exports.activeAtToken('see @li', 7), { prefix: '@li', query: 'li', quoted: false })
})

test('splitReferenceText recognizes canonical session mentions with escaped labels', () => {
  const { exports } = loadBundle()
  const mention = sessionMention('session-1', 'Fix login')
  const escaped = sessionMention('session-1', 'a\\]b')
  assert.deepEqual(exports.splitReferenceText(`see ${mention} and @lib/a.js`), [
    { kind: 'text', text: 'see ' },
    { kind: 'reference', referenceKind: 'session', label: 'Fix login', mention },
    { kind: 'text', text: ' and ' },
    { kind: 'reference', referenceKind: 'file', path: 'lib/a.js', label: 'a.js' }
  ])
  assert.deepEqual(exports.splitReferenceText(escaped), [
    { kind: 'reference', referenceKind: 'session', label: 'a]b', mention: escaped }
  ])
  assert.deepEqual(exports.splitReferenceText('@[x](dsh-session:!!)'), [
    { kind: 'text', text: '@[x](dsh-session:!!)' }
  ], 'a malformed session mention is text, never a file chip')
  assert.deepEqual(exports.splitReferenceText('@[Fix login]'), [
    { kind: 'text', text: '@[Fix login]' }
  ], 'an unexpanded readable token stays text')
})

test('referenceNodes renders a session chip with the mention as its title', () => {
  const { exports } = loadBundle()
  const mention = sessionMention('session-1', 'Fix login')
  const nodes = exports.referenceNodes(`see ${mention}`)
  assert.equal(nodes[0], 'see ')
  assert.equal(nodes[1].props.className, 'sc-ref-chip sc-ref-chip-session')
  assert.equal(nodes[1].props.title, mention)
  assert.deepEqual(nodes[1].children, ['Fix login'])
})

test('a session pick records the canonical mention and send expands it', async () => {
  const mention = sessionMention('session-1', 'Fix login')
  const fetchStub = createFetchStub({
    create: { ok: true, sessionId: 'side-1', inheritedEventCount: 0 },
    prompt: { ok: true },
    snapshot: { ok: true, inheritedEventCount: 0, running: false, status: 'idle', lastError: null, entries: [] },
    references: { ok: true, candidates: [{ kind: 'session', label: 'Fix login', mention, createdAt: 10 }] }
  })
  const { scheduler, runtime } = createRuntimeWith(fetchStub)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  runtime.composeDraft('main-1', 'see @Fix', 8)
  scheduler.runAll()
  await flush()
  runtime.pickReference('main-1', 0)
  let state = runtime.getState('main-1')
  assert.equal(state.draft, 'see @[Fix login]')
  assert.equal(state.composerCaret, 16)
  assert.deepEqual(state.sessionRefs, [{ token: '@[Fix login]', mention }])
  assert.equal(state.reference.status, 'closed')

  await runtime.send('main-1')
  const promptCalls = fetchStub.calls.filter((call) => call.url === `${API_PREFIX}prompt`)
  assert.equal(promptCalls.length, 1)
  assert.equal(promptCalls[0].body.text, `see ${mention}`)
  state = runtime.getState('main-1')
  assert.deepEqual(state.sessionRefs, [])
  await runtime.close('main-1')
})

test('a failed send keeps the readable draft and the recorded session references', async () => {
  const mention = sessionMention('session-1', 'Fix login')
  const fetchStub = createFetchStub({
    create: { ok: true, sessionId: 'side-1', inheritedEventCount: 0 },
    prompt: { ok: false, code: 'prompt-failed', message: 'nope' },
    references: { ok: true, candidates: [{ kind: 'session', label: 'Fix login', mention, createdAt: 10 }] }
  })
  const { scheduler, runtime } = createRuntimeWith(fetchStub)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  runtime.composeDraft('main-1', 'see @Fix', 8)
  scheduler.runAll()
  await flush()
  runtime.pickReference('main-1', 0)
  await runtime.send('main-1')
  const state = runtime.getState('main-1')
  assert.equal(state.draft, 'see @[Fix login]')
  assert.deepEqual(state.sessionRefs, [{ token: '@[Fix login]', mention }])
  assert.equal(state.error.code, 'prompt-failed')
  await runtime.close('main-1')
})

test('a quoted reference lookup asks the host to skip sessions', async () => {
  const fetchStub = createFetchStub({ references: { ok: true, candidates: [] } })
  const { scheduler, runtime } = createRuntimeWith(fetchStub)
  runtime.open('main-1')
  runtime.setVisible('main-1', true)
  runtime.composeDraft('main-1', '@"li', 4)
  scheduler.runAll()
  await flush()
  const call = fetchStub.calls.filter((entry) => entry.url === `${API_PREFIX}references`).at(-1)
  assert.deepEqual(call.body, { query: 'li', quoted: true, sourceId: 'main-1' })
  await runtime.close('main-1')
})

/* ------------------------------------------------------------------ *
 * Image input (P1b-1)
 * ------------------------------------------------------------------ */

function makeImageFile(name = 'shot.png', type = 'image/png') {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])], name, { type })
}

const IMAGE_ID = `sha256:${'a'.repeat(64)}`
const IMAGE_REF = { attachmentId: IMAGE_ID, mediaType: 'image/png', width: 2, height: 2, bytes: 8 }

/**
 * Fetch stub that answers the binary upload route plus the JSON routes; image
 * responses are switchable so tests can fail an upload and retry it.
 */
function imageFetchStub(handlers = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const path = url.startsWith(API_PREFIX) ? url.slice(API_PREFIX.length) : url
    const name = path.split('?')[0]
    if (name === 'attachment') {
      calls.push({ name, url, init })
      const answer = typeof handlers.attachment === 'function' ? handlers.attachment(init) : handlers.attachment
      const payload = answer === undefined ? { ok: true, attachment: { ...IMAGE_REF } } : answer
      return { ok: true, status: 200, json: async () => payload }
    }
    const body = init === undefined || init.body === undefined ? {} : JSON.parse(init.body)
    calls.push({ name, url, body, init })
    const handler = handlers[name]
    const payload = typeof handler === 'function' ? handler(body) : handler === undefined ? { ok: true } : handler
    return { ok: true, status: 200, json: async () => payload }
  }
  return { fetchImpl, calls }
}

test('image helpers normalize references, build the read URL and read image files', () => {
  const { exports } = loadBundle()
  assert.deepEqual(exports.imageRefOf(IMAGE_REF), IMAGE_REF)
  assert.deepEqual(exports.imageRefOf({ ...IMAGE_REF, name: ' shot.png ' }), { ...IMAGE_REF, name: 'shot.png' })
  assert.equal(exports.imageRefOf({ ...IMAGE_REF, attachmentId: 'sha256:abc' }), undefined)
  assert.equal(exports.imageRefOf({ ...IMAGE_REF, width: 0 }), undefined)
  assert.deepEqual(exports.imageRefsOfContent([
    { type: 'text', text: 'hi' },
    { type: 'image', attachment: IMAGE_REF },
    { type: 'image', attachment: { attachmentId: 'bad' } }
  ]), [IMAGE_REF])
  const expectedUrl = `${API_PREFIX}image?sessionId=side-1&attachmentId=${encodeURIComponent(IMAGE_ID)}&mediaType=image%2Fpng&width=2&height=2&bytes=8`
  assert.equal(exports.imageUrlOf('side-1', IMAGE_REF), expectedUrl)
  assert.equal(exports.isImageMediaType('image/png'), true)
  assert.equal(exports.isImageMediaType('text/plain'), false)
  assert.equal(exports.imageReasonKey('TOO_MANY_IMAGES'), 'image.reason.TOO_MANY_IMAGES')
  assert.equal(exports.imageReasonKey('SOMETHING_ELSE'), 'image.reason.unknown')

  const png = makeImageFile()
  const txt = new File(['hello'], 'notes.txt', { type: 'text/plain' })
  assert.deepEqual(exports.imageFilesOf({ files: [png, txt] }), [png])
  assert.deepEqual(exports.imageFilesOf({ items: [{ kind: 'file', getAsFile: () => png }, { kind: 'string' }] }), [png])
  assert.deepEqual(exports.imageFilesOf({ files: [txt] }), [])
  assert.deepEqual(exports.imageFilesOf(null), [])
})

test('foldEntries carries committed images and keeps image-only user messages', () => {
  const { exports } = loadBundle()
  const events = [
    {
      seq: 1,
      type: 'user/message',
      time: 1,
      surfaceOp: 'append',
      data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'image', attachment: IMAGE_REF }] }
    },
    {
      seq: 2,
      type: 'user/message',
      time: 2,
      surfaceOp: 'append',
      data: { id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: IMAGE_REF }] }
    }
  ]
  const nodes = exports.foldEntries(events, 0)
  assert.equal(nodes.length, 2)
  assert.deepEqual(nodes[0], { kind: 'user', seq: 1, time: 1, text: '', images: [IMAGE_REF] })
  assert.deepEqual(nodes[1].images, [IMAGE_REF])
  assert.equal(nodes[1].text, 'look')
})

test('the composer uploads an added image and sends its reference with an empty text', async () => {
  const stub = imageFetchStub({ create: { ok: true, sessionId: 'side-1', inheritedEventCount: 0 } })
  const { runtime, scheduler } = createRuntimeWith(stub)
  runtime.open('main-1')
  runtime.addImages('main-1', [makeImageFile()])
  await flush()
  const afterUpload = runtime.getState('main-1')
  assert.equal(afterUpload.images.length, 1)
  assert.equal(afterUpload.images[0].status, 'ready')
  assert.deepEqual(afterUpload.images[0].ref, IMAGE_REF)
  const upload = stub.calls.find((call) => call.name === 'attachment')
  assert.match(upload.url, /sourceId=main-1/)
  assert.match(upload.url, /mime=image%2Fpng/)
  assert.match(upload.url, /name=shot.png/)
  assert.equal(upload.init.method, 'POST')

  await runtime.send('main-1', '')
  const prompt = stub.calls.find((call) => call.name === 'prompt')
  assert.ok(prompt !== undefined, 'an image-only message is sent')
  assert.deepEqual(prompt.body, { sessionId: 'side-1', text: '', attachments: [IMAGE_ID] })
  const afterSend = runtime.getState('main-1')
  assert.equal(afterSend.images.length, 0, 'sent images leave the rail')
  assert.equal(afterSend.pending.length, 1)
  assert.deepEqual(afterSend.pending[0].images.map((image) => image.attachmentId), [IMAGE_ID])
  scheduler.runAll()
})

test('a removed image never reaches the prompt and an empty send is still refused', async () => {
  const stub = imageFetchStub()
  const { runtime } = createRuntimeWith(stub)
  runtime.open('main-1')
  runtime.addImages('main-1', [makeImageFile()])
  await flush()
  const key = runtime.getState('main-1').images[0].key
  runtime.removeImage('main-1', key)
  assert.equal(runtime.getState('main-1').images.length, 0)
  await runtime.send('main-1', '   ')
  assert.equal(stub.calls.filter((call) => call.name === 'prompt').length, 0, 'no text and no image sends nothing')
})

test('a failed upload reports its reason and can be retried', async () => {
  const handlers = {
    create: { ok: true, sessionId: 'side-1', inheritedEventCount: 0 },
    attachment: { ok: false, code: 'attachment-rejected', reason: 'IMAGE_TOO_LARGE', message: 'too large' }
  }
  const stub = imageFetchStub(handlers)
  const { runtime } = createRuntimeWith(stub)
  runtime.open('main-1')
  runtime.addImages('main-1', [makeImageFile()])
  await flush()
  const failed = runtime.getState('main-1').images[0]
  assert.equal(failed.status, 'error')
  assert.equal(failed.error.reason, 'IMAGE_TOO_LARGE')
  await runtime.send('main-1', 'text only')
  assert.equal(stub.calls.filter((call) => call.name === 'prompt').length, 1, 'failed images do not block a text send')
  assert.equal(runtime.getState('main-1').images.length, 1, 'the failed image stays in the rail')
  assert.equal(runtime.getState('main-1').pending[0].images.length, 0)

  handlers.attachment = { ok: true, attachment: { ...IMAGE_REF } }
  runtime.retryImage('main-1', failed.key)
  await flush()
  assert.equal(runtime.getState('main-1').images[0].status, 'ready')
})

test('a refused send keeps its draft and restores the rail images', async () => {
  const stub = imageFetchStub({
    create: { ok: true, sessionId: 'side-1', inheritedEventCount: 0 },
    prompt: { ok: false, code: 'attachment-rejected', reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES', message: 'model refuses images' }
  })
  const { runtime } = createRuntimeWith(stub)
  runtime.open('main-1')
  runtime.addImages('main-1', [makeImageFile()])
  await flush()
  await runtime.send('main-1', 'explain')
  const state = runtime.getState('main-1')
  assert.equal(state.pending.length, 0)
  assert.equal(state.images.length, 1, 'the image returns to the rail for a retry')
  assert.equal(state.draft, 'explain')
  assert.equal(state.error.code, 'attachment-rejected')
  assert.equal(state.error.reason, 'MODEL_DOES_NOT_SUPPORT_IMAGES')
})

test('the committed echo retires a pending row only when its image ids match', async () => {
  const snapshot = { ok: true, inheritedEventCount: 0, running: false, status: 'idle', lastError: null, entries: [], live: null }
  const stub = imageFetchStub({
    create: { ok: true, sessionId: 'side-1', inheritedEventCount: 0 },
    snapshot
  })
  const { runtime } = createRuntimeWith(stub)
  runtime.open('main-1')
  runtime.addImages('main-1', [makeImageFile()])
  await flush()
  await runtime.send('main-1', '')
  assert.equal(runtime.getState('main-1').pending.length, 1)

  const textOnlyEcho = {
    seq: 1,
    type: 'user/message',
    time: 1700000001000,
    surfaceOp: 'append',
    data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '' }] }
  }
  snapshot.entries = [textOnlyEcho]
  await runtime.pollOnce('main-1')
  assert.equal(runtime.getState('main-1').pending.length, 1, 'a text-only echo does not retire an image pending row')

  const imageEcho = {
    seq: 2,
    type: 'user/message',
    time: 1700000001000,
    surfaceOp: 'append',
    data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'image', attachment: IMAGE_REF }] }
  }
  snapshot.entries = [imageEcho]
  await runtime.pollOnce('main-1')
  assert.equal(runtime.getState('main-1').pending.length, 0, 'the matching echo retires the pending row')
})

test('the reason copy localizes attachment rejections and falls back', () => {
  const { exports, react } = loadBundle()
  const t = (key) => (key.startsWith('image.reason.') ? `copy:${key}` : key)
  const formatError = exports.formatError
  assert.deepEqual(formatError(t, { code: 'attachment-rejected', reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES', message: 'detail' }), {
    title: 'copy:image.reason.MODEL_DOES_NOT_SUPPORT_IMAGES',
    detail: 'detail'
  })
  assert.equal(formatError(t, { code: 'attachment-rejected', reason: 'UNKNOWN_CODE' }).title, 'copy:image.reason.unknown')
  assert.equal(formatError(t, { code: 'prompt-failed' }).title, 'error.promptFailed')
  void react
})

test('the panel renders the composer rail, the picker and image thumbs', () => {
  const { bodyRegistration } = panelRenderer()
  const calls = []
  const state = panelState({
    sessionId: 'side-1',
    nodes: [{
      kind: 'user',
      seq: 1,
      time: 1700000001000,
      text: '',
      images: [IMAGE_REF]
    }],
    images: [{
      key: 'img-1',
      name: 'shot.png',
      mediaType: 'image/png',
      previewUrl: 'blob:preview-1',
      status: 'ready',
      error: null,
      file: null,
      ref: IMAGE_REF
    }]
  })
  const props = bodyRegistration.options.inject('session-1')
  const runtime = { ...panelRuntime(state, calls), addImages: (id, files) => calls.push(['addImages', files]) }
  const bodyElement = bodyRegistration.component({
    runtime,
    sessionId: 'main-1',
    t: props.t,
    useTabInfo: () => ({ tab: { visible: true } })
  })
  const tree = bodyElement.type(bodyElement.props)
  const rail = findElement(tree, (element) => element.props !== undefined && element.props.className === 'sc-image-rail')
  assert.ok(rail !== undefined, 'the rail renders above the textarea')
  const railItem = findElement(rail, (element) => typeof element.type === 'function' && element.props.image !== undefined)
  assert.ok(railItem !== undefined, 'the rail renders one item per image')
  const railTree = railItem.type(railItem.props)
  const railThumb = findElement(railTree, (element) => element.props !== undefined && element.props.className === 'sc-image-thumb')
  assert.equal(railThumb.props.src, 'blob:preview-1')

  const attach = findElement(tree, (element) => element.props !== undefined && element.props.className === 'sc-attach')
  assert.ok(attach !== undefined, 'the picker button renders')
  assert.equal(attach.props['aria-label'], '添加图片')
  const input = findElement(tree, (element) => element.props !== undefined && element.props.className === 'sc-file-input')
  assert.equal(input.props.type, 'file')
  assert.equal(input.props.accept, 'image/png,image/jpeg,image/webp,image/gif')
  assert.equal(input.props.multiple, true)

  const body = findElement(tree, (element) => element.props !== undefined && element.props.className === 'sc-body')
  const userRow = body.children[0][0]
  const userTree = userRow.type(userRow.props)
  const thumbElement = findElement(userTree, (element) => typeof element.type === 'function' && element.props.image !== undefined)
  assert.ok(thumbElement !== undefined, 'the committed bubble renders an image element')
  const thumbTree = thumbElement.type(thumbElement.props)
  const thumbAnchor = findElement(thumbTree, (element) => element.props !== undefined && element.props.className === 'sc-image-link')
  assert.ok(thumbAnchor !== undefined, 'the committed bubble renders an image served by the read route')
  const thumb = findElement(thumbTree, (element) => element.props !== undefined && element.props.className === 'sc-image-thumb')
  assert.match(thumb.props.src, new RegExp(encodeURIComponent(IMAGE_ID).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  const textarea = findElement(tree, (element) => element.props !== undefined && element.props.className === 'sc-textarea')
  const file = makeImageFile()
  textarea.props.onPaste({ clipboardData: { files: [file] } })
  assert.equal(calls.filter((call) => call[0] === 'addImages').length, 1)
  const composer = composerOf(tree)
  composer.props.onDrop({ dataTransfer: { files: [file] }, preventDefault: () => {} })
  assert.equal(calls.filter((call) => call[0] === 'addImages').length, 2)
  composer.props.onDragOver({ dataTransfer: { files: [makeImageFile()] }, preventDefault: () => {} })
})

test('the composer allows sending with a ready image and no text', () => {
  const { bodyRegistration } = panelRenderer()
  const state = panelState({
    sessionId: 'side-1',
    images: [{ key: 'img-1', name: 'a.png', mediaType: 'image/png', previewUrl: undefined, status: 'ready', error: null, file: null, ref: IMAGE_REF }]
  })
  const props = bodyRegistration.options.inject('session-1')
  const bodyElement = bodyRegistration.component({
    runtime: panelRuntime(state),
    sessionId: 'main-1',
    t: props.t,
    useTabInfo: () => ({ tab: { visible: true } })
  })
  const tree = bodyElement.type(bodyElement.props)
  const send = findElement(tree, (element) => element.props !== undefined && typeof element.props.className === 'string' && element.props.className.startsWith('sc-send'))
  assert.equal(send.props.disabled, false)
  assert.equal(send.props['aria-label'], '发送')
  assert.equal(send.props.className, 'sc-send')
})
