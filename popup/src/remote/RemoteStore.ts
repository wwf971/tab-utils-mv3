import { makeAutoObservable, runInAction } from 'mobx'
import { remoteCall, remoteCodeNetwork, type RemoteResult } from './RemoteApi'

// MobX store of every remote (tab cloud) feature: endpoint/login settings,
// cloud status, the remote window cache, remote search (live and trash scope),
// the remote context view, the upload panel, the restore picker, and the
// per-instance ui states of remote window selectors.
//
// Everything the remote components render lives here; components only send
// change attempts back. The store never throws on backend/aws unavailability:
// every operation ends in a message line state, so the popup stays usable.

export interface RemoteTabItem {
  id: string
  windowId: string | null
  tabPath: string
  title: string
  url: string
  tagIdList: string[]
  groupId: string | null
  createAt: number | null
  trashAt: number | null
  matchList?: Array<{ field: string, indexStart: number, indexEnd: number }>
}

export interface RemoteWindowItem {
  id: string
  title: string
  tabCount?: number
  createAt?: number | null
  trashAt?: number | null
}

export interface RemoteContextState {
  tabCenterId: string
  items: RemoteTabItem[]
  countBefore: number
  countAfter: number
  isMoreBefore: boolean
  isMoreAfter: boolean
  selectedIds: string[]
  action: 'enter' | 'loadBefore' | 'loadAfter' | null
  scrollRequestCount: number
}

// One selector instance's ui state, keyed by a selector id (refer to
// selector.md). Cleared when the selector unmounts.
export interface RemoteSelectorState {
  isOpen: boolean
  searchText: string
}

export interface RemoteUploadTab {
  tabSourceId: number
  title: string
  url: string
}

export interface RemoteUploadPanelState {
  tabList: RemoteUploadTab[]
  sourceText: string
  isCloseOnSuccess: boolean
  isApplying: boolean
  windowIdSelected: string | null // null = the default remote window
}

export interface RemoteAwsCheckData {
  tableList?: Array<{
    tableName: string
    isExisting: boolean
    isConfigConsistent: boolean | null
    isReady: boolean
    statusText: string
    configIssueList: string[]
  }>
  index?: {
    isOk: boolean
    isExisting: boolean
    isConfigConsistent: boolean | null
    indexName: string
    documentCount: number | null
    configIssueList: string[]
    message: string
  }
  journalPendingCount?: number | null
  checkHistory?: RemoteConfigCheckHistory
}

export interface RemoteConfigCheckRecord {
  checkId: string
  checkType: 'dynamodbTables' | 'searchIndex'
  checkAtMs: number
  isPassed: boolean
  trigger: string
  result: Record<string, unknown>
}

export interface RemoteConfigCheckHistory {
  checkList: RemoteConfigCheckRecord[]
  latestByType: Partial<Record<RemoteConfigCheckRecord['checkType'], RemoteConfigCheckRecord>>
  isUploadAllowed: boolean
  uploadBlockReason: string
}

const uploadBatchMax = 40

export class RemoteStore {
  // endpoint and login, persisted in storage.local
  endpointUrl = ''
  userId = ''
  token = ''
  // settings popup
  isSettingsOpen = false
  isLoginOpen = false
  settingsUsername = ''
  settingsPassword = ''
  settingsAction: string | null = null
  settingsMessageStatus: 'idle' | 'loading' | 'success' | 'error' = 'idle'
  settingsMessageText = ''
  statusData: { isDbOk: boolean, isIndexOk: boolean, dbMessage?: string, indexMessage?: string } | null = null
  awsCheckData: RemoteAwsCheckData | null = null
  configCheckHistory: RemoteConfigCheckHistory | null = null
  settingsCloudTabId = 'tables'
  isIndexRecreateConfirmOpen = false
  indexRecreateDocumentCount: number | null = null

  // remote window cache, keyed by id, order kept in windowIds
  windowById = new Map<string, RemoteWindowItem>()
  windowIds: string[] = []
  isWindowsLoading = false
  windowsFetchedAt = 0
  windowDefaultId: string | null = null

  // selector ui states keyed by selector id
  selectorStateById = new Map<string, RemoteSelectorState>()

  // remote search
  textInput = ''
  textCommitted = ''
  isTrashScope = false
  isSearchTitle = true
  isSearchUrl = true
  items: RemoteTabItem[] = []
  selectedIds: string[] = []
  searchAction: string | null = null
  messageStatus: 'idle' | 'loading' | 'success' | 'error' = 'idle'
  messageText = ''
  // one remote context view at a time
  context: RemoteContextState | null = null

