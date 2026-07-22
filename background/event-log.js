(() => {
  const api = globalThis.TabSnapshot
  const tabUrlEventStateById = new Map()

  const getTabState = (tab) => ({
    tabSourceId: tab?.id ?? null,
    windowSourceId: tab?.windowId ?? null,
    tabIndex: tab?.index ?? null,
    title: tab?.title ?? '',
    url: tab?.url ?? tab?.pendingUrl ?? '',
    isActive: tab?.active === true,
    isSelected: tab?.highlighted === true,
    isPinned: tab?.pinned === true,
    isMuted: tab?.mutedInfo?.muted === true,
    isDiscarded: tab?.discarded === true,
    groupSourceId: Number.isInteger(tab?.groupId) && tab.groupId >= 0 ? tab.groupId : null
  })

  const createChunk = (browserRunId, eventAtMs) => {
    const chunkId = api.createId(eventAtMs)
    return {
      descriptor: {
        chunkId,
        storageKey: api.getEventChunkStorageKey(browserRunId, chunkId),
        browserRunId,
        eventSequenceFirst: null,
        eventSequenceLast: null,
        eventAtFirstMs: null,
        eventAtLastMs: null,
        eventCount: 0,
        isClosed: false
      },
      value: {
        schemaVersion: 1,
        chunkId,
        browserRunId,
        events: []
      }
    }
  }

  const isChunkRollRequired = (chunkValue, event, config) => {
    if (chunkValue.events.length === 0) return false
    const eventFirst = chunkValue.events[0]
    const isAgeReached = event.eventAtMs - eventFirst.eventAtMs >= config.eventChunkAgeMinute * 60000
    const isCountReached = chunkValue.events.length >= config.eventChunkCountMax
    if (isAgeReached || isCountReached) return true
    return api.encodeSizeByte({
      ...chunkValue,
      events: [...chunkValue.events, event]
    }) > config.eventChunkSizeByteMax
  }

  api.appendEvents = async (eventInputs) => {
    if (!Array.isArray(eventInputs) || eventInputs.length === 0) return
    const [config, browserRunId, catalog] = await Promise.all([
      api.getConfig(),
      api.ensureBrowserRunId(),
      api.getEventCatalog()
    ])
    if (!config.isEventLogEnabled) return

    const valuesSet = {}
    let descriptorActive = catalog.chunks.find(
      (chunk) => chunk.chunkId === catalog.chunkActiveId && !chunk.isClosed
    )
    let chunkActive = null
    if (descriptorActive) {
      const result = await chrome.storage.local.get(descriptorActive.storageKey)
      chunkActive = result[descriptorActive.storageKey]
    }
    if (descriptorActive && descriptorActive.browserRunId !== browserRunId) {
      descriptorActive.isClosed = true
      descriptorActive = null
      chunkActive = null
      catalog.chunkActiveId = null
    }
    if (!chunkActive) {
      const created = createChunk(browserRunId, eventInputs[0].eventAtMs)
      descriptorActive = created.descriptor
      chunkActive = created.value
      catalog.chunks.push(descriptorActive)
      catalog.chunkActiveId = descriptorActive.chunkId
    }

    for (const eventInput of eventInputs) {
      const eventAtMs = eventInput.eventAtMs ?? Date.now()
      const event = {
        schemaVersion: 1,
        eventId: `${api.formatTime(eventAtMs)}_${catalog.eventSequenceNext}`,
        browserRunId,
        eventSequence: catalog.eventSequenceNext,
        eventAtMs,
        eventAtText: api.formatTime(eventAtMs),
        ...eventInput
      }
      catalog.eventSequenceNext += 1

      if (isChunkRollRequired(chunkActive, event, config)) {
        descriptorActive.isClosed = true
        valuesSet[descriptorActive.storageKey] = chunkActive
        const created = createChunk(browserRunId, eventAtMs)
        descriptorActive = created.descriptor
        chunkActive = created.value
        catalog.chunks.push(descriptorActive)
        catalog.chunkActiveId = descriptorActive.chunkId
      }

      chunkActive.events.push(event)
      descriptorActive.eventSequenceFirst ??= event.eventSequence
      descriptorActive.eventSequenceLast = event.eventSequence
      descriptorActive.eventAtFirstMs ??= event.eventAtMs
      descriptorActive.eventAtLastMs = event.eventAtMs
      descriptorActive.eventCount = chunkActive.events.length
    }

    valuesSet[descriptorActive.storageKey] = chunkActive
    valuesSet[api.eventCatalogStorageKey] = catalog
    await chrome.storage.local.set(valuesSet)
    api.notifyRecoveryChanged({
      browserRunId,
      eventSequenceLast: descriptorActive.eventSequenceLast,
      changeType: 'events'
    })
  }

  const queueEventInputFlush = () => {
    if (api.isEventInputFlushQueued) return
    api.isEventInputFlushQueued = true
    api.enqueueStorageTask(async () => {
      try {
        while (api.eventInputsPending.length > 0) {
          const eventInputs = api.eventInputsPending.splice(0)
          await api.appendEvents(eventInputs)
        }
      } finally {
        api.isEventInputFlushQueued = false
        if (api.eventInputsPending.length > 0) queueEventInputFlush()
      }
    }).catch((error) => {
      api.recordSnapshotError(error).catch(() => undefined)
    })
  }

  api.recordBrowserEvent = (eventType, eventData = {}) => {
    const eventInput = {
      eventAtMs: Date.now(),
      eventType,
      ...eventData
    }
    if (api.isEventBatchActive) {
      api.eventBatch.push(eventInput)
      return
    }
    api.eventInputsPending.push(eventInput)
    queueEventInputFlush()
  }

  const recordTabUrlChange = (tabId, windowId, url) => {
    const timeNowMs = Date.now()
    const intervalSecond = (
      api.configMemory?.tabUrlEventIntervalSecond ??
      api.snapshotConfigDefault.tabUrlEventIntervalSecond
    )
    const intervalMs = intervalSecond * 1000
    let state = tabUrlEventStateById.get(tabId)
    if (!state || timeNowMs - state.eventLastAtMs >= intervalMs) {
      if (state?.timeoutId) clearTimeout(state.timeoutId)
      state = {
        eventLastAtMs: timeNowMs,
        timeoutId: null,
        urlPending: null,
        windowId
      }
      tabUrlEventStateById.set(tabId, state)
      api.recordBrowserEvent('tabUpdated', {
        tabSourceId: tabId,
        windowSourceId: windowId,
        change: { url }
      })
      return
    }

    state.urlPending = url
    state.windowId = windowId
    if (state.timeoutId) return
    const delayMs = Math.max(0, intervalMs - (timeNowMs - state.eventLastAtMs))
    state.timeoutId = setTimeout(() => {
      const stateCurrent = tabUrlEventStateById.get(tabId)
      if (!stateCurrent?.urlPending) return
      const urlPending = stateCurrent.urlPending
      stateCurrent.urlPending = null
      stateCurrent.timeoutId = null
      stateCurrent.eventLastAtMs = Date.now()
      api.recordBrowserEvent('tabUpdated', {
        tabSourceId: tabId,
        windowSourceId: stateCurrent.windowId,
        change: { url: urlPending }
      })
    }, delayMs)
  }

  api.flushEventBatch = async () => {
    const events = api.eventBatch.splice(0)
    if (events.length > 0) await api.appendEvents(events)
  }

  api.closeEventChunkActive = async () => {
    const catalog = await api.getEventCatalog()
    const descriptor = catalog.chunks.find(
      (chunk) => chunk.chunkId === catalog.chunkActiveId && !chunk.isClosed
    )
    if (descriptor) descriptor.isClosed = true
    catalog.chunkActiveId = null
    await api.setEventCatalog(catalog)
    return catalog.eventSequenceNext - 1
  }

  api.cleanEventChunks = async (snapshotGenerateAtMs, eventOverlapMinute) => {
    const catalog = await api.getEventCatalog()
    const eventDeleteBeforeMs = snapshotGenerateAtMs - eventOverlapMinute * 60000
    const chunksDelete = catalog.chunks.filter((chunk) => (
      chunk.isClosed && chunk.eventAtLastMs !== null && chunk.eventAtLastMs < eventDeleteBeforeMs
    ))
    if (chunksDelete.length === 0) return 0
    await chrome.storage.local.remove(chunksDelete.map((chunk) => chunk.storageKey))
    const chunkIdDeleteSet = new Set(chunksDelete.map((chunk) => chunk.chunkId))
    catalog.chunks = catalog.chunks.filter((chunk) => !chunkIdDeleteSet.has(chunk.chunkId))
    await api.setEventCatalog(catalog)
    return chunksDelete.length
  }

  api.registerEventListeners = () => {
    if (api.isEventListenerRegistered) return
    api.isEventListenerRegistered = true
    chrome.tabs.onCreated.addListener((tab) => {
      api.recordBrowserEvent('tabCreated', { tab: getTabState(tab) })
    })
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (typeof changeInfo.url === 'string') {
        recordTabUrlChange(tabId, tab.windowId, changeInfo.url)
      }
      const keysTracked = [
        'pinned', 'mutedInfo', 'discarded', 'groupId'
      ]
      const change = Object.fromEntries(
        keysTracked.filter((key) => key in changeInfo).map((key) => [key, changeInfo[key]])
      )
      if (Object.keys(change).length === 0) return
      api.recordBrowserEvent('tabUpdated', {
        tabSourceId: tabId,
        windowSourceId: tab.windowId,
        tabIndex: tab.index,
        change
      })
    })
    chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
      api.recordBrowserEvent('tabMoved', { tabSourceId: tabId, ...moveInfo })
    })
    chrome.tabs.onActivated.addListener((activeInfo) => {
      api.recordBrowserEvent('tabActivated', {
        tabSourceId: activeInfo.tabId,
        windowSourceId: activeInfo.windowId,
        tabSourceIdPrevious: activeInfo.previousTabId ?? null
      })
    })
    chrome.tabs.onHighlighted.addListener((highlightInfo) => {
      api.recordBrowserEvent('tabHighlighted', {
        windowSourceId: highlightInfo.windowId,
        tabSourceIds: highlightInfo.tabIds
      })
    })
    chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
      api.recordBrowserEvent('tabAttached', { tabSourceId: tabId, ...attachInfo })
    })
    chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
      api.recordBrowserEvent('tabDetached', { tabSourceId: tabId, ...detachInfo })
    })
    chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
      const urlEventState = tabUrlEventStateById.get(tabId)
      if (urlEventState?.timeoutId) clearTimeout(urlEventState.timeoutId)
      tabUrlEventStateById.delete(tabId)
      api.recordBrowserEvent('tabRemoved', { tabSourceId: tabId, ...removeInfo })
    })
    if (chrome.tabs.onReplaced) {
      chrome.tabs.onReplaced.addListener((tabSourceIdAdded, tabSourceIdRemoved) => {
        api.recordBrowserEvent('tabReplaced', { tabSourceIdAdded, tabSourceIdRemoved })
      })
    }
    if (chrome.tabs.onZoomChange) {
      chrome.tabs.onZoomChange.addListener((zoomChangeInfo) => {
        api.recordBrowserEvent('tabZoomChanged', zoomChangeInfo)
      })
    }

    chrome.windows.onCreated.addListener((windowCreated) => {
      api.recordBrowserEvent('windowCreated', {
        windowSourceId: windowCreated.id,
        windowType: windowCreated.type,
        windowState: windowCreated.state,
        isPrivate: windowCreated.incognito === true
      })
    })
    chrome.windows.onRemoved.addListener((windowSourceId) => {
      api.recordBrowserEvent('windowRemoved', { windowSourceId })
    })
    chrome.windows.onFocusChanged.addListener((windowSourceId) => {
      api.recordBrowserEvent('windowFocusChanged', { windowSourceId })
    })
    if (chrome.windows.onBoundsChanged) {
      chrome.windows.onBoundsChanged.addListener((windowChanged) => {
        api.recordBrowserEvent('windowBoundsChanged', {
          windowSourceId: windowChanged.id,
          left: windowChanged.left,
          top: windowChanged.top,
          width: windowChanged.width,
          height: windowChanged.height,
          windowState: windowChanged.state
        })
      })
    }

    if (chrome.tabGroups) {
      chrome.tabGroups.onCreated?.addListener((group) => {
        api.recordBrowserEvent('tabGroupCreated', { group })
      })
      chrome.tabGroups.onUpdated?.addListener((group) => {
        api.recordBrowserEvent('tabGroupUpdated', { group })
      })
      chrome.tabGroups.onMoved?.addListener((group) => {
        api.recordBrowserEvent('tabGroupMoved', { group })
      })
      chrome.tabGroups.onRemoved?.addListener((group) => {
        api.recordBrowserEvent('tabGroupRemoved', { group })
      })
    }
  }
})()
