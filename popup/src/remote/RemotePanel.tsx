import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import {
  FileIcon,
  FolderView,
  MenuComp,
  SettingIcon
} from '@wwf971/react-comp-misc'
import {
  TabContextEdge,
  TabItem,
  type TabItemStatus
} from '@wwf971/tab-manage-frontend-common'
import { RemoteStore, type RemoteTabItem } from './RemoteStore'
import { RemoteWindowSelect } from './RemoteWindowSelect'
import { RemoteSettingsPanel } from './RemoteSettingsPanel'
import './RemotePanel.css'

const contextEdgeRowIdBefore = 'context-edge-before'
const contextEdgeRowIdAfter = 'context-edge-after'

interface RemoteRowMenuState {
  tabId: string
  posOpen: { x: number, y: number }
  offsetX: number
  offsetY: number
}

export const RemotePanel = observer(function RemotePanel({
  store
}: {
  store: RemoteStore
}) {
  const resultsRef = useRef<HTMLDivElement>(null)
  const [rowMenu, setRowMenu] = useState<RemoteRowMenuState | null>(null)
  const context = store.context
  const isContextMode = store.isContextMode
  const isActionBusy = store.isBusy && store.searchAction !== 'search'
  const selectedCount = store.visibleSelectedIds.length
  const isSelected = selectedCount > 0

  const scrollRequestCount = context?.scrollRequestCount ?? 0
  const tabCenterId = context?.tabCenterId ?? null
  useEffect(() => {
    if (scrollRequestCount === 0 || tabCenterId === null) return
    requestAnimationFrame(() => {
      const rowEl = resultsRef.current?.querySelector(`[data-row-id="${tabCenterId}"]`)
      rowEl?.scrollIntoView({ block: 'center' })
    })
  }, [scrollRequestCount, tabCenterId])

  const getRowEl = (tabId: string) => (
    resultsRef.current?.querySelector(`[data-row-id="${tabId}"]`) as HTMLElement | null
  )

  const openRowMenu = (tabId: string, mouseEvent: MouseEvent) => {
    const rowRect = getRowEl(tabId)?.getBoundingClientRect()
    if (!rowRect) return
    setRowMenu(null)
    requestAnimationFrame(() => {
      setRowMenu({
        tabId,
        posOpen: { x: mouseEvent.clientX, y: mouseEvent.clientY },
        offsetX: mouseEvent.clientX - rowRect.left,
        offsetY: mouseEvent.clientY - rowRect.top
      })
    })
  }

  const loadMoreContext = async (direction: 'before' | 'after') => {
    const scrollEl = resultsRef.current?.querySelector('.folder-view-switcher-content')
    const scrollHeightBefore = scrollEl?.scrollHeight ?? 0
    const scrollTopBefore = scrollEl?.scrollTop ?? 0
    const isLoaded = await store.loadMoreContext(direction)
    if (isLoaded && direction === 'before' && scrollEl) {
      requestAnimationFrame(() => {
        scrollEl.scrollTop = scrollTopBefore + (scrollEl.scrollHeight - scrollHeightBefore)
      })
    }
  }

  const rowIdsOrder = store.visibleItems.map((item) => item.id)

  // same ctrl/shift selection rules as the local Search tab
  const applyRowClickSelect = (
    rowId: string,
    modifiers: { ctrl?: boolean, meta?: boolean, shift?: boolean }
  ) => {
    const rowIdsSelected = store.visibleSelectedIds
    const isCtrlPressed = modifiers.ctrl === true || modifiers.meta === true
    if (isCtrlPressed) {
      store.setSelectedIds(
        rowIdsSelected.includes(rowId)
          ? rowIdsSelected.filter((id) => id !== rowId)
          : [...rowIdsSelected, rowId]
      )
      return
    }
    if (modifiers.shift === true && rowIdsSelected.length > 0) {
      const indexAnchor = rowIdsOrder.indexOf(rowIdsSelected[rowIdsSelected.length - 1])
      const indexCurrent = rowIdsOrder.indexOf(rowId)
      if (indexAnchor < 0 || indexCurrent < 0) {
        store.setSelectedIds([rowId])
        return
      }
      const indexStart = Math.min(indexAnchor, indexCurrent)
      const indexEnd = Math.max(indexAnchor, indexCurrent)
      store.setSelectedIds(
        [...new Set([...rowIdsSelected, ...rowIdsOrder.slice(indexStart, indexEnd + 1)])]
      )
      return
    }
    store.setSelectedIds([rowId])
  }

  const rows = isContextMode && context
    ? [
      {
        id: contextEdgeRowIdBefore,
        data: {
          tab: {
            direction: 'before',
            isMore: context.isMoreBefore,
            isLoading: context.action === 'loadBefore',
            countLoad: store.getContextCountSide()
          }
        }
      },
      ...context.items.map((item) => ({
        id: item.id,
        rowClassName: item.id === context.tabCenterId ? 'tab-context-center' : '',
        data: { tab: { ...item, matchText: store.textCommitted } }
      })),
      {
        id: contextEdgeRowIdAfter,
        data: {
          tab: {
            direction: 'after',
            isMore: context.isMoreAfter,
            isLoading: context.action === 'loadAfter',
            countLoad: store.getContextCountSide()
          }
        }
      }
    ]
    : store.items.map((item) => ({
      id: item.id,
      data: { tab: { ...item, matchText: store.textCommitted } }
    }))

  const buttons = store.isTrashScope
    ? [
      {
        id: 'open',
        labelText: 'Open',
        isDisabled: isActionBusy || !isSelected,
        onClick: () => void store.openTabs(store.visibleSelectedIds, false)
      },
      {
        id: 'restore',
        labelText: 'Restore',
        isDisabled: isActionBusy || !isSelected,
        onClick: () => void store.restoreTabs(store.visibleSelectedIds, null)
      },
      {
        id: 'restore-to',
        labelText: 'Restore To...',
        isDisabled: isActionBusy || !isSelected,
        onClick: () => store.setRestorePickOpen(!store.restorePick.isOpen)
      },
      {
        id: 'delete-permanent',
        labelText: 'Delete Forever',
        isDisabled: isActionBusy || !isSelected,
        onClick: () => void store.deleteTabsPermanent(store.visibleSelectedIds)
      },
      {
        id: 'refresh',
        labelText: 'Refresh',
        isDisabled: isActionBusy,
        onClick: () => void store.refreshVisible()
      }
    ]
    : [
      {
        id: 'open',
        labelText: 'Open',
        isDisabled: isActionBusy || !isSelected,
        onClick: () => void store.openTabs(store.visibleSelectedIds, false)
      },
      {
        id: 'open-trash',
        labelText: 'Open + Trash',
        isDisabled: isActionBusy || !isSelected,
        onClick: () => void store.openTabs(store.visibleSelectedIds, true)
      },
      {
        id: 'trash',
        labelText: 'Trash',
        isDisabled: isActionBusy || !isSelected,
        onClick: () => void store.trashTabs(store.visibleSelectedIds)
      },
      {
        id: 'context',
        labelText: isContextMode ? 'Exit Context' : 'Context',
        className: 'tab-search-control-button-context',
        isDisabled: isActionBusy || (!isContextMode && selectedCount !== 1),
        onClick: () => {
          if (isContextMode) store.exitContext()
          else void store.enterContext(store.selectedIds[0])
        }
      },
      {
        id: 'refresh',
        labelText: 'Refresh',
        isDisabled: isActionBusy,
        onClick: () => void store.refreshVisible()
      }
    ]

  return (
    <div className="remote-panel">
      <div className="remote-panel-header">
        <div className="remote-scope-toggle">
          <button
            type="button"
            className={`remote-scope-button ${store.isTrashScope ? '' : 'remote-scope-button-active'}`}
            onClick={() => store.setTrashScope(false)}
          >
            Live
          </button>
          <button
            type="button"
            className={`remote-scope-button ${store.isTrashScope ? 'remote-scope-button-active' : ''}`}
            onClick={() => store.setTrashScope(true)}
          >
            Trash
          </button>
        </div>
        <div className="remote-field-toggle">
          <button
            type="button"
            className={`remote-scope-button ${store.isSearchTitle ? 'remote-scope-button-active' : ''}`}
            onClick={() => store.setSearchField('title', !store.isSearchTitle)}
          >
            Title
          </button>
          <button
            type="button"
            className={`remote-scope-button ${store.isSearchUrl ? 'remote-scope-button-active' : ''}`}
            onClick={() => store.setSearchField('url', !store.isSearchUrl)}
          >
            URL
          </button>
        </div>
        <span
          className="remote-settings-icon"
          title="Remote settings"
          onClick={() => store.setSettingsOpen(true)}
        >
          <SettingIcon />
        </span>
      </div>

      <div
        className={`tab-search-field ${store.textInput ? '' : 'tab-search-field-empty'}`}
        contentEditable={!isActionBusy}
        suppressContentEditableWarning
        spellCheck={false}
        role="textbox"
        data-placeholder={store.isTrashScope ? 'Search trashed tabs' : 'Search remote tabs'}
        onInput={(event) => {
          store.setTextInput(event.currentTarget.textContent ?? '')
        }}
      />

      <div className="tab-search-control-viewport">
        <div className="tab-search-control-track">
          {buttons.map((button) => (
            <button
              type="button"
              className={`tab-search-control-button ${'className' in button ? button.className ?? '' : ''}`}
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

      <div className={`tab-search-message tab-search-message-${store.messageStatus}`}>
        {store.messageText || (store.isLoggedIn
          ? 'Enter text to search remote tabs'
          : 'Not logged in. Open remote settings at top right')}
      </div>

      {store.restorePick.isOpen ? (
        <div className="remote-restore-pick">
          <span className="remote-restore-pick-label">Restore to</span>
          <RemoteWindowSelect
            store={store}
            selectorId="restore-pick"
            windowIdSelected={store.restorePick.windowIdSelected}
            emptyText="original window (restored if trashed)"
            isDisabled={isActionBusy}
            onEvent={(eventType, eventData) => {
              if (eventType === 'windowPick') {
                store.setRestorePickWindowId((eventData.windowId as string | null) ?? null)
              }
            }}
          />
          <button
            type="button"
            className="tab-search-control-button"
            disabled={isActionBusy || !isSelected}
            onClick={() => void store.applyRestorePick()}
          >
            Restore ({selectedCount})
          </button>
          <button
            type="button"
            className="tab-search-control-button"
            disabled={isActionBusy}
            onClick={() => store.setRestorePickOpen(false)}
          >
            Cancel
          </button>
        </div>
      ) : null}

      <div className="tab-search-results" ref={resultsRef}>
        <FolderView
          data={{
            columns: {
              tab: { data: 'Remote tabs', align: 'left' }
            },
            colsOrder: ['tab'],
            rows,
            rowIdsSelected: store.visibleSelectedIds,
            viewCurrent: 'list',
            statusBar: { itemCount: store.items.length, messageState: null }
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
              return RemoteTabCell
            }
          }}
          onEvent={async (eventType, eventData) => {
            if (eventType === 'rowInteraction') {
              const rowId = String(eventData.rowId ?? '')
              if (rowId === contextEdgeRowIdBefore || rowId === contextEdgeRowIdAfter) {
                return { code: 0 }
              }
              if (eventData.type === 'click') {
                applyRowClickSelect(
                  rowId,
                  (eventData.modifiers as { ctrl?: boolean, meta?: boolean, shift?: boolean }) ?? {}
                )
              }
              if (eventData.type === 'context-menu') {
                if (!store.visibleSelectedIds.includes(rowId)) {
                  store.setSelectedIds([rowId])
                }
              }
            }
            if (eventType === 'rowIdsSelectedChange') {
              const rowIds = (eventData.rowIdsSelected as string[] | undefined) ?? []
              if (rowIds.length === 0) store.setSelectedIds([])
            }
            if (eventType === 'rowClick') {
              if (eventData.rowId === contextEdgeRowIdBefore) void loadMoreContext('before')
              if (eventData.rowId === contextEdgeRowIdAfter) void loadMoreContext('after')
            }
            if (eventType === 'rowDoubleClick') {
              const rowId = String(eventData.rowId ?? '')
              if (rowId && rowId !== contextEdgeRowIdBefore && rowId !== contextEdgeRowIdAfter) {
                void store.openTabs([rowId], false)
              }
            }
            if (eventType === 'rowContextMenu') {
              const mouseEvent = eventData.event as MouseEvent | undefined
              mouseEvent?.preventDefault()
              const rowId = String(eventData.rowId ?? '')
              if (mouseEvent && rowId && rowId !== contextEdgeRowIdBefore && rowId !== contextEdgeRowIdAfter) {
                openRowMenu(rowId, mouseEvent)
              } else {
                setRowMenu(null)
              }
            }
            return { code: 0 }
          }}
        />
      </div>

      {rowMenu ? (
        <MenuComp
          data={{ items: getRemoteRowMenuItems(store, rowMenu.tabId) }}
          config={{
            isOpen: true,
            posOpen: rowMenu.posOpen,
            isBackdropScrollPassThrough: true,
            anchor: {
              getRect: () => getRowEl(rowMenu.tabId)?.getBoundingClientRect() ?? null,
              getTargetEl: () => getRowEl(rowMenu.tabId),
              getVisibilityRoot: () => (
                resultsRef.current?.querySelector('.folder-view-switcher-content') ?? null
              ),
              offsetX: rowMenu.offsetX,
              offsetY: rowMenu.offsetY
            }
          }}
          onEvent={(eventType: string, eventData: Record<string, unknown>) => {
            if (eventType === 'closeRequest') setRowMenu(null)
            if (eventType === 'itemClick') {
              const item = eventData.item as { id?: string } | undefined
              const selectedIds = store.visibleSelectedIds
              if (item?.id === 'open') void store.openTabs(selectedIds, false)
              if (item?.id === 'open-trash') void store.openTabs(selectedIds, true)
              if (item?.id === 'trash') void store.trashTabs(selectedIds)
              if (item?.id === 'move-before') {
                void store.moveTabs(
                  selectedIds.filter((id) => id !== rowMenu.tabId), rowMenu.tabId, 'before')
              }
              if (item?.id === 'move-after') {
                void store.moveTabs(
                  selectedIds.filter((id) => id !== rowMenu.tabId), rowMenu.tabId, 'after')
              }
              if (item?.id === 'restore') void store.restoreTabs(selectedIds, null)
              if (item?.id === 'restore-to') store.setRestorePickOpen(true)
              if (item?.id === 'delete-permanent') void store.deleteTabsPermanent(selectedIds)
              setRowMenu(null)
            }
          }}
        />
      ) : null}

      {store.isSettingsOpen ? <RemoteSettingsPanel store={store} /> : null}
    </div>
  )
})

function getRemoteRowMenuItems(store: RemoteStore, tabIdClicked: string) {
  const selectedIds = store.visibleSelectedIds
  if (store.isTrashScope) {
    return [
      { id: 'open', label: 'Open in browser' },
      { id: 'restore', label: 'Restore' },
      { id: 'restore-to', label: 'Restore to a window...' },
      { id: 'delete-permanent', label: 'Delete permanently' }
    ]
  }
  const isMoveDisabled = (
    selectedIds.length === 0 ||
    (selectedIds.length === 1 && selectedIds[0] === tabIdClicked)
  )
  return [
    { id: 'open', label: 'Open in browser' },
    { id: 'open-trash', label: 'Open and trash on remote' },
    { id: 'move-before', label: 'Move selected before it', isDisabled: isMoveDisabled },
    { id: 'move-after', label: 'Move selected after it', isDisabled: isMoveDisabled },
    { id: 'trash', label: 'Trash' }
  ]
}

export function RemoteTabCell({
  data
}: {
  data?: RemoteTabItem & { matchText?: string }
}) {
  if (!data) return null
  const statuses: TabItemStatus[] = [
    {
      id: 'trashed',
      labelText: 'Trashed',
      tone: 'warning',
      isVisible: data.trashAt != null
    },
    {
      id: 'grouped',
      labelText: 'Grouped',
      tone: 'neutral',
      isVisible: data.groupId != null
    }
  ]
  return (
    <TabItem
      data={{
        id: data.id,
        icon: <FileIcon />,
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
        isCloseVisible: false,
        isCloseEnabled: false
      }}
    />
  )
}