  // restore picker (trash scope): pick a target window for restore
  restorePick: { isOpen: boolean, windowIdSelected: string | null } = {
    isOpen: false,
    windowIdSelected: null
  }

  // upload panel, opened from the local Search tab
  uploadPanel: RemoteUploadPanelState | null = null
  uploadPanelOpenCount = 0

  getContextCountSide: () => number
  searchToken = 0
  commitTimeoutId: ReturnType<typeof setTimeout> | null = null

  constructor(options: { getContextCountSide: () => number }) {
    this.getContextCountSide = options.getContextCountSide
    makeAutoObservable(this, {
      getContextCountSide: false,
      searchToken: false,
      commitTimeoutId: false
    }, { autoBind: true })
  }

  get isLoggedIn() {
    return this.token !== ''
  }

  get isBusy() {
    return this.searchAction !== null || this.context?.action != null
  }

  get isUploadAllowed() {
    return this.isLoggedIn && this.configCheckHistory?.isUploadAllowed === true
  }

  get uploadBlockReason() {
    if (!this.isLoggedIn) return 'Log in to Tab Cloud before uploading'
    return this.configCheckHistory?.uploadBlockReason || 'Cloud configuration has not been checked'
  }

  get isContextMode() {
    return this.context !== null
  }

  get visibleItems() {
    return this.context ? this.context.items : this.items
  }

  get visibleSelectedIds() {
    return this.context ? this.context.selectedIds : this.selectedIds
  }

  get visibleSelectedItems() {
    const idSet = new Set(this.visibleSelectedIds)
    return this.visibleItems.filter((item) => idSet.has(item.id))
  }

  async init() {
    const stored = await chrome.storage.local.get([
      'remote_endpoint_url',
      'remote_user_id',
      'remote_token'
    ])
    runInAction(() => {
      this.endpointUrl = String(stored.remote_endpoint_url ?? '')
      this.userId = String(stored.remote_user_id ?? '')
      this.token = String(stored.remote_token ?? '')
      this.settingsUsername = this.userId
    })
    if (this.token && this.endpointUrl) {
      await this.configCheckHistoryFetch()
    }
  }

  dispose() {
    if (this.commitTimeoutId !== null) {
      clearTimeout(this.commitTimeoutId)
      this.commitTimeoutId = null
    }
    this.searchToken += 1
  }

  async call<T = Record<string, unknown>>(path: string, body: Record<string, unknown> = {}) {
    return remoteCall<T>(this.endpointUrl, this.token, path, body)
  }

  setMessage(status: 'idle' | 'loading' | 'success' | 'error', text: string) {
    this.messageStatus = status
    this.messageText = text
  }

  // -------------------------------------------------------------------------
  // settings, login, cloud status
  // -------------------------------------------------------------------------

  setSettingsOpen(isOpen: boolean) {
    this.isSettingsOpen = isOpen
    if (!isOpen) {
      this.isLoginOpen = false
      this.settingsPassword = ''
    }
    if (isOpen) {
      this.settingsMessageStatus = 'idle'
      this.settingsMessageText = ''
      void this.statusFetch()
    }
  }

  setLoginOpen(isOpen: boolean) {
    this.isLoginOpen = isOpen
    this.settingsPassword = ''
    if (isOpen && !this.settingsUsername) {
      this.settingsUsername = this.userId
    }
  }

  setSettingsMessage(status: 'idle' | 'loading' | 'success' | 'error', text: string) {
    this.settingsMessageStatus = status
    this.settingsMessageText = text
  }

  async updateEndpointUrl(endpointUrl: string) {
    const endpointUrlNext = endpointUrl.trim()
    if (endpointUrlNext !== this.endpointUrl) {
      this.statusData = null
      this.awsCheckData = null
      this.configCheckHistory = null
      this.cancelIndexRecreate()
    }
    this.endpointUrl = endpointUrlNext
    await chrome.storage.local.set({ remote_endpoint_url: this.endpointUrl })
  }

  setSettingsUsername(username: string) {
    this.settingsUsername = username
  }

  setSettingsPassword(password: string) {
    this.settingsPassword = password
  }

