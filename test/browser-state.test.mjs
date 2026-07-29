import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function loadBrowserStateApi(chrome) {
  const context = vm.createContext({
    chrome,
    console,
    crypto: webcrypto,
    Date,
    JSON,
    Map,
    Math,
    Number,
    Promise,
    Set,
    String,
    TextEncoder,
    Uint32Array,
    clearTimeout,
    setTimeout
  })
  context.globalThis = context
  for (const fileName of ['snapshot-base.js', 'browser-state.js']) {
    const source = await readFile(path.join(projectDir, 'background', fileName), 'utf8')
    vm.runInContext(source, context, { filename: fileName })
  }
  context.TabSnapshot.getConfig = async () => ({
    ...context.TabSnapshot.snapshotConfigDefault
  })
  context.TabSnapshot.ensureBrowserRunId = async () => 'browser-run-test'
  return context.TabSnapshot
}

function createChromeMock() {
  const notices = []
  const moves = []
  const tabs = [
    {
      id: 10,
      windowId: 1,
      index: 0,
      title: 'Example search result',
      url: 'https://example.com/reference',
      active: false,
      highlighted: true,
      pinned: false,
      incognito: false,
      groupId: -1
    },
    {
      id: 11,
      windowId: 1,
      index: 1,
      title: 'Current active tab',
      url: 'https://active.example/',
      active: true,
      highlighted: true,
      pinned: false,
      incognito: false,
      groupId: 4
    }
  ]
  return {
    notices,
    moves,
    runtime: {
      sendMessage: async (message) => {
        notices.push(message)
      }
    },
    alarms: {
      get: async () => null,
      create: async () => undefined
    },
    tabGroups: {
      query: async () => [{
        id: 4,
        windowId: 1,
        title: 'Work',
        color: 'blue',
        collapsed: false
      }]
    },
    windows: {
      getAll: async () => [{
        id: 1,
        type: 'normal',
        state: 'normal',
        focused: true,
        incognito: false,
        tabs
      }],
      update: async () => undefined
    },
    tabs: {
      get: async (tabId) => tabs.find((tab) => tab.id === tabId),
      query: async () => tabs.filter((tab) => tab.active),
      update: async () => undefined,
      remove: async () => undefined,
      duplicate: async (tabId) => ({
        ...tabs.find((tab) => tab.id === tabId),
        id: 12,
        index: 1
      }),
      move: async (tabId, moveInfo) => {
        moves.push({ tabId, moveInfo })
        return { id: tabId, windowId: moveInfo.windowId, index: moveInfo.index }
      }
    }
  }
}

test('live browser state scans and searches title or URL', async () => {
  const chrome = createChromeMock()
  const api = await loadBrowserStateApi(chrome)
  const state = await api.refreshBrowserState()
  assert.equal(state.windows.length, 1)
  assert.equal(state.windows[0].tabs.filter((tab) => tab.isSelected).length, 2)
  assert.equal(state.windows[0].groups[0].title, 'Work')

  const titleResult = await api.queryBrowserTabs({ text: 'SEARCH' })
  assert.deepEqual(titleResult.items.map((tab) => tab.tabSourceId), [10])
  const urlResult = await api.queryBrowserTabs({ text: 'active.example' })
  assert.deepEqual(urlResult.items.map((tab) => tab.tabSourceId), [11])
  await assert.rejects(() => api.queryBrowserTabs({ text: ' ' }), /required/)
})

test('live browser state applies selection, update, and removal events', async () => {
  const chrome = createChromeMock()
  const api = await loadBrowserStateApi(chrome)
  await api.refreshBrowserState()

  api.dispatchBrowserChange('tabHighlighted', {
    windowSourceId: 1,
    tabSourceIds: [11]
  })
  api.dispatchBrowserChange('tabUpdated', {
    tabSourceId: 10,
    windowSourceId: 1,
    change: { title: 'Renamed page' }
  })
  api.dispatchBrowserChange('tabRemoved', {
    tabSourceId: 11,
    windowId: 1
  })

  const state = await api.getBrowserState()
  assert.equal(state.stateRevision, 4)
  assert.equal(state.windows[0].tabs.length, 1)
  assert.equal(state.windows[0].tabs[0].title, 'Renamed page')
  assert.equal(state.windows[0].tabs[0].isSelected, false)
  assert.ok(chrome.notices.some((notice) => notice.changeType === 'tabRemoved'))
})

test('relative tab actions target the focused active tab', async () => {
  const chrome = createChromeMock()
  const api = await loadBrowserStateApi(chrome)
  await api.runBrowserTabAction({
    tabSourceId: 10,
    operation: 'moveRight'
  })
  assert.deepEqual(JSON.parse(JSON.stringify(chrome.moves[0])), {
    tabId: 10,
    moveInfo: {
      windowId: 1,
      index: 1
    }
  })
  await assert.rejects(
    () => api.runBrowserTabAction({ tabSourceId: 11, operation: 'moveLeft' }),
    /other than the current active tab/
  )
})
