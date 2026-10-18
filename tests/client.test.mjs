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

function createReactStub() {
  const noop = () => {}
  return {
    createElement: (type, props, ...children) => ({ type, props: props === null ? {} : props, children }),
    Fragment: 'Fragment',
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, noop],
    useEffect: noop,
    useRef: (initial) => ({ current: initial === undefined ? null : initial }),
    useMemo: (factory) => factory(),
    useSyncExternalStore: (snapshot) => snapshot()
  }
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
  return { registration, exports: exportsObject }
}

function createCtxStub() {
  const disposers = []
  const registered = []
  const injected = []
  const tabTypes = []
  const closeHandlers = []
  const ctx = {
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
  return { ctx, disposers, registered, injected, tabTypes, closeHandlers }
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

function createRuntimeWith(fetchStub) {
  const { exports } = loadBundle()
  const scheduler = createSchedulerStub()
  const runtime = exports.createRuntime({
    fetch: fetchStub.fetchImpl,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    document: null,
    pollRunningMs: 5,
    pollIdleMs: 5
  })
  return { exports, scheduler, runtime }
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
  assert.deepEqual(exports.inject, ['slots', 'sidebarRight', 'sidebarRightTabs'])
  assert.equal(typeof exports.apply, 'function')
})

test('apply registers the sidebar tab type, the tab body slot and the close handler', () => {
  const { exports } = loadBundle()
  const { ctx, registered, injected, tabTypes, closeHandlers } = createCtxStub()
  const { doc } = createDocumentStub()
  const previous = globalThis.document
  globalThis.document = doc
  try {
    exports.apply(ctx)
  } finally {
    globalThis.document = previous
  }

  assert.deepEqual(injected, ['sidebar.right.pane.tab'])
  assert.equal(registered.length, 1)
  const body = registered[0]
  assert.equal(body.options.name, 'sidebar.right.pane.tab')
  assert.equal(body.options.key, TYPE_ID)
  assert.equal(typeof body.component, 'function')

  assert.equal(tabTypes.length, 1)
  const type = tabTypes[0]
  assert.equal(type.id, TYPE_ID)
  assert.equal(type.kind, KIND)
  assert.equal(type.priority, 'extension')
  assert.equal(type.keepMounted, true)
  assert.equal(type.title(), '侧边会话')
  assert.equal(type.multiple, undefined)
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
  const { ctx, registered, injected } = createCtxStub()
  const { doc } = createDocumentStub()
  const previous = globalThis.document
  globalThis.document = doc
  try {
    exports.apply(ctx)
  } finally {
    globalThis.document = previous
  }
  assert.equal(injected.includes('conversation.session.header.actions'), false)
  assert.equal(injected.includes('shell.overlay'), false)
  assert.equal(registered.some((entry) => entry.options.id === 'side-chat.toggle'), false)
  assert.equal(registered.some((entry) => entry.options.id === 'side-chat.panel'), false)
})

test('the injected tab body props carry the runtime for the slot session', () => {
  const { exports } = loadBundle()
  const { ctx, registered } = createCtxStub()
  const { doc } = createDocumentStub()
  const previous = globalThis.document
  globalThis.document = doc
  try {
    exports.apply(ctx)
  } finally {
    globalThis.document = previous
  }
  const inject = registered[0].options.inject
  assert.equal(typeof inject, 'function')
  const props = inject('session-1')
  assert.equal(props.sessionId, 'session-1')
  assert.equal(typeof props.runtime.open, 'function')
  assert.equal(typeof props.runtime.setVisible, 'function')
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
    const runtime = registered[0].options.inject('session-1').runtime
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

test('apply injects the stylesheet with the dsh-side-chat marker and sc- classes only', () => {
  const { exports } = loadBundle()
  const { ctx } = createCtxStub()
  const { doc, appended } = createDocumentStub()
  const previous = globalThis.document
  globalThis.document = doc
  try {
    exports.apply(ctx)
  } finally {
    globalThis.document = previous
  }
  assert.equal(appended.length, 1)
  const style = appended[0]
  assert.equal(style.tagName, 'style')
  assert.equal(style.dataset.dyn, 'dsh-side-chat')
  assert.ok(style.textContent.includes('.sc-root'))
  assert.ok(style.textContent.includes('.sc-statusbar'))
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

test('foldEntries classifies injected context and ignores replacement surfaces', () => {
  const { exports } = loadBundle()
  const entries = [
    userEntry(3, 'hello'),
    userEntry(4, 'skill loaded', { kind: 'skill-invocation', name: 'agent-experience' }),
    { ...assistantEntry(5, [{ type: 'text', text: 'replaced' }]), surfaceOp: 'replace' },
    { ...userEntry(6, 'replaced user'), surfaceOp: 'replace' }
  ]
  const nodes = exports.foldEntries(entries, 0)
  assert.deepEqual(nodes.map((node) => node.kind), ['user', 'context'])
  assert.equal(nodes[1].tag, '技能 agent-experience')
  assert.equal(nodes[1].text, 'skill loaded')
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

test('create failure surfaces an error row and restores the draft', async () => {
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
  assert.equal(state.error, 'fork failed')
  assert.equal(fetchStub.calls.length, 1)
})

test('prompt failure keeps the session and reports the error instead of dropping it', async () => {
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
  assert.equal(state.error, 'agent busy')
  assert.equal(state.pending.length, 0)
  assert.equal(state.draft, 'hello')
})

test('a not-found snapshot stops polling and shows the polling error', async () => {
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
  assert.equal(state.pollError, 'unknown side session')
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
  const { ctx } = createCtxStub()
  const { doc } = createDocumentStub()
  const previous = globalThis.document
  globalThis.document = doc
  try {
    exports.apply(ctx)
  } finally {
    globalThis.document = previous
  }
  assert.equal(typeof exports.foldEntries, 'function')
})
