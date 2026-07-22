import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function loadSnapshotApi(fileNames, contextValues = {}) {
  const context = vm.createContext({
    console,
    crypto: webcrypto,
    Date,
    JSON,
    Map,
    Math,
    Set,
    String,
    TextEncoder,
    Uint32Array,
    ...contextValues
  })
  context.globalThis = context
  for (const fileName of fileNames) {
    const source = await readFile(path.join(projectDir, 'background', fileName), 'utf8')
    vm.runInContext(source, context, { filename: fileName })
  }
  return context.TabSnapshot
}

test('time text uses required ten-millisecond format', async () => {
  const api = await loadSnapshotApi(['snapshot-base.js'])
  const timeText = api.formatTime(Date.now())
  assert.match(timeText, /^\d{8}_\d{8}[+-]\d{2}$/)
})

test('snapshot ids remain distinct in one time unit', async () => {
  const api = await loadSnapshotApi(['snapshot-base.js'])
  const timeMs = Date.now()
  const idSet = new Set(Array.from({ length: 50 }, () => api.createId(timeMs)))
  assert.equal(idSet.size, 50)
})

test('retention removes recent snapshots closer than four minutes', async () => {
  const api = await loadSnapshotApi(['snapshot-base.js', 'snapshot-retention.js'])
  const timeNowMs = 1_800_000_000_000
  const itemAtMinuteAgo = (snapshotId, minuteAgo) => ({
    snapshotId,
    snapshotGenerateAtMs: timeNowMs - minuteAgo * 60000
  })
  const items = [
    itemAtMinuteAgo('newest', 0),
    itemAtMinuteAgo('too-close', 2),
    itemAtMinuteAgo('kept', 5)
  ]
  const config = api.cloneValue(api.snapshotConfigDefault)
  assert.deepEqual(
    Array.from(api.getSnapshotIdsDeleteByRetention(items, config, timeNowMs)),
    ['too-close']
  )
})

test('retention preserves one snapshot in each non-empty tier', async () => {
  const api = await loadSnapshotApi(['snapshot-base.js', 'snapshot-retention.js'])
  const timeNowMs = 1_800_000_000_000
  const items = [
    { snapshotId: 'recent', snapshotGenerateAtMs: timeNowMs - 5 * 60000 },
    { snapshotId: 'daily', snapshotGenerateAtMs: timeNowMs - 120 * 60000 },
    { snapshotId: 'weekly', snapshotGenerateAtMs: timeNowMs - 2000 * 60000 },
    { snapshotId: 'monthly', snapshotGenerateAtMs: timeNowMs - 12000 * 60000 },
    { snapshotId: 'forever', snapshotGenerateAtMs: timeNowMs - 50000 * 60000 }
  ]
  const config = api.cloneValue(api.snapshotConfigDefault)
  assert.deepEqual(
    Array.from(api.getSnapshotIdsDeleteByRetention(items, config, timeNowMs)),
    []
  )
})

test('retention never removes pinned snapshots', async () => {
  const api = await loadSnapshotApi(['snapshot-base.js', 'snapshot-retention.js'])
  const timeNowMs = 1_800_000_000_000
  const config = api.cloneValue(api.snapshotConfigDefault)
  const items = [
    { snapshotId: 'newest', snapshotGenerateAtMs: timeNowMs, isPinned: false },
    {
      snapshotId: 'pinned-close',
      snapshotGenerateAtMs: timeNowMs - 60000,
      isPinned: true
    },
    {
      snapshotId: 'unpinned-close',
      snapshotGenerateAtMs: timeNowMs - 2 * 60000,
      isPinned: false
    }
  ]

  assert.deepEqual(
    Array.from(api.getSnapshotIdsDeleteByRetention(items, config, timeNowMs)),
    ['unpinned-close']
  )
})

test('old snapshot catalog entries default to unpinned', async () => {
  const chrome = {
    storage: {
      local: {
        get: async () => ({
          snapshotCatalogV1: {
            schemaVersion: 1,
            snapshotItems: [{ snapshotId: 'old-snapshot' }]
          }
        })
      }
    }
  }
  const api = await loadSnapshotApi(['snapshot-base.js', 'snapshot-storage.js'], { chrome })
  const catalog = await api.getSnapshotCatalog()

  assert.equal(catalog.snapshotItems[0].isPinned, false)
})

