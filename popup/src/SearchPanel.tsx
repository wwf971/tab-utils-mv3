import {
  useEffect,
  useRef
} from 'react'
import { observer } from 'mobx-react-lite'
import {
  FileIcon,
  FolderView
} from '@wwf971/react-comp-misc'
import {
  TabContextEdge,
  TabItem,
  type TabItemStatus
} from '@wwf971/tab-manage-frontend-common'
import { PopupStore } from './PopupStore'
import { type TabSearchItem } from './TabSearchCore'
import './SearchPanel.css'

const contextEdgeRowIdBefore = 'context-edge-before'
const contextEdgeRowIdAfter = 'context-edge-after'

export const SearchPanel = observer(function SearchPanel({
  store
}: {
  store: PopupStore
}) {
  const resultsRef = useRef<HTMLDivElement>(null)
  const search = store.tabSearch
  const contextSingle = search.contextSingle
  const isContextMode = search.isContextMode
  const isActionBusy = (
    (search.isSearchBusy && search.searchAction !== 'search') ||
    search.isContextBusy
  )
  const tabSelectedCount = search.visibleSelectedIds.length
  const isTabSelected = tabSelectedCount > 0
  const isRelativeActionDisabled = (
    isActionBusy ||
    !isTabSelected ||
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
            isDisabled: isActionBusy || (!isContextMode && !isTabSelected),
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
            selectionMode: 'single',
            compBodyByColId: (colId: string, rowId: string) => {
              if (colId !== 'tab') return undefined
              if (rowId === contextEdgeRowIdBefore || rowId === contextEdgeRowIdAfter) {
                return TabContextEdge
              }
              return SearchTabCell
            }
          }}
          onEvent={async (eventType, eventData) => {
            if (eventType === 'rowIdsSelectedChange') {
              const rowIds = (eventData.rowIdsSelected as string[] | undefined) ?? []
              const isEdgeRowClicked = rowIds.some((rowId) => (
                rowId === contextEdgeRowIdBefore || rowId === contextEdgeRowIdAfter
              ))
              if (!isEdgeRowClicked) {
                const tabSourceIds = rowIds.map(Number).filter(Number.isInteger)
                if (isContextMode && contextSingle) {
                  search.setContextSelectedIds(contextSingle.windowSourceId, tabSourceIds)
                } else {
                  search.setSelectedIds(tabSourceIds)
                }
              }
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
    </div>
  )
})

function SearchTabCell({
  data,
  onEvent
}: {
  data?: TabSearchItem & { matchText?: string }
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
        isCloseVisible: true,
        isCloseEnabled: true
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