  async login() {
    if (this.settingsAction) return false
    this.settingsAction = 'login'
    this.setSettingsMessage('loading', 'Logging in...')
    const result = await this.call<{ token: string, userId: string }>('/api/auth/login', {
      username: this.settingsUsername,
      password: this.settingsPassword
    })
    return runInAction(() => {
      this.settingsAction = null
      if (result.code !== 0 || !result.data) {
        this.setSettingsMessage('error', result.message ?? 'Login failed')
        return false
      }
      this.token = result.data.token
      this.userId = result.data.userId
      this.isLoginOpen = false
      this.settingsPassword = ''
      void chrome.storage.local.set({
        remote_token: this.token,
        remote_user_id: this.userId
      })
      this.setSettingsMessage('success', `Logged in as ${this.userId}`)
      void this.configCheckHistoryFetch()
      return true
    })
  }

  async logout() {
    this.token = ''
    this.awsCheckData = null
    this.configCheckHistory = null
    await chrome.storage.local.set({ remote_token: '' })
    this.setSettingsMessage('idle', 'Logged out')
  }

  async statusFetch() {
    const result = await this.call<{ isDbOk: boolean, isIndexOk: boolean, dbMessage?: string, indexMessage?: string }>('/api/status')
    runInAction(() => {
      this.statusData = result.code === 0 && result.data ? result.data : null
      if (result.code !== 0) {
        this.setSettingsMessage('error', result.message ?? 'Backend unreachable')
        return
      }
      if (!result.data?.isDbOk) {
        this.awsCheckData = null
        this.setSettingsMessage(
          'error',
          result.data?.dbMessage || 'DynamoDB is not ready'
        )
        return
      }
      if (!result.data.isIndexOk) {
        this.setSettingsMessage(
          'error',
          result.data.indexMessage || 'Search index is missing'
        )
        return
      }
      this.setSettingsMessage('success', 'Backend, DynamoDB, and index are ready')
    })
    if (this.isLoggedIn && result.code !== remoteCodeNetwork) {
      void this.configCheckHistoryFetch()
    }
  }

  setSettingsCloudTabId(tabId: string) {
    this.settingsCloudTabId = tabId
  }

  applyMaintenanceData(data: RemoteAwsCheckData) {
    this.awsCheckData = {
      ...(this.awsCheckData ?? {}),
      ...data
    }
    if (data.checkHistory) {
      this.configCheckHistory = data.checkHistory
    }
  }

  async configCheckHistoryFetch() {
    if (!this.isLoggedIn) return false
    const result = await this.call<RemoteConfigCheckHistory>(
      '/api/maintenance/configCheckHistory',
      { limit: 20 }
    )
    return runInAction(() => {
      if (result.code !== 0 || !result.data) {
        return false
      }
      this.configCheckHistory = result.data
      return true
    })
  }

  async awsCheck() {
    if (this.settingsAction) return
    this.settingsAction = 'awsCheck'
    this.setSettingsMessage('loading', 'Checking aws side...')
    const result = await this.call<RemoteAwsCheckData>('/api/maintenance/awsCheck')
    runInAction(() => {
      this.settingsAction = null
      if (result.code !== 0 || !result.data) {
        this.awsCheckData = null
        this.setSettingsMessage('error', result.message ?? 'Check failed')
        return
      }
      this.applyMaintenanceData(result.data)
      this.setSettingsMessage('success', 'Check finished')
    })
  }

  async awsInit() {
    if (this.settingsAction) return
    this.settingsAction = 'awsInit'
    this.setSettingsMessage('loading', 'Initializing tables and index (may take a while)...')
    const result = await this.call<RemoteAwsCheckData>('/api/maintenance/awsInit')
    runInAction(() => {
      this.settingsAction = null
      if (result.code !== 0 || !result.data) {
        this.awsCheckData = null
        this.setSettingsMessage('error', result.message ?? 'Initialization failed')
        return
      }
      this.applyMaintenanceData(result.data)
      this.setSettingsMessage('success', 'Tables and index are ready')
    })
  }

  async tableCheck() {
    return this.runSettingsMaintenance(
      'tableCheck',
      'Checking DynamoDB tables...',
      '/api/maintenance/tableCheck',
      'DynamoDB table check finished'
    )
  }

  async tableInit() {
    return this.runSettingsMaintenance(
      'tableInit',
      'Initializing missing DynamoDB tables...',
      '/api/maintenance/tableInit',
      'DynamoDB table initialization finished'
    )
  }

  async indexCheck() {
    return this.runSettingsMaintenance(
      'indexCheck',
      'Checking search index...',
      '/api/maintenance/indexCheck',
      'Search index check finished'
    )
  }

  async indexInit() {
    return this.runSettingsMaintenance(
      'indexInit',
      'Initializing search index...',
      '/api/maintenance/indexInit',
      'Search index initialization finished'
    )
  }