test('manual snapshot scheduling resets snapshot and cleaning alarms', async () => {
  const alarmsCreated = []
  const alarmsCleared = []
  const chrome = {
    alarms: {
      get: async (name) => ({
        name,
        periodInMinutes: name === 'snapshot-create' ? 5 : 10
      }),
      clear: async (name) => {
        alarmsCleared.push(name)
      },
      create: async (name, options) => {
        alarmsCreated.push({ name, ...options })
      }
    },
    storage: {
      sync: {
        get: async () => ({})
      },
      onChanged: {
        addListener: () => undefined
      }
    }
  }
  const api = await loadSnapshotApi(['snapshot-base.js', 'snapshot-config.js'], { chrome })

  await api.resetSnapshotAndCleanAlarms()

  assert.deepEqual(alarmsCleared, ['snapshot-create', 'snapshot-clean'])
  assert.deepEqual(alarmsCreated, [
    { name: 'snapshot-create', delayInMinutes: 5, periodInMinutes: 5 },
    { name: 'snapshot-clean', delayInMinutes: 10, periodInMinutes: 10 }
  ])
})

test('event replay updates focus, URL, selection, and tab removal', async () => {
  const api = await loadSnapshotApi(['snapshot-base.js', 'recovery.js'])
  const state = api.cloneValue({
    windowFocusedSourceId: 1,
    tabFocusedSourceId: 10,
    windows: [
      {
        windowSourceId: 1,
        isFocused: true,
        tabActiveSourceId: 10,
        groups: [],
        tabs: [
          {
            tabSourceId: 10,
            tabIndex: 0,
            title: 'Old',
            isActive: true,
            isSelected: true
          },
          {
            tabSourceId: 11,
            tabIndex: 1,
            title: 'Second',
            url: 'https://example.com/old',
            isActive: false,
            isSelected: false
          }
        ]
      }
    ]
  })
  api.applyEventToState(state, {
    eventType: 'tabUpdated',
    tabSourceId: 11,
    change: { url: 'https://example.com/new' }
  })
  api.applyEventToState(state, {
    eventType: 'tabActivated',
    windowSourceId: 1,
    tabSourceId: 11
  })
  api.applyEventToState(state, {
    eventType: 'tabHighlighted',
    windowSourceId: 1,
    tabSourceIds: [10, 11]
  })
  api.applyEventToState(state, {
    eventType: 'tabRemoved',
    tabSourceId: 10
  })

  assert.equal(state.tabFocusedSourceId, 11)
  assert.equal(state.windows[0].tabs.length, 1)
  assert.equal(state.windows[0].tabs[0].url, 'https://example.com/new')
  assert.equal(state.windows[0].tabs[0].isSelected, true)
  assert.equal(state.windows[0].tabs[0].tabIndex, 0)
})

test('recovery replay can stop at one selected event', async () => {
  const api = await loadSnapshotApi(['snapshot-base.js', 'recovery.js'])
  api.getRecoverySource = async () => ({
    snapshot: {
      snapshotId: 'snapshot-selected-step',
      eventSequenceCutoff: 10,
      metadata: {
        windowCountTotal: 1,
        tabCountTotal: 2
      },
      windows: [{
        windowSourceId: 1,
        groups: [],
        tabs: [
          { tabSourceId: 20, tabIndex: 0, url: 'https://example.com/old' },
          { tabSourceId: 21, tabIndex: 1, url: 'https://example.com/keep' }
        ]
      }]
    },
    events: [
      {
        eventSequence: 11,
        eventType: 'tabUpdated',
        tabSourceId: 20,
        change: { url: 'https://example.com/selected' }
      },
      {
        eventSequence: 12,
        eventType: 'tabRemoved',
        tabSourceId: 21
      }
    ],
    messages: [],
    eventSequenceLast: 12
  })

  const result = await api.replayRecovery('snapshot-selected-step', 11)

  assert.equal(result.eventSequenceLast, 11)
  assert.equal(result.events.length, 2)
  assert.equal(result.stateRecovered.windows[0].tabs.length, 2)
  assert.equal(
    result.stateRecovered.windows[0].tabs[0].url,
    'https://example.com/selected'
  )
})

test('tab move events preserve reconstructed order and indexes', async () => {
  const api = await loadSnapshotApi(['snapshot-base.js', 'recovery.js'])
  const state = api.cloneValue({
    windows: [
      {
        windowSourceId: 1,
        groups: [],
        tabs: [
          { tabSourceId: 10, tabIndex: 0 },
          { tabSourceId: 11, tabIndex: 1 },
          { tabSourceId: 12, tabIndex: 2 }
        ]
      }
    ]
  })
  api.applyEventToState(state, {
    eventType: 'tabMoved',
    tabSourceId: 12,
    fromIndex: 2,
    toIndex: 0,
    windowId: 1
  })

  assert.deepEqual(
    Array.from(state.windows[0].tabs, (tab) => tab.tabSourceId),
    [12, 10, 11]
  )
  assert.deepEqual(
    Array.from(state.windows[0].tabs, (tab) => tab.tabIndex),
    [0, 1, 2]
  )
})

