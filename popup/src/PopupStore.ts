import { makeAutoObservable, runInAction } from 'mobx'
import type {
  SnapshotDetailData,
  SnapshotListItem,
  SnapshotMessageState,
  SnapshotViewSearchData
} from '@wwf971/tab-manage-frontend-common'
import {
  TabSearchCore,
  createLiveTabQuerySource,
  createWindowsTabQuerySource
} from './TabSearchCore'
import { TabBringCore, type TabBringRef } from './TabBringCore'
import { RemoteStore, type RemoteUploadTab } from './remote/RemoteStore'

export interface RetentionTier {
  ageMaxMinute: number | null
  spacingMinMinute: number
}

export interface SnapshotConfig {
  isSnapshotEnabled: boolean
  isEventLogEnabled: boolean
  snapshotIntervalMinute: number
  cleanIntervalMinute: number
  isPrivateIncluded: boolean
  isTabGroupIncluded: boolean
  isTabSelectionIncluded: boolean
  tabUrlEventIntervalSecond: number
  storageWarningByte: number
  retentionTiers: RetentionTier[]
}

export interface SnapshotMaintenance {
  snapshotCount: number
  eventCount: number
  snapshotStorageByte: number
  eventStorageByte: number
  storageTotalByte: number
  isStorageWarning: boolean
  snapshotLastErrorText: string | null
}

interface SnapshotState {
  config: SnapshotConfig
  snapshots: SnapshotListItem[]
  maintenance: SnapshotMaintenance
}

export interface RecoveryEvent {
  eventId?: string
  eventSequence: number
  eventAtText?: string
  eventType: string
  [key: string]: unknown
}

export interface RecoveryMessage {
  messageId: string
  level: 'log' | 'warning' | 'error'
  code: string
  text: string
  eventSequence: number | null
  eventType: string | null
}

interface RecoveryData {
  snapshot: SnapshotDetailData
  events: RecoveryEvent[]
  stateRecovered?: SnapshotDetailData
  messages: RecoveryMessage[]
  eventSequenceLast: number
}

export const tabContextCountSideDefault = 10
export const recoveryEventColCountDefault = 2

const snapshotConfigDefault: SnapshotConfig = {
  isSnapshotEnabled: true,
  isEventLogEnabled: true,
  snapshotIntervalMinute: 5,
  cleanIntervalMinute: 10,
  isPrivateIncluded: false,
  isTabGroupIncluded: true,
  isTabSelectionIncluded: true,
  tabUrlEventIntervalSecond: 10,
  storageWarningByte: 8388608,
  retentionTiers: [
    { ageMaxMinute: 60, spacingMinMinute: 4 },
    { ageMaxMinute: 1440, spacingMinMinute: 55 },
    { ageMaxMinute: 10080, spacingMinMinute: 1380 },
    { ageMaxMinute: 43200, spacingMinMinute: 10020 },
    { ageMaxMinute: null, spacingMinMinute: 43140 }
  ]
}

const maintenanceDefault: SnapshotMaintenance = {
  snapshotCount: 0,
  eventCount: 0,
  snapshotStorageByte: 0,
  eventStorageByte: 0,
  storageTotalByte: 0,
  isStorageWarning: false,
  snapshotLastErrorText: null
}

const snapshotMessageIdle: SnapshotMessageState = {
  status: 'idle',
  messageText: ''
}

const snapshotListColWidthDefault = {
  snapshot: 150,
  pinned: 48,
  windows: 46,
  tabs: 40,
  size: 46
}

export class PopupStore {
  isLoading = true
  isMoveNewTabNextToCurrentEnabled = true
  badgeTabCounts = ['currentWindow', 'total']
  configSubtabId = 'search_subtab'

  snapshotConfig = snapshotConfigDefault
  snapshotMaintenance = maintenanceDefault
  snapshots: SnapshotListItem[] = []
  snapshotIdsSelected: string[] = []
  snapshotAction: string | null = null
  snapshotMessageState: SnapshotMessageState = snapshotMessageIdle
  snapshotDetailIds: string[] = []
  snapshotTabActiveId = 'snapshot-list'
  snapshotById = new Map<string, SnapshotDetailData>()
  snapshotDetailIdLoading = new Set<string>()
  isBatchRestore = true
  windowSourceIdSelectedBySnapshotId = new Map<string, number | null>()
  tabIdsSelectedBySnapshotId = new Map<string, string[]>()
  buttonOffsetLeftById = new Map<string, number>()
  folderColWidthByIdByViewId = new Map<string, Record<string, number>>([
    ['snapshot-list', { ...snapshotListColWidthDefault }]
  ])
  recoverySnapshot: SnapshotDetailData | null = null
  recoveryEvents: RecoveryEvent[] = []
  recoveryCalculatedSnapshot: SnapshotDetailData | null = null
  recoveryMessages: RecoveryMessage[] = []
  recoveryEventSequenceLast: number | null = null
  recoveryEventSequenceSelected: number | null = null
  recoveryEventColCount = recoveryEventColCountDefault
  recoveryPhase: 'empty' | 'source' | 'replayed' | 'restored' = 'empty'
  isRecoveryUpdateListening = false
  recoveryRefreshTimeoutId: ReturnType<typeof setTimeout> | null = null
  // Configured tab count on each side of the center tab. Loading more also
  // extends the loaded range by this count.
  tabContextCountSide = tabContextCountSideDefault
  // Search over the live browser state, shown in the Search tab.
  tabSearch = new TabSearchCore({
    source: createLiveTabQuerySource(),
    getContextCountSide: () => this.tabContextCountSide,
    searchLimit: 100
  })
  // Search over one loaded snapshot, shown in that snapshot's detail tab.
  snapshotSearchById = new Map<string, TabSearchCore>()
  // Bring-tabs panel, opened from the right-click menu of the Search tab.
  // Refer to TabBringCore for the operation model.
  tabBring: TabBringCore | null = null
  // Raised on every open; the panel is keyed by it so a reopen remounts it.
  tabBringOpenCount = 0
  // Remote (tab cloud) features, in their own store. Refer to
  // backend/tab_cloud.md for the overall design.
  remote = new RemoteStore({
    getContextCountSide: () => this.tabContextCountSide
  })

