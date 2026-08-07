import { makeAutoObservable, runInAction } from 'mobx'

// Shared tab-search and context-mode core.
//
// A searched state is one window/tab tree (refer to doc/browser_state.md).
// The live browser state and a stored snapshot use the same tree, they only
// differ in how the tree is obtained and updated:
// - the live state is queried through background messages and re-fetched on
//   browser change notices
// - a snapshot is loaded once and stays steady
//
// TabSearchCore therefore takes a TabQuerySource and owns everything above it:
// input debounce, committed search results, and per-window context views.
// The Search tab uses one core over the live source (at most one context at a
// time). Each snapshot detail uses one core over its snapshot data and can
// hold one context per window.

export interface TabSearchItem {
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
  groupSourceId?: number | null
}

export interface TabQueryResult {
  queryText: string
  items: TabSearchItem[]
  offset: number
  limit: number
  totalValue: number
  isMore: boolean
}

export interface TabContextResult {
  isTabFound: boolean
  tabCenterSourceId?: number
  windowSourceId?: number
  windowTabCount?: number
  items?: TabSearchItem[]
  isMoreBefore?: boolean
  isMoreAfter?: boolean
}

export interface TabQuerySource {
  queryTabs(query: { text: string, offset: number, limit: number }): Promise<TabQueryResult>
  queryTabContext(query: {
    tabSourceId: number,
    countBefore: number,
    countAfter: number
  }): Promise<TabContextResult>
}

// One window of a searchable tree. Snapshot windows satisfy this shape.
export interface TabWindowLike {
  windowSourceId: number
  windowIndex: number
  isFocused: boolean
  tabs: Array<{
    tabSourceId: number
    tabIndex: number
    title: string
    url: string
    isActive: boolean
    isSelected: boolean
    isPinned: boolean
  }>
}

// Local implementations of the two queries. The matching and slicing semantics
// must stay identical to the background implementation in
// background/browser-state.js (queryBrowserTabs / queryBrowserTabContext).
export function queryTabsInWindows(
  windows: TabWindowLike[],
  query: { text: string, offset: number, limit: number }
): TabQueryResult {
  const textQuery = String(query.text ?? '').trim()
  if (!textQuery) throw new Error('Search text is required')
  const textNeedle = textQuery.toLocaleLowerCase()
  const itemsMatched = windows.flatMap((windowItem) => (
    windowItem.tabs
      .filter((tab) => (
        tab.title.toLocaleLowerCase().includes(textNeedle) ||
        tab.url.toLocaleLowerCase().includes(textNeedle)
      ))
      .map((tab) => ({
        ...tab,
        windowSourceId: windowItem.windowSourceId,
        windowIndex: windowItem.windowIndex,
        isWindowFocused: windowItem.isFocused
      }))
  ))
  const offset = Math.max(0, Number(query.offset) || 0)
  const limit = Math.max(1, Number(query.limit) || 200)
  return {
    queryText: textQuery,
    items: itemsMatched.slice(offset, offset + limit),
    offset,
    limit,
    totalValue: itemsMatched.length,
    isMore: offset + limit < itemsMatched.length
  }
}

export function queryTabContextInWindows(
  windows: TabWindowLike[],
  query: { tabSourceId: number, countBefore: number, countAfter: number }
): TabContextResult {
  const tabSourceId = Number(query.tabSourceId)
  if (!Number.isInteger(tabSourceId)) throw new Error('A valid tab ID is required')
  const countBefore = Math.max(0, Math.round(Number(query.countBefore) || 0))
  const countAfter = Math.max(0, Math.round(Number(query.countAfter) || 0))
  const windowItem = windows.find((windowCurrent) => (
    windowCurrent.tabs.some((tab) => tab.tabSourceId === tabSourceId)
  ))
  if (!windowItem) return { isTabFound: false }
  const indexCenter = windowItem.tabs.findIndex((tab) => tab.tabSourceId === tabSourceId)
  const indexFirst = Math.max(0, indexCenter - countBefore)
  const indexLast = Math.min(windowItem.tabs.length - 1, indexCenter + countAfter)
  const items = windowItem.tabs.slice(indexFirst, indexLast + 1).map((tab) => ({
    ...tab,
    windowSourceId: windowItem.windowSourceId,
    windowIndex: windowItem.windowIndex,
    isWindowFocused: windowItem.isFocused
  }))
  return {
    isTabFound: true,
    tabCenterSourceId: tabSourceId,
    windowSourceId: windowItem.windowSourceId,
    windowTabCount: windowItem.tabs.length,
    items,
    isMoreBefore: indexFirst > 0,
    isMoreAfter: indexLast < windowItem.tabs.length - 1
  }
}

