(() => {
  const api = globalThis.TabSnapshot
  const tabDetachedById = new Map()
  const changeSubscribers = new Set()
  // Windows intentionally left out of the state (non-normal type, or private
  // while private windows are excluded). Changes for these windows are dropped
  // silently; a full refresh is reserved for real inconsistencies.
  const windowExcludedIdSet = new Set()
  let stateCurrent = null
  let stateRefreshPromise = null
  let changesBuffered = []
  let isScanning = false
  let refreshTimeoutId = null

  api.getBrowserTabData = (tab, config = api.snapshotConfigDefault) => ({
    tabSourceId: tab?.id ?? null,
    tabIndex: tab?.index ?? null,
    title: tab?.title ?? '',
    url: tab?.url ?? tab?.pendingUrl ?? '',
    favIconUrl: tab?.favIconUrl ?? '',
    isActive: tab?.active === true,
    isSelected: config.isTabSelectionIncluded ? tab?.highlighted === true : false,
    isPinned: tab?.pinned === true,
    isPrivate: tab?.incognito === true,
    isAudible: tab?.audible === true,
    isMuted: tab?.mutedInfo?.muted === true,
    isDiscarded: tab?.discarded === true,
    openerTabSourceId: tab?.openerTabId ?? null,
    status: tab?.status ?? null,
    lastAccessedAtMs: tab?.lastAccessed ?? null,
    groupSourceId: (
      config.isTabGroupIncluded && Number.isInteger(tab?.groupId) && tab.groupId >= 0
        ? tab.groupId
        : null
    )
  })

  api.scanBrowserState = async (configInput) => {
    const config = configInput ?? await api.getConfig()
    const stateObserveStartAtMs = Date.now()
    const [windowsAll, groupsAll, browserRunId] = await Promise.all([
      chrome.windows.getAll({ populate: true }),
      getGroups(config),
      api.ensureBrowserRunId()
    ])
    const groupById = new Map(groupsAll.map((group) => [group.id, group]))
    windowExcludedIdSet.clear()
    for (const windowItem of windowsAll) {
      const isIncluded = (
        windowItem.type === 'normal' && (config.isPrivateIncluded || !windowItem.incognito)
      )
      if (!isIncluded) windowExcludedIdSet.add(windowItem.id)
    }
    const windowsIncluded = windowsAll.filter(
      (windowItem) => !windowExcludedIdSet.has(windowItem.id)
    )
    let windowFocusedSourceId = null
    let tabFocusedSourceId = null
    let tabCountTotal = 0
    const windows = windowsIncluded.map((windowItem, windowIndex) => {
      const tabs = [...(windowItem.tabs ?? [])]
        .sort((tabA, tabB) => tabA.index - tabB.index)
        .map((tab) => api.getBrowserTabData(tab, config))
      const tabActive = tabs.find((tab) => tab.isActive)
      const groupIds = new Set(tabs.map((tab) => tab.groupSourceId).filter(Number.isInteger))
      const groups = [...groupIds]
        .map((groupId) => getGroupData(groupById.get(groupId)))
        .filter(Boolean)
      tabCountTotal += tabs.length
      if (windowItem.focused) {
        windowFocusedSourceId = windowItem.id
        tabFocusedSourceId = tabActive?.tabSourceId ?? null
      }
      return {
        windowSourceId: windowItem.id,
        windowIndex,
        windowType: windowItem.type,
        windowState: windowItem.state,
        isFocused: windowItem.focused === true,
        isPrivate: windowItem.incognito === true,
        left: windowItem.left ?? null,
        top: windowItem.top ?? null,
        width: windowItem.width ?? null,
        height: windowItem.height ?? null,
        tabActiveSourceId: tabActive?.tabSourceId ?? null,
        tabs,
        groups
      }
    })
    return {
      browserRunId,
      stateObserveStartAtMs,
      stateObserveEndAtMs: Date.now(),
      windowFocusedSourceId,
      tabFocusedSourceId,
      metadata: {
        windowCountTotal: windows.length,
        tabCountTotal,
        isPrivateIncluded: config.isPrivateIncluded,
        isTabGroupIncluded: config.isTabGroupIncluded && chrome.tabGroups?.query !== undefined,
        isTabSelectionIncluded: config.isTabSelectionIncluded
      },
      windows
    }
  }

  api.refreshBrowserState = async () => {
    if (stateRefreshPromise) return stateRefreshPromise
    stateRefreshPromise = (async () => {
      isScanning = true
      const changesBeforeScan = changesBuffered
      changesBuffered = []
      try {
        const tree = await api.scanBrowserState()
        const stateNext = {
          schemaVersion: 1,
          stateId: api.createId(tree.stateObserveEndAtMs),
          stateRevision: 1,
          ...tree
        }
        const buffered = [...changesBeforeScan, ...changesBuffered]
        changesBuffered = []
        for (const change of buffered) applyBrowserChange(stateNext, change)
        stateCurrent = stateNext
        updateStateMetadata(stateCurrent)
        notifyStateChanged('stateRefreshed')
        return api.cloneValue(stateCurrent)
      } catch (error) {
        const buffered = [...changesBeforeScan, ...changesBuffered]
        changesBuffered = []
        if (stateCurrent) {
          for (const change of buffered) {
            if (applyBrowserChange(stateCurrent, change)) {
              stateCurrent.stateRevision += 1
            }
          }
          updateStateMetadata(stateCurrent)
          notifyStateChanged('stateRefreshFailed')
        } else {
          changesBuffered = buffered
        }
        throw error
      } finally {
        isScanning = false
        stateRefreshPromise = null
      }
    })()
    return stateRefreshPromise
  }

  api.ensureBrowserState = async () => {
    if (stateCurrent) return api.cloneValue(stateCurrent)
    return api.refreshBrowserState()
  }

  api.getBrowserState = async () => api.ensureBrowserState()

  api.queryBrowserTabs = async (query = {}) => {
    const textQuery = String(query.text ?? '').trim()
    if (!textQuery) throw new Error('Search text is required')
    const state = await api.ensureBrowserState()
    const textNeedle = textQuery.toLocaleLowerCase()
    const itemsMatched = state.windows.flatMap((windowItem) => (
      windowItem.tabs
        .filter((tab) => (
          tab.title.toLocaleLowerCase().includes(textNeedle) ||
          tab.url.toLocaleLowerCase().includes(textNeedle)
        ))
        .map((tab) => ({
          ...tab,
          windowSourceId: windowItem.windowSourceId,
          windowIndex: windowItem.windowIndex,
          isWindowFocused: windowItem.isFocused
        }))
    ))
    const offset = Math.max(0, Number(query.offset) || 0)
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 200))
    return {
      stateId: state.stateId,
      stateRevision: state.stateRevision,
      queryText: textQuery,
      items: itemsMatched.slice(offset, offset + limit),
      offset,
      limit,
      totalValue: itemsMatched.length,
      isMore: offset + limit < itemsMatched.length
    }
  }

  // Return one contiguous slice of a window's tabs, centered on one tab.
  // countBefore/countAfter are maximums; the window border can give fewer tabs.
  api.queryBrowserTabContext = async (query = {}) => {
    const tabSourceId = Number(query.tabSourceId)
    if (!Number.isInteger(tabSourceId)) throw new Error('A valid tab ID is required')
    const countBefore = Math.min(500, Math.max(0, Math.round(Number(query.countBefore) || 0)))
    const countAfter = Math.min(500, Math.max(0, Math.round(Number(query.countAfter) || 0)))
    const state = await api.ensureBrowserState()
    const location = findTab(state, tabSourceId)
    if (!location) {
      return {
        stateId: state.stateId,
        stateRevision: state.stateRevision,
        isTabFound: false
      }
    }
    const windowItem = location.windowItem
    const indexCenter = location.tabIndex
    const indexFirst = Math.max(0, indexCenter - countBefore)
    const indexLast = Math.min(windowItem.tabs.length - 1, indexCenter + countAfter)
    const items = windowItem.tabs.slice(indexFirst, indexLast + 1).map((tab) => ({
      ...tab,
      windowSourceId: windowItem.windowSourceId,
      windowIndex: windowItem.windowIndex,
      isWindowFocused: windowItem.isFocused
    }))
    return {
      stateId: state.stateId,
      stateRevision: state.stateRevision,
      isTabFound: true,
      tabCenterSourceId: tabSourceId,
      windowSourceId: windowItem.windowSourceId,
      windowTabCount: windowItem.tabs.length,
      items,
      isMoreBefore: indexFirst > 0,
      isMoreAfter: indexLast < windowItem.tabs.length - 1
    }
  }

  api.getBrowserTabsSelected = async (query = {}) => {
    const state = await api.ensureBrowserState()
    const windowSourceId = Number.isInteger(query.windowSourceId)
      ? query.windowSourceId
      : null
    return state.windows.flatMap((windowItem) => (
      windowSourceId !== null && windowItem.windowSourceId !== windowSourceId
        ? []
        : windowItem.tabs
          .filter((tab) => tab.isSelected)
          .map((tab) => ({ ...tab, windowSourceId: windowItem.windowSourceId }))
    ))
  }

  api.runBrowserTabAction = async ({ tabSourceId, tabSourceIds, operation }) => {
    if (operation === 'close') {
      const tabSourceIdsClose = Array.isArray(tabSourceIds) ? tabSourceIds : [tabSourceId]
      if (tabSourceIdsClose.length === 0 || !tabSourceIdsClose.every(Number.isInteger)) {
        throw new Error('Valid tab IDs are required')
      }
      await chrome.tabs.remove(tabSourceIdsClose)
      return { tabSourceIds: tabSourceIdsClose }
    }
    if (!Number.isInteger(tabSourceId)) throw new Error('A valid tab ID is required')
    if (operation === 'activate') {
      const tab = await chrome.tabs.get(tabSourceId)
      await chrome.windows.update(tab.windowId, { focused: true })
      await chrome.tabs.update(tabSourceId, { active: true })
      return { tabSourceId }
    }
    if (!['moveLeft', 'moveRight', 'duplicateLeft', 'duplicateRight'].includes(operation)) {
      throw new Error('Unsupported tab action')
    }

    const [tabSource, tabsFocused] = await Promise.all([
      chrome.tabs.get(tabSourceId),
      chrome.tabs.query({ active: true, lastFocusedWindow: true })
    ])
    const tabFocused = tabsFocused[0]
    if (!tabFocused?.id || !Number.isInteger(tabFocused.windowId)) {
      throw new Error('Current active tab cannot be found')
    }
    if (tabFocused.id === tabSourceId) {
      throw new Error('Select a tab other than the current active tab')
    }

    const isRight = operation.endsWith('Right')
    let tabAction = tabSource
    if (operation.startsWith('duplicate')) {
      tabAction = await chrome.tabs.duplicate(tabSourceId)
      if (!tabAction?.id) throw new Error('Duplicated tab cannot be found')
    }

    let indexTarget = tabFocused.index + (isRight ? 1 : 0)
    if (
      tabAction.windowId === tabFocused.windowId &&
      tabAction.index < tabFocused.index
    ) {
      indexTarget -= 1
    }
    const tabMoved = await chrome.tabs.move(tabAction.id, {
      windowId: tabFocused.windowId,
      index: Math.max(0, indexTarget)
    })
    return {
      tabSourceId: Array.isArray(tabMoved) ? tabMoved[0]?.id : tabMoved?.id,
      windowSourceId: tabFocused.windowId
    }
  }

  api.subscribeBrowserChange = (listener) => {
    changeSubscribers.add(listener)
    return () => changeSubscribers.delete(listener)
  }

  api.dispatchBrowserChange = (eventType, eventData = {}) => {
    const change = {
      changeAtMs: Date.now(),
      eventType,
      ...eventData
    }
    if (isScanning || !stateCurrent) {
      changesBuffered.push(change)
    } else {
      const isChanged = applyBrowserChange(stateCurrent, change)
      if (isChanged) {
        stateCurrent.stateRevision += 1
        updateStateMetadata(stateCurrent)
        notifyStateChanged(eventType, change)
      }
    }
    for (const listener of changeSubscribers) {
      try {
        listener(change)
      } catch {
        queueRefresh()
      }
    }
  }

  api.queueBrowserStateRefresh = queueRefresh
  api.browserStateAlarmName = 'browser-state-refresh'

  api.ensureBrowserStateAlarm = async () => {
    if (!chrome.alarms) return
    const alarm = await chrome.alarms.get(api.browserStateAlarmName)
    if (!alarm) {
      await chrome.alarms.create(api.browserStateAlarmName, { periodInMinutes: 5 })
    }
  }

  function applyBrowserChange(state, change) {
    const eventType = change.eventType
    if (eventType === 'tabCreated') return applyTabCreated(state, change.tab)
    if (eventType === 'tabUpdated') return applyTabUpdated(state, change)
    if (eventType === 'tabMoved') return applyTabMoved(state, change)
    if (eventType === 'tabActivated') return applyTabActivated(state, change)
    if (eventType === 'tabHighlighted') return applyTabHighlighted(state, change)
    if (eventType === 'tabDetached') return applyTabDetached(state, change)
    if (eventType === 'tabAttached') return applyTabAttached(state, change)
    if (eventType === 'tabRemoved') return applyTabRemoved(state, change)
    if (eventType === 'windowCreated') return applyWindowCreated(state, change)
    if (eventType === 'windowRemoved') return applyWindowRemoved(state, change)
    if (eventType === 'windowFocusChanged') return applyWindowFocusChanged(state, change)
    if (eventType === 'windowBoundsChanged') return applyWindowBoundsChanged(state, change)
    if (eventType.startsWith('tabGroup')) return applyTabGroupChange(state, change)
    if (eventType === 'tabReplaced') queueRefresh()
    return false
  }

  function applyTabCreated(state, tab) {
    if (!tab || !Number.isInteger(tab.windowSourceId)) {
      queueRefresh()
      return false
    }
    if (tab.isPrivate && !state.metadata.isPrivateIncluded) return false
    if (isWindowExcluded(tab.windowSourceId)) return false
    const windowItem = findWindow(state, tab.windowSourceId)
    if (!windowItem) {
      queueRefresh()
      return false
    }
    removeTab(state, tab.tabSourceId)
    windowItem.tabs.splice(clampIndex(tab.tabIndex, windowItem.tabs.length), 0, tab)
    normalizeTabIndexes(windowItem)
    if (tab.isActive) setTabActive(state, windowItem, tab.tabSourceId)
    return true
  }

  function applyTabUpdated(state, change) {
    const location = findTab(state, change.tabSourceId)
    if (!location) {
      if (!isWindowExcluded(change.windowSourceId)) queueRefresh()
      return false
    }
    if (change.tab) Object.assign(location.tab, change.tab)
    const valueByChangeKey = {
      url: 'url',
      title: 'title',
      pinned: 'isPinned',
      discarded: 'isDiscarded',
      audible: 'isAudible',
      status: 'status'
    }
    for (const [key, value] of Object.entries(change.change ?? {})) {
      const stateKey = valueByChangeKey[key]
      if (stateKey) location.tab[stateKey] = value
      if (key === 'mutedInfo') location.tab.isMuted = value?.muted === true
      if (key === 'groupId') location.tab.groupSourceId = value >= 0 ? value : null
      if (key === 'favIconUrl') location.tab.favIconUrl = value ?? ''
    }
    if (Number.isInteger(change.tabIndex) && change.tabIndex !== location.tab.tabIndex) {
      location.windowItem.tabs.splice(location.tabIndex, 1)
      location.windowItem.tabs.splice(
        clampIndex(change.tabIndex, location.windowItem.tabs.length),
        0,
        location.tab
      )
      normalizeTabIndexes(location.windowItem)
    }
    return true
  }

  function applyTabMoved(state, change) {
    const location = findTab(state, change.tabSourceId)
    if (!location) {
      if (!isWindowExcluded(change.windowId)) queueRefresh()
      return false
    }
    location.windowItem.tabs.splice(location.tabIndex, 1)
    location.windowItem.tabs.splice(
      clampIndex(change.toIndex, location.windowItem.tabs.length),
      0,
      location.tab
    )
    normalizeTabIndexes(location.windowItem)
    return true
  }

  function applyTabActivated(state, change) {
    const windowItem = findWindow(state, change.windowSourceId)
    if (!windowItem || !findTabInWindow(windowItem, change.tabSourceId)) {
      if (!isWindowExcluded(change.windowSourceId)) queueRefresh()
      return false
    }
    setTabActive(state, windowItem, change.tabSourceId)
    return true
  }

  function applyTabHighlighted(state, change) {
    const windowItem = findWindow(state, change.windowSourceId)
    if (!windowItem) {
      if (!isWindowExcluded(change.windowSourceId)) queueRefresh()
      return false
    }
    const selectedIdSet = new Set(change.tabSourceIds ?? [])
    for (const tab of windowItem.tabs) tab.isSelected = selectedIdSet.has(tab.tabSourceId)
    const tabActive = findTabInWindow(windowItem, windowItem.tabActiveSourceId)
    if (tabActive) tabActive.isSelected = true
    return true
  }

  function applyTabDetached(state, change) {
    const location = findTab(state, change.tabSourceId)
    if (!location) return false
    tabDetachedById.set(change.tabSourceId, location.tab)
    location.windowItem.tabs.splice(location.tabIndex, 1)
    normalizeTabIndexes(location.windowItem)
    return true
  }

  function applyTabAttached(state, change) {
    if (isWindowExcluded(change.newWindowId)) {
      tabDetachedById.delete(change.tabSourceId)
      return false
    }
    const windowItem = findWindow(state, change.newWindowId)
    const tab = tabDetachedById.get(change.tabSourceId)
    if (!windowItem || !tab) {
      queueRefresh()
      return false
    }
    tabDetachedById.delete(change.tabSourceId)
    windowItem.tabs.splice(clampIndex(change.newPosition, windowItem.tabs.length), 0, tab)
    normalizeTabIndexes(windowItem)
    return true
  }

  function applyTabRemoved(state, change) {
    tabDetachedById.delete(change.tabSourceId)
    return removeTab(state, change.tabSourceId)
  }

  function applyWindowCreated(state, change) {
    if (findWindow(state, change.windowSourceId)) return false
    if (
      change.windowType !== 'normal' ||
      (change.isPrivate && !state.metadata.isPrivateIncluded)
    ) {
      windowExcludedIdSet.add(change.windowSourceId)
      return false
    }
    state.windows.push({
      windowSourceId: change.windowSourceId,
      windowIndex: state.windows.length,
      windowType: change.windowType,
      windowState: change.windowState,
      isFocused: change.isFocused === true,
      isPrivate: change.isPrivate === true,
      left: change.left ?? null,
      top: change.top ?? null,
      width: change.width ?? null,
      height: change.height ?? null,
      tabActiveSourceId: null,
      tabs: [],
      groups: []
    })
    return true
  }

  function applyWindowRemoved(state, change) {
    windowExcludedIdSet.delete(change.windowSourceId)
    const index = state.windows.findIndex(
      (windowItem) => windowItem.windowSourceId === change.windowSourceId
    )
    if (index < 0) return false
    state.windows.splice(index, 1)
    normalizeWindowIndexes(state)
    if (state.windowFocusedSourceId === change.windowSourceId) {
      state.windowFocusedSourceId = null
      state.tabFocusedSourceId = null
    }
    return true
  }

  function applyWindowFocusChanged(state, change) {
    state.windowFocusedSourceId = null
    state.tabFocusedSourceId = null
    for (const windowItem of state.windows) {
      windowItem.isFocused = windowItem.windowSourceId === change.windowSourceId
      if (windowItem.isFocused) {
        state.windowFocusedSourceId = windowItem.windowSourceId
        state.tabFocusedSourceId = windowItem.tabActiveSourceId
      }
    }
    return true
  }

  function applyWindowBoundsChanged(state, change) {
    const windowItem = findWindow(state, change.windowSourceId)
    if (!windowItem) return false
    for (const key of ['left', 'top', 'width', 'height', 'windowState']) {
      if (change[key] !== undefined) windowItem[key] = change[key]
    }
    return true
  }

  function applyTabGroupChange(state, change) {
    const group = change.group
    if (!group) return false
    const groupData = getGroupData(group)
    const windowItem = findWindow(state, group.windowId)
    if (!windowItem) {
      if (!isWindowExcluded(group.windowId)) queueRefresh()
      return false
    }
    const groupIndex = windowItem.groups.findIndex(
      (item) => item.groupSourceId === group.id
    )
    if (change.eventType === 'tabGroupRemoved') {
      if (groupIndex >= 0) windowItem.groups.splice(groupIndex, 1)
      for (const tab of windowItem.tabs) {
        if (tab.groupSourceId === group.id) tab.groupSourceId = null
      }
      return groupIndex >= 0
    }
    if (groupIndex >= 0) windowItem.groups[groupIndex] = groupData
    else windowItem.groups.push(groupData)
    return true
  }

  function setTabActive(state, windowItem, tabSourceId) {
    for (const tab of windowItem.tabs) {
      tab.isActive = tab.tabSourceId === tabSourceId
      if (tab.isActive) tab.isSelected = true
    }
    windowItem.tabActiveSourceId = tabSourceId
    if (windowItem.isFocused) state.tabFocusedSourceId = tabSourceId
  }

  function removeTab(state, tabSourceId) {
    const location = findTab(state, tabSourceId)
    if (!location) return false
    location.windowItem.tabs.splice(location.tabIndex, 1)
    normalizeTabIndexes(location.windowItem)
    if (location.windowItem.tabActiveSourceId === tabSourceId) {
      location.windowItem.tabActiveSourceId = null
    }
    if (state.tabFocusedSourceId === tabSourceId) state.tabFocusedSourceId = null
    return true
  }

  function findWindow(state, windowSourceId) {
    return state.windows.find((windowItem) => windowItem.windowSourceId === windowSourceId)
  }

  function isWindowExcluded(windowSourceId) {
    return Number.isInteger(windowSourceId) && windowExcludedIdSet.has(windowSourceId)
  }

  function findTab(state, tabSourceId) {
    for (const windowItem of state.windows) {
      const tabIndex = windowItem.tabs.findIndex((tab) => tab.tabSourceId === tabSourceId)
      if (tabIndex >= 0) return { windowItem, tab: windowItem.tabs[tabIndex], tabIndex }
    }
    return null
  }

  function findTabInWindow(windowItem, tabSourceId) {
    return windowItem.tabs.find((tab) => tab.tabSourceId === tabSourceId)
  }

  function normalizeWindowIndexes(state) {
    state.windows.forEach((windowItem, index) => {
      windowItem.windowIndex = index
    })
  }

  function normalizeTabIndexes(windowItem) {
    windowItem.tabs.forEach((tab, index) => {
      tab.tabIndex = index
    })
  }

  function updateStateMetadata(state) {
    normalizeWindowIndexes(state)
    state.metadata.windowCountTotal = state.windows.length
    state.metadata.tabCountTotal = state.windows.reduce(
      (count, windowItem) => count + windowItem.tabs.length,
      0
    )
  }

  function notifyStateChanged(changeType, change = {}) {
    if (!stateCurrent) return
    const notice = {
      action: 'browserStateChanged',
      stateId: stateCurrent.stateId,
      stateRevision: stateCurrent.stateRevision,
      changeType,
      windowSourceIds: getIdsAffected(change, 'window'),
      tabSourceIds: getIdsAffected(change, 'tab')
    }
    Promise.resolve(chrome.runtime.sendMessage(notice)).catch(() => undefined)
  }

  function getIdsAffected(change, type) {
    const idSet = new Set()
    for (const [key, value] of Object.entries(change)) {
      if (!key.toLocaleLowerCase().includes(type)) continue
      if (Number.isInteger(value)) idSet.add(value)
      if (Array.isArray(value)) value.filter(Number.isInteger).forEach((id) => idSet.add(id))
    }
    return [...idSet]
  }

  function queueRefresh() {
    if (refreshTimeoutId !== null) return
    refreshTimeoutId = setTimeout(() => {
      refreshTimeoutId = null
      api.refreshBrowserState().catch(() => undefined)
    }, 100)
  }

  async function getGroups(config) {
    if (!config.isTabGroupIncluded || !chrome.tabGroups?.query) return []
    try {
      return await chrome.tabGroups.query({})
    } catch {
      return []
    }
  }

  function getGroupData(group) {
    if (!group) return null
    return {
      groupSourceId: group.id,
      title: group.title ?? '',
      color: group.color ?? null,
      isCollapsed: group.collapsed === true
    }
  }

  function clampIndex(index, length) {
    if (!Number.isInteger(index)) return length
    return Math.max(0, Math.min(length, index))
  }
})()