  constructor() {
    makeAutoObservable(this, { remote: false }, { autoBind: true })
  }

  get isSnapshotBusy() {
    return this.snapshotAction !== null
  }

  async initialize() {
    this.startRecoveryUpdates()
    void this.remote.init()
    try {
      const [settingsResult, snapshotResponse] = await Promise.all([
        chrome.storage.sync.get([
          'enable_move_new_tab_next_to_current',
          'enable_badge_show_current_window_tab_count',
          'enable_badge_show_total_tab_count',
          'search_context_tab_count_side',
          'recovery_event_column_count'
        ]),
        chrome.runtime.sendMessage({ action: 'snapshotGetState' })
      ])
      runInAction(() => {
        this.isMoveNewTabNextToCurrentEnabled =
          settingsResult.enable_move_new_tab_next_to_current ?? true
        this.tabContextCountSide = getTabContextCountSideValid(
          settingsResult.search_context_tab_count_side
        )
        this.recoveryEventColCount = getRecoveryEventColCountValid(
          settingsResult.recovery_event_column_count
        )
        this.badgeTabCounts = []
        if (settingsResult.enable_badge_show_current_window_tab_count ?? true) {
          this.badgeTabCounts.push('currentWindow')
        }
        if (settingsResult.enable_badge_show_total_tab_count ?? true) {
          this.badgeTabCounts.push('total')
        }
        if (snapshotResponse?.success) this.applySnapshotState(snapshotResponse.state)
      })
    } catch (error) {
      runInAction(() => {
        this.setSnapshotMessage('error', getErrorText(error))
      })
    } finally {
      runInAction(() => {
        this.isLoading = false
      })
    }
    void this.loadRecoverySource()
  }

  applySnapshotState(state: SnapshotState) {
    if (JSON.stringify(this.snapshotConfig) !== JSON.stringify(state.config)) {
      this.snapshotConfig = state.config
    }
    if (
      this.snapshotMaintenance.snapshotCount !== state.maintenance.snapshotCount ||
      this.snapshotMaintenance.eventCount !== state.maintenance.eventCount ||
      this.snapshotMaintenance.snapshotStorageByte !== state.maintenance.snapshotStorageByte ||
      this.snapshotMaintenance.eventStorageByte !== state.maintenance.eventStorageByte ||
      this.snapshotMaintenance.storageTotalByte !== state.maintenance.storageTotalByte ||
      this.snapshotMaintenance.isStorageWarning !== state.maintenance.isStorageWarning ||
      this.snapshotMaintenance.snapshotLastErrorText !== state.maintenance.snapshotLastErrorText
    ) {
      this.snapshotMaintenance = state.maintenance
    }
    if (JSON.stringify(this.snapshots) !== JSON.stringify(state.snapshots)) {
      this.snapshots = state.snapshots
    }
    const snapshotIdSet = new Set(state.snapshots.map((snapshot) => snapshot.snapshotId))
    this.snapshotIdsSelected = this.snapshotIdsSelected.filter((id) => snapshotIdSet.has(id))
    const detailIdsRemoved = this.snapshotDetailIds.filter((id) => !snapshotIdSet.has(id))
    if (detailIdsRemoved.length > 0) {
      this.closeSnapshotDetailTabs(detailIdsRemoved)
    }
    this.snapshotDetailIds = this.snapshotDetailIds.filter((id) => snapshotIdSet.has(id))
  }

  setConfigSubtabId(subtabId: string) {
    this.configSubtabId = subtabId
  }

  setSnapshotTabActiveId(tabId: string) {
    this.snapshotTabActiveId = tabId
  }

  setBatchRestore(isBatchRestore: boolean) {
    this.isBatchRestore = isBatchRestore
  }

  startRecoveryUpdates() {
    if (this.isRecoveryUpdateListening) return
    chrome.runtime.onMessage.addListener(this.handleRuntimeMessage)
    this.isRecoveryUpdateListening = true
  }

