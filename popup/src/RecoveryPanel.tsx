import { useEffect, useRef } from 'react'
import { observer } from 'mobx-react-lite'
import {
  ButtonWithDropDown,
  NumValue,
  SegmentedControl
} from '@wwf971/react-comp-misc'
import { Maximize2, X } from 'lucide-react'
import type { SnapshotDetailData } from '@wwf971/tab-manage-frontend-common'
import { PopupStore } from './PopupStore'
import './RecoveryPanel.css'

// The Restore tab fills the fixed popup height; the popup itself must never
// get a vertical scrollbar (refer to /doc/popup_size.md). All content around
// this panel has fixed height, so the panel height is measured once at mount:
// first fill down to the popup bottom, then shave off exactly the overflow
// that the scrolling ancestor still reports. The events table inside is the
// flexible area that absorbs the resulting height.
function usePanelHeightFit(panelRef: React.RefObject<HTMLDivElement>) {
  useEffect(() => {
    const panelEl = panelRef.current
    if (!panelEl) return
    const scrollerEl = panelEl.closest('.popup-config-panel') as HTMLElement | null
    if (scrollerEl) scrollerEl.scrollTop = 0
    const panelTop = panelEl.getBoundingClientRect().top
    let height = document.documentElement.clientHeight - panelTop
    panelEl.style.height = `${Math.max(320, height)}px`
    if (scrollerEl) {
      const overflow = scrollerEl.scrollHeight - scrollerEl.clientHeight
      if (overflow > 0) {
        height -= overflow
        panelEl.style.height = `${Math.max(320, height)}px`
      }
    }
  }, [panelRef])
}

export const RecoveryPanel = observer(function RecoveryPanel({
  store
}: {
  store: PopupStore
}) {
  const snapshot = store.recoverySnapshot
  const calculatedSnapshot = store.recoveryCalculatedSnapshot
  const isBusy = store.isSnapshotBusy
  const panelRef = useRef<HTMLDivElement>(null)
  usePanelHeightFit(panelRef)

  return (
    <div className="recovery-panel" ref={panelRef}>
      <ReplayModeRow store={store} />
      <ReplayTargetControls store={store} />

      <div className="recovery-source-grid">
        <div className="recovery-section">
          {snapshot ? (
            <SnapshotOverview snapshot={snapshot} titleText="Last snapshot" />
          ) : (
            <>
              <div className="recovery-section-title">Last snapshot</div>
              <div className="recovery-empty">No complete snapshot is available.</div>
            </>
          )}
        </div>
        <div className="recovery-section recovery-event-section">
          <div className="recovery-section-title">
            Events after snapshot
            <button
              type="button"
              className="recovery-icon-button"
              title="Open the events table enlarged"
              disabled={isBusy}
              onClick={() => store.setRecoveryEventPopupOpen(true)}
            >
              <Maximize2 size={12} />
            </button>
            <span className="recovery-count">{store.recoveryEvents.length} Events</span>
            {store.recoveryEventSequenceSelected !== null ? (
              <span className="recovery-count">
                Selected {store.recoveryEventSequenceSelected}
              </span>
            ) : null}
            <span className="recovery-toolbar-divider" />
            <RecoveryEventColCountControl store={store} />
          </div>
          <RecoveryEventTable store={store} />
        </div>
      </div>

      <div className="recovery-section recovery-message-section">
        <div className="recovery-section-title">Replay messages</div>
        <div className="recovery-message-list">
          {store.recoveryMessages.length > 0 ? store.recoveryMessages.map((message) => (
            <div
              className={`recovery-message-row recovery-message-${message.level}`}
              key={message.messageId}
            >
              <span className="recovery-message-level">{message.level}</span>
              <span>{message.text}</span>
            </div>
          )) : (
            <div className="recovery-empty">Replay has no warnings or errors.</div>
          )}
        </div>
      </div>

      <div className="recovery-section recovery-result-section">
        {calculatedSnapshot ? (
          <SnapshotOverview snapshot={calculatedSnapshot} titleText="Calculated snapshot" />
        ) : (
          <>
            <div className="recovery-section-title">Calculated snapshot</div>
            <div className="recovery-empty">Replay recorded events to calculate a state to restore.</div>
          </>
        )}
        <div className="recovery-confirm-row">
          <button
            type="button"
            className="recovery-button recovery-button-primary"
            disabled={isBusy || !calculatedSnapshot || store.recoveryPhase === 'restored'}
            onClick={() => store.restoreRecovery()}
          >
            Confirm and restore
          </button>
          <label className="snapshot-restore-mode">
            <input
              type="checkbox"
              className="snapshot-restore-mode-checkbox"
              checked={store.isBatchRestore}
              disabled={isBusy}
              onChange={(event) => store.setBatchRestore(event.currentTarget.checked)}
            />
            <span>Restore windows/tabs in a batch</span>
          </label>
        </div>
      </div>

      {store.isRecoveryEventPopupOpen ? <RecoveryEventPopup store={store} /> : null}
    </div>
  )
})