  requestIndexRecreate() {
    const documentCount = this.awsCheckData?.index?.documentCount
    if (documentCount !== null && documentCount !== undefined && documentCount > 0) {
      this.indexRecreateDocumentCount = documentCount
      this.isIndexRecreateConfirmOpen = true
      return
    }
    void this.indexRecreate(false)
  }

  cancelIndexRecreate() {
    this.isIndexRecreateConfirmOpen = false
    this.indexRecreateDocumentCount = null
  }

  async indexRecreate(isConfirmedNonEmpty: boolean) {
    if (this.settingsAction) return false
    this.settingsAction = 'indexRecreate'
    this.setSettingsMessage('loading', 'Recreating search index...')
    const result = await this.call<RemoteAwsCheckData>(
      '/api/maintenance/indexRecreate',
      { isConfirmedNonEmpty }
    )
    const isOk = runInAction(() => {
      this.settingsAction = null
      if (result.code === -6) {
        const data = result.data as unknown as { documentCount?: number } | undefined
        this.indexRecreateDocumentCount = data?.documentCount ?? null
        this.isIndexRecreateConfirmOpen = true
        this.setSettingsMessage('error', result.message ?? 'Confirmation is required')
        return false
      }
      if (result.code !== 0 || !result.data) {
        this.setSettingsMessage('error', result.message ?? 'Search index recreation failed')
        return false
      }
      this.applyMaintenanceData(result.data)
      this.cancelIndexRecreate()
      this.setSettingsMessage('success', 'Search index recreated')
      return true
    })
    if (!isOk && result.code !== -6 && result.code !== remoteCodeNetwork) {
      void this.configCheckHistoryFetch()
    }
    return isOk
  }

  async runSettingsMaintenance(
    actionName: string,
    loadingText: string,
    path: string,
    successText: string
  ) {
    if (this.settingsAction) return false
    this.settingsAction = actionName
    this.setSettingsMessage('loading', loadingText)
    const result = await this.call<RemoteAwsCheckData>(path)
    const isOk = runInAction(() => {
      this.settingsAction = null
      if (result.code !== 0 || !result.data) {
        if (actionName.startsWith('table') && this.awsCheckData) {
          this.awsCheckData.tableList = undefined
          this.awsCheckData.journalPendingCount = undefined
        }
        if (actionName.startsWith('index') && this.awsCheckData) {
          this.awsCheckData.index = undefined
        }
        this.setSettingsMessage('error', result.message ?? `${actionName} failed`)
        return false
      }
      this.applyMaintenanceData(result.data)
      this.setSettingsMessage('success', successText)
      return true
    })
    if (!isOk && result.code !== remoteCodeNetwork) {
      void this.configCheckHistoryFetch()
    }
    return isOk
  }

  async indexRepair() {
    if (this.settingsAction) return
    this.settingsAction = 'indexRepair'
    this.setSettingsMessage('loading', 'Repairing index...')
    const result = await this.call<{ repairCount: number }>('/api/maintenance/indexRepair')
    runInAction(() => {
      this.settingsAction = null
      if (result.code !== 0) {
        this.setSettingsMessage('error', result.message ?? 'Repair failed')
        return
      }
      this.setSettingsMessage('success', `Repaired ${result.data?.repairCount ?? 0} pending journal(s)`)
    })
  }

  async indexRebuild() {
    if (this.settingsAction) return
    this.settingsAction = 'indexRebuild'
    this.setSettingsMessage('loading', 'Rebuilding current account search documents...')
    const result = await this.call<{ docCount: number }>('/api/maintenance/indexRebuild')
    runInAction(() => {
      this.settingsAction = null
      if (result.code !== 0) {
        this.setSettingsMessage('error', result.message ?? 'Index rebuild failed')
        return
      }
      this.setSettingsMessage(
        'success',
        `Rebuilt ${result.data?.docCount ?? 0} search document(s)`
      )
      void this.indexCheck()
    })
  }

  // -------------------------------------------------------------------------
  // remote windows cache and selectors
  // -------------------------------------------------------------------------