// The live browser state is queried in the background context.
export function createLiveTabQuerySource(): TabQuerySource {
  return {
    async queryTabs(query) {
      const response = await chrome.runtime.sendMessage({
        action: 'browserStateQueryTabs',
        query
      })
      if (!response?.success) throw new Error(response?.error ?? 'Tab search failed')
      return response.result as TabQueryResult
    },
    async queryTabContext(query) {
      const response = await chrome.runtime.sendMessage({
        action: 'browserStateQueryTabContext',
        query
      })
      if (!response?.success) throw new Error(response?.error ?? 'Tab context loading failed')
      return response.result as TabContextResult
    }
  }
}

// A steady local tree, for example a loaded snapshot, is queried in place.
export function createWindowsTabQuerySource(getWindows: () => TabWindowLike[]): TabQuerySource {
  return {
    async queryTabs(query) {
      return queryTabsInWindows(getWindows(), query)
    },
    async queryTabContext(query) {
      return queryTabContextInWindows(getWindows(), query)
    }
  }
}

export interface TabContextState {
  windowSourceId: number
  tabCenterSourceId: number
  countBefore: number
  countAfter: number
  items: TabSearchItem[]
  isMoreBefore: boolean
  isMoreAfter: boolean
  selectedIds: number[]
  action: 'enter' | 'loadBefore' | 'loadAfter' | null
  scrollRequestCount: number
}

export interface TabSearchCoreOptions {
  source: TabQuerySource
  getContextCountSide: () => number
  searchLimit?: number
  emptyMessageText?: string
}

export class TabSearchCore {
  textInput = ''
  textCommitted = ''
  items: TabSearchItem[] = []
  selectedIds: number[] = []
  resultTotal = 0
  isMore = false
  searchAction: string | null = null
  messageStatus: 'idle' | 'loading' | 'success' | 'error' = 'idle'
  messageText = ''
  // One context view per window. The Search tab keeps at most one entry; a
  // snapshot detail can keep one entry for each of its windows.
  contextByWindowId = new Map<number, TabContextState>()

  source: TabQuerySource
  getContextCountSide: () => number
  searchLimit: number
  emptyMessageText: string
  searchToken = 0
  contextToken = 0
  commitTimeoutId: ReturnType<typeof setTimeout> | null = null
  searchRefreshTimeoutId: ReturnType<typeof setTimeout> | null = null
  contextRefreshTimeoutId: ReturnType<typeof setTimeout> | null = null

  constructor(options: TabSearchCoreOptions) {
    this.source = options.source
    this.getContextCountSide = options.getContextCountSide
    this.searchLimit = options.searchLimit ?? 100
    this.emptyMessageText = options.emptyMessageText ?? 'Enter text to search tab titles or URLs'
    makeAutoObservable(this, {
      source: false,
      getContextCountSide: false,
      searchLimit: false,
      emptyMessageText: false
    }, { autoBind: true })
  }

  get isSearchBusy() {
    return this.searchAction !== null
  }

  get isContextBusy() {
    for (const context of this.contextByWindowId.values()) {
      if (context.action !== null) return true
    }
    return false
  }

  get isBusy() {
    return this.isSearchBusy || this.isContextBusy
  }