const ReplayModeRow = observer(function ReplayModeRow({
  store
}: {
  store: PopupStore
}) {
  const isBusy = store.isSnapshotBusy
  return (
    <div className="recovery-replay-mode-row">
      <span className="recovery-replay-mode-lead">Replay</span>
      <label className="recovery-replay-mode-option">
        <input
          type="radio"
          name="recovery-replay-mode"
          checked={store.recoveryReplayMode === 'last'}
          disabled={isBusy || !store.recoverySnapshot}
          onChange={() => store.setRecoveryReplayMode('last')}
        />
        <span>to last step</span>
      </label>
      <label className="recovery-replay-mode-option">
        <input
          type="radio"
          name="recovery-replay-mode"
          checked={store.recoveryReplayMode === 'selected'}
          disabled={isBusy || !store.recoverySnapshot}
          onChange={() => store.setRecoveryReplayMode('selected')}
        />
        <span>to given step</span>
      </label>
      <label className="recovery-replay-mode-option">
        <input
          type="radio"
          name="recovery-replay-mode"
          checked={store.recoveryReplayMode === 'target'}
          disabled={isBusy || !store.recoverySnapshot}
          onChange={() => store.setRecoveryReplayMode('target')}
        />
        <span>using advanced features below</span>
      </label>
      <button
        type="button"
        className="recovery-button recovery-button-primary"
        disabled={!store.recoverySnapshot}
        title={replayButtonTitle(store)}
        onClick={() => store.replayRecoveryByMode()}
      >
        Replay
      </button>
      <label className="recovery-realtime-toggle" title="Replay immediately after each mode or parameter edit">
        <input
          type="checkbox"
          checked={store.isRecoveryReplayRealtime}
          onChange={(event) => store.setRecoveryReplayRealtime(event.currentTarget.checked)}
        />
        <span>Real-time replay</span>
      </label>
      <button
        type="button"
        className="recovery-button"
        disabled={isBusy}
        onClick={() => store.loadRecoverySource()}
      >
        Refresh source
      </button>
    </div>
  )
})

// Target-based replay: replay to {offset} step of the (last) {index}-th
// {event type} event. With real-time replay on, every parameter edit replays
// immediately, so the user can tune parameters and watch the result.
const ReplayTargetControls = observer(function ReplayTargetControls({
  store
}: {
  store: PopupStore
}) {
  const target = store.recoveryReplayTarget
  const isBusy = store.isSnapshotBusy
  const isAdvancedEnabled = store.recoveryReplayMode === 'target'
  const isControlDisabled = isBusy || !isAdvancedEnabled

  return (
    <div
      className={`recovery-replay-target-row${
        isAdvancedEnabled ? '' : ' recovery-replay-target-row-disabled'
      }`}
    >
      <span className="recovery-replay-target-text">Replay to</span>
      <NumValue
        data={{ value: target.offsetStep }}
        config={{ min: -999, max: 999, step: 1, isDisabled: isControlDisabled }}
        onEvent={(eventType, eventData) => {
          if (eventType === 'valueChangeAttempt') {
            store.setRecoveryReplayTarget({ offsetStep: Number(eventData.value) })
          }
        }}
      />
      <span className="recovery-replay-target-text">step of</span>
      <SegmentedControl
        data={{
          valueSelected: target.isFromLast ? 'last' : 'first',
          segList: [
            { value: 'last', labelText: 'Last' },
            { value: 'first', labelText: 'First' }
          ]
        }}
        config={{ isDisabled: isControlDisabled }}
        onEvent={(eventType: string, eventData: Record<string, unknown>) => {
          if (eventType === 'valueSelectedChange') {
            store.setRecoveryReplayTarget({ isFromLast: eventData.valueSelected === 'last' })
          }
        }}
      />
      <NumValue
        data={{ value: target.indexNth }}
        config={{ min: 1, max: 9999, step: 1, isDisabled: isControlDisabled }}
        onEvent={(eventType, eventData) => {
          if (eventType === 'valueChangeAttempt') {
            store.setRecoveryReplayTarget({ indexNth: Number(eventData.value) })
          }
        }}
      />
      <span className="recovery-replay-target-text">-th</span>
      <ButtonWithDropDown
        data={{
          label: formatEventType(target.eventType),
          items: store.recoveryEventTypes.map((eventType) => ({
            id: eventType,
            label: formatEventType(eventType)
          }))
        }}
        config={{
          isDisabled: isControlDisabled,
          buttonClassName: 'recovery-event-type-button',
          minWidth: 150,
          title: 'Event type of the replay target'
        }}
        onEvent={(eventType: string, eventData: Record<string, unknown>) => {
          if (eventType === 'itemClick') {
            store.setRecoveryReplayTarget({ eventType: String(eventData.itemId) })
          }
        }}
      />
      <span className="recovery-replay-target-text">event</span>
    </div>
  )
})