  async windowsFetch() {
    if (this.isWindowsLoading) return false
    this.isWindowsLoading = true
    try {
      const windows: RemoteWindowItem[] = []
      let cursor: string | undefined = undefined
      while (true) {
        const result: RemoteResult<{ windowList: RemoteWindowItem[], cursor?: string }> =
          await this.call('/api/window/list', cursor ? { cursor } : {})
        if (result.code !== 0 || !result.data) {
          runInAction(() => {
            this.setMessage('error', result.message ?? 'Window list loading failed')
          })
          return false
        }
        windows.push(...result.data.windowList)
        cursor = result.data.cursor
        if (!cursor) break
      }
      const metaResult = await this.call<{ windowDefaultId: string | null }>('/api/meta/get')
      runInAction(() => {
        this.windowById.clear()
        this.windowIds = []
        for (const windowItem of windows) {
          this.windowById.set(windowItem.id, windowItem)
          this.windowIds.push(windowItem.id)
        }
        this.windowsFetchedAt = Date.now()
        if (metaResult.code === 0) {
          this.windowDefaultId = metaResult.data?.windowDefaultId ?? null
        }
      })
      return true
    } finally {
      runInAction(() => {
        this.isWindowsLoading = false
      })
    }
  }

  selectorState(selectorId: string): RemoteSelectorState {
    let state = this.selectorStateById.get(selectorId)
    if (!state) {
      state = { isOpen: false, searchText: '' }
      this.selectorStateById.set(selectorId, state)
    }
    return state
  }

  selectorSetOpen(selectorId: string, isOpen: boolean) {
    const state = this.selectorState(selectorId)
    state.isOpen = isOpen
    if (isOpen) {
      state.searchText = ''
      // list already cached windows immediately; fetch only when the cache is empty
      if (this.windowIds.length === 0) void this.windowsFetch()
    }
  }

  selectorSetSearchText(selectorId: string, searchText: string) {
    this.selectorState(selectorId).searchText = searchText
  }

  selectorClear(selectorId: string) {
    this.selectorStateById.delete(selectorId)
  }

  // windows matching one selector's search text, over the cached windows
  selectorWindowIdsVisible(selectorId: string) {
    const searchText = this.selectorState(selectorId).searchText.trim().toLocaleLowerCase()
    if (!searchText) return this.windowIds
    return this.windowIds.filter((windowId) => {
      const windowItem = this.windowById.get(windowId)
      return (windowItem?.title ?? '').toLocaleLowerCase().includes(searchText)
    })
  }

  // -------------------------------------------------------------------------
  // remote search (live scope and trash scope share one search bar)
  // -------------------------------------------------------------------------

  setTextInput(text: string) {
    this.textInput = text
    if (this.context) this.exitContext()
    this.queueCommit()
  }

  queueCommit() {
    this.searchToken += 1
    const searchToken = this.searchToken
    if (this.commitTimeoutId !== null) clearTimeout(this.commitTimeoutId)
    this.commitTimeoutId = setTimeout(() => {
      this.commitTimeoutId = null
      if (searchToken !== this.searchToken) return
      void this.search()
    }, 180)
  }

  setTrashScope(isTrashScope: boolean) {
    if (this.isTrashScope === isTrashScope) return
    this.isTrashScope = isTrashScope
    this.restorePick = { isOpen: false, windowIdSelected: null }
    if (this.context) this.exitContext()
    this.items = []
    this.selectedIds = []
    if (this.textInput.trim()) {
      void this.search()
    } else {
      // an empty search text in trash scope lists the newest trashed tabs
      if (isTrashScope) void this.trashListLoad()
    }
  }

  setSearchField(fieldName: 'title' | 'url', isEnabled: boolean) {
    if (fieldName === 'title') this.isSearchTitle = isEnabled
    else this.isSearchUrl = isEnabled
    if (!this.isSearchTitle && !this.isSearchUrl) {
      // at least one field stays enabled
      if (fieldName === 'title') this.isSearchUrl = true
      else this.isSearchTitle = true
    }
    if (this.textInput.trim()) void this.search()
  }

  setSelectedIds(ids: string[]) {
    if (this.context) this.context.selectedIds = ids
    else this.selectedIds = ids
  }

  async search() {
    const searchText = this.textInput.trim()
    this.searchToken += 1
    const searchToken = this.searchToken
    if (!searchText) {
      this.textCommitted = ''
      if (this.isTrashScope) return this.trashListLoad()
      this.items = []
      this.selectedIds = []
      this.setMessage('idle', 'Enter text to search remote tabs')
      return false
    }
    if (!this.isLoggedIn) {
      this.setMessage('error', 'Not logged in. Open remote settings to log in')
      return false
    }
    this.searchAction = 'search'
    this.setMessage('loading', 'Searching remote tabs...')
    const result = await this.call<{ tabList: RemoteTabItem[] }>('/api/search', {
      query: searchText,
      isSearchTitle: this.isSearchTitle,
      isSearchUrl: this.isSearchUrl,
      isTrashed: this.isTrashScope,
      limit: 200
    })
    return runInAction(() => {
      if (searchToken !== this.searchToken) return false
      this.searchAction = null
      if (result.code !== 0 || !result.data) {
        this.items = []
        this.selectedIds = []
        this.setMessage('error', result.message ?? 'Remote search failed')
        return false
      }
      this.textCommitted = searchText
      this.items = result.data.tabList
      const idSet = new Set(this.items.map((item) => item.id))
      this.selectedIds = this.selectedIds.filter((id) => idSet.has(id))
      this.setMessage(
        'success',
        this.items.length === 1 ? '1 remote tab found' : `${this.items.length} remote tabs found`
      )
      return true
    })
  }