  handleRuntimeMessage(message: { action?: string }) {
    if (message?.action === 'snapshotRecoveryChanged') {
      this.queueRecoveryRefresh()
    }
    if (message?.action === 'browserStateChanged') {
      this.tabSearch.queueSearchRefresh()
      this.tabSearch.queueContextRefresh()
      this.tabBring?.search.queueSearchRefresh()
    }
    return false
  }

  queueRecoveryRefresh() {
    if (this.recoveryRefreshTimeoutId !== null) {
      clearTimeout(this.recoveryRefreshTimeoutId)
    }
    this.recoveryRefreshTimeoutId = setTimeout(() => {
      this.recoveryRefreshTimeoutId = null
      if (this.isSnapshotBusy) {
        this.queueRecoveryRefresh()
        return
      }
      this.loadRecoverySource()
      this.refreshSnapshotState()
    }, 150)
  }

  dispose() {
    if (this.isRecoveryUpdateListening) {
      chrome.runtime.onMessage.removeListener(this.handleRuntimeMessage)
      this.isRecoveryUpdateListening = false
    }
    if (this.recoveryRefreshTimeoutId !== null) {
      clearTimeout(this.recoveryRefreshTimeoutId)
      this.recoveryRefreshTimeoutId = null
    }
    this.tabSearch.dispose()
    for (const searchCore of this.snapshotSearchById.values()) {
      searchCore.dispose()
    }
    this.snapshotSearchById.clear()
    this.closeTabBring()
    this.remote.dispose()
  }

  // Upload panel in the Search tab: openers resolve the local tabs to upload;
  // the apply result lands in the search message line.
  openRemoteUploadForTabs(tabs: RemoteUploadTab[]) {
    if (tabs.length === 0) {
      this.tabSearch.setMessage('error', 'Select at least one tab to upload')
      return
    }
    if (!this.remote.isUploadAllowed) {
      this.tabSearch.setMessage('error', this.remote.uploadBlockReason)
      return
    }
    this.remote.openUploadPanel(tabs, 'selected tabs')
  }

  async openRemoteUploadForWindow(windowSourceId: number) {
    if (!this.remote.isUploadAllowed) {
      this.tabSearch.setMessage('error', this.remote.uploadBlockReason)
      return
    }
    await this.remote.openUploadPanelForWindow(windowSourceId)
  }

  async applyRemoteUpload() {
    const result = await this.remote.applyUpload()
    runInAction(() => {
      this.tabSearch.setMessage(result.isOk ? 'success' : 'error', result.messageText)
      if (result.isOk) this.remote.closeUploadPanel()
    })
    if (result.isOk) {
      if (this.tabSearch.isContextMode) await this.tabSearch.refreshContexts()
      if (this.tabSearch.textCommitted) await this.tabSearch.search(true)
    }
    return result.isOk
  }

  setSearchButtonOffsetLeft(offsetLeft: number) {
    this.buttonOffsetLeftById.set('tab-search', offsetLeft)
  }

  async runTabSearchAction(
    operation: 'activate' | 'close' | 'moveLeft' | 'moveRight' | 'duplicateLeft' | 'duplicateRight',
    tabSourceIdInput?: number
  ) {
    const search = this.tabSearch
    // Close acts on every selected tab in one run. Other operations act on one tab.
    const tabSourceIds = tabSourceIdInput !== undefined
      ? [tabSourceIdInput]
      : [...search.visibleSelectedIds]
    const tabSourceId = tabSourceIds[0]
    if (!Number.isInteger(tabSourceId) || search.isBusy) return false
    search.setSearchAction(operation)
    search.setMessage('loading', getTabActionLoadingText(operation, tabSourceIds.length))
    try {
      const response = await chrome.runtime.sendMessage(
        operation === 'close'
          ? { action: 'browserTabAction', operation, tabSourceIds }
          : { action: 'browserTabAction', operation, tabSourceId }
      )
      if (!response?.success) throw new Error(response?.error ?? 'Tab action failed')
      runInAction(() => {
        search.setMessage('success', getTabActionSuccessText(operation, tabSourceIds.length))
      })
      if (operation !== 'activate') {
        runInAction(() => {
          search.setSearchAction(null)
        })
        if (search.isContextMode) await search.refreshContexts()
        await search.search(true)
      }
      return true
    } catch (error) {
      runInAction(() => {
        search.setMessage('error', getErrorText(error))
      })
      return false
    } finally {
      runInAction(() => {
        search.setSearchAction(null)
      })
    }
  }

  // The current tab is resolved once at open time, so the panel can show it
  // as the special "current tab" option and apply on a concrete tab ID.
  async openTabBring(options: {
    pickSide: 'source' | 'target'
    tabTargetFixed?: TabBringRef
    tabsSourceFixed?: TabBringRef[]
    isTabCurrentPicked?: boolean
  }) {
    let tabCurrent: TabBringRef | null = null
    try {
      const tabsActive = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      const tabActive = tabsActive[0]
      if (Number.isInteger(tabActive?.id)) {
        tabCurrent = {
          tabSourceId: tabActive.id as number,
          titleText: tabActive.title ?? ''
        }
      }
    } catch {
      tabCurrent = null
    }
    runInAction(() => {
      this.closeTabBring()
      this.tabBring = new TabBringCore({
        pickSide: options.pickSide,
        tabTargetFixed: options.tabTargetFixed ?? null,
        tabsSourceFixed: options.tabsSourceFixed ?? [],
        tabCurrent,
        isTabCurrentPicked: options.isTabCurrentPicked === true && tabCurrent !== null,
        getContextCountSide: () => this.tabContextCountSide
      })
      this.tabBringOpenCount += 1
    })
  }

