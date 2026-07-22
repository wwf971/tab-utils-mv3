(() => {
  const api = globalThis.TabSnapshot

  const toPositiveNumber = (value, valueDefault, valueMin = 0.01) => {
    const numberValue = Number(value)
    return Number.isFinite(numberValue) && numberValue >= valueMin
      ? numberValue
      : valueDefault
  }

  const validateRetentionTiers = (tiers) => {
    if (!Array.isArray(tiers) || tiers.length === 0) {
      return api.cloneValue(api.snapshotConfigDefault.retentionTiers)
    }

    let ageMaxPrevious = 0
    const tiersNext = []
    for (let index = 0; index < tiers.length; index += 1) {
      const tier = tiers[index] ?? {}
      const isLast = index === tiers.length - 1
      const ageMaxMinute = tier.ageMaxMinute === null && isLast
        ? null
        : toPositiveNumber(tier.ageMaxMinute, NaN)
      const spacingMinMinute = toPositiveNumber(tier.spacingMinMinute, NaN)
      if (
        !Number.isFinite(spacingMinMinute) ||
        (ageMaxMinute !== null && (!Number.isFinite(ageMaxMinute) || ageMaxMinute <= ageMaxPrevious))
      ) {
        return api.cloneValue(api.snapshotConfigDefault.retentionTiers)
      }
      tiersNext.push({ ageMaxMinute, spacingMinMinute })
      if (ageMaxMinute !== null) ageMaxPrevious = ageMaxMinute
    }

    if (tiersNext.at(-1)?.ageMaxMinute !== null) {
      return api.cloneValue(api.snapshotConfigDefault.retentionTiers)
    }
    return tiersNext
  }

  api.validateConfig = (configInput = {}) => {
    const configDefault = api.snapshotConfigDefault
    return {
      schemaVersion: 1,
      isSnapshotEnabled: configInput.isSnapshotEnabled ?? configDefault.isSnapshotEnabled,
      isEventLogEnabled: configInput.isEventLogEnabled ?? configDefault.isEventLogEnabled,
      snapshotIntervalMinute: toPositiveNumber(
        configInput.snapshotIntervalMinute,
        configDefault.snapshotIntervalMinute,
        0.5
      ),
      cleanIntervalMinute: toPositiveNumber(
        configInput.cleanIntervalMinute,
        configDefault.cleanIntervalMinute,
        1
      ),
      isPrivateIncluded: configInput.isPrivateIncluded ?? configDefault.isPrivateIncluded,
      isTabGroupIncluded: configInput.isTabGroupIncluded ?? configDefault.isTabGroupIncluded,
      isTabSelectionIncluded: configInput.isTabSelectionIncluded ?? configDefault.isTabSelectionIncluded,
      tabUrlEventIntervalSecond: toPositiveNumber(
        configInput.tabUrlEventIntervalSecond,
        configDefault.tabUrlEventIntervalSecond,
        1
      ),
      eventOverlapMinute: toPositiveNumber(
        configInput.eventOverlapMinute,
        configDefault.eventOverlapMinute
      ),
      eventChunkAgeMinute: toPositiveNumber(
        configInput.eventChunkAgeMinute,
        configDefault.eventChunkAgeMinute
      ),
      eventChunkCountMax: Math.round(toPositiveNumber(
        configInput.eventChunkCountMax,
        configDefault.eventChunkCountMax,
        1
      )),
      eventChunkSizeByteMax: Math.round(toPositiveNumber(
        configInput.eventChunkSizeByteMax,
        configDefault.eventChunkSizeByteMax,
        1024
      )),
      storageWarningByte: Math.round(toPositiveNumber(
        configInput.storageWarningByte,
        configDefault.storageWarningByte,
        1024
      )),
      retentionTiers: validateRetentionTiers(configInput.retentionTiers)
    }
  }

  api.getConfig = async () => {
    if (api.configMemory) return api.configMemory
    const result = await chrome.storage.sync.get(api.configStorageKey)
    api.configMemory = api.validateConfig(result[api.configStorageKey])
    return api.configMemory
  }

  api.updateConfig = async (changes) => {
    const configCurrent = await api.getConfig()
    const configNext = api.validateConfig({ ...configCurrent, ...(changes ?? {}) })
    await chrome.storage.sync.set({ [api.configStorageKey]: configNext })
    api.configMemory = configNext
    await api.ensureSnapshotAlarm(configNext)
    await api.ensureCleanAlarm(configNext)
    return configNext
  }

  api.ensureSnapshotAlarm = async (configInput, isReset = false) => {
    if (!chrome.alarms) return
    const config = configInput ?? await api.getConfig()
    const alarmCurrent = await chrome.alarms.get(api.alarmName)
    if (!config.isSnapshotEnabled) {
      if (alarmCurrent) await chrome.alarms.clear(api.alarmName)
      return
    }

    const isIntervalCurrent = alarmCurrent?.periodInMinutes === config.snapshotIntervalMinute
    if (isIntervalCurrent && !isReset) return
    if (alarmCurrent) await chrome.alarms.clear(api.alarmName)
    await chrome.alarms.create(api.alarmName, {
      delayInMinutes: config.snapshotIntervalMinute,
      periodInMinutes: config.snapshotIntervalMinute
    })
  }

  api.ensureCleanAlarm = async (configInput, isReset = false) => {
    if (!chrome.alarms) return
    const config = configInput ?? await api.getConfig()
    const alarmCurrent = await chrome.alarms.get(api.alarmNameClean)
    const cleanIntervalMinute = config.cleanIntervalMinute
    if (!Number.isFinite(cleanIntervalMinute) || cleanIntervalMinute <= 0) {
      if (alarmCurrent) await chrome.alarms.clear(api.alarmNameClean)
      return
    }

    const isIntervalCurrent = alarmCurrent?.periodInMinutes === cleanIntervalMinute
    if (isIntervalCurrent && !isReset) return
    if (alarmCurrent) await chrome.alarms.clear(api.alarmNameClean)
    await chrome.alarms.create(api.alarmNameClean, {
      delayInMinutes: cleanIntervalMinute,
      periodInMinutes: cleanIntervalMinute
    })
  }

  api.resetSnapshotAndCleanAlarms = async () => {
    const config = await api.getConfig()
    await Promise.all([
      api.ensureSnapshotAlarm(config, true),
      api.ensureCleanAlarm(config, true)
    ])
  }

  chrome.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !changes[api.configStorageKey]) return
    api.configMemory = api.validateConfig(changes[api.configStorageKey].newValue)
  })
})()
