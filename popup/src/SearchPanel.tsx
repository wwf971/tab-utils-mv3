import {
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { observer } from 'mobx-react-lite'
import {
  FileIcon,
  MenuComp,
  SegmentedControl,
  SpinningCircle
} from '@wwf971/react-comp-misc'
import {
  TabItem,
  WindowTabView,
  type SnapshotWindowData,
  type TabItemStatus,
  type WindowTabViewContext
} from '@wwf971/tab-manage-frontend-common'
import { PopupStore } from './PopupStore'
import { type TabSearchItem } from './TabSearchCore'
import { TabBringPanel } from './TabBringPanel'
import { CurrentTabPanel } from './CurrentTabPanel'
import { RemoteUploadPanel } from './remote/RemoteUploadPanel'
import {
  getSearchFieldText,
  handleSearchFieldKeyDown,
  handleSearchFieldPaste
} from './searchFieldPlain'
import './SearchPanel.css'

// Right-click menu on one tab row. The click offset inside the row rect is
// kept so the menu stays static relative to its row while scrolling.
interface TabRowMenuState {
  tabSourceId: number
  titleText: string
  posOpen: { x: number, y: number }
  offsetX: number
  offsetY: number
}

// Right-click menu on one window of the window sidebar.
interface WindowRowMenuState {
  windowSourceId: number
  posOpen: { x: number, y: number }
  offsetX: number
  offsetY: number
}

// One selected tab as the right-click tab menu sees it, the common shape of
// every panel mode (search results, all-windows, selected-tabs).
interface TabMenuTab {
  tabSourceId: number
  title: string
  url: string
  windowSourceId: number
  isActive: boolean
  isWindowFocused: boolean
}

// The 'All Windows' and 'Selected Tabs' modes fill the fixed popup height
// (refer to /doc/popup_size.md): first fill down to the popup bottom, then
// shave off exactly the overflow the scrolling ancestor still reports. The
// same approach as the Restore tab, measured when the mode is entered.
function useResultsHeightFit(
  resultsRef: React.RefObject<HTMLDivElement>,
  isEnabled: boolean
) {
  const [heightPx, setHeightPx] = useState<number | null>(null)
  const isOverflowCheckedRef = useRef(false)
  useEffect(() => {
    if (!isEnabled) {
      setHeightPx(null)
      isOverflowCheckedRef.current = false
      return
    }
    const resultsEl = resultsRef.current
    if (!resultsEl) return
    const scrollerEl = resultsEl.closest('.popup-config-panel') as HTMLElement | null
    if (heightPx === null) {
      if (scrollerEl) scrollerEl.scrollTop = 0
      const top = resultsEl.getBoundingClientRect().top
      setHeightPx(Math.max(200, Math.floor(document.documentElement.clientHeight - top)))
      return
    }
    if (isOverflowCheckedRef.current || !scrollerEl) return
    isOverflowCheckedRef.current = true
    const overflow = scrollerEl.scrollHeight - scrollerEl.clientHeight
    if (overflow > 0) {
      setHeightPx((heightCurrent) => Math.max(200, (heightCurrent ?? 260) - overflow))
    }
  }, [isEnabled, heightPx, resultsRef])
  return heightPx
}

// Height of the FolderView status bar inside WindowTabView (refer to
// .window-tab-view .folder-statusbar), subtracted from the fitted height so
// the table body plus the status bar exactly fill the measured space.
const windowTabStatusBarHeightPx = 18

export const SearchPanel = observer(function SearchPanel({
  store
}: {
  store: PopupStore
}) {
  const resultsRef = useRef<HTMLDivElement>(null)
  const [tabRowMenu, setTabRowMenu] = useState<TabRowMenuState | null>(null)
  const [windowRowMenu, setWindowRowMenu] = useState<WindowRowMenuState | null>(null)
  const search = store.tabSearch
  const contextSingle = search.contextSingle
  const isContextMode = search.isContextMode
  const isActionBusy = (
    (search.isSearchBusy && search.searchAction !== 'search') ||
    search.isContextBusy
  )
  const tabSelectedCount = search.visibleSelectedIds.length
  const isTabSelected = tabSelectedCount > 0
  // The window view shows windows with matches at the left side and the
  // selected window's matches at the right, like the snapshot detail.
  const isWindowView = store.searchViewCurrent === 'window'
  // 'All Windows' (full live tree) and 'Selected Tabs' (browser-selected tabs
  // of each window) are top-level panel modes, separate from the List/Windows
  // search result views. Both render the windows tree kept in windowsAll.
  const isWindowsMode = store.searchWorkspaceMode === 'all' ||
    store.searchWorkspaceMode === 'selected'
  // 'Current Tab' mode: only the active tab, uploaded to remote with tags.
  const isCurrentMode = store.searchWorkspaceMode === 'current'
  const windowSourceIdSelected = isWindowView ? store.searchWindowSourceIdEffective : null
  const isContextVisible = isContextMode && contextSingle !== null &&
    (!isWindowView || contextSingle.windowSourceId === windowSourceIdSelected)
  // Tab rows of the current search view: the context slice, the selected
  // window's matches, or the flat match list.
  const itemsVisible = isContextVisible && contextSingle
    ? contextSingle.items
    : isWindowView
      ? search.items.filter((tab) => tab.windowSourceId === windowSourceIdSelected)
      : search.items
  // Move/duplicate act relative to the current active tab, one tab at a time.
  const isRelativeActionDisabled = (
    isActionBusy ||
    tabSelectedCount !== 1 ||
    search.isVisibleSelectedCurrentActive
  )

  const resultsHeightPx = useResultsHeightFit(resultsRef, isWindowsMode)

  const getTabRowEl = (tabSourceId: number) => (
    resultsRef.current?.querySelector(`[data-row-id="${tabSourceId}"]`) as HTMLElement | null
  )

  const openTabRowMenu = (tabSourceId: number, mouseEvent: MouseEvent) => {
    const tabItem = tabMenuFind(tabSourceId)
    const rowRect = getTabRowEl(tabSourceId)?.getBoundingClientRect()
    if (!tabItem || !rowRect) return
    // An already open menu is closed first and the new one appears on the next
    // frame, so right-clicking another row repositions the menu correctly.
    setTabRowMenu(null)
    requestAnimationFrame(() => {
      setTabRowMenu({
        tabSourceId,
        titleText: tabItem.title,
        posOpen: { x: mouseEvent.clientX, y: mouseEvent.clientY },
        offsetX: mouseEvent.clientX - rowRect.left,
        offsetY: mouseEvent.clientY - rowRect.top
      })
    })
  }

  const getWindowRowEl = (windowSourceId: number) => (
    resultsRef.current?.querySelector(`[data-window-id="${windowSourceId}"]`) as HTMLElement | null
  )

  // Right-clicking a sidebar window selects it and opens the window menu, the
  // same way right-clicking a tab row selects that tab first.
  const openWindowRowMenu = (windowSourceId: number, mouseEvent: MouseEvent) => {
    mouseEvent.preventDefault()
    if (isWindowsMode) store.setWindowSourceIdSelectedAllView(windowSourceId)
    else store.setSearchWindowSourceIdSelected(windowSourceId)
    const rowRect = getWindowRowEl(windowSourceId)?.getBoundingClientRect()
    if (!rowRect) return
    setWindowRowMenu(null)
    requestAnimationFrame(() => {
      setWindowRowMenu({
        windowSourceId,
        posOpen: { x: mouseEvent.clientX, y: mouseEvent.clientY },
        offsetX: mouseEvent.clientX - rowRect.left,
        offsetY: mouseEvent.clientY - rowRect.top
      })
    })
  }

  const loadMoreTabContext = async (direction: 'before' | 'after') => {
    const windowSourceId = contextSingle?.windowSourceId
    if (windowSourceId === undefined) return false
    return search.loadMoreContext(windowSourceId, direction)
  }

  // Selected tabs the right-click tab menu acts on, one common shape for every
  // panel mode: row order for the menu items and the bring operations,
  // select order for ordered operations like uploading.
  const windowsMode = store.windowsWorkspaceVisible
  const windowModeSelected = windowsMode.find(
    (windowItem) => windowItem.windowSourceId === store.windowSourceIdSelectedAllView
  ) ?? windowsMode[0]
  const tabsMenuWindowsMode: TabMenuTab[] = (windowModeSelected?.tabs ?? []).map((tab) => ({
    tabSourceId: tab.tabSourceId,
    title: tab.title,
    url: tab.url,
    windowSourceId: windowModeSelected.windowSourceId,
    isActive: tab.isActive,
    isWindowFocused: windowModeSelected.isFocused
  }))
  const tabMenuOfSearchItem = (tab: TabSearchItem): TabMenuTab => ({
    tabSourceId: tab.tabSourceId,
    title: tab.title,
    url: tab.url,
    windowSourceId: tab.windowSourceId,
    isActive: tab.isActive,
    isWindowFocused: tab.isWindowFocused
  })
  const tabIdSelectedSetWindowsMode = new Set(store.tabIdsSelectedAllView)
  const tabsMenuSelected: TabMenuTab[] = isWindowsMode
    ? tabsMenuWindowsMode.filter((tab) => tabIdSelectedSetWindowsMode.has(String(tab.tabSourceId)))
    : search.visibleSelectedItems.map(tabMenuOfSearchItem)
  const tabsMenuSelectedSelectOrder: TabMenuTab[] = isWindowsMode
    ? store.tabIdsSelectedAllView
      .map((tabId) => tabsMenuWindowsMode.find((tab) => String(tab.tabSourceId) === tabId))
      .filter((tab): tab is TabMenuTab => tab !== undefined)
    : search.visibleSelectedItemsSelectOrder.map(tabMenuOfSearchItem)
  const tabMenuFind = (tabSourceId: number) => (
    isWindowsMode
      ? tabsMenuWindowsMode.find((tab) => tab.tabSourceId === tabSourceId)
      : itemsVisible.find((tab) => tab.tabSourceId === tabSourceId)
  )

  const setVisibleSelectedIds = (tabSourceIds: number[]) => {
    if (isContextVisible && contextSingle) {
      search.setContextSelectedIds(contextSingle.windowSourceId, tabSourceIds)
    } else {
      search.setSelectedIds(tabSourceIds)
    }
  }

  // Windows tree of the search views, built from the flat search items: the
  // matched windows with their matched tabs, and the context slice replacing
  // the tabs of its window while a context is shown.
  const windowsSearch: SnapshotWindowData[] = (() => {
    if (isContextVisible && contextSingle) {
      if (!isWindowView) return getWindowsOfItems(contextSingle.items)
      const windows = getWindowsOfItems(search.items)
      const windowContext = getWindowsOfItems(contextSingle.items)[0]
      if (!windowContext) return windows
      const indexContext = windows.findIndex(
        (windowItem) => windowItem.windowSourceId === windowContext.windowSourceId
      )
      if (indexContext >= 0) windows[indexContext] = windowContext
      else windows.push(windowContext)
      return windows
    }
    return getWindowsOfItems(search.items)
  })()

  const contextView: WindowTabViewContext | null = isContextVisible && contextSingle
    ? {
      tabCenterSourceId: contextSingle.tabCenterSourceId,
      isMoreBefore: contextSingle.isMoreBefore,
      isMoreAfter: contextSingle.isMoreAfter,
      isLoadingBefore: contextSingle.action === 'loadBefore',
      isLoadingAfter: contextSingle.action === 'loadAfter',
      countLoad: store.tabContextCountSide,
      scrollRequestCount: contextSingle.scrollRequestCount
    }
    : null

  // In the window view the sidebar shows match counts, not the tab counts of
  // the (possibly context-replaced) windows passed in.
  const countTextByWindowId: Record<string, string> = {}
  for (const windowItem of store.searchWindowItems) {
    countTextByWindowId[String(windowItem.windowSourceId)] = String(windowItem.matchCount)
  }

  const contentOffsetLeftById: Record<string, number> = {}
  for (const [tabSourceId, offsetLeft] of search.contentOffsetLeftById) {
    contentOffsetLeftById[String(tabSourceId)] = offsetLeft
  }

  return (
    <div className="tab-search-panel">
      <div
        className={`tab-search-field ${search.textInput ? '' : 'tab-search-field-empty'}`}
        // display:none instead of unmounting: the contentEditable field is
        // uncontrolled, so unmounting would lose the entered search text.
        style={{ display: isWindowsMode || isCurrentMode ? 'none' : undefined }}
        contentEditable={!isActionBusy}
        suppressContentEditableWarning
        spellCheck={false}
        role="textbox"
        data-placeholder="Search title or URL"
        onPaste={(event) => {
          handleSearchFieldPaste(event)
          search.setTextInput(getSearchFieldText(event.currentTarget))
        }}
        onKeyDown={handleSearchFieldKeyDown}
        onInput={(event) => {
          search.setTextInput(getSearchFieldText(event.currentTarget))
        }}
      />

      {!isWindowsMode && !isCurrentMode ? (
      <SearchControlButtonGroup
        store={store}
        compLead={(
          <SegmentedControl
            data={{
              valueSelected: store.searchViewCurrent,
              segList: [
                { value: 'list', labelText: 'List' },
                { value: 'window', labelText: 'Windows' }
              ]
            }}
            config={{
              isDisabled: isActionBusy,
              classNameTrack: 'tab-search-view-switch'
            }}
            onEvent={(eventType: string, eventData: Record<string, unknown>) => {
              if (eventType === 'valueSelectedChange') {
                store.setSearchViewCurrent(eventData.valueSelected)
              }
            }}
          />
        )}
        buttons={[
          {
            id: 'close',
            labelText: 'Close',
            isDisabled: isActionBusy || !isTabSelected,
            onClick: () => store.runTabSearchAction('close')
          },
          {
            id: 'context',
            labelText: isContextMode ? 'Exit Context' : 'Context',
            className: 'tab-search-control-button-context',
            isDisabled: isActionBusy || (!isContextMode && tabSelectedCount !== 1),
            onClick: () => {
              if (isContextMode) search.exitContextAll()
              else void store.enterTabSearchContext(search.selectedIds[0])
            }
          },
          {
            id: 'move-left',
            labelText: 'Move Left',
            isDisabled: isRelativeActionDisabled,
            onClick: () => store.runTabSearchAction('moveLeft')
          },
          {
            id: 'move-right',
            labelText: 'Move Right',
            isDisabled: isRelativeActionDisabled,
            onClick: () => store.runTabSearchAction('moveRight')
          },
          {
            id: 'duplicate-left',
            labelText: 'Duplicate Left',
            isDisabled: isRelativeActionDisabled,
            onClick: () => store.runTabSearchAction('duplicateLeft')
          },
          {
            id: 'duplicate-right',
            labelText: 'Duplicate Right',
            isDisabled: isRelativeActionDisabled,
            onClick: () => store.runTabSearchAction('duplicateRight')
          }
        ]}
      />
      ) : null}

      <div className={`tab-search-message tab-search-message-${search.messageStatus}`}>
        {search.messageText || (isCurrentMode
          ? 'Upload the currently active tab to remote with tags'
          : isWindowsMode
            ? getWindowsModeSummaryText(store.searchWorkspaceMode, windowsMode)
            : 'Enter text to search open tabs')}
      </div>

      {store.tabBring ? (
        <TabBringPanel store={store} key={store.tabBringOpenCount} />
      ) : null}

      {store.remote.uploadPanel ? (
        <RemoteUploadPanel store={store} key={store.remote.uploadPanelOpenCount} />
      ) : null}

      {isCurrentMode ? (
        <CurrentTabPanel store={store} />
      ) : isWindowsMode ? (
        <div className="tab-search-results" ref={resultsRef}>
          {store.isWindowsAllEnterPending ? (
            // The heavy windows tree stays unmounted while the mode-enter load
            // runs; this spinner frame is painted before the blocking mount,
            // and its composited animation keeps spinning through that mount.
            <div
              className="tab-search-results-loading"
              style={{ height: resultsHeightPx ?? 260 }}
            >
              <SpinningCircle width={20} height={20} />
            </div>
          ) : (
          <WindowTabView
            data={{
              windows: windowsMode,
              windowSourceIdSelected: store.windowSourceIdSelectedAllView,
              tabIdsSelected: store.tabIdsSelectedAllView,
              contentOffsetLeftById
            }}
            config={{
              isBusy: isActionBusy,
              viewMode: 'item',
              // active/selected/pinned status marks are hidden here: 'All
              // Windows' shows entire windows and 'Selected Tabs' shows only
              // selected tabs, so the marks carry no useful information
              isTabStatusVisible: false,
              bodyHeight: resultsHeightPx === null
                ? 260
                : resultsHeightPx - windowTabStatusBarHeightPx,
              sidebarHeightPx: resultsHeightPx ?? 260
            }}
            onEvent={(eventType, eventData) => {
              if (eventType === 'windowSourceIdSelectedChange') {
                store.setWindowSourceIdSelectedAllView(Number(eventData.windowSourceId))
              }
              if (eventType === 'windowContextMenu') {
                openWindowRowMenu(
                  Number(eventData.windowSourceId),
                  eventData.event as MouseEvent
                )
              }
              if (eventType === 'tabIdsSelectedChange') {
                store.setTabIdsSelectedAllView(
                  [...(eventData.tabIds as string[] ?? [])].map(String)
                )
              }
              if (eventType === 'tabRowDoubleClick') {
                void store.runTabSearchAction('activate', Number(eventData.tabSourceId))
              }
              if (eventType === 'tabRowContextMenu') {
                const mouseEvent = eventData.event as MouseEvent | undefined
                mouseEvent?.preventDefault()
                if (mouseEvent) {
                  openTabRowMenu(Number(eventData.tabSourceId), mouseEvent)
                }
              }
              if (eventType === 'tabContentOffsetChange') {
                search.setContentOffsetLeft(
                  Number(eventData.tabSourceId),
                  Number(eventData.offsetLeft)
                )
              }
              return undefined
            }}
          />
          )}
          {!store.isWindowsAllEnterPending && store.windowSourceIdPendingAllView !== null ? (
            // A window switch commits one frame after this overlay is painted
            // (refer to PopupStore.setWindowSourceIdSelectedAllView), so the
            // spinner is on screen through the blocking tab-list re-render.
            <div className="tab-search-results-loading-overlay">
              <SpinningCircle width={20} height={20} />
            </div>
          ) : null}
        </div>
      ) : (
      <div className="tab-search-results" ref={resultsRef}>
        <WindowTabView
          data={{
            windows: windowsSearch,
            windowSourceIdSelected,
            tabIdsSelected: search.visibleSelectedIds.map(String),
            matchText: search.textCommitted,
            contentOffsetLeftById,
            countTextByWindowId,
            windowIdsInContext: [...search.contextByWindowId.keys()],
            context: contextView
          }}
          config={{
            isBusy: isActionBusy,
            viewMode: 'item',
            isSidebarVisible: isWindowView,
            isTabCloseVisible: true,
            isStatusBarVisible: false,
            bodyHeight: 260,
            sidebarHeightPx: 260
          }}
          onEvent={(eventType, eventData) => {
            if (eventType === 'windowSourceIdSelectedChange') {
              store.setSearchWindowSourceIdSelected(Number(eventData.windowSourceId))
            }
            if (eventType === 'windowContextMenu') {
              openWindowRowMenu(
                Number(eventData.windowSourceId),
                eventData.event as MouseEvent
              )
            }
            if (eventType === 'tabIdsSelectedChange') {
              setVisibleSelectedIds(
                [...(eventData.tabIds as string[] ?? [])].map(Number)
              )
            }
            if (eventType === 'tabRowDoubleClick') {
              void store.runTabSearchAction('activate', Number(eventData.tabSourceId))
            }
            if (eventType === 'tabRowContextMenu') {
              const mouseEvent = eventData.event as MouseEvent | undefined
              mouseEvent?.preventDefault()
              if (mouseEvent) {
                openTabRowMenu(Number(eventData.tabSourceId), mouseEvent)
              } else {
                setTabRowMenu(null)
              }
            }
            if (eventType === 'tabCloseAttempt') {
              store.runTabSearchAction('close', Number(eventData.tabSourceId))
            }
            if (eventType === 'tabContentOffsetChange') {
              search.setContentOffsetLeft(
                Number(eventData.tabSourceId),
                Number(eventData.offsetLeft)
              )
            }
            if (eventType === 'contextLoadMoreAttempt') {
              return loadMoreTabContext(eventData.direction as 'before' | 'after')
            }
            return undefined
          }}
        />
      </div>
      )}
      {!isWindowsMode && !isCurrentMode && !isContextMode && search.isMore ? (
        <button
          type="button"
          className="tab-search-load-more"
          disabled={isActionBusy}
          onClick={() => search.loadMore()}
        >
          Load More
        </button>
      ) : null}

      {tabRowMenu ? (
        <MenuComp
          data={{ items: getTabRowMenuItems(tabsMenuSelected, store.remote, tabRowMenu) }}
          config={{
            isOpen: true,
            posOpen: tabRowMenu.posOpen,
            isBackdropScrollPassThrough: true,
            anchor: {
              getRect: () => getTabRowEl(tabRowMenu.tabSourceId)?.getBoundingClientRect() ?? null,
              getTargetEl: () => getTabRowEl(tabRowMenu.tabSourceId),
              getVisibilityRoot: () => (
                resultsRef.current?.querySelector('.folder-view-switcher-content') ?? null
              ),
              offsetX: tabRowMenu.offsetX,
              offsetY: tabRowMenu.offsetY
            }
          }}
          onEvent={(eventType: string, eventData: Record<string, unknown>) => {
            if (eventType === 'closeRequest') {
              setTabRowMenu(null)
            }
            if (eventType === 'itemClick') {
              const item = eventData.item as { id?: string } | undefined
              const tabTargetFixed = {
                tabSourceId: tabRowMenu.tabSourceId,
                titleText: tabRowMenu.titleText
              }
              const tabsSourceFixed = tabsMenuSelected.map((tab) => ({
                tabSourceId: tab.tabSourceId,
                titleText: tab.title
              }))
              if (item?.id === 'bring-current-to-it') {
                void store.openTabBring({
                  pickSide: 'source',
                  tabTargetFixed,
                  isTabCurrentPicked: true
                })
              }
              if (item?.id === 'bring-tabs-to-it') {
                void store.openTabBring({ pickSide: 'source', tabTargetFixed })
              }
              if (item?.id === 'bring-to-current') {
                void store.openTabBring({
                  pickSide: 'target',
                  tabsSourceFixed,
                  isTabCurrentPicked: true
                })
              }
              if (item?.id === 'bring-to-target') {
                void store.openTabBring({ pickSide: 'target', tabsSourceFixed })
              }
              // Tabs copy and upload in the order they were selected, not in
              // row order.
              const tabsSelectOrder = tabsMenuSelectedSelectOrder.map((tab) => ({
                tabSourceId: tab.tabSourceId,
                title: tab.title,
                url: tab.url
              }))
              if (item?.id === 'copy-selected-tabs') {
                void store.copyTabsText(tabsSelectOrder)
              }
              if (item?.id === 'copy-close-selected-tabs') {
                void store.copyTabsTextThenClose(tabsSelectOrder)
              }
              if (item?.id === 'upload-selected-to-remote') {
                store.openRemoteUploadForTabs(tabsSelectOrder)
              }
              if (item?.id === 'upload-window-to-remote') {
                const tabClicked = tabMenuFind(tabRowMenu.tabSourceId)
                if (tabClicked) {
                  void store.openRemoteUploadForWindow(tabClicked.windowSourceId)
                }
              }
              setTabRowMenu(null)
            }
          }}
        />
      ) : null}

      {windowRowMenu ? (
        <MenuComp
          data={{
            items: [
              { id: 'copy-window-tabs', label: 'Copy tabs as "url | title" lines' },
              { id: 'close-window', label: 'Close window' }
            ]
          }}
          config={{
            isOpen: true,
            posOpen: windowRowMenu.posOpen,
            isBackdropScrollPassThrough: true,
            anchor: {
              getRect: () => (
                getWindowRowEl(windowRowMenu.windowSourceId)?.getBoundingClientRect() ?? null
              ),
              getTargetEl: () => getWindowRowEl(windowRowMenu.windowSourceId),
              getVisibilityRoot: () => (
                resultsRef.current?.querySelector('.window-sidebar') ?? null
              ),
              offsetX: windowRowMenu.offsetX,
              offsetY: windowRowMenu.offsetY
            }
          }}
          onEvent={(eventType: string, eventData: Record<string, unknown>) => {
            if (eventType === 'closeRequest') {
              setWindowRowMenu(null)
            }
            if (eventType === 'itemClick') {
              const item = eventData.item as { id?: string } | undefined
              if (item?.id === 'copy-window-tabs') {
                void store.copyWindowTabsText(windowRowMenu.windowSourceId)
              }
              if (item?.id === 'close-window') {
                void store.closeBrowserWindow(windowRowMenu.windowSourceId)
              }
              setWindowRowMenu(null)
            }
          }}
        />
      ) : null}
    </div>
  )
})

// Group flat search items into the shared windows-tree shape, keeping the
// item order inside each window and the window order of first appearance.
function getWindowsOfItems(items: TabSearchItem[]): SnapshotWindowData[] {
  const windowById = new Map<number, SnapshotWindowData>()
  for (const item of items) {
    let windowItem = windowById.get(item.windowSourceId)
    if (!windowItem) {
      windowItem = {
        windowSourceId: item.windowSourceId,
        windowIndex: item.windowIndex,
        isFocused: item.isWindowFocused,
        tabs: [],
        groups: []
      }
      windowById.set(item.windowSourceId, windowItem)
    }
    windowItem.tabs.push({
      tabSourceId: item.tabSourceId,
      tabIndex: item.tabIndex,
      title: item.title,
      url: item.url,
      favIconUrl: item.favIconUrl,
      isActive: item.isActive,
      isSelected: item.isSelected,
      isPinned: item.isPinned,
      groupSourceId: item.groupSourceId ?? null
    })
  }
  return [...windowById.values()]
}

function getWindowsModeSummaryText(
  mode: string,
  windows: Array<{ tabs: unknown[] }>
) {
  const tabCount = windows.reduce((count, windowItem) => count + windowItem.tabs.length, 0)
  if (mode === 'selected') {
    return `${tabCount} selected tab${tabCount === 1 ? '' : 's'} in ${windows.length} window${windows.length === 1 ? '' : 's'}`
  }
  return `${windows.length} window${windows.length === 1 ? '' : 's'}, ${tabCount} tab${tabCount === 1 ? '' : 's'}`
}

// Menu items depend on the selection: the "before/after it" pair needs one
// selected tab (the right-clicked one); the "before/after current tab" and
// "before/after a target tab" pair takes any selection as the source tabs.
// tabsSelected comes in the common TabMenuTab shape, so every panel mode
// shares this menu.
function getTabRowMenuItems(
  tabsSelected: TabMenuTab[],
  remote: PopupStore['remote'],
  tabRowMenu: TabRowMenuState
) {
  const tabClicked = tabsSelected.find(
    (tab) => tab.tabSourceId === tabRowMenu.tabSourceId
  )
  const isTabClickedCurrent = (
    tabClicked?.isActive === true && tabClicked?.isWindowFocused === true
  )
  const isSelectionCurrentOnly = (
    tabsSelected.length === 1 &&
    tabsSelected[0].isActive &&
    tabsSelected[0].isWindowFocused
  )
  const items = []
  if (tabsSelected.length === 1) {
    items.push(
      {
        id: 'bring-current-to-it',
        label: 'Bring current tab before/after it',
        isDisabled: isTabClickedCurrent
      },
      {
        id: 'bring-tabs-to-it',
        label: 'Bring other tabs before/after it'
      }
    )
  }
  items.push(
    {
      id: 'bring-to-current',
      label: 'Bring it before/after current tab',
      isDisabled: isSelectionCurrentOnly
    },
    {
      id: 'bring-to-target',
      label: 'Bring it before/after a target tab'
    },
    {
      id: 'copy-selected-tabs',
      label: `Copy selected tab(s) as "url | title" lines (${tabsSelected.length})`,
      isDisabled: tabsSelected.length === 0
    },
    {
      id: 'copy-close-selected-tabs',
      label: `Copy selected tab(s), close on success (${tabsSelected.length})`,
      isDisabled: tabsSelected.length === 0
    },
    {
      id: 'upload-selected-to-remote',
      label: `Upload selected tab(s) to remote (${tabsSelected.length})`,
      isDisabled: tabsSelected.length === 0 || !remote.isLoggedIn
    },
    {
      id: 'upload-window-to-remote',
      label: 'Upload this window to remote',
      isDisabled: !remote.isLoggedIn
    }
  )
  return items
}

export function SearchTabCell({
  data,
  onEvent
}: {
  data?: TabSearchItem & {
    matchText?: string
    isCloseVisible?: boolean
    contentOffsetLeft?: number
  }
  onEvent?: (eventType: string, eventData: Record<string, unknown>) => unknown
}) {
  if (!data) return null
  const statuses: TabItemStatus[] = [
    {
      id: 'active',
      labelText: data.isWindowFocused ? 'Current active' : 'Active',
      tone: 'info',
      isVisible: data.isActive
    },
    {
      id: 'selected',
      labelText: 'Selected',
      tone: 'neutral',
      isVisible: data.isSelected
    },
    {
      id: 'pinned',
      labelText: 'Pinned',
      tone: 'warning',
      isVisible: data.isPinned
    }
  ]
  const icon = data.favIconUrl ? (
    <img
      className="tab-item-icon-image"
      src={data.favIconUrl}
      alt=""
    />
  ) : <FileIcon />

  return (
    <TabItem
      data={{
        id: String(data.tabSourceId),
        icon,
        title: data.title || 'Untitled tab',
        url: data.url,
        matchTexts: data.matchText ? [data.matchText] : [],
        statuses
      }}
      config={{
        layoutMode: 'list',
        sizeMode: 'compact',
        responsiveMode: 'container',
        isIconVisible: true,
        isCloseVisible: data.isCloseVisible !== false,
        isCloseEnabled: data.isCloseVisible !== false,
        contentOffsetLeft: data.contentOffsetLeft
      }}
      onEvent={(eventType, eventData) => {
        if (eventType === 'closeAttempt') {
          onEvent?.('tabCloseAttempt', { tabSourceId: data.tabSourceId })
        }
        if (eventType === 'contentOffsetChange') {
          onEvent?.('tabContentOffsetChange', {
            tabSourceId: data.tabSourceId,
            offsetLeft: eventData.offsetLeft
          })
        }
      }}
    />
  )
}

function SearchControlButtonGroup({
  store,
  compLead,
  buttons
}: {
  store: PopupStore
  // Extra control rendered at the start of the track, e.g. the view switcher.
  compLead?: ReactNode
  buttons: Array<{
    id: string
    labelText: string
    isDisabled: boolean
    onClick: () => void
    className?: string
  }>
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const offsetLeft = store.getButtonOffsetLeft('tab-search')
  const offsetLeftRef = useRef(offsetLeft)
  offsetLeftRef.current = offsetLeft

  useEffect(() => {
    if (viewportRef.current) viewportRef.current.scrollLeft = offsetLeft
  }, [offsetLeft])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return undefined

    const handleWheel = (event: WheelEvent) => {
      const offsetMax = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
      if (offsetMax === 0) return
      event.preventDefault()
      event.stopPropagation()
      store.setSearchButtonOffsetLeft(Math.max(
        0,
        Math.min(offsetMax, offsetLeftRef.current + event.deltaX + event.deltaY)
      ))
    }

    viewport.addEventListener('wheel', handleWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', handleWheel)
  }, [store])

  return (
    <div
      className="tab-search-control-viewport"
      ref={viewportRef}
    >
      <div className="tab-search-control-track">
        {compLead}
        {buttons.map((button) => (
          <button
            type="button"
            className={`tab-search-control-button ${button.className ?? ''}`}
            title={button.labelText}
            disabled={button.isDisabled}
            onClick={button.onClick}
            key={button.id}
          >
            {button.labelText}
          </button>
        ))}
      </div>
    </div>
  )
}
