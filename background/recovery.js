(() => {
  const api = globalThis.TabSnapshot

  const getWindowCreateData = (windowSnapshot) => {
    const createData = {
      focused: false,
      incognito: windowSnapshot.isPrivate === true
    }
    if (windowSnapshot.windowState === 'normal') {
      for (const key of ['left', 'top', 'width', 'height']) {
        if (Number.isFinite(windowSnapshot[key])) createData[key] = windowSnapshot[key]
      }
    }
    return createData
  }

  const findTabLocation = (state, tabSourceId) => {
    for (const windowItem of state.windows) {
      const tabIndex = windowItem.tabs.findIndex((tab) => tab.tabSourceId === tabSourceId)
      if (tabIndex >= 0) return { windowItem, tabIndex, tab: windowItem.tabs[tabIndex] }
    }
    return null
  }

  const normalizeTabIndexes = (windowItem) => {
    windowItem.tabs.forEach((tab, tabIndex) => {
      tab.tabIndex = tabIndex
    })
  }

  const addReplayMessage = (messages, level, code, text, event = null) => {
    if (!Array.isArray(messages)) return
    messages.push({
      messageId: `${event?.eventSequence ?? 'replay'}:${code}:${messages.length}`,
      level,
      code,
      text,
      eventSequence: event?.eventSequence ?? null,
      eventType: event?.eventType ?? null
    })
  }

  const applyEvent = (state, event, messages = null) => {
    if (!event || typeof event.eventType !== 'string') {
      addReplayMessage(messages, 'error', 'invalid-event', 'Skipped an event without a valid type')
      return
    }
    if (event.eventType === 'windowCreated') {
      if (!Number.isInteger(event.windowSourceId)) {
        addReplayMessage(messages, 'warning', 'window-create-missing-id', 'Kept the current state because a window creation had no valid window ID', event)
        return
      }
      if (state.windows.some((windowItem) => windowItem.windowSourceId === event.windowSourceId)) {
        addReplayMessage(messages, 'log', 'window-create-duplicate', 'A window creation was already reflected in the snapshot', event)
        return
      }
      state.windows.push({
        windowSourceId: event.windowSourceId,
        windowIndex: state.windows.length,
        windowType: event.windowType ?? 'normal',
        windowState: event.windowState ?? 'normal',
        isFocused: false,
        isPrivate: event.isPrivate === true,
        left: null,
        top: null,
        width: null,
        height: null,
        tabActiveSourceId: null,
        tabs: [],
        groups: []
      })
      return
    }
    if (event.eventType === 'windowRemoved') {
      const isWindowFound = state.windows.some(
        (windowItem) => windowItem.windowSourceId === event.windowSourceId
      )
      if (!isWindowFound) {
        addReplayMessage(messages, 'warning', 'window-remove-missing', 'A window to close could not be found, so no window was removed', event)
        return
      }
      state.windows = state.windows.filter(
        (windowItem) => windowItem.windowSourceId !== event.windowSourceId
      )
      if (state.windowFocusedSourceId === event.windowSourceId) {
        state.windowFocusedSourceId = null
        state.tabFocusedSourceId = null
      }
      return
    }
    if (event.eventType === 'windowFocusChanged') {
      state.windowFocusedSourceId = event.windowSourceId
      state.windows.forEach((windowItem) => {
        windowItem.isFocused = windowItem.windowSourceId === event.windowSourceId
      })
      const windowFocused = state.windows.find(
        (windowItem) => windowItem.windowSourceId === event.windowSourceId
      )
      if (!windowFocused && event.windowSourceId !== -1) {
        addReplayMessage(messages, 'warning', 'window-focus-missing', 'The focused window could not be found; existing windows were kept', event)
      }
      state.tabFocusedSourceId = windowFocused?.tabActiveSourceId ?? null
      return
    }
    if (event.eventType === 'windowBoundsChanged') {
      const windowItem = state.windows.find(
        (windowCurrent) => windowCurrent.windowSourceId === event.windowSourceId
      )
      if (!windowItem) {
        addReplayMessage(messages, 'warning', 'window-bounds-missing', 'A window bounds change referred to a missing window and was skipped', event)
        return
      }
      for (const key of ['left', 'top', 'width', 'height', 'windowState']) {
        if (event[key] !== undefined) windowItem[key] = event[key]
      }
      return
    }
    if (event.eventType === 'tabCreated') {
      const tab = event.tab
      const windowItem = state.windows.find(
        (windowCurrent) => windowCurrent.windowSourceId === tab?.windowSourceId
      )
      if (!tab || !windowItem) {
        addReplayMessage(messages, 'warning', 'tab-create-window-missing', 'A tab creation referred to a missing window and was skipped', event)
        return
      }
      if (findTabLocation(state, tab.tabSourceId)) {
        addReplayMessage(messages, 'log', 'tab-create-duplicate', 'A tab creation was already reflected in the snapshot', event)
        return
      }
      const tabIndex = Math.max(0, Math.min(tab.tabIndex ?? windowItem.tabs.length, windowItem.tabs.length))
      windowItem.tabs.splice(tabIndex, 0, api.cloneValue(tab))
      normalizeTabIndexes(windowItem)
      return
    }
    if (event.eventType === 'tabRemoved') {
      const location = findTabLocation(state, event.tabSourceId)
      if (!location) {
        addReplayMessage(messages, 'warning', 'tab-remove-missing', 'A tab to close could not be found, so no tab was removed', event)
        return
      }
      location.windowItem.tabs.splice(location.tabIndex, 1)
      normalizeTabIndexes(location.windowItem)
      if (location.windowItem.tabActiveSourceId === event.tabSourceId) {
        location.windowItem.tabActiveSourceId = location.windowItem.tabs.find(
          (tab) => tab.isActive
        )?.tabSourceId ?? location.windowItem.tabs[0]?.tabSourceId ?? null
        location.windowItem.tabs.forEach((tab) => {
          tab.isActive = tab.tabSourceId === location.windowItem.tabActiveSourceId
        })
      }
      if (state.tabFocusedSourceId === event.tabSourceId) {
        state.tabFocusedSourceId = location.windowItem.tabActiveSourceId
      }
      return
    }
    if (event.eventType === 'tabUpdated') {
      const location = findTabLocation(state, event.tabSourceId)
      if (!location) {
        addReplayMessage(messages, 'warning', 'tab-update-missing', 'A tab update referred to a missing tab and was skipped', event)
        return
      }
      const changeNameMap = {
        pinned: 'isPinned',
        discarded: 'isDiscarded',
        groupId: 'groupSourceId'
      }
      for (const [key, value] of Object.entries(event.change ?? {})) {
        const keyTarget = changeNameMap[key] ?? key
        if (key === 'mutedInfo') {
          location.tab.isMuted = value?.muted === true
        } else {
          location.tab[keyTarget] = value
        }
      }
      if (Number.isInteger(event.tabIndex) && event.tabIndex !== location.tabIndex) {
        const [tab] = location.windowItem.tabs.splice(location.tabIndex, 1)
        const tabIndexNext = Math.max(
          0,
          Math.min(event.tabIndex, location.windowItem.tabs.length)
        )
        location.windowItem.tabs.splice(tabIndexNext, 0, tab)
        normalizeTabIndexes(location.windowItem)
      }
      return
    }
    if (event.eventType === 'tabMoved') {
      const location = findTabLocation(state, event.tabSourceId)
      if (!location) {
        addReplayMessage(messages, 'warning', 'tab-move-missing', 'A tab to move could not be found, so existing tab order was kept', event)
        return
      }
      const [tab] = location.windowItem.tabs.splice(location.tabIndex, 1)
      const indexNext = Number.isInteger(event.toIndex)
        ? Math.max(0, Math.min(event.toIndex, location.windowItem.tabs.length))
        : location.tabIndex
      if (indexNext !== event.toIndex) {
        addReplayMessage(messages, 'warning', 'tab-move-index-invalid', 'A tab move position was invalid and was limited to the known tab range', event)
      }
      location.windowItem.tabs.splice(indexNext, 0, tab)
      normalizeTabIndexes(location.windowItem)
      return
    }
    if (event.eventType === 'tabAttached') {
      const location = findTabLocation(state, event.tabSourceId)
      const windowNext = state.windows.find(
        (windowItem) => windowItem.windowSourceId === event.newWindowId
      )
      if (!location || !windowNext) {
        addReplayMessage(messages, 'warning', 'tab-attach-missing', 'A tab attachment could not be matched safely, so the existing tab was kept in place', event)
        return
      }
      const [tab] = location.windowItem.tabs.splice(location.tabIndex, 1)
      normalizeTabIndexes(location.windowItem)
      tab.windowSourceId = event.newWindowId
      const positionNext = Number.isInteger(event.newPosition)
        ? Math.max(0, Math.min(event.newPosition, windowNext.tabs.length))
        : windowNext.tabs.length
      windowNext.tabs.splice(positionNext, 0, tab)
      normalizeTabIndexes(windowNext)
      return
    }
    if (event.eventType === 'tabDetached') {
      if (!findTabLocation(state, event.tabSourceId)) {
        addReplayMessage(messages, 'warning', 'tab-detach-missing', 'A detached tab could not be found; no tab was removed', event)
      }
      return
    }
    if (event.eventType === 'tabActivated') {
      const windowItem = state.windows.find(
        (windowCurrent) => windowCurrent.windowSourceId === event.windowSourceId
      )
      if (!windowItem || !findTabLocation(state, event.tabSourceId)) {
        addReplayMessage(messages, 'warning', 'tab-activate-missing', 'An active-tab change referred to a missing window or tab and was skipped', event)
        return
      }
      windowItem.tabActiveSourceId = event.tabSourceId
      windowItem.tabs.forEach((tab) => {
        tab.isActive = tab.tabSourceId === event.tabSourceId
      })
      if (state.windowFocusedSourceId === event.windowSourceId) {
        state.tabFocusedSourceId = event.tabSourceId
      }
      return
    }
    if (event.eventType === 'tabHighlighted') {
      const tabSourceIdSet = new Set(event.tabSourceIds ?? [])
      const windowItem = state.windows.find(
        (windowCurrent) => windowCurrent.windowSourceId === event.windowSourceId
      )
      if (!windowItem) {
        addReplayMessage(messages, 'warning', 'tab-highlight-window-missing', 'A tab selection change referred to a missing window and was skipped', event)
        return
      }
      windowItem.tabs.forEach((tab) => {
        tab.isSelected = tabSourceIdSet.has(tab.tabSourceId)
      })
      return
    }
    if (event.eventType === 'tabReplaced') {
      const location = findTabLocation(state, event.tabSourceIdRemoved)
      if (location) {
        location.tab.tabSourceId = event.tabSourceIdAdded
      } else {
        addReplayMessage(messages, 'warning', 'tab-replace-missing', 'A replaced tab could not be found, so existing tabs were kept', event)
      }
      return
    }
    if (event.eventType.startsWith('tabGroup')) {
      const group = event.group
      if (!group) return
      const windowItem = state.windows.find(
        (windowCurrent) => windowCurrent.windowSourceId === group.windowId
      )
      if (!windowItem) {
        addReplayMessage(messages, 'warning', 'tab-group-window-missing', 'A tab-group change referred to a missing window and was skipped', event)
        return
      }
      if (event.eventType === 'tabGroupRemoved') {
        windowItem.groups = windowItem.groups.filter(
          (groupCurrent) => groupCurrent.groupSourceId !== group.id
        )
        windowItem.tabs.forEach((tab) => {
          if (tab.groupSourceId === group.id) tab.groupSourceId = null
        })
        return
      }
      const groupNext = {
        groupSourceId: group.id,
        title: group.title ?? '',
        color: group.color ?? null,
        isCollapsed: group.collapsed === true
      }
      const groupIndex = windowItem.groups.findIndex(
        (groupCurrent) => groupCurrent.groupSourceId === group.id
      )
      if (groupIndex >= 0) windowItem.groups[groupIndex] = groupNext
      else windowItem.groups.push(groupNext)
      return
    }
    if (event.eventType === 'browserRunStarted' || event.eventType === 'tabZoomChanged') return
    addReplayMessage(messages, 'warning', 'event-type-unsupported', `Kept existing state because ${event.eventType} is not supported by recovery`, event)
  }

  api.applyEventToState = applyEvent

  const getLatestValidSnapshot = async (snapshotId) => {
    if (snapshotId) return api.getSnapshot(snapshotId)
    const catalog = await api.getSnapshotCatalog()
    for (const snapshotItem of catalog.snapshotItems) {
      try {
        return await api.getSnapshot(snapshotItem.snapshotId)
      } catch {
        continue
      }
    }
    throw new Error('No complete snapshot is available for recovery')
  }

  api.getRecoverySource = async (snapshotId = null) => {
    const snapshot = await getLatestValidSnapshot(snapshotId)
    const eventCatalog = await api.getEventCatalog()
    const chunks = eventCatalog.chunks.filter((chunk) => (
      chunk.browserRunId === snapshot.browserRunId &&
      chunk.eventSequenceLast > snapshot.eventSequenceCutoff
    ))
    const chunkResult = chunks.length > 0
      ? await chrome.storage.local.get(chunks.map((chunk) => chunk.storageKey))
      : {}
    const messages = []
    for (const chunk of chunks) {
      if (!Array.isArray(chunkResult[chunk.storageKey]?.events)) {
        addReplayMessage(
          messages,
          'error',
          'event-chunk-missing',
          `Event records ${chunk.eventSequenceFirst} to ${chunk.eventSequenceLast} could not be loaded`
        )
      }
    }
    const events = chunks
      .flatMap((chunk) => chunkResult[chunk.storageKey]?.events ?? [])
      .filter((event) => (
        event.browserRunId === snapshot.browserRunId &&
        event.eventSequence > snapshot.eventSequenceCutoff
      ))
      .sort((eventA, eventB) => eventA.eventSequence - eventB.eventSequence)
    return {
      snapshot,
      events,
      messages,
      eventSequenceLast: events.at(-1)?.eventSequence ?? snapshot.eventSequenceCutoff
    }
  }

  api.replayRecovery = async (snapshotId = null, eventSequenceEnd = null) => {
    const source = await api.getRecoverySource(snapshotId)
    const { snapshot } = source
    if (
      eventSequenceEnd !== null &&
      (
        !Number.isInteger(eventSequenceEnd) ||
        eventSequenceEnd < snapshot.eventSequenceCutoff ||
        (
          eventSequenceEnd > snapshot.eventSequenceCutoff &&
          !source.events.some((event) => event.eventSequence === eventSequenceEnd)
        )
      )
    ) {
      throw new Error('The selected recovery event is no longer available')
    }
    const events = eventSequenceEnd === null
      ? source.events
      : source.events.filter((event) => event.eventSequence <= eventSequenceEnd)
    const messages = [...source.messages]
    const stateRecovered = api.cloneValue(snapshot)
    const sequenceSeen = new Set()
    let eventSequenceExpected = snapshot.eventSequenceCutoff + 1
    for (const event of events) {
      if (!Number.isInteger(event.eventSequence)) {
        addReplayMessage(messages, 'error', 'event-sequence-invalid', 'Skipped an event without a valid sequence', event)
        continue
      }
      if (sequenceSeen.has(event.eventSequence)) {
        addReplayMessage(messages, 'warning', 'event-sequence-duplicate', 'Skipped a duplicate event sequence', event)
        continue
      }
      if (event.eventSequence > eventSequenceExpected) {
        addReplayMessage(
          messages,
          'warning',
          'event-sequence-gap',
          `Event sequence ${eventSequenceExpected} to ${event.eventSequence - 1} is unavailable; existing tabs are kept when later events are uncertain`,
          event
        )
      }
      sequenceSeen.add(event.eventSequence)
      eventSequenceExpected = Math.max(eventSequenceExpected, event.eventSequence + 1)
      try {
        applyEvent(stateRecovered, event, messages)
      } catch (error) {
        addReplayMessage(
          messages,
          'error',
          'event-apply-failed',
          `Event could not be applied: ${api.toErrorText(error)}`,
          event
        )
      }
    }
    stateRecovered.windows.forEach((windowItem, windowIndex) => {
      windowItem.windowIndex = windowIndex
      normalizeTabIndexes(windowItem)
    })
    stateRecovered.metadata.windowCountTotal = stateRecovered.windows.length
    stateRecovered.metadata.tabCountTotal = stateRecovered.windows.reduce(
      (count, windowItem) => count + windowItem.tabs.length,
      0
    )
    return {
      snapshot,
      events: source.events,
      stateRecovered,
      messages,
      eventSequenceLast: eventSequenceEnd ?? source.eventSequenceLast
    }
  }

  api.getRecoveredState = async (snapshotId) => (
    (await api.replayRecovery(snapshotId)).stateRecovered
  )

  const restoreWindow = async (windowSnapshot, isBatchRestore) => {
    const tabIdBySourceId = new Map()
    const errors = []
    let windowCreated

    if (isBatchRestore && windowSnapshot.tabs.length > 0) {
      windowCreated = await chrome.windows.create({
        ...getWindowCreateData(windowSnapshot),
        url: windowSnapshot.tabs.map((tab) => tab.url || 'about:blank')
      })
      const tabsCreated = (
        windowCreated.tabs?.length === windowSnapshot.tabs.length
          ? windowCreated.tabs
          : await chrome.tabs.query({ windowId: windowCreated.id })
      ).sort((tabA, tabB) => tabA.index - tabB.index)
      windowSnapshot.tabs.forEach((tabSnapshot, index) => {
        const tabCreated = tabsCreated[index]
        if (Number.isInteger(tabCreated?.id)) {
          tabIdBySourceId.set(tabSnapshot.tabSourceId, tabCreated.id)
        } else {
          errors.push({
            tabSourceId: tabSnapshot.tabSourceId,
            errorText: 'Batch restore did not return the created tab'
          })
        }
      })
      await Promise.all(windowSnapshot.tabs.map(async (tabSnapshot) => {
        if (tabSnapshot.isPinned !== true) return
        const tabId = tabIdBySourceId.get(tabSnapshot.tabSourceId)
        if (!Number.isInteger(tabId)) return
        try {
          await chrome.tabs.update(tabId, { pinned: true })
        } catch (error) {
          errors.push({
            tabSourceId: tabSnapshot.tabSourceId,
            errorText: api.toErrorText(error)
          })
        }
      }))
    } else {
      windowCreated = await chrome.windows.create(getWindowCreateData(windowSnapshot))
      const tabCreatedDefault = windowCreated.tabs?.[0]

      for (let index = 0; index < windowSnapshot.tabs.length; index += 1) {
        const tabSnapshot = windowSnapshot.tabs[index]
        try {
          let tabCreated
          if (index === 0 && tabCreatedDefault) {
            tabCreated = await chrome.tabs.update(tabCreatedDefault.id, {
              url: tabSnapshot.url || undefined,
              pinned: tabSnapshot.isPinned === true
            })
          } else {
            tabCreated = await chrome.tabs.create({
              windowId: windowCreated.id,
              index,
              url: tabSnapshot.url || undefined,
              active: false,
              pinned: tabSnapshot.isPinned === true
            })
          }
          tabIdBySourceId.set(tabSnapshot.tabSourceId, tabCreated.id)
        } catch (error) {
          errors.push({
            tabSourceId: tabSnapshot.tabSourceId,
            errorText: api.toErrorText(error)
          })
        }
      }
    }

    const tabIdsOrdered = windowSnapshot.tabs
      .map((tab) => tabIdBySourceId.get(tab.tabSourceId))
      .filter(Number.isInteger)
    let isBatchOrderApplied = false
    if (isBatchRestore) {
      const tabIdsPinned = windowSnapshot.tabs
        .filter((tab) => tab.isPinned === true)
        .map((tab) => tabIdBySourceId.get(tab.tabSourceId))
        .filter(Number.isInteger)
      const tabIdsUnpinned = windowSnapshot.tabs
        .filter((tab) => tab.isPinned !== true)
        .map((tab) => tabIdBySourceId.get(tab.tabSourceId))
        .filter(Number.isInteger)
      try {
        if (tabIdsPinned.length > 0) {
          await chrome.tabs.move(tabIdsPinned, { windowId: windowCreated.id, index: 0 })
        }
        if (tabIdsUnpinned.length > 0) {
          await chrome.tabs.move(tabIdsUnpinned, {
            windowId: windowCreated.id,
            index: tabIdsPinned.length
          })
        }
        isBatchOrderApplied = true
      } catch {
        isBatchOrderApplied = false
      }
    }
    if (!isBatchOrderApplied) {
      for (let index = 0; index < tabIdsOrdered.length; index += 1) {
        try {
          await chrome.tabs.move(tabIdsOrdered[index], {
            windowId: windowCreated.id,
            index
          })
        } catch (error) {
          errors.push({
            tabOrder: true,
            tabId: tabIdsOrdered[index],
            errorText: api.toErrorText(error)
          })
        }
      }
    }

    if (chrome.tabs.group && chrome.tabGroups) {
      for (const groupSnapshot of windowSnapshot.groups ?? []) {
        const tabIds = windowSnapshot.tabs
          .filter((tab) => tab.groupSourceId === groupSnapshot.groupSourceId)
          .map((tab) => tabIdBySourceId.get(tab.tabSourceId))
          .filter(Number.isInteger)
        if (tabIds.length === 0) continue
        try {
          const groupId = await chrome.tabs.group({
            tabIds,
            createProperties: { windowId: windowCreated.id }
          })
          await chrome.tabGroups.update(groupId, {
            title: groupSnapshot.title,
            color: groupSnapshot.color,
            collapsed: groupSnapshot.isCollapsed
          })
        } catch (error) {
          errors.push({
            groupSourceId: groupSnapshot.groupSourceId,
            errorText: api.toErrorText(error)
          })
        }
      }
    }

    const tabIndexesSelected = windowSnapshot.tabs
      .filter((tab) => tab.isSelected && tabIdBySourceId.has(tab.tabSourceId))
      .map((tab) => tabIdsOrdered.indexOf(tabIdBySourceId.get(tab.tabSourceId)))
      .filter((tabIndex) => tabIndex >= 0)
    if (tabIndexesSelected.length > 0) {
      try {
        await chrome.tabs.highlight({
          windowId: windowCreated.id,
          tabs: tabIndexesSelected
        })
      } catch (error) {
        errors.push({ selection: true, errorText: api.toErrorText(error) })
      }
    }

    const tabActiveId = tabIdBySourceId.get(windowSnapshot.tabActiveSourceId)
    if (tabActiveId !== undefined) {
      try {
        await chrome.tabs.update(tabActiveId, { active: true })
      } catch (error) {
        errors.push({ activeTab: true, errorText: api.toErrorText(error) })
      }
    }
    if (windowSnapshot.windowState && windowSnapshot.windowState !== 'normal') {
      try {
        await chrome.windows.update(windowCreated.id, { state: windowSnapshot.windowState })
      } catch (error) {
        errors.push({ windowState: true, errorText: api.toErrorText(error) })
      }
    }

    return {
      windowCreatedId: windowCreated.id,
      windowSourceId: windowSnapshot.windowSourceId,
      tabIdBySourceId,
      errors
    }
  }

  const restoreState = async (snapshot, isBatchRestore = false) => {
    api.isTabPositioningSuppressed = true
    api.isEventBatchActive = true
    api.eventBatch = []
    const windowResultList = []
    const errors = []
    try {
      for (const windowSnapshot of snapshot.windows) {
        try {
          windowResultList.push(await restoreWindow(windowSnapshot, isBatchRestore))
        } catch (error) {
          errors.push({
            windowSourceId: windowSnapshot.windowSourceId,
            errorText: api.toErrorText(error)
          })
        }
      }

      const windowFocusedResult = windowResultList.find(
        (result) => result.windowSourceId === snapshot.windowFocusedSourceId
      )
      if (windowFocusedResult) {
        try {
          await chrome.windows.update(windowFocusedResult.windowCreatedId, { focused: true })
        } catch (error) {
          errors.push({ windowFocus: true, errorText: api.toErrorText(error) })
        }
      }
    } finally {
      api.isEventBatchActive = false
      api.isTabPositioningSuppressed = false
      await api.flushEventBatch()
    }

    // One immediate checkpoint compacts the restore event burst without losing it.
    await api.createSnapshotNow()
    return {
      windowCountCreated: windowResultList.length,
      tabCountCreated: windowResultList.reduce(
        (count, result) => count + result.tabIdBySourceId.size,
        0
      ),
      errors: [
        ...errors,
        ...windowResultList.flatMap((result) => result.errors)
      ]
    }
  }

  api.restoreSnapshot = (snapshotId, isBatchRestore = false) => api.enqueueStorageTask(async () => {
    const snapshot = await api.getSnapshot(snapshotId)
    return restoreState(snapshot, isBatchRestore)
  })

  api.restoreRecoveredState = (
    snapshotId,
    eventSequenceLast,
    isBatchRestore = false
  ) => api.enqueueStorageTask(async () => {
    const replayResult = await api.replayRecovery(snapshotId, eventSequenceLast)
    if (replayResult.eventSequenceLast !== eventSequenceLast) {
      throw new Error('Recovery events changed. Replay the events again before restoring')
    }
    const restoreResult = await restoreState(replayResult.stateRecovered, isBatchRestore)
    return {
      ...restoreResult,
      replayMessages: replayResult.messages
    }
  })
})()