test('replay keeps known tabs when a removed tab cannot be found', async () => {
  const api = await loadSnapshotApi(['snapshot-base.js', 'recovery.js'])
  const state = api.cloneValue({
    windowFocusedSourceId: 1,
    tabFocusedSourceId: 10,
    windows: [{
      windowSourceId: 1,
      tabActiveSourceId: 10,
      groups: [],
      tabs: [{ tabSourceId: 10, tabIndex: 0, isActive: true }]
    }]
  })
  const messages = []

  api.applyEventToState(state, {
    eventSequence: 12,
    eventType: 'tabRemoved',
    tabSourceId: 999
  }, messages)

  assert.equal(state.windows[0].tabs.length, 1)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].level, 'warning')
  assert.equal(messages[0].code, 'tab-remove-missing')
})

test('replay limits an invalid move position without losing the tab', async () => {
  const api = await loadSnapshotApi(['snapshot-base.js', 'recovery.js'])
  const state = api.cloneValue({
    windows: [{
      windowSourceId: 1,
      groups: [],
      tabs: [
        { tabSourceId: 10, tabIndex: 0 },
        { tabSourceId: 11, tabIndex: 1 }
      ]
    }]
  })
  const messages = []

  api.applyEventToState(state, {
    eventSequence: 13,
    eventType: 'tabMoved',
    tabSourceId: 10,
    toIndex: 100
  }, messages)

  assert.deepEqual(
    Array.from(state.windows[0].tabs, (tab) => tab.tabSourceId),
    [11, 10]
  )
  assert.equal(messages[0].code, 'tab-move-index-invalid')
})

test('tab updates can carry the browser index after a pin change', async () => {
  const api = await loadSnapshotApi(['snapshot-base.js', 'recovery.js'])
  const state = api.cloneValue({
    windows: [{
      windowSourceId: 1,
      groups: [],
      tabs: [
        { tabSourceId: 10, tabIndex: 0, isPinned: false },
        { tabSourceId: 11, tabIndex: 1, isPinned: false },
        { tabSourceId: 12, tabIndex: 2, isPinned: false }
      ]
    }]
  })

  api.applyEventToState(state, {
    eventType: 'tabUpdated',
    tabSourceId: 12,
    tabIndex: 0,
    change: { pinned: true }
  })

  assert.deepEqual(
    Array.from(state.windows[0].tabs, (tab) => tab.tabSourceId),
    [12, 10, 11]
  )
  assert.equal(state.windows[0].tabs[0].isPinned, true)
})

test('a new browser run starts a separate event chunk', async () => {
  const valuesSet = {}
  const runtimeMessages = []
  const chunkOld = {
    schemaVersion: 1,
    chunkId: 'old-chunk',
    browserRunId: 'old-run',
    events: [{
      browserRunId: 'old-run',
      eventSequence: 1,
      eventAtMs: 100,
      eventType: 'browserRunStarted'
    }]
  }
  const chrome = {
    runtime: {
      sendMessage: async (message) => {
        runtimeMessages.push(message)
      }
    },
    storage: {
      local: {
        get: async () => ({ 'eventChunkV1:old-run:old-chunk': chunkOld }),
        set: async (values) => Object.assign(valuesSet, values)
      }
    }
  }
  const api = await loadSnapshotApi(['snapshot-base.js', 'event-log.js'], { chrome })
  const catalog = {
    schemaVersion: 1,
    eventSequenceNext: 2,
    chunkActiveId: 'old-chunk',
    chunks: [{
      chunkId: 'old-chunk',
      storageKey: 'eventChunkV1:old-run:old-chunk',
      browserRunId: 'old-run',
      eventSequenceFirst: 1,
      eventSequenceLast: 1,
      eventAtFirstMs: 100,
      eventAtLastMs: 100,
      eventCount: 1,
      isClosed: false
    }]
  }
  api.getConfig = async () => api.snapshotConfigDefault
  api.ensureBrowserRunId = async () => 'new-run'
  api.getEventCatalog = async () => catalog

  await api.appendEvents([{ eventAtMs: 200, eventType: 'browserRunStarted' }])

  assert.equal(catalog.chunks.length, 2)
  assert.equal(catalog.chunks[0].isClosed, true)
  assert.equal(catalog.chunks[1].browserRunId, 'new-run')
  assert.ok(valuesSet[catalog.chunks[1].storageKey])
  assert.equal(runtimeMessages.length, 1)
  assert.equal(runtimeMessages[0].action, 'snapshotRecoveryChanged')
  assert.equal(runtimeMessages[0].eventSequenceLast, 2)
})

