(() => {
  const api = globalThis.TabSnapshot
  if (api.isSnapshotMainRegistered) return
  api.isSnapshotMainRegistered = true

  const getStateRefreshed = async () => {
    await api.refreshStorageUsage()
    return api.getSnapshotState()
  }

  const runCommand = async (message) => {
    if (message.action === 'snapshotGetState') {
      return { success: true, state: await getStateRefreshed() }
    }
    if (message.action === 'snapshotGet') {
      return {
        success: true,
        snapshot: await api.getSnapshot(message.snapshotId)
      }
    }
    if (message.action === 'snapshotCreate') {
      await api.createSnapshot()
      return { success: true, state: await api.getSnapshotState() }
    }
    if (message.action === 'snapshotDelete') {
      await api.enqueueStorageTask(() => api.deleteSnapshots(message.snapshotIds))
      return { success: true, state: await api.getSnapshotState() }
    }
    if (message.action === 'snapshotRestore') {
      const restoreResult = await api.restoreSnapshot(message.snapshotId)
      return {
        success: true,
        restoreResult,
        state: await api.getSnapshotState()
      }
    }
    if (message.action === 'snapshotGetRecoverySource') {
      return {
        success: true,
        recovery: await api.enqueueStorageTask(() => api.getRecoverySource())
      }
    }
    if (message.action === 'snapshotReplayRecovery') {
      return {
        success: true,
        recovery: await api.enqueueStorageTask(() => api.replayRecovery(message.snapshotId))
      }
    }
    if (message.action === 'snapshotRestoreRecovery') {
      const restoreResult = await api.restoreRecoveredState(
        message.snapshotId,
        message.eventSequenceLast
      )
      return {
        success: true,
        restoreResult,
        state: await api.getSnapshotState()
      }
    }
    if (message.action === 'snapshotClean') {
      const cleanResult = await api.enqueueStorageTask(() => api.cleanSnapshotsByRetention())
      await api.refreshStorageUsage()
      return {
        success: true,
        cleanResult,
        state: await api.getSnapshotState()
      }
    }
    if (message.action === 'snapshotUpdateConfig') {
      await api.updateConfig(message.changes)
      await api.refreshStorageUsage()
      return { success: true, state: await api.getSnapshotState() }
    }
    return null
  }

  const recordBrowserRunStart = async () => {
    if (!chrome.storage.session) return
    const result = await chrome.storage.session.get(api.runtimeStorageKey)
    const runtimeState = result[api.runtimeStorageKey] ?? {}
    if (runtimeState.isStartEventRecorded) return
    const browserRunId = await api.ensureBrowserRunId()
    await chrome.storage.session.set({
      [api.runtimeStorageKey]: {
        schemaVersion: 1,
        browserRunId,
        isStartEventRecorded: true
      }
    })
    api.recordBrowserEvent('browserRunStarted')
  }

  api.registerEventListeners()

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.action === 'snapshotRecoveryChanged') return false
    if (!message?.action?.startsWith('snapshot')) return false
    runCommand(message)
      .then((response) => sendResponse(response))
      .catch(async (error) => {
        await api.recordSnapshotError(error)
        sendResponse({ success: false, error: api.toErrorText(error) })
      })
    return true
  })

  if (chrome.alarms) {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === api.alarmName) {
        api.createSnapshot().catch(() => undefined)
        return
      }
      if (alarm.name === api.alarmNameClean) {
        api.enqueueStorageTask(async () => {
          await api.cleanSnapshotsByRetention()
          await api.refreshStorageUsage()
        }).catch(() => undefined)
      }
    })
  }

  Promise.all([
    api.ensureSnapshotAlarm(),
    api.ensureCleanAlarm(),
    api.ensureBrowserRunId(),
    recordBrowserRunStart()
  ]).catch(() => undefined)
})()
