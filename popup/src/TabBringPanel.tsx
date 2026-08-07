import { observer } from 'mobx-react-lite'
import { FolderView } from '@wwf971/react-comp-misc'
import { PopupStore } from './PopupStore'
import { SearchTabCell } from './SearchPanel'
import './TabBringPanel.css'

// Panel of one bring operation (refer to TabBringCore): one side of the
// operation is fixed by the right-click menu, the other side is picked here,
// through a secondary search and the special "current tab" option.
export const TabBringPanel = observer(function TabBringPanel({
  store
}: {
  store: PopupStore
}) {
  const bring = store.tabBring
  if (!bring) return null
  const search = bring.search
  const isBusy = bring.isApplying
  const isPickSingle = bring.pickSide === 'target'
  const isSearchDisabled = isBusy || bring.isSearchForbidden
  const countApply = bring.tabSourceIdsApply.length

  const rows = search.items.map((tab) => {
    const isUnpickable = bring.tabSourceIdsUnpickable.has(tab.tabSourceId)
    // The current tab picked through its option shows as checked in the
    // result list too, just not toggleable there.
    const isPickedAsCurrent = (
      bring.isTabCurrentPicked &&
      tab.tabSourceId === bring.tabCurrent?.tabSourceId
    )
    return {
      id: String(tab.tabSourceId),
      rowClassName: isUnpickable ? 'tab-bring-row-unpickable' : '',
      data: {
        check: {
          isChecked: search.selectedIds.includes(tab.tabSourceId) || isPickedAsCurrent,
          isDisabled: isUnpickable || bring.isSearchForbidden
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
        {bring.pickSide === 'source'
          ? 'Bring tab(s) to'
          : `Bring ${bring.tabsSourceFixed.length} tab(s) to`}
        <button
          type="button"
          className={`tab-bring-placement-button ${bring.placement === 'before' ? 'tab-bring-placement-button-active' : ''}`}
          disabled={isBusy}
          onClick={() => bring.setPlacement('before')}
        >
          Before
        </button>
        <button
          type="button"
          className={`tab-bring-placement-button ${bring.placement === 'after' ? 'tab-bring-placement-button-active' : ''}`}
          disabled={isBusy}
          onClick={() => bring.setPlacement('after')}
        >
          After
        </button>
        <span
          className={`tab-bring-target-title ${bring.tabTarget === null ? 'tab-bring-target-title-empty' : ''}`}
          title={bring.tabTarget?.titleText ?? ''}
        >
          {getTabTargetText(bring)}
        </span>
      </div>

      {bring.tabCurrent ? (
        <div
          className={`tab-bring-option-current ${isBusy ? 'tab-bring-option-current-disabled' : ''}`}
          onClick={() => {
            if (!isBusy) bring.setTabCurrentPicked(!bring.isTabCurrentPicked)
          }}
        >
          <BringCheckMark isChecked={bring.isTabCurrentPicked} isDisabled={isBusy} />
          <span className="tab-bring-option-current-label">Current tab:</span>
          <span className="tab-bring-option-current-title" title={bring.tabCurrent.titleText}>
            {bring.tabCurrent.titleText || 'Untitled tab'}
          </span>
        </div>
      ) : null}

      <div
        className={[
          'tab-search-field',
          search.textInput ? '' : 'tab-search-field-empty',
          bring.isSearchForbidden ? 'tab-bring-search-forbidden' : ''
        ].filter(Boolean).join(' ')}
        contentEditable={!isSearchDisabled}
        suppressContentEditableWarning
        spellCheck={false}
        role="textbox"
        data-placeholder={isPickSingle ? 'Search the target tab' : 'Search tabs to bring'}
        onInput={(event) => {
          search.setTextInput(event.currentTarget.textContent ?? '')
        }}
      />

      <div className={`tab-search-message tab-search-message-${search.messageStatus}`}>
        {bring.isSearchForbidden
          ? 'The current tab is picked as the target. Untick it to search'
          : search.messageText || (
            isPickSingle
              ? 'Enter text to search the target tab'
              : 'Enter text to search tabs to bring'
          )}
      </div>

      <div
        className={`tab-bring-results tab-search-results ${bring.isSearchForbidden ? 'tab-bring-results-forbidden' : ''}`}
      >
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
            if (eventType === 'rowClick' && !isBusy) {
              const tabSourceId = Number(eventData.rowId)
              if (Number.isInteger(tabSourceId)) bring.toggleTabPicked(tabSourceId)
            }
            return { code: 0 }
          }}
        />
      </div>
      {search.isMore && !bring.isSearchForbidden ? (
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
          disabled={isBusy || !bring.isApplyReady}
          onClick={() => void store.applyTabBring()}
        >
          {countApply > 0 ? `Apply (${countApply})` : 'Apply'}
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

function getTabTargetText(bring: NonNullable<PopupStore['tabBring']>) {
  const tabTarget = bring.tabTarget
  if (tabTarget === null) return 'the target tab picked below'
  const titleText = tabTarget.titleText || 'Untitled tab'
  if (bring.pickSide === 'target' && bring.isTabCurrentPicked) {
    return `current tab: ${titleText}`
  }
  return titleText
}

function BringCheckCell({
  data
}: {
  data?: { isChecked: boolean, isDisabled: boolean }
}) {
  if (!data) return null
  return <BringCheckMark isChecked={data.isChecked} isDisabled={data.isDisabled} />
}

function BringCheckMark({
  isChecked,
  isDisabled
}: {
  isChecked: boolean
  isDisabled: boolean
}) {
  return (
    <span
      className={[
        'tab-bring-check',
        isChecked ? 'tab-bring-check-checked' : '',
        isDisabled ? 'tab-bring-check-disabled' : ''
      ].filter(Boolean).join(' ')}
    >
      {isChecked ? (
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