test('tab creation and URL changes are persisted and announced', async () => {
  const createBrowserEvent = () => {
    const listeners = []
    return {
      addListener: (listener) => listeners.push(listener),
      emit: (...args) => listeners.forEach((listener) => listener(...args))
    }
  }
  const tabCreated = createBrowserEvent()
  const tabUpdated = createBrowserEvent()
  const eventUnused = createBrowserEvent()
  const storageValues = {}
  const runtimeMessages = []
  const chrome = {
    runtime: {
      sendMessage: async (message) => {
        runtimeMessages.push(message)
      }
    },
    storage: {
      local: {
        get: async (key) => (
          typeof key === 'string'
            ? { [key]: storageValues[key] }
            : {}
        ),
        set: async (values) => Object.assign(storageValues, values)
      }
    },
    tabs: {
      onCreated: tabCreated,
      onUpdated: tabUpdated,
      onMoved: eventUnused,
      onActivated: eventUnused,
      onHighlighted: eventUnused,
      onAttached: eventUnused,
      onDetached: eventUnused,
      onRemoved: eventUnused,
      onReplaced: null,
      onZoomChange: null
    },
    windows: {
      onCreated: eventUnused,
      onRemoved: eventUnused,
      onFocusChanged: eventUnused,
      onBoundsChanged: null
    },
    tabGroups: null
  }
  const api = await loadSnapshotApi(['snapshot-base.js', 'event-log.js'], { chrome })
  const catalog = {
    schemaVersion: 1,
    eventSequenceNext: 1,
    chunkActiveId: null,
    chunks: []
  }
  api.getConfig = async () => api.snapshotConfigDefault
  api.ensureBrowserRunId = async () => 'current-run'
  api.getEventCatalog = async () => catalog
  api.recordSnapshotError = async () => undefined
  api.registerEventListeners()
  api.registerEventListeners()

  const tab = {
    id: 71,
    windowId: 8,
    index: 2,
    title: 'New tab',
    url: 'about:newtab',
    active: true,
    highlighted: true,
    pinned: false,
    groupId: -1
  }
  tabCreated.emit(tab)
  tabUpdated.emit(71, { url: 'https://example.com/new' }, {
    ...tab,
    url: 'https://example.com/new'
  })
  tabUpdated.emit(71, { pinned: true }, {
    ...tab,
    url: 'https://example.com/new',
    pinned: true
  })
  await api.storageTaskCurrent

  const chunk = storageValues[catalog.chunks[0].storageKey]
  assert.deepEqual(
    Array.from(chunk.events, (event) => event.eventType),
    ['tabCreated', 'tabUpdated', 'tabUpdated']
  )
  assert.equal(chunk.events[1].change.url, 'https://example.com/new')
  assert.equal(chunk.events[2].change.pinned, true)
  assert.equal(chunk.events[2].tabIndex, 2)
  assert.equal(runtimeMessages.length, 1)
  assert.equal(runtimeMessages[0].eventSequenceLast, 3)
})

test('restore suppresses tab positioning and enforces final tab order', async () => {
  const tabOrder = [100]
  let tabIdNext = 101
  let highlightedIndexes = []
  let api
  const chrome = {
    windows: {
      create: async () => {
        assert.equal(api.isTabPositioningSuppressed, true)
        return { id: 50, tabs: [{ id: 100 }] }
      },
      update: async () => undefined
    },
    tabs: {
      update: async (tabId) => ({ id: tabId }),
      create: async () => {
        const tabId = tabIdNext
        tabIdNext += 1
        tabOrder.splice(1, 0, tabId)
        return { id: tabId }
      },
      move: async (tabId, moveProperties) => {
        tabOrder.splice(tabOrder.indexOf(tabId), 1)
        tabOrder.splice(moveProperties.index, 0, tabId)
      },
      highlight: async ({ tabs }) => {
        highlightedIndexes = tabs
      },
      group: null
    },
    tabGroups: null
  }
  api = await loadSnapshotApi(['snapshot-base.js', 'recovery.js'], { chrome })
  api.getSnapshot = async () => ({
    snapshotId: 'snapshot-order',
    windowFocusedSourceId: 1,
    windows: [{
      windowSourceId: 1,
      windowState: 'normal',
      isPrivate: false,
      tabActiveSourceId: 11,
      groups: [],
      tabs: [
        { tabSourceId: 10, tabIndex: 0, url: 'https://a.example', isSelected: true },
        { tabSourceId: 11, tabIndex: 1, url: 'https://b.example', isSelected: false },
        { tabSourceId: 12, tabIndex: 2, url: 'https://c.example', isSelected: true }
      ]
    }]
  })
  api.flushEventBatch = async () => undefined
  api.createSnapshotNow = async () => undefined

  await api.restoreSnapshot('snapshot-order')

  assert.deepEqual(tabOrder, [100, 101, 102])
  assert.deepEqual(highlightedIndexes, [0, 2])
  assert.equal(api.isTabPositioningSuppressed, false)
  assert.equal(api.isEventBatchActive, false)
})

