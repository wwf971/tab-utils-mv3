(() => {
  const snapshotConfigDefault = {
    schemaVersion: 1,
    isSnapshotEnabled: true,
    isEventLogEnabled: true,
    snapshotIntervalMinute: 5,
    cleanIntervalMinute: 10,
    isPrivateIncluded: false,
    isTabGroupIncluded: true,
    isTabSelectionIncluded: true,
    tabUrlEventIntervalSecond: 10,
    eventOverlapMinute: 1,
    eventChunkAgeMinute: 1,
    eventChunkCountMax: 256,
    eventChunkSizeByteMax: 262144,
    storageWarningByte: 8388608,
    retentionTiers: [
      { ageMaxMinute: 60, spacingMinMinute: 4 },
      { ageMaxMinute: 1440, spacingMinMinute: 55 },
      { ageMaxMinute: 10080, spacingMinMinute: 1380 },
      { ageMaxMinute: 43200, spacingMinMinute: 10020 },
      { ageMaxMinute: null, spacingMinMinute: 43140 }
    ]
  }

  const api = {
    alarmName: 'snapshot-create',
    alarmNameClean: 'snapshot-clean',
    configStorageKey: 'snapshotConfigV1',
    eventCatalogStorageKey: 'eventCatalogV1',
    maintenanceStorageKey: 'snapshotMaintenanceV1',
    runtimeStorageKey: 'snapshotRuntimeV1',
    snapshotCatalogStorageKey: 'snapshotCatalogV1',
    snapshotConfigDefault,
    eventBatch: [],
    isEventBatchActive: false,
    isEventListenerRegistered: false,
    isSnapshotMainRegistered: false,
    isTabPositioningSuppressed: false,
    storageTaskCurrent: Promise.resolve(),
    browserRunIdMemory: null,
    browserRunIdPromise: null
  }

  api.cloneValue = (value) => JSON.parse(JSON.stringify(value))

  api.encodeSizeByte = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength

  api.enqueueStorageTask = (operation) => {
    const task = api.storageTaskCurrent.then(operation, operation)
    api.storageTaskCurrent = task.catch(() => undefined)
    return task
  }

  api.notifyRecoveryChanged = (change = {}) => {
    Promise.resolve(chrome.runtime.sendMessage({
      action: 'snapshotRecoveryChanged',
      ...change
    })).catch(() => undefined)
  }

  api.formatTime = (timeMs = Date.now()) => {
    const date = new Date(timeMs)
    const part = (value, length = 2) => String(value).padStart(length, '0')
    const timezoneHour = Math.round(-date.getTimezoneOffset() / 60)
    const timezoneSign = timezoneHour >= 0 ? '+' : '-'
    const timezoneText = `${timezoneSign}${part(Math.abs(timezoneHour))}`
    return [
      part(date.getFullYear(), 4),
      part(date.getMonth() + 1),
      part(date.getDate()),
      '_',
      part(date.getHours()),
      part(date.getMinutes()),
      part(date.getSeconds()),
      part(Math.floor(date.getMilliseconds() / 10)),
      timezoneText
    ].join('')
  }

  api.createId = (timeMs = Date.now()) => {
    const randomText = crypto.getRandomValues(new Uint32Array(1))[0].toString(16).padStart(8, '0')
    return `${api.formatTime(timeMs)}_${randomText}`
  }

  api.getSnapshotStorageKey = (snapshotId) => `snapshotDataV1:${snapshotId}`

  api.getEventChunkStorageKey = (browserRunId, chunkId) => (
    `eventChunkV1:${browserRunId}:${chunkId}`
  )

  api.getSnapshotCatalogEmpty = () => ({
    schemaVersion: 1,
    snapshotItems: []
  })

  api.getEventCatalogEmpty = () => ({
    schemaVersion: 1,
    eventSequenceNext: 1,
    chunkActiveId: null,
    chunks: []
  })

  api.getMaintenanceEmpty = () => ({
    schemaVersion: 1,
    snapshotLastSuccessAtMs: null,
    snapshotLastSuccessAtText: null,
    snapshotLastErrorAtMs: null,
    snapshotLastErrorText: null,
    retentionLastAtMs: null,
    snapshotCount: 0,
    eventCount: 0,
    snapshotStorageByte: 0,
    eventStorageByte: 0,
    storageTotalByte: 0,
    storageWarningByte: snapshotConfigDefault.storageWarningByte,
    isStorageWarning: false,
    isStorageSizeEstimated: false
  })

  api.toErrorText = (error) => {
    if (error instanceof Error) return error.message.slice(0, 300)
    return String(error).slice(0, 300)
  }

  globalThis.TabSnapshot = api
})()