  // trash scope with empty search text: list the newest trashed tabs
  async trashListLoad() {
    if (!this.isLoggedIn) {
      this.setMessage('error', 'Not logged in. Open remote settings to log in')
      return false
    }
    this.searchToken += 1
    const searchToken = this.searchToken
    this.searchAction = 'search'
    this.setMessage('loading', 'Loading trash...')
    const result = await this.call<{ tabList: RemoteTabItem[] }>('/api/trash/list', { limit: 200 })
    return runInAction(() => {
      if (searchToken !== this.searchToken) return false
      this.searchAction = null
      if (result.code !== 0 || !result.data) {
        this.items = []
        this.setMessage('error', result.message ?? 'Trash loading failed')
        return false
      }
      this.textCommitted = ''
      this.items = result.data.tabList
      const idSet = new Set(this.items.map((item) => item.id))
      this.selectedIds = this.selectedIds.filter((id) => idSet.has(id))
      this.setMessage(
        'success',
        this.items.length === 1 ? '1 trashed tab' : `${this.items.length} trashed tabs`
      )
      return true
    })
  }

  async refreshVisible() {
    if (this.context) return this.refreshContext()
    if (this.textInput.trim()) return this.search()
    if (this.isTrashScope) return this.trashListLoad()
    return false
  }

  // -------------------------------------------------------------------------
  // remote context view
  // -------------------------------------------------------------------------

  async enterContext(tabId: string) {
    if (this.isBusy) return false
    const countSide = this.getContextCountSide()
    this.searchAction = 'contextEnter'
    this.setMessage('loading', 'Loading nearby remote tabs...')
    const isEntered = await this.contextFetch(tabId, countSide, countSide, 'enter')
    runInAction(() => {
      this.searchAction = null
    })
    return isEntered
  }

  async contextFetch(
    tabCenterId: string,
    countBefore: number,
    countAfter: number,
    action: 'enter' | 'loadBefore' | 'loadAfter' | 'refresh'
  ) {
    const result = await this.call<{
      tabListBefore: RemoteTabItem[]
      tabCenter: RemoteTabItem
      tabListAfter: RemoteTabItem[]
      isWindowStartReached: boolean
      isWindowEndReached: boolean
    }>('/api/tab/context', { tabId: tabCenterId, countBefore, countAfter })
    return runInAction(() => {
      if (result.code !== 0 || !result.data) {
        if (action !== 'refresh') {
          this.setMessage('error', result.message ?? 'Remote context loading failed')
        } else {
          this.exitContext()
          this.setMessage('error', 'The context tab is gone. Context view exited')
        }
        return false
      }
      const items = [
        ...result.data.tabListBefore,
        result.data.tabCenter,
        ...result.data.tabListAfter
      ]
      const selectedIds = this.context
        ? this.context.selectedIds.filter((id) => items.some((item) => item.id === id))
        : [tabCenterId]
      this.context = {
        tabCenterId,
        items,
        countBefore,
        countAfter,
        isMoreBefore: !result.data.isWindowStartReached,
        isMoreAfter: !result.data.isWindowEndReached,
        selectedIds,
        action: null,
        scrollRequestCount: (this.context?.scrollRequestCount ?? 0) + (action === 'enter' ? 1 : 0)
      }
      if (action === 'enter') {
        this.setMessage('success', 'Showing nearby tabs in the same remote window')
      }
      return true
    })
  }

  async loadMoreContext(direction: 'before' | 'after') {
    const context = this.context
    if (!context || this.isBusy) return false
    if (direction === 'before' ? !context.isMoreBefore : !context.isMoreAfter) return false
    const countSide = this.getContextCountSide()
    const countBefore = context.countBefore + (direction === 'before' ? countSide : 0)
    const countAfter = context.countAfter + (direction === 'after' ? countSide : 0)
    context.action = direction === 'before' ? 'loadBefore' : 'loadAfter'
    const isLoaded = await this.contextFetch(
      context.tabCenterId, countBefore, countAfter,
      direction === 'before' ? 'loadBefore' : 'loadAfter')
    runInAction(() => {
      if (this.context) this.context.action = null
    })
    return isLoaded
  }