  get isContextMode() {
    return this.contextByWindowId.size > 0
  }

  // The Search tab shows one context at a time; this is that single entry.
  get contextSingle(): TabContextState | null {
    for (const context of this.contextByWindowId.values()) return context
    return null
  }

  get matchCountByWindowId() {
    const countByWindowId = new Map<number, number>()
    for (const item of this.items) {
      countByWindowId.set(
        item.windowSourceId,
        (countByWindowId.get(item.windowSourceId) ?? 0) + 1
      )
    }
    return countByWindowId
  }

  // The visible view is either the search-result list or the single context.
  get visibleSelectedIds() {
    return this.contextSingle ? this.contextSingle.selectedIds : this.selectedIds
  }

  // Selected items of the visible view, in row order instead of click order.
  get visibleSelectedItems() {
    const items = this.contextSingle ? this.contextSingle.items : this.items
    const tabSourceIdSet = new Set(this.visibleSelectedIds)
    return items.filter((tab) => tabSourceIdSet.has(tab.tabSourceId))
  }

  get visibleSelectedFirst() {
    const items = this.contextSingle ? this.contextSingle.items : this.items
    const tabSourceIdFirst = this.visibleSelectedIds[0]
    return items.find((tab) => tab.tabSourceId === tabSourceIdFirst) ?? null
  }

  get isVisibleSelectedCurrentActive() {
    return (
      this.visibleSelectedFirst?.isActive === true &&
      this.visibleSelectedFirst?.isWindowFocused === true
    )
  }

  setTextInput(text: string) {
    this.textInput = text
    // The context views belong to tabs chosen from the previous result list.
    if (this.isContextMode) this.exitContextAll()
    this.queueCommit()
  }

  queueCommit() {
    this.searchToken += 1
    const searchToken = this.searchToken
    if (this.commitTimeoutId !== null) clearTimeout(this.commitTimeoutId)
    this.commitTimeoutId = setTimeout(() => {
      this.commitTimeoutId = null
      if (searchToken !== this.searchToken) return
      void this.search(true)
    }, 180)
  }

  setSelectedIds(tabSourceIds: number[]) {
    this.selectedIds = tabSourceIds.filter(Number.isInteger)
  }

  setContextSelectedIds(windowSourceId: number, tabSourceIds: number[]) {
    const context = this.contextByWindowId.get(windowSourceId)
    if (!context) return
    context.selectedIds = tabSourceIds.filter(Number.isInteger)
  }

  setMessage(status: 'idle' | 'loading' | 'success' | 'error', messageText: string) {
    this.messageStatus = status
    this.messageText = messageText
  }

  setSearchAction(action: string | null) {
    this.searchAction = action
  }

  queueSearchRefresh() {
    if (!this.textCommitted || this.searchRefreshTimeoutId !== null) return
    this.searchRefreshTimeoutId = setTimeout(() => {
      this.searchRefreshTimeoutId = null
      if (this.isSearchBusy) {
        this.queueSearchRefresh()
        return
      }
      void this.search(true)
    }, 150)
  }

