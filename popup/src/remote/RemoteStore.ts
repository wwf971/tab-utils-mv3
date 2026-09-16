import { makeAutoObservable, runInAction } from 'mobx'
import { remoteCall, remoteCodeAuth, remoteCodeNetwork, type RemoteResult } from './RemoteApi'
import { cognitoLogin, cognitoRefresh } from './CognitoAuth'
import { remoteAwsBuildDefaults } from './RemoteBuildConfig'
import { REMOTE_SEARCH_PAGE_SIZE, REMOTE_TAG_PAGE_SIZE } from '../params'

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

// One tag of the tag service (aws_oa _3_tag_and_type), fetched through the
// /api/tabTag apis. Tags are user specific and cannot be deleted from here.
export interface RemoteTagItem {
  id: string
  name: string
  parentId: string | null
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

// One tab row of the upload panel with its own upload progress. Tabs upload
// one by one; a failed tab does not block the remaining tabs.
export interface RemoteUploadTabState extends RemoteUploadTab {
  status: 'pending' | 'uploading' | 'success' | 'fail'
  errorText: string
}

export interface RemoteUploadPanelState {
  tabList: RemoteUploadTabState[]
  sourceText: string
  isCloseOnSuccess: boolean
  isApplying: boolean
  // set by the Stop button; the run breaks after the tab currently being
  // processed finishes (success or fail), never in the middle of one tab
  isStopRequested: boolean
  windowIdSelected: string | null // null = the default remote window
  tagIdsSelected: string[] // tags assigned to every uploaded tab
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

export type RemoteBackendUse = 'local' | 'aws'

// state answered for a selector that has no stored state yet (refer to
// RemoteStore.selectorState); shared and never mutated
const SELECTOR_STATE_DEFAULT: RemoteSelectorState = { isOpen: false, searchText: '' }

export class RemoteStore {
  // which backend the popup talks to, persisted in storage.local:
  // 'local' = the home flask server, 'aws' = api gateway + cognito directly
  backendUse: RemoteBackendUse = 'local'
  // local backend endpoint and login, persisted in storage.local
  endpointUrl = ''
  userId = ''
  token = ''
  // aws backend settings and cognito session, persisted in storage.local;
  // values come from backend-aws config_gen.yaml after ensure_architect.py
  awsEndpointUrl = ''
  awsRegion = ''
  awsClientId = ''
  awsUsername = ''
  awsAccessToken = ''
  awsRefreshToken = ''
  awsExpireAtMs = 0
  // dedupe concurrent access-token refreshes (popup fires parallel calls)
  awsRefreshPromise: Promise<RemoteResult<unknown>> | null = null
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

  // tag cache and the tag selector's search state. one tag selector dropdown
  // is open at a time, so the search state is shared, not per selector. tag
  // name search runs on the backend (char-level index of the tag service),
  // unlike the window selector which filters its local cache.
  tagById = new Map<string, RemoteTagItem>()
  tagIdsVisible: string[] = []
  tagSearchText = ''
  tagSearchAction: string | null = null
  tagSearchMessageText = ''
  isTagCreating = false
  tagSearchToken = 0
  tagSearchTimeoutId: ReturnType<typeof setTimeout> | null = null
  // dropdown list pagination: whether more tags exist past the loaded pages,
  // and the offset the next page starts at
  isTagsMore = false
  tagOffsetNext = 0