  async refreshContext() {
    const context = this.context
    if (!context) return false
    return this.contextFetch(context.tabCenterId, context.countBefore, context.countAfter, 'refresh')
  }

  exitContext() {
    if (!this.context) return
    const idSet = new Set(this.items.map((item) => item.id))
    this.selectedIds = this.context.selectedIds.filter((id) => idSet.has(id))
    this.context = null
  }

  // -------------------------------------------------------------------------
  // operations on remote tabs
  // -------------------------------------------------------------------------

  async runTabAction(
    actionName: string,
    loadingText: string,
    successText: string,
    apply: () => Promise<RemoteResult<unknown>>
  ) {
    if (this.searchAction) return false
    this.searchAction = actionName
    this.setMessage('loading', loadingText)
    const result = await apply()
    let isOk = false
    runInAction(() => {
      this.searchAction = null
      if (result.code !== 0) {
        this.setMessage('error', result.message ?? `${actionName} failed`)
        return
      }
      this.setMessage('success', successText)
      isOk = true
    })
    if (isOk) await this.refreshVisible()
    return isOk
  }

  // open remote tabs in the browser; optionally trash them remotely after the
  // browser confirms every tab was opened
  async openTabs(tabIds: string[], isTrashAfterOpen: boolean) {
    const idSet = new Set(tabIds)
    const tabs = this.visibleItems.filter((item) => idSet.has(item.id))
    if (tabs.length === 0) return false
    this.searchAction = 'open'
    this.setMessage('loading', tabs.length === 1 ? 'Opening tab...' : `Opening ${tabs.length} tabs...`)
    const tabIdsOpened: string[] = []
    try {
      for (const tab of tabs) {
        await chrome.tabs.create({ url: tab.url, active: false })
        tabIdsOpened.push(tab.id)
      }
    } catch (error) {
      runInAction(() => {
        this.searchAction = null
        this.setMessage('error', `Opening failed: ${getErrorText(error)}`)
      })
      // tabs already opened before the failure are still trashed below when asked
    }
    let isTrashOk = true
    if (isTrashAfterOpen && tabIdsOpened.length > 0) {
      const result = await this.call('/api/tab/trash', { tabIdList: tabIdsOpened })
      isTrashOk = result.code === 0
      if (!isTrashOk) {
        runInAction(() => {
          this.setMessage('error', `Opened, but trashing on remote failed: ${result.message ?? ''}`)
        })
      }
    }
    runInAction(() => {
      this.searchAction = null
      if (isTrashOk && tabIdsOpened.length === tabs.length) {
        this.setMessage('success', isTrashAfterOpen
          ? `${tabIdsOpened.length} tab(s) opened and trashed on remote`
          : `${tabIdsOpened.length} tab(s) opened`)
      }
    })
    if (isTrashAfterOpen) await this.refreshVisible()
    return isTrashOk
  }

  async trashTabs(tabIds: string[]) {
    if (tabIds.length === 0) return false
    return this.runTabAction(
      'trash',
      tabIds.length === 1 ? 'Trashing tab...' : `Trashing ${tabIds.length} tabs...`,
      tabIds.length === 1 ? 'Tab moved to trash' : `${tabIds.length} tabs moved to trash`,
      () => this.call('/api/tab/trash', { tabIdList: tabIds })
    )
  }

  async restoreTabs(tabIds: string[], windowIdTarget: string | null) {
    if (tabIds.length === 0) return false
    const body: Record<string, unknown> = { tabIdList: tabIds }
    if (windowIdTarget) body.windowIdTarget = windowIdTarget
    return this.runTabAction(
      'restore',
      'Restoring...',
      tabIds.length === 1 ? 'Tab restored' : `${tabIds.length} tabs restored`,
      () => this.call('/api/tab/restore', body)
    )
  }

  async deleteTabsPermanent(tabIds: string[]) {
    if (tabIds.length === 0) return false
    return this.runTabAction(
      'deletePermanent',
      'Deleting permanently...',
      tabIds.length === 1 ? 'Tab deleted permanently' : `${tabIds.length} tabs deleted permanently`,
      () => this.call('/api/tab/deletePermanent', { tabIdList: tabIds })
    )
  }