test('batch restore creates ordered tabs in one cross-browser window call', async () => {
  let windowCreateData = null
  const tabMoveCalls = []
  let tabCreateCount = 0
  const chrome = {
    windows: {
      create: async (createData) => {
        windowCreateData = createData
        return {
          id: 50,
          tabs: [
            { id: 200, index: 0 },
            { id: 201, index: 1 },
            { id: 202, index: 2 }
          ]
        }
      },
      update: async () => undefined
    },
    tabs: {
      query: async () => [],
      update: async (tabId) => ({ id: tabId }),
      create: async () => {
        tabCreateCount += 1
        return { id: 999 }
      },
      move: async (tabIds, moveProperties) => {
        tabMoveCalls.push({ tabIds, moveProperties })
      },
      highlight: async () => undefined,
      group: null
    },
    tabGroups: null
  }
  const api = await loadSnapshotApi(['snapshot-base.js', 'recovery.js'], { chrome })
  api.getSnapshot = async () => ({
    snapshotId: 'snapshot-batch',
    windowFocusedSourceId: 1,
    windows: [{
      windowSourceId: 1,
      windowState: 'normal',
      isPrivate: false,
      tabActiveSourceId: 11,
      groups: [],
      tabs: [
        {
          tabSourceId: 10,
          tabIndex: 0,
          url: 'https://a.example',
          isPinned: true,
          isSelected: false
        },
        {
          tabSourceId: 11,
          tabIndex: 1,
          url: 'https://b.example',
          isPinned: false,
          isSelected: true
        },
        {
          tabSourceId: 12,
          tabIndex: 2,
          url: 'https://c.example',
          isPinned: false,
          isSelected: false
        }
      ]
    }]
  })
  api.flushEventBatch = async () => undefined
  api.createSnapshotNow = async () => undefined

  const result = await api.restoreSnapshot('snapshot-batch', true)

  assert.deepEqual(Array.from(windowCreateData.url), [
    'https://a.example',
    'https://b.example',
    'https://c.example'
  ])
  assert.equal(tabCreateCount, 0)
  assert.deepEqual(tabMoveCalls.map((call) => ({
    tabIds: Array.from(call.tabIds),
    moveProperties: { ...call.moveProperties }
  })), [
    {
      tabIds: [200],
      moveProperties: { windowId: 50, index: 0 }
    },
    {
      tabIds: [201, 202],
      moveProperties: { windowId: 50, index: 1 }
    }
  ])
  assert.equal(result.tabCountCreated, 3)
})

test('storage usage includes snapshot and event counts', async () => {
  const chrome = {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => undefined
      }
    }
  }
  const api = await loadSnapshotApi(['snapshot-base.js', 'snapshot-storage.js'], { chrome })
  api.getSnapshotCatalog = async () => ({
    snapshotItems: [
      { storageKey: 'snapshot:1' },
      { storageKey: 'snapshot:2' }
    ]
  })
  api.getEventCatalog = async () => ({
    chunks: [
      { storageKey: 'events:1', eventCount: 3 },
      { storageKey: 'events:2', eventCount: 5 }
    ]
  })
  api.getConfig = async () => ({ storageWarningByte: 1000 })
  api.getBytesInUseSafe = async (keys) => {
    if (keys === null) return { byteCount: 300, isEstimated: false }
    return {
      byteCount: keys[0] === api.snapshotCatalogStorageKey ? 100 : 150,
      isEstimated: false
    }
  }
  api.updateMaintenance = async (changes) => changes

  const maintenance = await api.refreshStorageUsage()

  assert.equal(maintenance.snapshotCount, 2)
  assert.equal(maintenance.eventCount, 8)
  assert.equal(maintenance.snapshotStorageByte, 100)
  assert.equal(maintenance.eventStorageByte, 150)
  assert.equal(maintenance.storageTotalByte, 300)
})