  // remote search
  textInput = ''
  textCommitted = ''
  // tag filter of the remote search: results must carry ALL these tags.
  // empty = no tag filter (the search request then omits tagIdList).
  // launch rule: with no picked tag the search launches automatically
  // (typing is debounced); with at least one picked tag it is launched
  // manually with the Search button — picking tags and typing then only
  // compose the query, so composing a multi-tag query fires no requests.
  searchTagIdsSelected: string[] = []
  // the tag filter of the loaded results (set at launch), used by load more:
  // the composed selection may have drifted since the last launch
  searchTagIdsCommitted: string[] = []
  isTrashScope = false
  isSearchTitle = true
  isSearchUrl = true
  // search result pagination: whether more results exist past the loaded
  // pages, and the offset the next page starts at
  isSearchMore = false
  searchOffsetNext = 0
  items: RemoteTabItem[] = []
  selectedIds: string[] = []
  contentOffsetLeftById = new Map<string, number>()
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
      commitTimeoutId: false,
      tagSearchToken: false,
      tagSearchTimeoutId: false,
      awsRefreshPromise: false
    }, { autoBind: true })
  }

  get isLoggedIn() {
    if (this.backendUse === 'aws') return this.awsRefreshToken !== ''
    return this.token !== ''
  }

  get loginDisplayName() {
    return this.backendUse === 'aws' ? this.awsUsername : this.userId
  }

  get isBusy() {
    return this.searchAction !== null || this.context?.action != null
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
      'remote_backend_use',
      'remote_endpoint_url',
      'remote_user_id',
      'remote_token',
      'remote_aws_endpoint_url',
      'remote_aws_region',
      'remote_aws_client_id',
      'remote_aws_username',
      'remote_aws_access_token',
      'remote_aws_refresh_token',
      'remote_aws_expire_at'
    ])
    runInAction(() => {
      this.backendUse = stored.remote_backend_use === 'aws' ? 'aws' : 'local'
      this.endpointUrl = String(stored.remote_endpoint_url ?? '')
      this.userId = String(stored.remote_user_id ?? '')
      this.token = String(stored.remote_token ?? '')
      this.awsEndpointUrl = stored.remote_aws_endpoint_url === undefined
        ? remoteAwsBuildDefaults.endpointUrl
        : String(stored.remote_aws_endpoint_url)
      this.awsRegion = stored.remote_aws_region === undefined
        ? remoteAwsBuildDefaults.region
        : String(stored.remote_aws_region)
      this.awsClientId = stored.remote_aws_client_id === undefined
        ? remoteAwsBuildDefaults.clientId
        : String(stored.remote_aws_client_id)
      this.awsUsername = String(stored.remote_aws_username ?? '')
      this.awsAccessToken = String(stored.remote_aws_access_token ?? '')
      this.awsRefreshToken = String(stored.remote_aws_refresh_token ?? '')
      this.awsExpireAtMs = Number(stored.remote_aws_expire_at ?? 0)
      this.settingsUsername = this.loginDisplayName
    })
  }

  dispose() {
    if (this.commitTimeoutId !== null) {
      clearTimeout(this.commitTimeoutId)
      this.commitTimeoutId = null
    }
    this.searchToken += 1
    if (this.tagSearchTimeoutId !== null) {
      clearTimeout(this.tagSearchTimeoutId)
      this.tagSearchTimeoutId = null
    }
    this.tagSearchToken += 1
  }

  async call<T = Record<string, unknown>>(path: string, body: Record<string, unknown> = {}) {
    if (this.backendUse === 'aws') {
      const tokenResult = await this.awsAccessTokenEnsure()
      if (tokenResult.code !== 0) return tokenResult as RemoteResult<T>
      return remoteCall<T>(this.awsEndpointUrl, this.awsAccessToken, path, body)
    }
    return remoteCall<T>(this.endpointUrl, this.token, path, body)
  }

  // a valid cognito access token before an aws call, renewing silently with
  // the stored refresh token when the current one is (nearly) expired
  async awsAccessTokenEnsure(): Promise<RemoteResult<unknown>> {
    if (!this.awsRefreshToken) {
      return { code: remoteCodeAuth, message: 'Not logged in. Open remote settings to log in' }
    }
    if (this.awsAccessToken && Date.now() < this.awsExpireAtMs - 60000) {
      return { code: 0 }
    }
    if (!this.awsRefreshPromise) {
      this.awsRefreshPromise = this.awsAccessTokenRefresh().finally(() => {
        this.awsRefreshPromise = null
      })
    }
    return this.awsRefreshPromise
  }

  async awsAccessTokenRefresh(): Promise<RemoteResult<unknown>> {
    const result = await cognitoRefresh(this.awsRegion, this.awsClientId, this.awsRefreshToken)
    return runInAction(() => {
      if (result.code !== 0 || !result.data) {
        // the refresh token itself expired or was revoked: back to logged out
        this.awsAccessToken = ''
        this.awsRefreshToken = ''
        this.awsExpireAtMs = 0
        void chrome.storage.local.set({
          remote_aws_access_token: '',
          remote_aws_refresh_token: '',
          remote_aws_expire_at: 0
        })
        return {
          code: remoteCodeAuth,
          message: `Login session expired (${result.message ?? 'refresh failed'}). Log in again`
        }
      }
      this.awsAccessToken = result.data.accessToken
      this.awsExpireAtMs = result.data.expireAtMs
      if (result.data.refreshToken) this.awsRefreshToken = result.data.refreshToken
      void chrome.storage.local.set({
        remote_aws_access_token: this.awsAccessToken,
        remote_aws_refresh_token: this.awsRefreshToken,
        remote_aws_expire_at: this.awsExpireAtMs
      })
      return { code: 0 }
    })
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
      this.settingsUsername = this.loginDisplayName
    }
  }

  setSettingsMessage(status: 'idle' | 'loading' | 'success' | 'error', text: string) {
    this.settingsMessageStatus = status
    this.settingsMessageText = text
  }

  async updateEndpointUrl(endpointUrl: string) {
    const endpointUrlNext = endpointUrl.trim()
    if (endpointUrlNext !== this.endpointUrl) {
      this.backendDataReset()
    }
    this.endpointUrl = endpointUrlNext
    await chrome.storage.local.set({ remote_endpoint_url: this.endpointUrl })
  }

  async setBackendUse(backendUse: RemoteBackendUse) {
    if (backendUse === this.backendUse) return
    this.backendUse = backendUse
    this.backendDataReset()
    // remote data of the previous backend is stale for the new one
    this.windowById.clear()
    this.windowIds = []
    this.windowsFetchedAt = 0
    this.windowDefaultId = null
    this.items = []
    this.selectedIds = []
    this.context = null
    this.textCommitted = ''
    // picked filter tags belong to the previous backend
    this.searchTagIdsSelected = []
    this.searchTagIdsCommitted = []
    this.isSearchMore = false
    this.setMessage('idle', '')
    this.settingsUsername = this.loginDisplayName
    await chrome.storage.local.set({ remote_backend_use: this.backendUse })
    if (this.isSettingsOpen) void this.statusFetch()
  }

  backendDataReset() {
    this.statusData = null
    this.awsCheckData = null
    this.configCheckHistory = null
    this.cancelIndexRecreate()
  }

  async updateAwsEndpointUrl(endpointUrl: string) {
    const endpointUrlNext = endpointUrl.trim()
    if (endpointUrlNext !== this.awsEndpointUrl && this.backendUse === 'aws') {
      this.backendDataReset()
    }
    this.awsEndpointUrl = endpointUrlNext
    await chrome.storage.local.set({ remote_aws_endpoint_url: this.awsEndpointUrl })
  }

  async updateAwsRegion(region: string) {
    this.awsRegion = region.trim()
    await chrome.storage.local.set({ remote_aws_region: this.awsRegion })
  }

  async updateAwsClientId(clientId: string) {
    this.awsClientId = clientId.trim()
    await chrome.storage.local.set({ remote_aws_client_id: this.awsClientId })
  }

  async restoreAwsBuildDefaults() {
    this.awsEndpointUrl = remoteAwsBuildDefaults.endpointUrl
    this.awsRegion = remoteAwsBuildDefaults.region
    this.awsClientId = remoteAwsBuildDefaults.clientId
    if (this.backendUse === 'aws') {
      this.backendDataReset()
    }
    await chrome.storage.local.set({
      remote_aws_endpoint_url: this.awsEndpointUrl,
      remote_aws_region: this.awsRegion,
      remote_aws_client_id: this.awsClientId
    })
    if (this.isSettingsOpen && this.backendUse === 'aws') {
      void this.statusFetch()
    }
  }

  setSettingsUsername(username: string) {
    this.settingsUsername = username
  }

  setSettingsPassword(password: string) {
    this.settingsPassword = password
  }

  async login() {
    if (this.backendUse === 'aws') return this.loginAws()
    if (this.settingsAction) return false
    this.settingsAction = 'login'
    this.setSettingsMessage('loading', 'Logging in...')
    const result = await remoteCall<{ token: string, userId: string }>(
      this.endpointUrl, '', '/api/auth/login', {
        username: this.settingsUsername,
        password: this.settingsPassword
      }
    )
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
      return true
    })
  }

  async loginAws() {
    if (this.settingsAction) return false
    if (!this.awsRegion || !this.awsClientId) {
      this.setSettingsMessage('error', 'Set the aws region and app client id first')
      return false
    }
    this.settingsAction = 'login'
    this.setSettingsMessage('loading', 'Logging in to aws cognito...')
    const result = await cognitoLogin(
      this.awsRegion, this.awsClientId, this.settingsUsername, this.settingsPassword
    )
    return runInAction(() => {
      this.settingsAction = null
      if (result.code !== 0 || !result.data) {
        this.setSettingsMessage('error', result.message ?? 'Cognito login failed')
        return false
      }
      this.awsAccessToken = result.data.accessToken
      this.awsRefreshToken = result.data.refreshToken
      this.awsExpireAtMs = result.data.expireAtMs
      this.awsUsername = this.settingsUsername
      this.isLoginOpen = false
      this.settingsPassword = ''
      void chrome.storage.local.set({
        remote_aws_access_token: this.awsAccessToken,
        remote_aws_refresh_token: this.awsRefreshToken,
        remote_aws_expire_at: this.awsExpireAtMs,
        remote_aws_username: this.awsUsername
      })
      this.setSettingsMessage('success', `Logged in as ${this.awsUsername}`)
      return true
    })
  }

  async logout() {
    if (this.backendUse === 'aws') {
      this.awsAccessToken = ''
      this.awsRefreshToken = ''
      this.awsExpireAtMs = 0
      this.awsCheckData = null
      this.configCheckHistory = null
      await chrome.storage.local.set({
        remote_aws_access_token: '',
        remote_aws_refresh_token: '',
        remote_aws_expire_at: 0
      })
      this.setSettingsMessage('idle', 'Logged out')
      return
    }
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

  // The check history is a settings-panel display only (Check History tab and
  // the check summary line). It never gates any operation: a not-ready cloud
  // side surfaces as the failing operation's own error.
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

  // Read-only lookup used by component renders: a selector without stored
  // state is closed with an empty search text. It must not create the entry:
  // a render must not mutate the store.
  selectorState(selectorId: string): RemoteSelectorState {
    return this.selectorStateById.get(selectorId) ?? SELECTOR_STATE_DEFAULT
  }

  // Used by the mutating methods. The returned object is always re-read from
  // the observable map: the map wraps a set plain object into an observable
  // proxy, so returning the plain object itself would hand out state whose
  // reads are untracked and whose mutations notify nobody (the dropdown then
  // opens only when some unrelated observable happens to change).
  selectorStateEnsure(selectorId: string): RemoteSelectorState {
    let state = this.selectorStateById.get(selectorId)
    if (!state) {
      this.selectorStateById.set(selectorId, { isOpen: false, searchText: '' })
      state = this.selectorStateById.get(selectorId) as RemoteSelectorState
    }
    return state
  }

  selectorSetOpen(selectorId: string, isOpen: boolean) {
    const state = this.selectorStateEnsure(selectorId)
    state.isOpen = isOpen
    if (isOpen) {
      state.searchText = ''
      // list already cached windows immediately; fetch only when the cache is empty
      if (this.windowIds.length === 0) void this.windowsFetch()
    }
  }

  selectorSetSearchText(selectorId: string, searchText: string) {
    this.selectorStateEnsure(selectorId).searchText = searchText
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
  // tags (the /api/tabTag apis of the tag service)
  // -------------------------------------------------------------------------

  tagSelectorSetOpen(selectorId: string, isOpen: boolean) {
    const state = this.selectorStateEnsure(selectorId)
    state.isOpen = isOpen
    if (isOpen) {
      this.tagSearchText = ''
      this.tagSearchMessageText = ''
      void this.tagSearch()
    }
  }

  setTagSearchText(text: string) {
    this.tagSearchText = text
    this.tagSearchToken += 1
    const tagSearchToken = this.tagSearchToken
    if (this.tagSearchTimeoutId !== null) clearTimeout(this.tagSearchTimeoutId)
    this.tagSearchTimeoutId = setTimeout(() => {
      this.tagSearchTimeoutId = null
      if (tagSearchToken !== this.tagSearchToken) return
      void this.tagSearch()
    }, 180)
  }

  // one page of tags for the dropdown: empty search text lists the user's
  // tags (name order); otherwise the backend searches the tag names (any
  // substring, case-insensitive)
  async tagPageFetch(searchText: string, offset: number) {
    const body: Record<string, unknown> = { limit: REMOTE_TAG_PAGE_SIZE, offset }
    if (searchText) {
      body.query = searchText
      return this.call<{ tagList: RemoteTagItem[], isMore?: boolean }>('/api/tabTag/search', body)
    }
    return this.call<{ tagList: RemoteTagItem[], isMore?: boolean }>('/api/tabTag/list', body)
  }

  async tagSearch() {
    if (!this.isLoggedIn) {
      this.tagSearchMessageText = 'Not logged in'
      return false
    }
    const searchText = this.tagSearchText.trim()
    this.tagSearchToken += 1
    const tagSearchToken = this.tagSearchToken
    this.tagSearchAction = 'search'
    const result = await this.tagPageFetch(searchText, 0)
    return runInAction(() => {
      if (tagSearchToken !== this.tagSearchToken) return false
      this.tagSearchAction = null
      if (result.code !== 0 || !result.data) {
        this.tagIdsVisible = []
        this.isTagsMore = false
        this.tagSearchMessageText = result.message ?? 'Tag search failed'
        return false
      }
      for (const tag of result.data.tagList) {
        this.tagById.set(tag.id, tag)
      }
      this.tagIdsVisible = result.data.tagList.map((tag) => tag.id)
      this.isTagsMore = result.data.isMore === true
      this.tagOffsetNext = REMOTE_TAG_PAGE_SIZE
      this.tagSearchMessageText = ''
      return true
    })
  }

  // next page of the dropdown (same search text), appended to the list
  async tagSearchLoadMore() {
    if (this.tagSearchAction !== null || !this.isTagsMore) return false
    const searchText = this.tagSearchText.trim()
    this.tagSearchToken += 1
    const tagSearchToken = this.tagSearchToken
    this.tagSearchAction = 'searchMore'
    const result = await this.tagPageFetch(searchText, this.tagOffsetNext)
    return runInAction(() => {
      if (tagSearchToken !== this.tagSearchToken) return false
      this.tagSearchAction = null
      if (result.code !== 0 || !result.data) {
        this.tagSearchMessageText = result.message ?? 'Tag loading failed'
        return false
      }
      for (const tag of result.data.tagList) {
        this.tagById.set(tag.id, tag)
      }
      // pages can overlap when tags changed meanwhile; drop duplicates
      const idSet = new Set(this.tagIdsVisible)
      this.tagIdsVisible = [
        ...this.tagIdsVisible,
        ...result.data.tagList.map((tag) => tag.id).filter((tagId) => !idSet.has(tagId))
      ]
      this.isTagsMore = result.data.isMore === true
      this.tagOffsetNext += REMOTE_TAG_PAGE_SIZE
      this.tagSearchMessageText = ''
      return true
    })
  }

  // in-place tag creation from the selector; returns the new tag id. the
  // created tag lands in the cache and at the top of the current dropdown
  // list (it matches the entered text). it is not selected automatically:
  // the user clicks the listed tag to add it to the selection.
  async tagCreate(name: string): Promise<string | null> {
    const nameTrimmed = name.trim()
    if (!nameTrimmed || this.isTagCreating) return null
    this.isTagCreating = true
    const result = await this.call<{ tag: RemoteTagItem }>(
      '/api/tabTag/create', { name: nameTrimmed })
    return runInAction(() => {
      this.isTagCreating = false
      if (result.code !== 0 || !result.data) {
        this.tagSearchMessageText = result.message ?? 'Tag creation failed'
        return null
      }
      const tag = result.data.tag
      this.tagById.set(tag.id, tag)
      if (!this.tagIdsVisible.includes(tag.id)) {
        this.tagIdsVisible = [tag.id, ...this.tagIdsVisible]
      }
      this.tagSearchMessageText = ''
      return tag.id
    })
  }

  // -------------------------------------------------------------------------
  // remote search (live scope and trash scope share one search bar)
  // -------------------------------------------------------------------------

  setTextInput(text: string) {
    this.textInput = text
    if (this.context) this.exitContext()
    // with picked tags, typing only composes the query (manual launch)
    if (this.searchTagIdsSelected.length === 0) this.queueCommit()
  }

  setSearchTagIds(tagIds: string[]) {
    this.searchTagIdsSelected = tagIds
    if (this.context) this.exitContext()
    if (tagIds.length === 0) {
      // the last tag was removed: the automatic mode resumes right away
      void this.search()
      return
    }
    this.setMessage('idle', 'Click Search to run the query')
  }

  setContentOffsetLeft(tabId: string, offsetLeft: number) {
    this.contentOffsetLeftById.set(tabId, Math.max(0, offsetLeft))
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
    if (this.searchTagIdsSelected.length > 0) {
      // manual mode: the user launches the query in the new scope
      this.isSearchMore = false
      this.setMessage('idle', 'Click Search to run the query in this scope')
      return
    }
    if (this.textInput.trim()) {
      void this.search()
    } else {
      // an empty search (no text, no tags) in trash scope lists the newest
      // trashed tabs
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
    // manual mode (tags picked): the toggle only composes the query
    if (this.searchTagIdsSelected.length === 0 && this.textInput.trim()) void this.search()
  }

  setSelectedIds(ids: string[]) {
    if (this.context) this.context.selectedIds = ids
    else this.selectedIds = ids
  }

  // one page request of the remote search. without picked tags the request
  // stays the original one (no tagIdList); with tags the backend answers
  // only tabs carrying all of them, and an empty search text is allowed
  // (tags-only listing)
  searchBodyMake(searchText: string, tagIds: string[], offset: number) {
    const body: Record<string, unknown> = {
      isSearchTitle: this.isSearchTitle,
      isSearchUrl: this.isSearchUrl,
      isTrashed: this.isTrashScope,
      limit: REMOTE_SEARCH_PAGE_SIZE,
      offset
    }
    if (searchText) body.query = searchText
    if (tagIds.length > 0) body.tagIdList = [...tagIds]
    return body
  }

  async search() {
    const searchText = this.textInput.trim()
    const tagIds = [...this.searchTagIdsSelected]
    this.searchToken += 1
    const searchToken = this.searchToken
    if (!searchText && tagIds.length === 0) {
      this.textCommitted = ''
      this.searchTagIdsCommitted = []
      this.isSearchMore = false
      if (this.isTrashScope) return this.trashListLoad()
      this.items = []
      this.selectedIds = []
      this.setMessage('idle', 'Enter text or pick tags to search remote tabs')
      return false
    }
    if (!this.isLoggedIn) {
      this.setMessage('error', 'Not logged in. Open remote settings to log in')
      return false
    }
    this.searchAction = 'search'
    this.setMessage('loading', 'Searching remote tabs...')
    const result = await this.call<{ tabList: RemoteTabItem[], isMore?: boolean }>(
      '/api/search', this.searchBodyMake(searchText, tagIds, 0))
    return runInAction(() => {
      if (searchToken !== this.searchToken) return false
      this.searchAction = null
      if (result.code !== 0 || !result.data) {
        this.items = []
        this.selectedIds = []
        this.isSearchMore = false
        this.setMessage('error', result.message ?? 'Remote search failed')
        return false
      }
      this.textCommitted = searchText
      this.searchTagIdsCommitted = tagIds
      this.items = result.data.tabList
      this.isSearchMore = result.data.isMore === true
      this.searchOffsetNext = REMOTE_SEARCH_PAGE_SIZE
      const idSet = new Set(this.items.map((item) => item.id))
      this.selectedIds = this.selectedIds.filter((id) => idSet.has(id))
      this.setMessage(
        'success',
        (this.items.length === 1 ? '1 remote tab found' : `${this.items.length} remote tabs found`)
        + (this.isSearchMore ? ', more available' : '')
      )
      return true
    })
  }

  // next page of the current search, appended to the loaded results. the
  // query is the committed one (text and tags of the last launch) — the one
  // the loaded results reflect, not the possibly re-composed selection
  async searchLoadMore() {
    if (this.searchAction || this.context || !this.isSearchMore) return false
    if (!this.isLoggedIn) return false
    this.searchToken += 1
    const searchToken = this.searchToken
    this.searchAction = 'searchMore'
    this.setMessage('loading', 'Loading more results...')
    const result = await this.call<{ tabList: RemoteTabItem[], isMore?: boolean }>(
      '/api/search',
      this.searchBodyMake(this.textCommitted, this.searchTagIdsCommitted, this.searchOffsetNext))
    return runInAction(() => {
      if (searchToken !== this.searchToken) return false
      this.searchAction = null
      if (result.code !== 0 || !result.data) {
        this.setMessage('error', result.message ?? 'Loading more results failed')
        return false
      }
      // pages can overlap when tabs changed meanwhile; drop duplicates
      const idSet = new Set(this.items.map((item) => item.id))
      this.items = [
        ...this.items,
        ...result.data.tabList.filter((item) => !idSet.has(item.id))
      ]
      this.isSearchMore = result.data.isMore === true
      this.searchOffsetNext += REMOTE_SEARCH_PAGE_SIZE
      this.setMessage(
        'success',
        `${this.items.length} remote tabs loaded` + (this.isSearchMore ? ', more available' : '')
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
    this.isSearchMore = false // this listing is not the paged search
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
    if (this.textInput.trim() || this.searchTagIdsSelected.length > 0) return this.search()
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
    if (!this.isLoggedIn) {
      this.setMessage('error', 'Log in to Tab Cloud before uploading')
      return false
    }
    this.uploadPanel = {
      tabList: tabList.map((tab) => ({ ...tab, status: 'pending', errorText: '' })),
      sourceText,
      isCloseOnSuccess: true,
      isApplying: false,
      isStopRequested: false,
      windowIdSelected: null,
      tagIdsSelected: []
    }
    this.uploadPanelOpenCount += 1
    return true
  }

  async openUploadPanelForWindow(windowSourceId: number) {
    if (!this.isLoggedIn) {
      this.setMessage('error', 'Log in to Tab Cloud before uploading')
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

  setUploadTagIds(tagIds: string[]) {
    if (this.uploadPanel) this.uploadPanel.tagIdsSelected = tagIds
  }

  // Stop button of the running upload. The run breaks after the tab currently
  // being processed completes its full logic (success or fail).
  requestUploadStop() {
    if (this.uploadPanel?.isApplying) this.uploadPanel.isStopRequested = true
  }

  // Progress of the running or finished upload, shown by the upload panel.
  get uploadProgress() {
    const panel = this.uploadPanel
    if (!panel) return null
    const countSuccess = panel.tabList.filter((tab) => tab.status === 'success').length
    const countFail = panel.tabList.filter((tab) => tab.status === 'fail').length
    return {
      countTotal: panel.tabList.length,
      countSuccess,
      countFail,
      countDone: countSuccess + countFail
    }
  }

  // Upload the panel tabs one by one, each in its own backend call, so one
  // failed tab does not block the remaining tabs (partial failure is allowed).
  // A tab with close-on-success enabled is closed right after its own upload
  // is confirmed, not in a batch at the end. Applying again after a partial
  // failure retries only the tabs that are not uploaded yet.
  async applyUpload(): Promise<{ isOk: boolean, messageText: string }> {
    const panel = this.uploadPanel
    if (!panel || panel.isApplying || panel.tabList.length === 0) {
      return { isOk: false, messageText: 'Nothing to upload' }
    }
    if (!this.isLoggedIn) {
      return { isOk: false, messageText: 'Not logged in. Open the Remote tab settings to log in' }
    }
    panel.isApplying = true
    panel.isStopRequested = false
    for (const tab of panel.tabList) {
      if (tab.status === 'success') continue
      tab.status = 'pending'
      tab.errorText = ''
    }
    let closeFailCount = 0
    try {
      // the first successful upload decides the target window when none is
      // chosen; every later tab goes to that same window
      let windowId = panel.windowIdSelected
      for (const tab of panel.tabList) {
        if (tab.status === 'success') continue
        if (panel.isStopRequested) break
        runInAction(() => {
          tab.status = 'uploading'
        })
        const body: Record<string, unknown> = {
          tabList: [{ title: tab.title, url: tab.url }]
        }
        if (windowId) body.windowId = windowId
        if (panel.tagIdsSelected.length > 0) body.tagIdList = [...panel.tagIdsSelected]
        const result = await this.call<{ windowId: string }>('/api/tab/create', body)
        if (result.code !== 0 || !result.data) {
          runInAction(() => {
            tab.status = 'fail'
            tab.errorText = result.message ?? 'Upload failed'
          })
          continue
        }
        windowId = result.data.windowId
        runInAction(() => {
          tab.status = 'success'
        })
        if (panel.isCloseOnSuccess) {
          try {
            await chrome.tabs.remove(tab.tabSourceId)
          } catch {
            // the tab is uploaded; it may have been closed manually meanwhile
            closeFailCount += 1
          }
        }
      }
    } finally {
      runInAction(() => {
        if (this.uploadPanel) {
          this.uploadPanel.isApplying = false
          this.uploadPanel.isStopRequested = false
        }
      })
    }
    const countSuccess = panel.tabList.filter((tab) => tab.status === 'success').length
    const countFail = panel.tabList.filter((tab) => tab.status === 'fail').length
    const countSkipped = panel.tabList.length - countSuccess - countFail
    const parts = [`${countSuccess} tab(s) uploaded`]
    if (countFail > 0) parts.push(`${countFail} failed`)
    if (countSkipped > 0) parts.push(`${countSkipped} not attempted (stopped)`)
    if (closeFailCount > 0) parts.push(`closing ${closeFailCount} local tab(s) failed`)
    return {
      isOk: countFail === 0 && countSkipped === 0,
      messageText: parts.join(', ')
    }
  }
}

function getErrorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