const RecoveryEventColCountControl = observer(function RecoveryEventColCountControl({
  store
}: {
  store: PopupStore
}) {
  return (
    <div className="recovery-event-column-control">
      <span>Columns Per Row</span>
      <NumValue
        data={{ value: store.recoveryEventColCount }}
        config={{ min: 1, max: 8, step: 1, isDisabled: store.isSnapshotBusy }}
        onEvent={(eventType, eventData) => {
          if (eventType === 'valueChangeAttempt') {
            void store.setRecoveryEventColCount(Number(eventData.value))
          }
        }}
      />
    </div>
  )
})

// Events table with one header per column group. The # and Type column widths
// are resized by dragging the border handle in the header cells; the Time
// column fills the remaining group width.
const RecoveryEventTable = observer(function RecoveryEventTable({
  store
}: {
  store: PopupStore
}) {
  const isBusy = store.isSnapshotBusy
  const colCount = store.recoveryEventColCount
  const colWidth = store.recoveryEventColWidthById
  const groupTemplate = `${colWidth.seq}px ${colWidth.type}px minmax(0, 1fr)`
  const listTemplate = `repeat(${colCount}, minmax(0, 1fr))`
  const isReplayed = store.recoveryPhase === 'replayed' || store.recoveryPhase === 'restored'

  return (
    <div className="recovery-event-table">
      <div className="recovery-event-table-header" style={{ gridTemplateColumns: listTemplate }}>
        {Array.from({ length: colCount }, (_, groupIndex) => (
          <div
            className="recovery-event-header-group"
            key={groupIndex}
            style={{ gridTemplateColumns: groupTemplate }}
          >
            <span className="recovery-event-header-cell">
              #
              <span
                className="recovery-event-col-handle"
                title="Drag to resize the index column"
                onMouseDown={(event) => startEventColResize(store, 'seq', event)}
              />
            </span>
            <span className="recovery-event-header-cell">
              Type
              <span
                className="recovery-event-col-handle"
                title="Drag to resize the type column"
                onMouseDown={(event) => startEventColResize(store, 'type', event)}
              />
            </span>
            <span className="recovery-event-header-cell">Time</span>
          </div>
        ))}
      </div>
      <div className="recovery-event-list" style={{ gridTemplateColumns: listTemplate }}>
        {store.recoveryEvents.length > 0 ? store.recoveryEvents.map((eventItem) => (
          <button
            type="button"
            className={[
              'recovery-event-row',
              store.recoveryEventSequenceSelected === eventItem.eventSequence
                ? 'recovery-event-row-selected'
                : '',
              isReplayed && store.recoveryEventSequenceLast === eventItem.eventSequence
                ? 'recovery-event-row-replay-end'
                : ''
            ].filter((namePart) => namePart.length > 0).join(' ')}
            style={{ gridTemplateColumns: groupTemplate }}
            key={eventItem.eventId ?? eventItem.eventSequence}
            aria-pressed={store.recoveryEventSequenceSelected === eventItem.eventSequence}
            title={[
              eventItem.eventSequence,
              formatEventType(eventItem.eventType),
              eventItem.eventAtText ?? ''
            ].filter((part) => String(part).length > 0).join(' · ')}
            disabled={isBusy}
            onClick={() => store.setRecoveryEventSequenceSelected(eventItem.eventSequence)}
          >
            <span className="recovery-event-sequence">{eventItem.eventSequence}</span>
            <span className="recovery-event-type">{formatEventType(eventItem.eventType)}</span>
            <span className="recovery-event-time">{eventItem.eventAtText ?? ''}</span>
          </button>
        )) : (
          <div className="recovery-empty">No later events. Replay will keep the snapshot unchanged.</div>
        )}
      </div>
    </div>
  )
})

