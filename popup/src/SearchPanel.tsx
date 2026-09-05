import {
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { observer } from 'mobx-react-lite'
import {
  FileIcon,
  FolderView,
  MenuComp,
  SegmentedControl
} from '@wwf971/react-comp-misc'
import {
  TabContextEdge,
  TabItem,
  WindowSidebar,
  WindowTabView,
  rowIdsSelectedAfterClick,
  type TabItemStatus
} from '@wwf971/tab-manage-frontend-common'
import { PopupStore } from './PopupStore'
import { type TabSearchItem } from './TabSearchCore'
import { TabBringPanel } from './TabBringPanel'
import { RemoteUploadPanel } from './remote/RemoteUploadPanel'
import {
  getSearchFieldText,
  handleSearchFieldKeyDown,
  handleSearchFieldPaste
} from './searchFieldPlain'
import './SearchPanel.css'

const contextEdgeRowIdBefore = 'context-edge-before'
const contextEdgeRowIdAfter = 'context-edge-after'

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
// both panel modes (search results and the all-windows view).
interface TabMenuTab {
  tabSourceId: number
  title: string
  url: string
  windowSourceId: number
  isActive: boolean
  isWindowFocused: boolean
}

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
  // Full display is a top-level panel mode, separate from List/Windows search
  // result views.
  const isAllView = store.searchWorkspaceMode === 'all'
  const windowSourceIdSelected = isWindowView ? store.searchWindowSourceIdEffective : null
  const isContextVisible = isContextMode && contextSingle !== null &&
    (!isWindowView || contextSingle.windowSourceId === windowSourceIdSelected)
  // Tab rows of the current view: the context slice, the selected window's
  // matches, or the flat match list.
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

  const scrollRequestCount = contextSingle?.scrollRequestCount ?? 0
  const tabCenterSourceId = contextSingle?.tabCenterSourceId ?? null
  useEffect(() => {
    if (scrollRequestCount === 0 || tabCenterSourceId === null) return
    requestAnimationFrame(() => {
      const rowEl = resultsRef.current?.querySelector(
        `[data-row-id="${tabCenterSourceId}"]`
      )
      rowEl?.scrollIntoView({ block: 'center' })
    })
  }, [scrollRequestCount, tabCenterSourceId])

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
    if (isAllView) store.setWindowSourceIdSelectedAllView(windowSourceId)
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

  // Loading earlier tabs prepends rows. The scroll offset is compensated so the
  // tabs already on screen stay in place and no visual jump happens.
  const loadMoreTabContext = async (direction: 'before' | 'after') => {
    const windowSourceId = contextSingle?.windowSourceId
    if (windowSourceId === undefined) return
    const scrollEl = resultsRef.current?.querySelector('.folder-view-switcher-content')
    const scrollHeightBefore = scrollEl?.scrollHeight ?? 0
    const scrollTopBefore = scrollEl?.scrollTop ?? 0
    const isLoaded = await search.loadMoreContext(windowSourceId, direction)
    if (isLoaded && direction === 'before' && scrollEl) {
      requestAnimationFrame(() => {
        scrollEl.scrollTop = scrollTopBefore + (scrollEl.scrollHeight - scrollHeightBefore)
      })
    }
  }

  // Tab row IDs in display order. Edge rows of the context view are excluded
  // so shift-range selection only covers real tabs.
  const tabRowIdsOrder = itemsVisible.map((tab) => String(tab.tabSourceId))

  // Selected tabs the right-click tab menu acts on, one common shape for both
  // panel modes: row order for the menu items and the bring operations,
  // select order for ordered operations like uploading.
  const windowAllViewSelected = store.windowsAll.find(
    (windowItem) => windowItem.windowSourceId === store.windowSourceIdSelectedAllView
  ) ?? store.windowsAll[0]
  const tabsMenuAllView: TabMenuTab[] = (windowAllViewSelected?.tabs ?? []).map((tab) => ({
    tabSourceId: tab.tabSourceId,
    title: tab.title,
    url: tab.url,
    windowSourceId: windowAllViewSelected.windowSourceId,
    isActive: tab.isActive,
    isWindowFocused: windowAllViewSelected.isFocused
  }))
  const tabMenuOfSearchItem = (tab: TabSearchItem): TabMenuTab => ({
    tabSourceId: tab.tabSourceId,
    title: tab.title,
    url: tab.url,
    windowSourceId: tab.windowSourceId,
    isActive: tab.isActive,
    isWindowFocused: tab.isWindowFocused
  })
  const tabIdSelectedSetAllView = new Set(store.tabIdsSelectedAllView)
  const tabsMenuSelected: TabMenuTab[] = isAllView
    ? tabsMenuAllView.filter((tab) => tabIdSelectedSetAllView.has(String(tab.tabSourceId)))
    : search.visibleSelectedItems.map(tabMenuOfSearchItem)
  const tabsMenuSelectedSelectOrder: TabMenuTab[] = isAllView
    ? store.tabIdsSelectedAllView
      .map((tabId) => tabsMenuAllView.find((tab) => String(tab.tabSourceId) === tabId))
      .filter((tab): tab is TabMenuTab => tab !== undefined)
    : search.visibleSelectedItemsSelectOrder.map(tabMenuOfSearchItem)
  const tabMenuFind = (tabSourceId: number) => (
    isAllView
      ? tabsMenuAllView.find((tab) => tab.tabSourceId === tabSourceId)
      : itemsVisible.find((tab) => tab.tabSourceId === tabSourceId)
  )

  const setVisibleSelectedIds = (tabSourceIds: number[]) => {
    if (isContextVisible && contextSingle) {
      search.setContextSelectedIds(contextSingle.windowSourceId, tabSourceIds)
    } else {
      search.setSelectedIds(tabSourceIds)
    }
  }

  // Shared click rules (ctrl/shift/plain) of the table-like views; refer to
  // rowClickSelect.ts in frontend-common.
  const applyTabRowClickSelect = (
    rowId: string,
    modifiers: { ctrl?: boolean, meta?: boolean, shift?: boolean }
  ) => {
    if (!Number.isInteger(Number(rowId))) return
    setVisibleSelectedIds(
      rowIdsSelectedAfterClick(
        rowId,
        modifiers,
        tabRowIdsOrder,
        search.visibleSelectedIds.map(String)
      ).map(Number)
    )
  }

  const rows = isContextVisible && contextSingle
    ? [
      {
        id: contextEdgeRowIdBefore,
        data: {
          tab: {
            direction: 'before',
            isMore: contextSingle.isMoreBefore,
            isLoading: contextSingle.action === 'loadBefore',
            countLoad: store.tabContextCountSide
          }
        }
      },
      ...contextSingle.items.map((tab) => ({
        id: String(tab.tabSourceId),
        rowClassName: tab.tabSourceId === contextSingle.tabCenterSourceId
          ? 'tab-context-center'
          : '',
        data: {
          tab: {
            ...tab,
            matchText: search.textCommitted,
            contentOffsetLeft: search.contentOffsetLeftById.get(tab.tabSourceId) ?? 0
          }
        }
      })),
      {
        id: contextEdgeRowIdAfter,
        data: {
          tab: {
            direction: 'after',
            isMore: contextSingle.isMoreAfter,
            isLoading: contextSingle.action === 'loadAfter',
            countLoad: store.tabContextCountSide
          }
        }
      }
    ]
    : itemsVisible.map((tab) => ({
      id: String(tab.tabSourceId),
      data: {
        tab: {
          ...tab,
          matchText: search.textCommitted,
          contentOffsetLeft: search.contentOffsetLeftById.get(tab.tabSourceId) ?? 0
        }
      }
    }))

  const rowIdsSelected = search.visibleSelectedIds.map(String)

  return (
    <div className="tab-search-panel">
      <div
        className={`tab-search-field ${search.textInput ? '' : 'tab-search-field-empty'}`}
        // display:none instead of unmounting: the contentEditable field is
        // uncontrolled, so unmounting would lose the entered search text.
        style={{ display: isAllView ? 'none' : undefined }}
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

      {!isAllView ? (
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
        {search.messageText || (isAllView
          ? getWindowsAllSummaryText(store.windowsAll)
          : 'Enter text to search open tabs')}
      </div>

      {store.tabBring ? (
        <TabBringPanel store={store} key={store.tabBringOpenCount} />
      ) : null}

      {store.remote.uploadPanel ? (
        <RemoteUploadPanel store={store} key={store.remote.uploadPanelOpenCount} />
      ) : null}

      {isAllView ? (
        <div className="tab-search-results" ref={resultsRef}>
          <WindowTabView
            data={{
              windows: store.windowsAll,
              windowSourceIdSelected: store.windowSourceIdSelectedAllView,
              tabIdsSelected: store.tabIdsSelectedAllView
            }}
            config={{
              isBusy: isActionBusy,
              bodyHeight: 260,
              sidebarHeightPx: 260,
              colWidthById: store.getFolderColWidthById('search-all')
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
              if (eventType === 'colWidthByIdChange') {
                store.setFolderColWidthById(
                  'search-all',
                  eventData.colWidthById as Record<string, number>
                )
              }
            }}
          />
        </div>
      ) : (
      <div className="tab-search-results" ref={resultsRef}>
        {isWindowView ? (
          <WindowSidebar
            data={{
              windows: store.searchWindowItems.map((windowItem) => {
                const labelText = `Window ${windowItem.windowIndex + 1}`
                return {
                  windowSourceId: windowItem.windowSourceId,
                  labelText,
                  countText: String(windowItem.matchCount),
                  titleText: `${labelText}, ${windowItem.matchCount} matched tab${windowItem.matchCount === 1 ? '' : 's'}`,
                  isInContext: search.contextByWindowId.has(windowItem.windowSourceId)
                }
              }),
              windowSourceIdSelected
            }}
            config={{ isBusy: isActionBusy, heightPx: 260 }}
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
            }}
          />
        ) : null}
        <FolderView
          data={{
            columns: {
              tab: { data: 'Tabs', align: 'left' }
            },
            colsOrder: ['tab'],
            rows,
            rowIdsSelected,
            viewCurrent: 'list',
            statusBar: {
              itemCount: search.resultTotal,
              messageState: null
            }
          }}
          config={{
            bodyHeight: 260,
            colSizeById: {
              tab: { width: 560, minWidth: 140, resizable: false }
            },
            isLastColFilled: true,
            isListOnly: true,
            isStatusBarVisible: false,
            isLocked: isActionBusy,
            isRowReorderAllowed: false,
            selectionMode: 'multiple',
            compBodyByColId: (colId: string, rowId: string) => {
              if (colId !== 'tab') return undefined
              if (rowId === contextEdgeRowIdBefore || rowId === contextEdgeRowIdAfter) {
                return TabContextEdge
              }
              return SearchTabCell
            }
          }}
          onEvent={async (eventType, eventData) => {
            // Click selection follows the FolderView multi-select example via
            // rowInteraction. Built-in rowIdsSelectedChange is only used to
            // clear the selection when clicking empty space.
            if (eventType === 'rowInteraction') {
              const rowId = String(eventData.rowId ?? '')
              if (
                rowId === contextEdgeRowIdBefore ||
                rowId === contextEdgeRowIdAfter
              ) {
                return { code: 0 }
              }
              if (eventData.type === 'click') {
                applyTabRowClickSelect(
                  rowId,
                  (eventData.modifiers as {
                    ctrl?: boolean
                    meta?: boolean
                    shift?: boolean
                  }) ?? {}
                )
              }
              if (eventData.type === 'context-menu') {
                const tabSourceId = Number(rowId)
                if (
                  Number.isInteger(tabSourceId) &&
                  !search.visibleSelectedIds.includes(tabSourceId)
                ) {
                  setVisibleSelectedIds([tabSourceId])
                }
              }
            }
            if (eventType === 'rowIdsSelectedChange') {
              const rowIds = (eventData.rowIdsSelected as string[] | undefined) ?? []
              if (rowIds.length === 0) setVisibleSelectedIds([])
            }
            if (eventType === 'rowClick') {
              if (eventData.rowId === contextEdgeRowIdBefore) void loadMoreTabContext('before')
              if (eventData.rowId === contextEdgeRowIdAfter) void loadMoreTabContext('after')
            }
            if (eventType === 'rowDoubleClick') {
              const tabSourceId = Number(eventData.rowId)
              if (Number.isInteger(tabSourceId)) {
                store.runTabSearchAction('activate', tabSourceId)
              }
            }
            if (eventType === 'rowContextMenu') {
              const mouseEvent = eventData.event as MouseEvent | undefined
              mouseEvent?.preventDefault()
              const tabSourceId = Number(eventData.rowId)
              if (mouseEvent && Number.isInteger(tabSourceId)) {
                openTabRowMenu(tabSourceId, mouseEvent)
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
            return { code: 0 }
          }}
        />
      </div>
      )}
      {!isContextMode && search.isMore ? (
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
              if (item?.id === 'upload-selected-to-remote') {
                // Tabs upload in the order they were selected, not in row order.
                store.openRemoteUploadForTabs(
                  tabsMenuSelectedSelectOrder.map((tab) => ({
                    tabSourceId: tab.tabSourceId,
                    title: tab.title,
                    url: tab.url
                  }))
                )
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

function getWindowsAllSummaryText(windows: Array<{ tabs: unknown[] }>) {
  const tabCount = windows.reduce((count, windowItem) => count + windowItem.tabs.length, 0)
  return `${windows.length} window${windows.length === 1 ? '' : 's'}, ${tabCount} tab${tabCount === 1 ? '' : 's'}`
}

// Menu items depend on the selection: the "before/after it" pair needs one
// selected tab (the right-clicked one); the "before/after current tab" and
// "before/after a target tab" pair takes any selection as the source tabs.
// tabsSelected comes in the common TabMenuTab shape, so the search results
// and the all-windows view share this menu.
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
      id: 'upload-selected-to-remote',
      label: `Upload selected tab(s) to remote (${tabsSelected.length})`,
      isDisabled: tabsSelected.length === 0 || !remote.isUploadAllowed
    },
    {
      id: 'upload-window-to-remote',
      label: 'Upload this window to remote',
      isDisabled: !remote.isUploadAllowed
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