  closeTabBring() {
    this.tabBring?.dispose()
    this.tabBring = null
  }

  async applyTabBring() {
    const bring = this.tabBring
    if (!bring || bring.isApplying || !bring.isApplyReady) return false
    const placement = bring.placement
    const tabTargetSourceId = bring.tabTarget?.tabSourceId as number
    const tabSourceIds = bring.tabSourceIdsApply
    bring.setApplying(true)
    bring.search.setMessage('loading', 'Bringing tabs...')
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'browserTabAction',
        operation: 'bringTabs',
        tabTargetSourceId,
        tabSourceIds,
        placement
      })
      if (!response?.success) throw new Error(response?.error ?? 'Tab bring failed')
      runInAction(() => {
        this.tabSearch.setMessage(
          'success',
          tabSourceIds.length === 1
            ? `Tab brought ${placement} the target tab`
            : `${tabSourceIds.length} tabs brought ${placement} the target tab`
        )
        this.closeTabBring()
      })
      if (this.tabSearch.isContextMode) await this.tabSearch.refreshContexts()
      if (this.tabSearch.textCommitted) await this.tabSearch.search(true)
      return true
    } catch (error) {
      runInAction(() => {
        bring.search.setMessage('error', getErrorText(error))
        bring.setApplying(false)
      })
      return false
    }
  }

  clearRecovery() {
    this.recoverySnapshot = null
    this.recoveryEvents = []
    this.recoveryCalculatedSnapshot = null
    this.recoveryMessages = []
    this.recoveryEventSequenceLast = null
    this.recoveryEventSequenceSelected = null
    this.recoveryPhase = 'empty'
  }

  setRecoveryEventSequenceSelected(eventSequence: number) {
    this.recoveryEventSequenceSelected = eventSequence
  }

  async setRecoveryEventColCount(colCountInput: number) {
    const colCount = getRecoveryEventColCountValid(colCountInput)
    this.recoveryEventColCount = colCount
    await chrome.runtime.sendMessage({
      action: 'updateSettings',
      settings: { recovery_event_column_count: colCount }
    })
  }

  setSnapshotIdsSelected(snapshotIds: string[]) {
    this.snapshotIdsSelected = [...snapshotIds].map(String)
  }

  setTabIdsSelected(snapshotId: string, tabIds: string[]) {
    this.tabIdsSelectedBySnapshotId.set(snapshotId, [...tabIds].map(String))
  }

  getTabIdsSelected(snapshotId: string) {
    return this.tabIdsSelectedBySnapshotId.get(snapshotId) ?? []
  }

  setButtonOffsetLeft(groupId: string, offsetLeft: number) {
    this.buttonOffsetLeftById.set(groupId, offsetLeft)
  }

  getButtonOffsetLeft(groupId: string) {
    return this.buttonOffsetLeftById.get(groupId) ?? 0
  }

  setFolderColWidthById(viewId: string, colWidthById: Record<string, number>) {
    this.folderColWidthByIdByViewId.set(viewId, colWidthById)
  }

  getFolderColWidthById(viewId: string) {
    return this.folderColWidthByIdByViewId.get(viewId)
  }

  setWindowSourceIdSelected(snapshotId: string, windowSourceId: number) {
    this.windowSourceIdSelectedBySnapshotId.set(snapshotId, windowSourceId)
    this.tabIdsSelectedBySnapshotId.set(snapshotId, [])
  }

  setSnapshotMessage(status: SnapshotMessageState['status'], messageText: string) {
    this.snapshotMessageState = { status, messageText }
  }

  dismissSnapshotMessage() {
    if (this.isSnapshotBusy) return
    this.snapshotMessageState = snapshotMessageIdle
  }

  async updateCommonSetting(valueId: string, valueNext: unknown) {
    if (valueId === 'enable_move_new_tab_next_to_current') {
      const isEnabledNext = Boolean(valueNext)
      this.isMoveNewTabNextToCurrentEnabled = isEnabledNext
      await chrome.runtime.sendMessage({
        action: 'updateSettings',
        settings: { enable_move_new_tab_next_to_current: isEnabledNext }
      })
      return
    }
    if (valueId === 'search_context_tab_count_side') {
      const countNext = getTabContextCountSideValid(valueNext)
      this.tabContextCountSide = countNext
      await chrome.runtime.sendMessage({
        action: 'updateSettings',
        settings: { search_context_tab_count_side: countNext }
      })
      return
    }
    if (valueId === 'badge_tab_counts') {
      const valueList = Array.isArray(valueNext) ? valueNext.map(String) : []
      this.badgeTabCounts = valueList
      await chrome.runtime.sendMessage({
        action: 'updateSettings',
        settings: {
          enable_badge_show_current_window_tab_count: valueList.includes('currentWindow'),
          enable_badge_show_total_tab_count: valueList.includes('total')
        }
      })
    }
  }

  async updateSnapshotConfig(changes: Partial<SnapshotConfig>) {
    await this.runSnapshotAction('config', {
      action: 'snapshotUpdateConfig',
      changes
    }, {
      loadingText: 'Saving snapshot settings...',
      successText: 'Snapshot settings saved'
    })
  }

  async createSnapshot() {
    await this.runSnapshotAction(
      'create',
      { action: 'snapshotCreate' },
      {
        loadingText: 'Creating snapshot...',
        successText: 'Snapshot created'
      }
    )
  }

  async toggleSnapshotsPinned(snapshotIdsInput: string[]) {
    const snapshotIdSet = new Set(snapshotIdsInput.map(String))
    const snapshotsSelected = this.snapshots.filter((snapshot) => (
      snapshotIdSet.has(snapshot.snapshotId)
    ))
    if (snapshotsSelected.length === 0) {
      this.setSnapshotMessage('error', 'Select at least one snapshot to pin or unpin')
      return
    }
    const isPinned = !snapshotsSelected.every((snapshot) => snapshot.isPinned === true)
    await this.runSnapshotAction(
      'pin',
      {
        action: 'snapshotSetPinned',
        snapshotIds: [...snapshotIdSet],
        isPinned
      },
      {
        loadingText: isPinned ? 'Pinning snapshots...' : 'Unpinning snapshots...',
        successText: isPinned ? 'Snapshot pin updated' : 'Snapshot pin removed'
      }
    )
  }

  async deleteSnapshots(snapshotIdsInput: string[]) {
    const snapshotIds = [...snapshotIdsInput].map(String)
    if (snapshotIds.length === 0) {
      this.setSnapshotMessage('error', 'Select at least one snapshot to delete')
      return
    }
    const snapshotIdSet = new Set(snapshotIds)
    const countBefore = this.snapshots.length
    const isSuccess = await this.runSnapshotAction(
      'delete',
      { action: 'snapshotDelete', snapshotIds },
      {
        loadingText: snapshotIds.length === 1
          ? 'Deleting snapshot...'
          : `Deleting ${snapshotIds.length} snapshots...`,
        successText: ''
      }
    )
    if (!isSuccess) return
    runInAction(() => {
      const countDeleted = countBefore - this.snapshots.length
      this.closeSnapshotDetailTabs(snapshotIds)
      if (countDeleted === 0) {
        this.setSnapshotMessage('error', 'No matching snapshot was deleted')
        return
      }
      this.setSnapshotMessage(
        'success',
        countDeleted === 1
          ? 'Snapshot deleted'
          : `${countDeleted} snapshots deleted`
      )
    })
  }

  async restoreSnapshot(snapshotId: string) {
    await this.runSnapshotAction(
      'restore',
      {
        action: 'snapshotRestore',
        snapshotId,
        isBatchRestore: this.isBatchRestore
      },
      {
        loadingText: 'Restoring snapshot...',
        successText: 'Snapshot restored in new windows'
      }
    )
  }

  async loadRecoverySource() {
    if (this.isSnapshotBusy) return false
    this.snapshotAction = 'recovery-load'
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'snapshotGetRecoverySource'
      })
      if (!response?.success) throw new Error(response?.error ?? 'Recovery source loading failed')
      runInAction(() => {
        this.applyRecoveryData(response.recovery as RecoveryData, false)
      })
      return true
    } catch (error) {
      runInAction(() => {
        this.clearRecovery()
        this.recoveryMessages = [{
          messageId: 'recovery-source-error',
          level: 'error',
          code: 'recovery-source-error',
          text: getErrorText(error),
          eventSequence: null,
          eventType: null
        }]
      })
      return false
    } finally {
      runInAction(() => {
        this.snapshotAction = null
      })
    }
  }

  async refreshSnapshotState(isStorageUsageRefresh = false) {
    try {
      const response = await chrome.runtime.sendMessage({
        action: isStorageUsageRefresh ? 'snapshotRefreshState' : 'snapshotGetState'
      })
      if (!response?.success) throw new Error(response?.error ?? 'Snapshot state loading failed')
      runInAction(() => {
        this.applySnapshotState(response.state as SnapshotState)
      })
      return true
    } catch (error) {
      runInAction(() => {
        this.setSnapshotMessage('error', getErrorText(error))
      })
      return false
    }
  }

  async replayRecovery(eventSequenceEnd: number | null = null) {
    const snapshotId = this.recoverySnapshot?.snapshotId
    if (!snapshotId || this.isSnapshotBusy) return false
    this.snapshotAction = 'recovery-replay'
    this.setSnapshotMessage('loading', 'Applying recorded events...')
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'snapshotReplayRecovery',
        snapshotId,
        eventSequenceEnd
      })
      if (!response?.success) throw new Error(response?.error ?? 'Recovery replay failed')
      runInAction(() => {
        this.applyRecoveryData(response.recovery as RecoveryData, true)
        const warningCount = this.recoveryMessages.filter(
          (message) => message.level !== 'log'
        ).length
        this.setSnapshotMessage(
          warningCount > 0 ? 'error' : 'success',
          warningCount > 0
            ? `Replay completed with ${warningCount} warning${warningCount === 1 ? '' : 's'}`
            : 'Replay completed'
        )
      })
      return true
    } catch (error) {
      runInAction(() => {
        this.recoveryCalculatedSnapshot = null
        this.recoveryPhase = 'source'
        this.recoveryMessages = [{
          messageId: 'recovery-replay-error',
          level: 'error',
          code: 'recovery-replay-error',
          text: getErrorText(error),
          eventSequence: null,
          eventType: null
        }]
        this.setSnapshotMessage('error', getErrorText(error))
      })
      return false
    } finally {
      runInAction(() => {
        this.snapshotAction = null
      })
    }
  }

  async restoreRecovery() {
    const snapshotId = this.recoverySnapshot?.snapshotId
    const eventSequenceLast = this.recoveryEventSequenceLast
    if (!snapshotId || eventSequenceLast === null || !this.recoveryCalculatedSnapshot) return false
    if (this.isSnapshotBusy) return false
    this.snapshotAction = 'recovery-restore'
    this.setSnapshotMessage('loading', 'Restoring calculated windows...')
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'snapshotRestoreRecovery',
        snapshotId,
        eventSequenceLast,
        isBatchRestore: this.isBatchRestore
      })
      if (!response?.success) throw new Error(response?.error ?? 'Calculated snapshot restoration failed')
      runInAction(() => {
        this.applySnapshotState(response.state)
        const restoreErrors = Array.isArray(response.restoreResult?.errors)
          ? response.restoreResult.errors
          : []
        this.recoveryMessages = [
          ...this.recoveryMessages,
          ...restoreErrors.map((errorItem: { errorText?: string }, errorIndex: number) => ({
            messageId: `restore-error:${errorIndex}`,
            level: 'error' as const,
            code: 'restore-item-error',
            text: errorItem.errorText ?? 'One restored item could not be created',
            eventSequence: null,
            eventType: null
          }))
        ]
        this.recoveryPhase = 'restored'
        this.setSnapshotMessage(
          restoreErrors.length > 0 ? 'error' : 'success',
          restoreErrors.length > 0
            ? `Restore completed with ${restoreErrors.length} error${restoreErrors.length === 1 ? '' : 's'}`
            : 'Calculated snapshot restored in new windows'
        )
      })
      return true
    } catch (error) {
      runInAction(() => {
        this.recoveryMessages = [
          ...this.recoveryMessages,
          {
            messageId: `restore-error:${this.recoveryMessages.length}`,
            level: 'error',
            code: 'restore-error',
            text: getErrorText(error),
            eventSequence: null,
            eventType: null
          }
        ]
        this.setSnapshotMessage('error', getErrorText(error))
      })
      return false
    } finally {
      runInAction(() => {
        this.snapshotAction = null
      })
    }
  }

  applyRecoveryData(recovery: RecoveryData, isReplayed: boolean) {
    const eventSequenceSet = new Set(recovery.events.map((event) => event.eventSequence))
    this.recoverySnapshot = recovery.snapshot
    this.recoveryEvents = recovery.events
    if (
      this.recoveryEventSequenceSelected !== null &&
      !eventSequenceSet.has(this.recoveryEventSequenceSelected)
    ) {
      this.recoveryEventSequenceSelected = null
    }
    this.recoveryCalculatedSnapshot = isReplayed
      ? recovery.stateRecovered ?? null
      : null
    this.recoveryMessages = recovery.messages
    this.recoveryEventSequenceLast = recovery.eventSequenceLast
    this.recoveryPhase = isReplayed ? 'replayed' : 'source'
  }

  async cleanSnapshots() {
    const countBefore = this.snapshots.length
    const isSuccess = await this.runSnapshotAction(
      'clean',
      { action: 'snapshotClean' },
      {
        loadingText: 'Cleaning snapshots...',
        successText: ''
      }
    )
    if (!isSuccess) return
    runInAction(() => {
      const countDeleted = countBefore - this.snapshots.length
      this.setSnapshotMessage(
        'success',
        countDeleted === 0
          ? 'Cleaning finished. No snapshots removed'
          : `Cleaning finished. Removed ${countDeleted} snapshot${countDeleted === 1 ? '' : 's'}`
      )
    })
  }

  async openSnapshotDetail(snapshotIdInput?: string) {
    const snapshotId = snapshotIdInput ?? this.snapshotIdsSelected[0]
    if (!snapshotId) {
      this.setSnapshotMessage('error', 'Select one snapshot to view detail')
      return
    }
    if (!this.snapshotDetailIds.includes(snapshotId)) this.snapshotDetailIds.push(snapshotId)
    this.snapshotTabActiveId = `snapshot:${snapshotId}`
    this.ensureSnapshotSearch(snapshotId)
    if (this.snapshotById.has(snapshotId) || this.snapshotDetailIdLoading.has(snapshotId)) return
    await this.loadSnapshotDetail(snapshotId, 'Snapshot detail loaded')
  }

  ensureSnapshotSearch(snapshotId: string) {
    let searchCore = this.snapshotSearchById.get(snapshotId)
    if (!searchCore) {
      searchCore = new TabSearchCore({
        source: createWindowsTabQuerySource(
          () => this.snapshotById.get(snapshotId)?.windows ?? []
        ),
        getContextCountSide: () => this.tabContextCountSide,
        // A snapshot is searched locally and completely; no paging is needed.
        searchLimit: 100000
      })
      this.snapshotSearchById.set(snapshotId, searchCore)
    }
    return searchCore
  }

  getSnapshotSearch(snapshotId: string) {
    return this.snapshotSearchById.get(snapshotId) ?? null
  }

  // Data for the search bar, window match counts, and per-window context views
  // rendered inside one snapshot detail.
  getSnapshotSearchViewData(snapshotId: string): SnapshotViewSearchData | null {
    const searchCore = this.getSnapshotSearch(snapshotId)
    if (!searchCore) return null
    const windowSourceIdSelected =
      this.windowSourceIdSelectedBySnapshotId.get(snapshotId) ?? null
    const isActive = searchCore.textCommitted.trim().length > 0
    const context = windowSourceIdSelected !== null
      ? searchCore.contextByWindowId.get(windowSourceIdSelected) ?? null
      : null
    const itemsMatched = searchCore.items.filter(
      (item) => item.windowSourceId === windowSourceIdSelected
    )
    const tabIdSelectedSet = new Set(this.getTabIdsSelected(snapshotId))
    const isContextEnterEnabled = (
      isActive &&
      context === null &&
      itemsMatched.some((item) => tabIdSelectedSet.has(String(item.tabSourceId)))
    )
    const matchCountByWindowId: Record<string, number> = {}
    for (const [windowSourceId, matchCount] of searchCore.matchCountByWindowId) {
      matchCountByWindowId[String(windowSourceId)] = matchCount
    }
    return {
      textInput: searchCore.textInput,
      matchText: searchCore.textCommitted,
      isActive,
      isBusy: searchCore.isBusy,
      messageStatus: searchCore.messageStatus,
      messageText: searchCore.messageText,
      matchCountByWindowId,
      windowIdsInContext: [...searchCore.contextByWindowId.keys()],
      itemsMatched,
      context: context === null ? null : {
        tabCenterSourceId: context.tabCenterSourceId,
        items: context.items,
        isMoreBefore: context.isMoreBefore,
        isMoreAfter: context.isMoreAfter,
        isLoadingBefore: context.action === 'loadBefore',
        isLoadingAfter: context.action === 'loadAfter',
        countLoad: this.tabContextCountSide,
        scrollRequestCount: context.scrollRequestCount
      },
      isContextEnterEnabled
    }
  }

  setSnapshotSearchTextInput(snapshotId: string, text: string) {
    this.ensureSnapshotSearch(snapshotId).setTextInput(text)
  }

  // Enter the context view of the selected window, centered on the first
  // selected tab among that window's matched tabs.
  async enterSnapshotContext(snapshotId: string) {
    const searchCore = this.getSnapshotSearch(snapshotId)
    if (!searchCore) return false
    const windowSourceIdSelected =
      this.windowSourceIdSelectedBySnapshotId.get(snapshotId) ?? null
    if (windowSourceIdSelected === null) return false
    const tabIdSelectedSet = new Set(this.getTabIdsSelected(snapshotId))
    const tabCenter = searchCore.items.find((item) => (
      item.windowSourceId === windowSourceIdSelected &&
      tabIdSelectedSet.has(String(item.tabSourceId))
    ))
    if (!tabCenter) return false
    return searchCore.enterContext(tabCenter.tabSourceId)
  }

  exitSnapshotContext(snapshotId: string) {
    const searchCore = this.getSnapshotSearch(snapshotId)
    const windowSourceIdSelected =
      this.windowSourceIdSelectedBySnapshotId.get(snapshotId) ?? null
    if (!searchCore || windowSourceIdSelected === null) return
    searchCore.exitContext(windowSourceIdSelected)
  }

  async loadMoreSnapshotContext(snapshotId: string, direction: 'before' | 'after') {
    const searchCore = this.getSnapshotSearch(snapshotId)
    const windowSourceIdSelected =
      this.windowSourceIdSelectedBySnapshotId.get(snapshotId) ?? null
    if (!searchCore || windowSourceIdSelected === null) return false
    return searchCore.loadMoreContext(windowSourceIdSelected, direction)
  }

  async refreshSnapshotDetail(snapshotId: string) {
    if (!snapshotId) return
    if (!this.snapshotDetailIds.includes(snapshotId)) this.snapshotDetailIds.push(snapshotId)
    this.snapshotTabActiveId = `snapshot:${snapshotId}`
    await this.loadSnapshotDetail(snapshotId, 'Snapshot detail refreshed')
  }

  async loadSnapshotDetail(snapshotId: string, successText: string) {
    if (this.snapshotDetailIdLoading.has(snapshotId)) return
    this.snapshotDetailIdLoading.add(snapshotId)
    this.setSnapshotMessage('loading', 'Loading snapshot detail...')
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'snapshotGet',
        snapshotId
      })
      if (!response?.success) throw new Error(response?.error ?? 'Snapshot loading failed')
      runInAction(() => {
        const snapshot = response.snapshot as SnapshotDetailData
        this.snapshotById.set(snapshotId, snapshot)
        // A reloaded snapshot body replaces the searched tree. The committed
        // search and the loaded context ranges are recomputed on it.
        const searchCore = this.ensureSnapshotSearch(snapshotId)
        if (searchCore.textCommitted) {
          void searchCore.search(true)
          void searchCore.refreshContexts()
        }
        const windowSourceIdSelected =
          this.windowSourceIdSelectedBySnapshotId.get(snapshotId)
        const isWindowStillPresent = snapshot.windows.some(
          (windowItem) => windowItem.windowSourceId === windowSourceIdSelected
        )
        this.windowSourceIdSelectedBySnapshotId.set(
          snapshotId,
          isWindowStillPresent
            ? windowSourceIdSelected ?? null
            : snapshot.windows[0]?.windowSourceId ?? null
        )
        const tabIdsSelected = this.getTabIdsSelected(snapshotId)
        const tabIdSet = new Set(
          snapshot.windows.flatMap((windowItem) => (
            windowItem.tabs.map((tab) => String(tab.tabSourceId))
          ))
        )
        this.tabIdsSelectedBySnapshotId.set(
          snapshotId,
          tabIdsSelected.filter((tabId) => tabIdSet.has(tabId))
        )
        this.setSnapshotMessage('success', successText)
      })
    } catch (error) {
      runInAction(() => {
        this.setSnapshotMessage('error', getErrorText(error))
      })
    } finally {
      runInAction(() => {
        this.snapshotDetailIdLoading.delete(snapshotId)
      })
    }
  }

  closeSnapshotDetailTab(tabId: string) {
    if (tabId === 'snapshot-list') return
    const snapshotId = tabId.replace('snapshot:', '')
    this.closeSnapshotDetailTabs([snapshotId])
  }

  closeSnapshotDetailTabs(snapshotIds: string[]) {
    const snapshotIdSet = new Set(snapshotIds.map(String))
    if (snapshotIdSet.size === 0) return
    const activeSnapshotId = this.snapshotTabActiveId.startsWith('snapshot:')
      ? this.snapshotTabActiveId.slice('snapshot:'.length)
      : ''
    this.snapshotDetailIds = this.snapshotDetailIds.filter((id) => !snapshotIdSet.has(id))
    snapshotIdSet.forEach((id) => {
      this.snapshotById.delete(id)
      this.windowSourceIdSelectedBySnapshotId.delete(id)
      this.tabIdsSelectedBySnapshotId.delete(id)
      this.snapshotDetailIdLoading.delete(id)
      this.snapshotSearchById.get(id)?.dispose()
      this.snapshotSearchById.delete(id)
    })
    if (activeSnapshotId && snapshotIdSet.has(activeSnapshotId)) {
      this.snapshotTabActiveId = 'snapshot-list'
    }
  }

  async runSnapshotAction(
    actionName: string,
    message: Record<string, unknown>,
    texts: { loadingText: string, successText: string }
  ) {
    if (this.isSnapshotBusy) return false
    this.snapshotAction = actionName
    this.setSnapshotMessage('loading', texts.loadingText)
    try {
      const response = await chrome.runtime.sendMessage(toPlainClone(message))
      if (!response?.success) throw new Error(response?.error ?? 'Snapshot operation failed')
      runInAction(() => {
        this.applySnapshotState(response.state)
        if (texts.successText) {
          this.setSnapshotMessage('success', texts.successText)
        }
      })
      return true
    } catch (error) {
      runInAction(() => {
        this.setSnapshotMessage('error', getErrorText(error))
      })
      return false
    } finally {
      runInAction(() => {
        this.snapshotAction = null
      })
    }
  }
}

function toPlainClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function getErrorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function getTabContextCountSideValid(value: unknown) {
  const countValue = Math.round(Number(value))
  if (!Number.isFinite(countValue) || countValue < 1) return tabContextCountSideDefault
  return Math.min(100, countValue)
}

function getRecoveryEventColCountValid(value: unknown) {
  const countValue = Math.round(Number(value))
  if (!Number.isFinite(countValue) || countValue < 1) {
    return recoveryEventColCountDefault
  }
  return Math.min(8, countValue)
}

function getTabActionLoadingText(operation: string, tabCount: number) {
  if (operation === 'activate') return 'Opening tab...'
  if (operation === 'close') {
    return tabCount === 1 ? 'Closing tab...' : `Closing ${tabCount} tabs...`
  }
  if (operation.startsWith('duplicate')) return 'Duplicating tab...'
  return 'Moving tab...'
}

function getTabActionSuccessText(operation: string, tabCount: number) {
  if (operation === 'activate') return 'Tab activated'
  if (operation === 'close') {
    return tabCount === 1 ? 'Tab closed' : `${tabCount} tabs closed`
  }
  if (operation.startsWith('duplicate')) return 'Tab duplicated'
  return 'Tab moved'
}