  async search(isSilent = false, isAppend = false) {
    const searchText = this.textInput.trim()
    this.searchToken += 1
    const searchToken = this.searchToken
    if (!searchText) {
      this.items = []
      this.selectedIds = []
      this.resultTotal = 0
      this.isMore = false
      this.textCommitted = ''
      this.setMessage('idle', this.emptyMessageText)
      return false
    }
    if (this.isSearchBusy && this.searchAction !== 'search') return false
    this.searchAction = 'search'
    if (!isSilent) this.setMessage('loading', 'Searching tabs...')
    try {
      const result = await this.source.queryTabs({
        text: searchText,
        offset: isAppend ? this.items.length : 0,
        limit: this.searchLimit
      })
      if (searchToken !== this.searchToken) return false
      runInAction(() => {
        if (searchToken !== this.searchToken) return
        this.textCommitted = result.queryText
        this.items = isAppend ? [...this.items, ...result.items] : result.items
        this.resultTotal = result.totalValue
        this.isMore = result.isMore
        const tabSourceIdSet = new Set(this.items.map((tab) => tab.tabSourceId))
        this.selectedIds = this.selectedIds.filter(
          (tabSourceId) => tabSourceIdSet.has(tabSourceId)
        )
        // A silent background refresh must not replace a visible error message,
        // for example the notice that a context tab was closed.
        if (!isSilent || this.messageStatus !== 'error') {
          this.setMessage(
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
          this.items = []
          this.selectedIds = []
          this.resultTotal = 0
          this.isMore = false
        }
        this.setMessage('error', getErrorText(error))
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

  async loadMore() {
    if (!this.isMore) return false
    return this.search(false, true)
  }

  async enterContext(tabCenterSourceId: number | null | undefined) {
    if (!Number.isInteger(tabCenterSourceId) || this.isBusy) return false
    const tabCenterSourceIdValid = tabCenterSourceId as number
    this.contextToken += 1
    const contextToken = this.contextToken
    this.searchAction = 'contextEnter'
    this.setMessage('loading', 'Loading nearby tabs...')
    const countSide = this.getContextCountSide()
    try {
      const result = await this.source.queryTabContext({
        tabSourceId: tabCenterSourceIdValid,
        countBefore: countSide,
        countAfter: countSide
      })
      if (contextToken !== this.contextToken) return false
      let isEntered = false
      runInAction(() => {
        if (!result.isTabFound || !Number.isInteger(result.windowSourceId)) {
          this.setMessage('error', 'The selected tab no longer exists')
          return
        }
        const context: TabContextState = {
          windowSourceId: result.windowSourceId as number,
          tabCenterSourceId: tabCenterSourceIdValid,
          countBefore: countSide,
          countAfter: countSide,
          items: result.items ?? [],
          isMoreBefore: result.isMoreBefore === true,
          isMoreAfter: result.isMoreAfter === true,
          selectedIds: [tabCenterSourceIdValid],
          action: null,
          scrollRequestCount: 1
        }
        this.contextByWindowId.set(context.windowSourceId, context)
        this.setMessage('success', 'Showing nearby tabs in the same window')
        isEntered = true
      })
      return isEntered
    } catch (error) {
      runInAction(() => {
        this.setMessage('error', getErrorText(error))
      })
      return false
    } finally {
      runInAction(() => {
        if (this.searchAction === 'contextEnter') this.searchAction = null
      })
    }
  }

  exitContext(windowSourceId: number, messageText = '') {
    const context = this.contextByWindowId.get(windowSourceId)
    if (!context) return
    // Tabs selected inside the context stay selected in the result list when
    // they are part of it.
    const searchResultIdSet = new Set(this.items.map((tab) => tab.tabSourceId))
    this.selectedIds = context.selectedIds.filter(
      (tabSourceId) => searchResultIdSet.has(tabSourceId)
    )
    this.contextByWindowId.delete(windowSourceId)
    this.contextToken += 1
    if (this.contextByWindowId.size === 0 && this.contextRefreshTimeoutId !== null) {
      clearTimeout(this.contextRefreshTimeoutId)
      this.contextRefreshTimeoutId = null
    }
    if (messageText) this.setMessage('error', messageText)
  }

  exitContextAll(messageText = '') {
    for (const windowSourceId of [...this.contextByWindowId.keys()]) {
      this.exitContext(windowSourceId)
    }
    if (messageText) this.setMessage('error', messageText)
  }

  async loadMoreContext(windowSourceId: number, direction: 'before' | 'after') {
    const context = this.contextByWindowId.get(windowSourceId)
    if (!context || this.isBusy) return false
    const isBefore = direction === 'before'
    if (isBefore ? !context.isMoreBefore : !context.isMoreAfter) return false
    const countSide = this.getContextCountSide()
    const countBeforeNext = context.countBefore + (isBefore ? countSide : 0)
    const countAfterNext = context.countAfter + (isBefore ? 0 : countSide)
    this.contextToken += 1
    const contextToken = this.contextToken
    context.action = isBefore ? 'loadBefore' : 'loadAfter'
    try {
      const result = await this.source.queryTabContext({
        tabSourceId: context.tabCenterSourceId,
        countBefore: countBeforeNext,
        countAfter: countAfterNext
      })
      if (contextToken !== this.contextToken) return false
      runInAction(() => {
        if (!result.isTabFound) {
          this.exitContext(windowSourceId, 'The context tab was closed. Context view exited')
          return
        }
        context.countBefore = countBeforeNext
        context.countAfter = countAfterNext
        this.applyContextResult(windowSourceId, context, result)
      })
      return true
    } catch (error) {
      runInAction(() => {
        if (contextToken === this.contextToken) {
          this.setMessage('error', getErrorText(error))
        }
      })
      return false
    } finally {
      runInAction(() => {
        context.action = null
      })
    }
  }

  queueContextRefresh() {
    if (!this.isContextMode || this.contextRefreshTimeoutId !== null) return
    this.contextRefreshTimeoutId = setTimeout(() => {
      this.contextRefreshTimeoutId = null
      if (!this.isContextMode) return
      if (this.isBusy) {
        this.queueContextRefresh()
        return
      }
      void this.refreshContexts()
    }, 150)
  }

  // Silent re-fetch of every context after a change of the underlying state.
  // The loaded range of each context is kept. A missing center tab exits that
  // context; a center tab moved to another window re-keys and recenters it.
  async refreshContexts() {
    if (!this.isContextMode || this.isContextBusy) return false
    const contextToken = this.contextToken
    for (const windowSourceId of [...this.contextByWindowId.keys()]) {
      const context = this.contextByWindowId.get(windowSourceId)
      if (!context) continue
      try {
        const result = await this.source.queryTabContext({
          tabSourceId: context.tabCenterSourceId,
          countBefore: context.countBefore,
          countAfter: context.countAfter
        })
        if (contextToken !== this.contextToken) return false
        runInAction(() => {
          if (!result.isTabFound) {
            this.exitContext(windowSourceId, 'The context tab was closed. Context view exited')
            return
          }
          this.applyContextResult(windowSourceId, context, result)
        })
      } catch (error) {
        runInAction(() => {
          if (contextToken === this.contextToken) {
            this.setMessage('error', getErrorText(error))
          }
        })
        return false
      }
    }
    return true
  }

  applyContextResult(
    windowSourceIdBefore: number,
    context: TabContextState,
    result: TabContextResult
  ) {
    context.items = result.items ?? []
    context.isMoreBefore = result.isMoreBefore === true
    context.isMoreAfter = result.isMoreAfter === true
    const tabSourceIdSet = new Set(context.items.map((tab) => tab.tabSourceId))
    context.selectedIds = context.selectedIds.filter(
      (tabSourceId) => tabSourceIdSet.has(tabSourceId)
    )
    const windowSourceIdNext = result.windowSourceId
    if (Number.isInteger(windowSourceIdNext) && windowSourceIdNext !== windowSourceIdBefore) {
      context.windowSourceId = windowSourceIdNext as number
      this.contextByWindowId.delete(windowSourceIdBefore)
      this.contextByWindowId.set(context.windowSourceId, context)
      context.scrollRequestCount += 1
    }
  }

  dispose() {
    if (this.commitTimeoutId !== null) {
      clearTimeout(this.commitTimeoutId)
      this.commitTimeoutId = null
    }
    if (this.searchRefreshTimeoutId !== null) {
      clearTimeout(this.searchRefreshTimeoutId)
      this.searchRefreshTimeoutId = null
    }
    if (this.contextRefreshTimeoutId !== null) {
      clearTimeout(this.contextRefreshTimeoutId)
      this.contextRefreshTimeoutId = null
    }
    this.searchToken += 1
    this.contextToken += 1
  }
}

function getErrorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
