import { makeAutoObservable, runInAction } from 'mobx'
import type {
  SnapshotDetailData,
  SnapshotListItem,
  SnapshotMessageState
} from '@wwf971/tab-manage-frontend-common'

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

export interface BrowserTabSearchItem {
  tabSourceId: number
  windowSourceId: number
  windowIndex: number
  tabIndex: number
  title: string
  url: string
  favIconUrl?: string
  isActive: boolean
  isSelected: boolean
  isPinned: boolean
  isWindowFocused: boolean
}

interface BrowserTabSearchResult {
  stateId: string
  stateRevision: number
  queryText: string
  items: BrowserTabSearchItem[]
  offset: number
  limit: number
  totalValue: number
  isMore: boolean
}

interface BrowserTabContextResult {
  stateId: string
  stateRevision: number
  isTabFound: boolean
  tabCenterSourceId?: number
  windowSourceId?: number
  windowTabCount?: number
  items?: BrowserTabSearchItem[]
  isMoreBefore?: boolean
  isMoreAfter?: boolean
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
  searchTextInput = ''
  searchTextCommitted = ''
  tabSearchItems: BrowserTabSearchItem[] = []
  tabSearchSelectedIds: number[] = []
  searchResultTotal = 0
  isSearchMore = false
  searchAction: string | null = null
  searchMessageStatus: 'idle' | 'loading' | 'success' | 'error' = 'idle'
  searchMessageText = ''
  searchRefreshTimeoutId: ReturnType<typeof setTimeout> | null = null
  searchCommitTimeoutId: ReturnType<typeof setTimeout> | null = null
  searchToken = 0
  isTabContextMode = false
  tabContextCenterSourceId: number | null = null
  tabContextItems: BrowserTabSearchItem[] = []
  tabContextSelectedIds: number[] = []
  // Configured tab count on each side of the center tab. Loading more also
  // extends the loaded range by this count.
  tabContextCountSide = tabContextCountSideDefault
  tabContextCountBefore = tabContextCountSideDefault
  tabContextCountAfter = tabContextCountSideDefault
  isTabContextMoreBefore = false
  isTabContextMoreAfter = false
  tabContextWindowSourceId: number | null = null
  contextAction: 'enter' | 'loadBefore' | 'loadAfter' | null = null
  contextRefreshTimeoutId: ReturnType<typeof setTimeout> | null = null
  contextToken = 0
  tabContextScrollRequestCount = 0

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true })
  }

  get isSnapshotBusy() {
    return this.snapshotAction !== null
  }

  get isSearchBusy() {
    return this.searchAction !== null
  }

  get isContextBusy() {
    return this.contextAction !== null
  }

  // The visible view is either the search-result list or the context list.
  get tabVisibleSelectedIds() {
    return this.isTabContextMode ? this.tabContextSelectedIds : this.tabSearchSelectedIds
  }

  get tabVisibleSelectedFirst() {
    const items = this.isTabContextMode ? this.tabContextItems : this.tabSearchItems
    const tabSourceIdFirst = this.tabVisibleSelectedIds[0]
    return items.find((tab) => tab.tabSourceId === tabSourceIdFirst) ?? null
  }

  get isTabVisibleSelectedCurrentActive() {
    return (
      this.tabVisibleSelectedFirst?.isActive === true &&
      this.tabVisibleSelectedFirst?.isWindowFocused === true
    )
  }

  async initialize() {
    this.startRecoveryUpdates()
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
      this.queueSearchRefresh()
      this.queueContextRefresh()
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
    if (this.searchRefreshTimeoutId !== null) {
      clearTimeout(this.searchRefreshTimeoutId)
      this.searchRefreshTimeoutId = null
    }
    if (this.searchCommitTimeoutId !== null) {
      clearTimeout(this.searchCommitTimeoutId)
      this.searchCommitTimeoutId = null
    }
    if (this.contextRefreshTimeoutId !== null) {
      clearTimeout(this.contextRefreshTimeoutId)
      this.contextRefreshTimeoutId = null
    }
    this.searchToken += 1
    this.contextToken += 1
  }

  setSearchTextInput(text: string) {
    this.searchTextInput = text
    if (this.isTabContextMode) this.exitTabContextMode()
    this.queueSearchCommit()
  }

  queueSearchCommit() {
    this.searchToken += 1
    const searchToken = this.searchToken
    if (this.searchCommitTimeoutId !== null) {
      clearTimeout(this.searchCommitTimeoutId)
    }
    this.searchCommitTimeoutId = setTimeout(() => {
      this.searchCommitTimeoutId = null
      if (searchToken !== this.searchToken) return
      void this.searchTabs(true)
    }, 180)
  }

  setTabSearchSelectedIds(tabSourceIds: number[]) {
    this.tabSearchSelectedIds = tabSourceIds.filter(Number.isInteger)
  }

  setTabContextSelectedIds(tabSourceIds: number[]) {
    this.tabContextSelectedIds = tabSourceIds.filter(Number.isInteger)
  }

  setSearchMessage(
    status: 'idle' | 'loading' | 'success' | 'error',
    messageText: string
  ) {
    this.searchMessageStatus = status
    this.searchMessageText = messageText
  }

  setSearchButtonOffsetLeft(offsetLeft: number) {
    this.buttonOffsetLeftById.set('tab-search', offsetLeft)
  }

  queueSearchRefresh() {
    if (!this.searchTextCommitted || this.searchRefreshTimeoutId !== null) return
    this.searchRefreshTimeoutId = setTimeout(() => {
      this.searchRefreshTimeoutId = null
      if (this.isSearchBusy) {
        this.queueSearchRefresh()
        return
      }
      this.searchTabs(true)
    }, 150)
  }

  async searchTabs(isSilent = false, isAppend = false) {
    const searchText = this.searchTextInput.trim()
    this.searchToken += 1
    const searchToken = this.searchToken
    if (!searchText) {
      this.tabSearchItems = []
      this.tabSearchSelectedIds = []
      this.searchResultTotal = 0
      this.isSearchMore = false
      this.searchTextCommitted = ''
      this.setSearchMessage('idle', 'Enter text to search tab titles or URLs')
      return false
    }
    if (this.isSearchBusy && this.searchAction !== 'search') return false
    this.searchAction = 'search'
    if (!isSilent) this.setSearchMessage('loading', 'Searching tabs...')
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'browserStateQueryTabs',
        query: {
          text: searchText,
          offset: isAppend ? this.tabSearchItems.length : 0,
          limit: 100
        }
      })
      if (searchToken !== this.searchToken) return false
      if (!response?.success) throw new Error(response?.error ?? 'Tab search failed')
      runInAction(() => {
        if (searchToken !== this.searchToken) return
        const result = response.result as BrowserTabSearchResult
        this.searchTextCommitted = result.queryText
        this.tabSearchItems = isAppend
          ? [...this.tabSearchItems, ...result.items]
          : result.items
        this.searchResultTotal = result.totalValue
        this.isSearchMore = result.isMore
        const tabSourceIdSet = new Set(this.tabSearchItems.map((tab) => tab.tabSourceId))
        this.tabSearchSelectedIds = this.tabSearchSelectedIds.filter(
          (tabSourceId) => tabSourceIdSet.has(tabSourceId)
        )
        // A silent background refresh must not replace a visible error message,
        // for example the notice that the context tab was closed.
        if (!isSilent || this.searchMessageStatus !== 'error') {
          this.setSearchMessage(
            'success',
            result.totalValue === 1 ? '1 tab found' : `${result.totalValue} tabs found`
          )
        }
      })
      return true
    } catch (error) {
      runInAction(() => {
        if (searchToken !== this.searchToken) return
        if (!isAppend) {
          this.tabSearchItems = []
          this.tabSearchSelectedIds = []
          this.searchResultTotal = 0
          this.isSearchMore = false
        }
        this.setSearchMessage('error', getErrorText(error))
      })
      return false
    } finally {
      runInAction(() => {
        if (searchToken === this.searchToken && this.searchAction === 'search') {
          this.searchAction = null
        }
      })
    }
  }

  async loadMoreSearchTabs() {
    if (!this.isSearchMore) return false
    return this.searchTabs(false, true)
  }

  async runTabSearchAction(
    operation: 'activate' | 'close' | 'moveLeft' | 'moveRight' | 'duplicateLeft' | 'duplicateRight',
    tabSourceIdInput?: number
  ) {
    // Close acts on every selected tab in one run. Other operations act on one tab.
    const tabSourceIds = tabSourceIdInput !== undefined
      ? [tabSourceIdInput]
      : [...this.tabVisibleSelectedIds]
    const tabSourceId = tabSourceIds[0]
    if (!Number.isInteger(tabSourceId) || this.isSearchBusy || this.isContextBusy) return false
    this.searchAction = operation
    this.setSearchMessage('loading', getTabActionLoadingText(operation, tabSourceIds.length))
    try {
      const response = await chrome.runtime.sendMessage(
        operation === 'close'
          ? { action: 'browserTabAction', operation, tabSourceIds }
          : { action: 'browserTabAction', operation, tabSourceId }
      )
      if (!response?.success) throw new Error(response?.error ?? 'Tab action failed')
      runInAction(() => {
        this.setSearchMessage('success', getTabActionSuccessText(operation, tabSourceIds.length))
      })
      if (operation !== 'activate') {
        runInAction(() => {
          this.searchAction = null
        })
        if (this.isTabContextMode) await this.refreshTabContext()
        await this.searchTabs(true)
      }
      return true
    } catch (error) {
      runInAction(() => {
        this.setSearchMessage('error', getErrorText(error))
      })
      return false
    } finally {
      runInAction(() => {
        this.searchAction = null
      })
    }
  }

  async fetchTabContext(countBefore: number, countAfter: number) {
    const response = await chrome.runtime.sendMessage({
      action: 'browserStateQueryTabContext',
      query: {
        tabSourceId: this.tabContextCenterSourceId,
        countBefore,
        countAfter
      }
    })
    if (!response?.success) throw new Error(response?.error ?? 'Tab context loading failed')
    return response.result as BrowserTabContextResult
  }

  applyTabContextResult(result: BrowserTabContextResult) {
    this.tabContextItems = result.items ?? []
    this.isTabContextMoreBefore = result.isMoreBefore === true
    this.isTabContextMoreAfter = result.isMoreAfter === true
    this.tabContextWindowSourceId = result.windowSourceId ?? null
    const tabSourceIdSet = new Set(this.tabContextItems.map((tab) => tab.tabSourceId))
    this.tabContextSelectedIds = this.tabContextSelectedIds.filter(
      (tabSourceId) => tabSourceIdSet.has(tabSourceId)
    )
  }

  async enterTabContextMode() {
    const tabCenterSourceId = this.tabSearchSelectedIds[0] ?? null
    if (tabCenterSourceId === null || this.isSearchBusy || this.isContextBusy) return false
    this.contextToken += 1
    const contextToken = this.contextToken
    this.contextAction = 'enter'
    this.tabContextCenterSourceId = tabCenterSourceId
    this.setSearchMessage('loading', 'Loading nearby tabs...')
    const countSide = this.tabContextCountSide
    try {
      const result = await this.fetchTabContext(countSide, countSide)
      if (contextToken !== this.contextToken) return false
      runInAction(() => {
        if (!result.isTabFound) {
          this.tabContextCenterSourceId = null
          this.setSearchMessage('error', 'The selected tab no longer exists')
          return
        }
        this.isTabContextMode = true
        this.tabContextCountBefore = countSide
        this.tabContextCountAfter = countSide
        this.tabContextSelectedIds = [tabCenterSourceId]
        this.applyTabContextResult(result)
        this.tabContextScrollRequestCount += 1
        this.setSearchMessage('success', 'Showing nearby tabs in the same window')
      })
      return this.isTabContextMode
    } catch (error) {
      runInAction(() => {
        this.tabContextCenterSourceId = null
        this.setSearchMessage('error', getErrorText(error))
      })
      return false
    } finally {
      runInAction(() => {
        if (contextToken === this.contextToken) this.contextAction = null
      })
    }
  }

  exitTabContextMode(messageText = '') {
    const searchResultIdSet = new Set(
      this.tabSearchItems.map((tab) => tab.tabSourceId)
    )
    this.tabSearchSelectedIds = this.tabContextSelectedIds.filter(
      (tabSourceId) => searchResultIdSet.has(tabSourceId)
    )
    this.contextToken += 1
    this.isTabContextMode = false
    this.tabContextCenterSourceId = null
    this.tabContextItems = []
    this.tabContextSelectedIds = []
    this.tabContextCountBefore = this.tabContextCountSide
    this.tabContextCountAfter = this.tabContextCountSide
    this.isTabContextMoreBefore = false
    this.isTabContextMoreAfter = false
    this.tabContextWindowSourceId = null
    this.contextAction = null
    if (this.contextRefreshTimeoutId !== null) {
      clearTimeout(this.contextRefreshTimeoutId)
      this.contextRefreshTimeoutId = null
    }
    if (messageText) this.setSearchMessage('error', messageText)
  }

  async loadMoreTabContext(direction: 'before' | 'after') {
    if (!this.isTabContextMode || this.isContextBusy || this.isSearchBusy) return false
    const isBefore = direction === 'before'
    if (isBefore ? !this.isTabContextMoreBefore : !this.isTabContextMoreAfter) return false
    const countBeforeNext = this.tabContextCountBefore + (isBefore ? this.tabContextCountSide : 0)
    const countAfterNext = this.tabContextCountAfter + (isBefore ? 0 : this.tabContextCountSide)
    this.contextToken += 1
    const contextToken = this.contextToken
    this.contextAction = isBefore ? 'loadBefore' : 'loadAfter'
    try {
      const result = await this.fetchTabContext(countBeforeNext, countAfterNext)
      if (contextToken !== this.contextToken) return false
      runInAction(() => {
        if (!result.isTabFound) {
          this.exitTabContextMode('The context tab was closed. Context view exited')
          return
        }
        this.tabContextCountBefore = countBeforeNext
        this.tabContextCountAfter = countAfterNext
        this.applyTabContextResult(result)
      })
      return true
    } catch (error) {
      runInAction(() => {
        if (contextToken === this.contextToken) {
          this.setSearchMessage('error', getErrorText(error))
        }
      })
      return false
    } finally {
      runInAction(() => {
        if (contextToken === this.contextToken) this.contextAction = null
      })
    }
  }

  queueContextRefresh() {
    if (!this.isTabContextMode || this.contextRefreshTimeoutId !== null) return
    this.contextRefreshTimeoutId = setTimeout(() => {
      this.contextRefreshTimeoutId = null
      if (!this.isTabContextMode) return
      if (this.isContextBusy || this.isSearchBusy) {
        this.queueContextRefresh()
        return
      }
      void this.refreshTabContext()
    }, 150)
  }

  // Silent re-fetch after a browser change notice. The loaded range is kept.
  // The center tab being gone forces an exit; a moved center tab is recentered.
  async refreshTabContext() {
    if (!this.isTabContextMode || this.isContextBusy) return false
    const contextToken = this.contextToken
    const windowSourceIdBefore = this.tabContextWindowSourceId
    try {
      const result = await this.fetchTabContext(
        this.tabContextCountBefore,
        this.tabContextCountAfter
      )
      if (contextToken !== this.contextToken || !this.isTabContextMode) return false
      runInAction(() => {
        if (!result.isTabFound) {
          this.exitTabContextMode('The context tab was closed. Context view exited')
          return
        }
        this.applyTabContextResult(result)
        if (result.windowSourceId !== windowSourceIdBefore) {
          this.tabContextScrollRequestCount += 1
        }
      })
      return true
    } catch (error) {
      runInAction(() => {
        if (contextToken === this.contextToken) {
          this.setSearchMessage('error', getErrorText(error))
        }
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
    if (this.snapshotById.has(snapshotId) || this.snapshotDetailIdLoading.has(snapshotId)) return
    await this.loadSnapshotDetail(snapshotId, 'Snapshot detail loaded')
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
