import { observer } from 'mobx-react-lite'
import { FolderView } from '@wwf971/react-comp-misc'
import { PopupStore } from './PopupStore'
import { SearchTabCell } from './SearchPanel'
import './TabBringPanel.css'

// Panel for bringing searched tabs to before/after one target tab. It is
// opened from the right-click menu of a tab row in the Search tab.
export const TabBringPanel = observer(function TabBringPanel({
  store
}: {
  store: PopupStore
}) {
  const search = store.tabBringSearch
  const target = store.tabBringTarget
  if (!search || !target) return null

  const isBusy = store.isTabBringApplying
  const selectedIdSet = new Set(search.selectedIds)
  const selectedCount = search.selectedIds.filter(
    (tabSourceId) => tabSourceId !== target.tabSourceId
  ).length

  const toggleTabSelected = (tabSourceId: number) => {
    if (tabSourceId === target.tabSourceId) return
    if (selectedIdSet.has(tabSourceId)) {
      search.setSelectedIds(search.selectedIds.filter((id) => id !== tabSourceId))
    } else {
      search.setSelectedIds([...search.selectedIds, tabSourceId])
    }
  }

  const rows = search.items.map((tab) => {
    const isTarget = tab.tabSourceId === target.tabSourceId
    return {
      id: String(tab.tabSourceId),
      rowClassName: isTarget ? 'tab-bring-row-target' : '',
      data: {
        check: {
          isChecked: selectedIdSet.has(tab.tabSourceId),
          isDisabled: isTarget
        },
        tab: {
          ...tab,
          matchText: search.textCommitted,
          isCloseVisible: false
        }
      }
    }
  })

  return (
    <div className="tab-bring-panel">
      <div className="tab-bring-title">
        Bring tab(s) to
        <button
          type="button"
          className={`tab-bring-placement-button ${store.tabBringPlacement === 'before' ? 'tab-bring-placement-button-active' : ''}`}
          disabled={isBusy}
          onClick={() => store.setTabBringPlacement('before')}
        >
          Before
        </button>
        <button
          type="button"
          className={`tab-bring-placement-button ${store.tabBringPlacement === 'after' ? 'tab-bring-placement-button-active' : ''}`}
          disabled={isBusy}
          onClick={() => store.setTabBringPlacement('after')}
        >
          After
        </button>
        <span className="tab-bring-target-title" title={target.titleText}>
          {target.titleText || 'Untitled tab'}
        </span>
      </div>

      <div
        className={`tab-search-field ${search.textInput ? '' : 'tab-search-field-empty'}`}
        contentEditable={!isBusy}
        suppressContentEditableWarning
        spellCheck={false}
        role="textbox"
        data-placeholder="Search tabs to bring"
        onInput={(event) => {
          search.setTextInput(event.currentTarget.textContent ?? '')
        }}
      />

      <div className={`tab-search-message tab-search-message-${search.messageStatus}`}>
        {search.messageText || 'Enter text to search tabs to bring'}
      </div>

      <div className="tab-bring-results tab-search-results">
        <FolderView
          data={{
            columns: {
              check: { data: '', align: 'center' },
              tab: { data: 'Tabs', align: 'left' }
            },
            colsOrder: ['check', 'tab'],
            rows,
            rowIdsSelected: [],
            viewCurrent: 'list',
            statusBar: {
              itemCount: search.resultTotal,
              messageState: null
            }
          }}
          config={{
            bodyHeight: 180,
            colSizeById: {
              check: { width: 26, minWidth: 26, resizable: false },
              tab: { width: 534, minWidth: 140, resizable: false }
            },
            isLastColFilled: true,
            isListOnly: true,
            isStatusBarVisible: false,
            isLocked: isBusy,
            isRowReorderAllowed: false,
            selectionMode: 'none',
            compBodyByColId: (colId: string) => {
              if (colId === 'check') return BringCheckCell
              if (colId === 'tab') return SearchTabCell
              return undefined
            }
          }}
          onEvent={(eventType, eventData) => {
            if (eventType === 'rowClick') {
              const tabSourceId = Number(eventData.rowId)
              if (Number.isInteger(tabSourceId)) toggleTabSelected(tabSourceId)
            }
            return { code: 0 }
          }}
        />
      </div>
      {search.isMore ? (
        <button
          type="button"
          className="tab-search-load-more"
          disabled={isBusy}
          onClick={() => search.loadMore()}
        >
          Load More
        </button>
      ) : null}

      <div className="tab-bring-actions">
        <button
          type="button"
          className="tab-search-control-button"
          disabled={isBusy || selectedCount === 0}
          onClick={() => void store.applyTabBring()}
        >
          {selectedCount > 0 ? `Apply (${selectedCount})` : 'Apply'}
        </button>
        <button
          type="button"
          className="tab-search-control-button"
          disabled={isBusy}
          onClick={() => store.closeTabBring()}
        >
          Cancel
        </button>
      </div>
    </div>
  )
})

function BringCheckCell({
  data
}: {
  data?: { isChecked: boolean, isDisabled: boolean }
}) {
  if (!data) return null
  return (
    <span
      className={[
        'tab-bring-check',
        data.isChecked ? 'tab-bring-check-checked' : '',
        data.isDisabled ? 'tab-bring-check-disabled' : ''
      ].filter(Boolean).join(' ')}
    >
      {data.isChecked ? (
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path
            d="M1.5 5.5L4 8L8.5 2.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </span>
  )
}
