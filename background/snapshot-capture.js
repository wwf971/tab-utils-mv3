(() => {
  const api = globalThis.TabSnapshot

  api.captureSnapshotData = async (config, eventSequenceCutoff) => {
    const tree = await api.refreshBrowserState()
    const snapshotGenerateAtMs = Date.now()
    const snapshotId = api.createId(snapshotGenerateAtMs)
    const snapshot = {
      schemaVersion: 1,
      snapshotId,
      browserRunId: tree.browserRunId,
      snapshotGenerateAtMs,
      snapshotGenerateAtText: api.formatTime(snapshotGenerateAtMs),
      snapshotCaptureStartAtMs: tree.stateObserveStartAtMs,
      snapshotCaptureEndAtMs: snapshotGenerateAtMs,
      eventSequenceCutoff,
      windowFocusedSourceId: tree.windowFocusedSourceId,
      tabFocusedSourceId: tree.tabFocusedSourceId,
      metadata: {
        ...tree.metadata,
        snapshotSizeByte: 0,
      },
      windows: tree.windows
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
      snapshotSizeByte: snapshot.metadata.snapshotSizeByte,
      isPinned: false
    })
    await api.setSnapshotCatalog(catalog)

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
