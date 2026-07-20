(() => {
  const api = globalThis.TabSnapshot

  const getGroupDataById = async (config) => {
    const groupDataById = new Map()
    if (!config.isTabGroupIncluded || !chrome.tabGroups?.query) return groupDataById
    try {
      const groups = await chrome.tabGroups.query({})
      for (const group of groups) {
        groupDataById.set(group.id, {
          groupSourceId: group.id,
          title: group.title ?? '',
          color: group.color ?? null,
          isCollapsed: group.collapsed === true
        })
      }
    } catch {
      return groupDataById
    }
    return groupDataById
  }

  const getTabData = (tab, config) => ({
    tabSourceId: tab.id,
    tabIndex: tab.index,
    title: tab.title ?? '',
    url: tab.url ?? tab.pendingUrl ?? '',
    isActive: tab.active === true,
    isSelected: config.isTabSelectionIncluded ? tab.highlighted === true : false,
    isPinned: tab.pinned === true,
    groupSourceId: (
      config.isTabGroupIncluded && Number.isInteger(tab.groupId) && tab.groupId >= 0
        ? tab.groupId
        : null
    )
  })

  api.captureSnapshotData = async (config, eventSequenceCutoff) => {
    const snapshotCaptureStartAtMs = Date.now()
    const [windowsAll, groupDataById, browserRunId] = await Promise.all([
      chrome.windows.getAll({ populate: true }),
      getGroupDataById(config),
      api.ensureBrowserRunId()
    ])
    const windowsIncluded = windowsAll.filter((windowItem) => (
      windowItem.type === 'normal' && (config.isPrivateIncluded || !windowItem.incognito)
    ))

    let windowFocusedSourceId = null
    let tabFocusedSourceId = null
    let tabCountTotal = 0
    const windows = windowsIncluded.map((windowItem, windowIndex) => {
      const tabs = (windowItem.tabs ?? [])
        .sort((tabA, tabB) => tabA.index - tabB.index)
        .map((tab) => getTabData(tab, config))
      tabCountTotal += tabs.length
      const tabActive = tabs.find((tab) => tab.isActive)
      if (windowItem.focused) {
        windowFocusedSourceId = windowItem.id
        tabFocusedSourceId = tabActive?.tabSourceId ?? null
      }
      const groupIds = new Set(tabs.map((tab) => tab.groupSourceId).filter((id) => id !== null))
      const groups = [...groupIds]
        .map((groupId) => groupDataById.get(groupId))
        .filter(Boolean)
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

    const snapshotGenerateAtMs = Date.now()
    const snapshotId = api.createId(snapshotGenerateAtMs)
    const snapshot = {
      schemaVersion: 1,
      snapshotId,
      browserRunId,
      snapshotGenerateAtMs,
      snapshotGenerateAtText: api.formatTime(snapshotGenerateAtMs),
      snapshotCaptureStartAtMs,
      snapshotCaptureEndAtMs: snapshotGenerateAtMs,
      eventSequenceCutoff,
      windowFocusedSourceId,
      tabFocusedSourceId,
      metadata: {
        windowCountTotal: windows.length,
        tabCountTotal,
        snapshotSizeByte: 0,
        isPrivateIncluded: config.isPrivateIncluded,
        isTabGroupIncluded: config.isTabGroupIncluded && groupDataById.size > 0,
        isTabSelectionIncluded: config.isTabSelectionIncluded
      },
      windows
    }
    const snapshotSizeInput = api.cloneValue(snapshot)
    delete snapshotSizeInput.metadata.snapshotSizeByte
    snapshot.metadata.snapshotSizeByte = api.encodeSizeByte(snapshotSizeInput)
    return snapshot
  }

  api.createSnapshotNow = async () => {
    const config = await api.getConfig()
    const eventSequenceCutoff = await api.closeEventChunkActive()
    const snapshot = await api.captureSnapshotData(config, eventSequenceCutoff)
    const storageKey = api.getSnapshotStorageKey(snapshot.snapshotId)

    await chrome.storage.local.set({ [storageKey]: snapshot })
    const resultVerify = await chrome.storage.local.get(storageKey)
    if (resultVerify[storageKey]?.snapshotId !== snapshot.snapshotId) {
      throw new Error('Snapshot validation failed after storage write')
    }

    const catalog = await api.getSnapshotCatalog()
    catalog.snapshotItems.unshift({
      snapshotId: snapshot.snapshotId,
      storageKey,
      browserRunId: snapshot.browserRunId,
      snapshotGenerateAtMs: snapshot.snapshotGenerateAtMs,
      snapshotGenerateAtText: snapshot.snapshotGenerateAtText,
      windowCountTotal: snapshot.metadata.windowCountTotal,
      tabCountTotal: snapshot.metadata.tabCountTotal,
      snapshotSizeByte: snapshot.metadata.snapshotSizeByte
    })
    await api.setSnapshotCatalog(catalog)

    await api.cleanSnapshotsByRetention()
    await api.cleanEventChunks(snapshot.snapshotGenerateAtMs, config.eventOverlapMinute)
    const maintenance = await api.refreshStorageUsage()
    await api.updateMaintenance({
      ...maintenance,
      snapshotLastSuccessAtMs: snapshot.snapshotGenerateAtMs,
      snapshotLastSuccessAtText: snapshot.snapshotGenerateAtText,
      snapshotLastErrorAtMs: null,
      snapshotLastErrorText: null
    })
    api.notifyRecoveryChanged({
      browserRunId: snapshot.browserRunId,
      snapshotId: snapshot.snapshotId,
      changeType: 'snapshot'
    })
    return snapshot
  }

  api.createSnapshot = () => api.enqueueStorageTask(async () => {
    try {
      return await api.createSnapshotNow()
    } catch (error) {
      await api.recordSnapshotError(error)
      throw error
    }
  })
})()
