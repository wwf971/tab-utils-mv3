(() => {
  const api = globalThis.TabSnapshot

  api.getSnapshotCatalog = async () => {
    const result = await chrome.storage.local.get(api.snapshotCatalogStorageKey)
    const catalog = result[api.snapshotCatalogStorageKey]
    if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.snapshotItems)) {
      return api.getSnapshotCatalogEmpty()
    }
    return catalog
  }

  api.setSnapshotCatalog = async (catalog) => {
    await chrome.storage.local.set({ [api.snapshotCatalogStorageKey]: catalog })
  }

  api.getEventCatalog = async () => {
    const result = await chrome.storage.local.get(api.eventCatalogStorageKey)
    const catalog = result[api.eventCatalogStorageKey]
    if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.chunks)) {
      return api.getEventCatalogEmpty()
    }
    return catalog
  }

  api.setEventCatalog = async (catalog) => {
    await chrome.storage.local.set({ [api.eventCatalogStorageKey]: catalog })
  }

  api.getMaintenance = async () => {
    const result = await chrome.storage.local.get(api.maintenanceStorageKey)
    const maintenance = result[api.maintenanceStorageKey]
    return maintenance?.schemaVersion === 1
      ? { ...api.getMaintenanceEmpty(), ...maintenance }
      : api.getMaintenanceEmpty()
  }

  api.updateMaintenance = async (changes) => {
    const maintenanceCurrent = await api.getMaintenance()
    const maintenanceNext = { ...maintenanceCurrent, ...(changes ?? {}), schemaVersion: 1 }
    await chrome.storage.local.set({ [api.maintenanceStorageKey]: maintenanceNext })
    return maintenanceNext
  }

  api.ensureBrowserRunId = async () => {
    if (api.browserRunIdMemory) return api.browserRunIdMemory
    if (api.browserRunIdPromise) return api.browserRunIdPromise
    api.browserRunIdPromise = (async () => {
      if (chrome.storage.session) {
        const result = await chrome.storage.session.get(api.runtimeStorageKey)
        const runtimeState = result[api.runtimeStorageKey]
        if (runtimeState?.browserRunId) {
          api.browserRunIdMemory = runtimeState.browserRunId
          return api.browserRunIdMemory
        }
      }

      api.browserRunIdMemory = api.createId()
      if (chrome.storage.session) {
        await chrome.storage.session.set({
          [api.runtimeStorageKey]: {
            schemaVersion: 1,
            browserRunId: api.browserRunIdMemory
          }
        })
      }
      return api.browserRunIdMemory
    })()
    return api.browserRunIdPromise
  }

  api.getSnapshot = async (snapshotId) => {
    const storageKey = api.getSnapshotStorageKey(snapshotId)
    const result = await chrome.storage.local.get(storageKey)
    const snapshot = result[storageKey]
    if (snapshot?.schemaVersion !== 1 || snapshot.snapshotId !== snapshotId) {
      throw new Error('Snapshot is missing or invalid')
    }
    return snapshot
  }

  api.deleteSnapshots = async (snapshotIds) => {
    const snapshotIdSet = new Set(snapshotIds ?? [])
    if (snapshotIdSet.size === 0) return api.getSnapshotCatalog()

    const catalog = await api.getSnapshotCatalog()
    const itemsDelete = catalog.snapshotItems.filter((item) => snapshotIdSet.has(item.snapshotId))
    if (itemsDelete.length === 0) return catalog

    await chrome.storage.local.remove(itemsDelete.map((item) => item.storageKey))
    const catalogNext = {
      ...catalog,
      snapshotItems: catalog.snapshotItems.filter((item) => !snapshotIdSet.has(item.snapshotId))
    }
    await api.setSnapshotCatalog(catalogNext)
    await api.refreshStorageUsage()
    api.notifyRecoveryChanged({ changeType: 'snapshot-delete' })
    return catalogNext
  }

  api.getBytesInUseSafe = async (keys) => {
    if (typeof chrome.storage.local.getBytesInUse === 'function') {
      return {
        byteCount: await chrome.storage.local.getBytesInUse(keys),
        isEstimated: false
      }
    }
    const result = await chrome.storage.local.get(keys)
    return {
      byteCount: api.encodeSizeByte(result),
      isEstimated: true
    }
  }

  api.refreshStorageUsage = async () => {
    const [snapshotCatalog, eventCatalog, config] = await Promise.all([
      api.getSnapshotCatalog(),
      api.getEventCatalog(),
      api.getConfig()
    ])
    const snapshotKeys = [
      api.snapshotCatalogStorageKey,
      ...snapshotCatalog.snapshotItems.map((item) => item.storageKey)
    ]
    const eventKeys = [
      api.eventCatalogStorageKey,
      ...eventCatalog.chunks.map((chunk) => chunk.storageKey)
    ]
    const [snapshotSize, eventSize, totalSize] = await Promise.all([
      api.getBytesInUseSafe(snapshotKeys),
      api.getBytesInUseSafe(eventKeys),
      api.getBytesInUseSafe(null)
    ])

    return api.updateMaintenance({
      snapshotCount: snapshotCatalog.snapshotItems.length,
      eventCount: eventCatalog.chunks.reduce(
        (count, chunk) => count + Number(chunk.eventCount ?? 0),
        0
      ),
      snapshotStorageByte: snapshotSize.byteCount,
      eventStorageByte: eventSize.byteCount,
      storageTotalByte: totalSize.byteCount,
      storageWarningByte: config.storageWarningByte,
      isStorageWarning: snapshotSize.byteCount >= config.storageWarningByte,
      isStorageSizeEstimated: snapshotSize.isEstimated || eventSize.isEstimated || totalSize.isEstimated
    })
  }

  api.recordSnapshotError = async (error) => {
    const timeMs = Date.now()
    await api.updateMaintenance({
      snapshotLastErrorAtMs: timeMs,
      snapshotLastErrorText: api.toErrorText(error)
    })
  }

  api.getSnapshotState = async () => {
    const [config, catalog, maintenance] = await Promise.all([
      api.getConfig(),
      api.getSnapshotCatalog(),
      api.getMaintenance()
    ])
    return {
      config,
      snapshots: catalog.snapshotItems,
      maintenance
    }
  }
})()