// Enlarged events view in an in-popup overlay, opened by the Maximize button.
// Clicking the backdrop closes it, like other transient popups.
const RecoveryEventPopup = observer(function RecoveryEventPopup({
  store
}: {
  store: PopupStore
}) {
  return (
    <div
      className="recovery-event-popup-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) store.setRecoveryEventPopupOpen(false)
      }}
    >
      <div className="recovery-event-popup">
        <div className="recovery-event-popup-title-row">
          <div className="recovery-event-popup-title-main">
            <span className="recovery-event-popup-title">Events after snapshot</span>
            <span className="recovery-count">{store.recoveryEvents.length} Events</span>
            {store.recoveryEventSequenceSelected !== null ? (
              <span className="recovery-count">
                Selected {store.recoveryEventSequenceSelected}
              </span>
            ) : null}
            <span className="recovery-toolbar-divider" />
            <RecoveryEventColCountControl store={store} />
            <button
              type="button"
              className="recovery-button recovery-button-primary"
              disabled={
                store.isSnapshotBusy ||
                !store.recoverySnapshot ||
                store.recoveryEventSequenceSelected === null
              }
              onClick={() => store.replayRecovery(store.recoveryEventSequenceSelected)}
            >
              Replay to selected step
            </button>
          </div>
          <button
            type="button"
            className="recovery-icon-button recovery-event-popup-close"
            title="Close the enlarged events table"
            onClick={() => store.setRecoveryEventPopupOpen(false)}
          >
            <X size={13} />
          </button>
        </div>
        <RecoveryEventTable store={store} />
      </div>
    </div>
  )
})

function SnapshotOverview({
  snapshot,
  titleText
}: {
  snapshot: SnapshotDetailData
  titleText?: string
}) {
  const windowCount = snapshot.windows.length
  const tabCount = snapshot.windows.reduce(
    (count, windowItem) => count + windowItem.tabs.length,
    0
  )
  const summary = (
    <span className="recovery-overview-summary">
      <span className="recovery-overview-summary-item">{snapshot.snapshotGenerateAtText}</span>
      <span className="recovery-overview-summary-item">{windowCount} windows</span>
      <span className="recovery-overview-summary-item">{tabCount} tabs</span>
    </span>
  )
  return (
    <div className="recovery-overview">
      {titleText ? (
        <div className="recovery-section-title">
          {titleText}
          {summary}
        </div>
      ) : summary}
      <div className="recovery-window-list">
        {snapshot.windows.map((windowItem, windowIndex) => (
          <div className="recovery-window-row" key={windowItem.windowSourceId}>
            <span className="recovery-window-label">Window {windowIndex + 1}</span>
            <span className="recovery-window-tab-count">{windowItem.tabs.length} tabs</span>
            <span className="recovery-window-preview">
              {windowItem.tabs.slice(0, 2).map((tab) => tab.title || tab.url || 'Untitled').join(', ')}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// Immediate-mode column resize: the width follows the mouse while dragging and
// stops changing at the limits. When the mouse comes back into the legal
// range, the width follows again because it derives from the press position.
function startEventColResize(
  store: PopupStore,
  colId: 'seq' | 'type',
  eventDown: React.MouseEvent
) {
  eventDown.preventDefault()
  const widthStart = store.recoveryEventColWidthById[colId]
  const xStart = eventDown.clientX
  const widthMin = colId === 'seq' ? 22 : 40
  const widthMax = 260
  const onMouseMove = (eventMove: MouseEvent) => {
    const width = Math.max(
      widthMin,
      Math.min(widthMax, widthStart + eventMove.clientX - xStart)
    )
    store.setRecoveryEventColWidth(colId, width)
  }
  const onMouseUp = () => {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
  }
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}

function formatEventType(eventType: string) {
  return eventType.replace(/([a-z])([A-Z])/g, '$1 $2')
}

function replayButtonTitle(store: PopupStore) {
  if (store.recoveryReplayMode === 'last') return 'Replay through the last event'
  if (store.recoveryReplayMode === 'selected') {
    return store.recoveryEventSequenceSelected === null
      ? 'Select an event to replay to'
      : `Replay through event sequence ${store.recoveryEventSequenceSelected}`
  }
  return store.recoveryEventSequenceTargetEnd === null
    ? 'No recorded event matches the target'
    : `Replay through event sequence ${store.recoveryEventSequenceTargetEnd}`
}