  async moveTabs(tabIds: string[], targetTabId: string, placement: 'before' | 'after') {
    if (tabIds.length === 0) return false
    return this.runTabAction(
      'move',
      'Moving tabs...',
      tabIds.length === 1 ? 'Tab moved' : `${tabIds.length} tabs moved`,
      () => this.call('/api/tab/move', { tabIdList: tabIds, targetTabId, placement })
    )
  }

  setRestorePickOpen(isOpen: boolean) {
    this.restorePick = { isOpen, windowIdSelected: null }
  }

  setRestorePickWindowId(windowId: string | null) {
    this.restorePick.windowIdSelected = windowId
  }

  async applyRestorePick() {
    const windowId = this.restorePick.windowIdSelected
    const tabIds = this.visibleSelectedIds
    const isOk = await this.restoreTabs(tabIds, windowId)
    if (isOk) {
      runInAction(() => {
        this.restorePick = { isOpen: false, windowIdSelected: null }
      })
    }
    return isOk
  }

  // -------------------------------------------------------------------------
  // upload panel (opened from the local Search tab)
  // -------------------------------------------------------------------------

  openUploadPanel(tabList: RemoteUploadTab[], sourceText: string) {
    if (!this.isUploadAllowed) {
      this.setMessage('error', this.uploadBlockReason)
      return false
    }
    this.uploadPanel = {
      tabList,
      sourceText,
      isCloseOnSuccess: true,
      isApplying: false,
      windowIdSelected: null
    }
    this.uploadPanelOpenCount += 1
    return true
  }

  async openUploadPanelForWindow(windowSourceId: number) {
    if (!this.isUploadAllowed) {
      this.setMessage('error', this.uploadBlockReason)
      return false
    }
    const tabs = await chrome.tabs.query({ windowId: windowSourceId })
    const tabList = tabs
      .filter((tab) => Number.isInteger(tab.id))
      .map((tab) => ({
        tabSourceId: tab.id as number,
        title: tab.title ?? '',
        url: tab.url ?? ''
      }))
    runInAction(() => {
      this.openUploadPanel(tabList, 'this window')
    })
    return true
  }

  closeUploadPanel() {
    this.uploadPanel = null
  }

  setUploadCloseOnSuccess(isCloseOnSuccess: boolean) {
    if (this.uploadPanel) this.uploadPanel.isCloseOnSuccess = isCloseOnSuccess
  }

  setUploadWindowId(windowId: string | null) {
    if (this.uploadPanel) this.uploadPanel.windowIdSelected = windowId
  }

  async applyUpload(): Promise<{ isOk: boolean, messageText: string }> {
    const panel = this.uploadPanel
    if (!panel || panel.isApplying || panel.tabList.length === 0) {
      return { isOk: false, messageText: 'Nothing to upload' }
    }
    if (!this.isLoggedIn) {
      return { isOk: false, messageText: 'Not logged in. Open the Remote tab settings to log in' }
    }
    if (!this.isUploadAllowed) {
      return { isOk: false, messageText: this.uploadBlockReason }
    }
    panel.isApplying = true
    try {
      // each chunk is one backend transaction; the batch cap comes from the api
      let windowId = panel.windowIdSelected
      for (let indexStart = 0; indexStart < panel.tabList.length; indexStart += uploadBatchMax) {
        const chunk = panel.tabList.slice(indexStart, indexStart + uploadBatchMax)
        const body: Record<string, unknown> = {
          tabList: chunk.map((tab) => ({ title: tab.title, url: tab.url }))
        }
        if (windowId) body.windowId = windowId
        const result = await this.call<{ windowId: string }>('/api/tab/create', body)
        if (result.code !== 0 || !result.data) {
          return { isOk: false, messageText: result.message ?? 'Upload failed' }
        }
        // later chunks go to the same window the first chunk landed in
        windowId = result.data.windowId
      }
      if (panel.isCloseOnSuccess) {
        const tabSourceIds = panel.tabList.map((tab) => tab.tabSourceId)
        try {
          await chrome.tabs.remove(tabSourceIds)
        } catch (error) {
          return {
            isOk: true,
            messageText: `Uploaded, but closing local tabs failed: ${getErrorText(error)}`
          }
        }
        return { isOk: true, messageText: `${panel.tabList.length} tab(s) uploaded and closed` }
      }
      return { isOk: true, messageText: `${panel.tabList.length} tab(s) uploaded` }
    } finally {
      runInAction(() => {
        if (this.uploadPanel) this.uploadPanel.isApplying = false
      })
    }
  }
}

function getErrorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
