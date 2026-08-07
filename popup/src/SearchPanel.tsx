import {
  useEffect,
  useRef,
  useState
} from 'react'
import { observer } from 'mobx-react-lite'
import {
  FileIcon,
  FolderView,
  MenuComp
} from '@wwf971/react-comp-misc'
import {
  TabContextEdge,
  TabItem,
  type TabItemStatus
} from '@wwf971/tab-manage-frontend-common'
import { PopupStore } from './PopupStore'
import { type TabSearchItem } from './TabSearchCore'
import { TabBringPanel } from './TabBringPanel'
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

export const SearchPanel = observer(function SearchPanel({
  store
}: {
  store: PopupStore
}) {
  const resultsRef = useRef<HTMLDivElement>(null)
  const [tabRowMenu, setTabRowMenu] = useState<TabRowMenuState | null>(null)
  const search = store.tabSearch
  const contextSingle = search.contextSingle
  const isContextMode = search.isContextMode
  const isActionBusy = (
    (search.isSearchBusy && search.searchAction !== 'search') ||
    search.isContextBusy
  )
  const tabSelectedCount = search.visibleSelectedIds.length
  const isTabSelected = tabSelectedCount > 0
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
    const itemsVisible = isContextMode && contextSingle ? contextSingle.items : search.items
    const tabItem = itemsVisible.find((tab) => tab.tabSourceId === tabSourceId)
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
  const tabRowIdsOrder = (
    isContextMode && contextSingle ? contextSingle.items : search.items
  ).map((tab) => String(tab.tabSourceId))

  const setVisibleSelectedIds = (tabSourceIds: number[]) => {
    if (isContextMode && contextSingle) {
      search.setContextSelectedIds(contextSingle.windowSourceId, tabSourceIds)
    } else {
      search.setSelectedIds(tabSourceIds)
    }
  }

  // Same ctrl/shift rules as the FolderView multi-select example.
  const applyTabRowClickSelect = (
    rowId: string,
    modifiers: { ctrl?: boolean, meta?: boolean, shift?: boolean }
  ) => {
    const tabSourceId = Number(rowId)
    if (!Number.isInteger(tabSourceId)) return
    const rowIdsSelected = search.visibleSelectedIds.map(String)
    const isCtrlPressed = modifiers.ctrl === true || modifiers.meta === true
    if (isCtrlPressed) {
      if (rowIdsSelected.includes(rowId)) {
        setVisibleSelectedIds(
          rowIdsSelected.filter((id) => id !== rowId).map(Number)
        )
      } else {
        setVisibleSelectedIds([...rowIdsSelected, rowId].map(Number))
      }
      return
    }
    if (modifiers.shift === true && rowIdsSelected.length > 0) {
      const indexAnchor = tabRowIdsOrder.indexOf(
        rowIdsSelected[rowIdsSelected.length - 1]
      )
      const indexCurrent = tabRowIdsOrder.indexOf(rowId)
      if (indexAnchor < 0 || indexCurrent < 0) {
        setVisibleSelectedIds([tabSourceId])
        return
      }
      const indexStart = Math.min(indexAnchor, indexCurrent)
      const indexEnd = Math.max(indexAnchor, indexCurrent)
      const rowIdsRange = tabRowIdsOrder.slice(indexStart, indexEnd + 1)
      setVisibleSelectedIds(
        [...new Set([...rowIdsSelected, ...rowIdsRange])].map(Number)
      )
      return
    }
    setVisibleSelectedIds([tabSourceId])
  }

  const rows = isContextMode && contextSingle
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
            matchText: search.textCommitted
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
    : search.items.map((tab) => ({
      id: String(tab.tabSourceId),
      data: {
        tab: {
          ...tab,
          matchText: search.textCommitted
        }
      }
    }))

  const rowIdsSelected = search.visibleSelectedIds.map(String)

  return (
    <div className="tab-search-panel">
      <div
        className={`tab-search-field ${search.textInput ? '' : 'tab-search-field-empty'}`}
        contentEditable={!isActionBusy}
        suppressContentEditableWarning
        spellCheck={false}
        role="textbox"
        data-placeholder="Search title or URL"
        onInput={(event) => {
          search.setTextInput(event.currentTarget.textContent ?? '')
        }}
      />

      <SearchControlButtonGroup
        store={store}
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
              else void search.enterContext(search.selectedIds[0])
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

      <div className={`tab-search-message tab-search-message-${search.messageStatus}`}>
        {search.messageText || 'Enter text to search open tabs'}
      </div>

      {store.tabBring ? (
        <TabBringPanel store={store} key={store.tabBringOpenCount} />
      ) : null}

      <div className="tab-search-results" ref={resultsRef}>
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
            return { code: 0 }
          }}
        />
      </div>
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
          data={{ items: getTabRowMenuItems(search, tabRowMenu) }}
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
              const tabsSourceFixed = search.visibleSelectedItems.map((tab) => ({
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
              setTabRowMenu(null)
            }
          }}
        />
      ) : null}
    </div>
  )
})

// Menu items depend on the selection: the "before/after it" pair needs one
// selected tab (the right-clicked one); the "before/after current tab" and
// "before/after a target tab" pair takes any selection as the source tabs.
function getTabRowMenuItems(
  search: PopupStore['tabSearch'],
  tabRowMenu: TabRowMenuState
) {
  const tabsSelected = search.visibleSelectedItems
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
      label: 'Bring before/after current tab',
      isDisabled: isSelectionCurrentOnly
    },
    {
      id: 'bring-to-target',
      label: 'Bring before/after a target tab'
    }
  )
  return items
}

export function SearchTabCell({
  data,
  onEvent
}: {
  data?: TabSearchItem & { matchText?: string, isCloseVisible?: boolean }
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
        isCloseEnabled: data.isCloseVisible !== false
      }}
      onEvent={(eventType) => {
        if (eventType === 'closeAttempt') {
          onEvent?.('tabCloseAttempt', { tabSourceId: data.tabSourceId })
        }
      }}
    />
  )
}

function SearchControlButtonGroup({
  store,
  buttons
}: {
  store: PopupStore
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
