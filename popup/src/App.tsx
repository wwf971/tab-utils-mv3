import { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import {
  ConfigPanel,
  MessageBar,
  NumValue,
  TabsOnTop,
  TabsOnTopTab,
  TabsOnTopTabLabel,
  type ConfigCustomControlProps
} from '@wwf971/react-comp-misc'
import {
  SnapshotList,
  SnapshotView,
  type SnapshotDetailData
} from '@wwf971/tab-manage-frontend-common'
import {
  PopupStore,
  type SnapshotMaintenance
} from './PopupStore'
import './App.css'

const badgeCurrentWindowValue = 'currentWindow'
const badgeTotalValue = 'total'

function BadgeTabCountControl({
  value,
  item,
  isDisabled,
  onValueChange
}: ConfigCustomControlProps) {
  const valueList = Array.isArray(value) ? value : []
  const labelByValue: Record<string, string> = {
    [badgeCurrentWindowValue]: 'Current Window',
    [badgeTotalValue]: 'All Windows'
  }
  return (
    <div className="badge-count-control">
      {(item.options ?? []).map((option) => {
        const optionValue = typeof option === 'string'
          ? option
          : String(option.value ?? option.id ?? '')
        const optionLabel = typeof option === 'string'
          ? labelByValue[option] ?? option
          : option.labelText ?? option.label ?? optionValue
        const isSelected = valueList.includes(optionValue)
        return (
          <button
            key={optionValue}
            type="button"
            className={`badge-count-button ${isSelected ? 'badge-count-button-selected' : ''}`}
            disabled={isDisabled}
            onClick={() => {
              const valueNext = isSelected
                ? valueList.filter((valueItem) => valueItem !== optionValue)
                : [...valueList, optionValue]
              onValueChange?.(valueNext)
            }}
          >
            {optionLabel}
          </button>
        )
      })}
    </div>
  )
}

function SnapshotListTabLabel({
  isActive,
  onClick
}: {
  isActive?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      className={`tab-on-top-btn snapshot-main-tab-button ${isActive ? 'active' : ''}`}
      onClick={onClick}
    >
      Snapshots
    </button>
  )
}

const RecoveryPanel = observer(function RecoveryPanel({ store }: { store: PopupStore }) {
  const snapshot = store.recoverySnapshot
  const calculatedSnapshot = store.recoveryCalculatedSnapshot
  const isBusy = store.isSnapshotBusy

  return (
    <div className="recovery-panel">
      <div className="recovery-action-row">
        <button
          type="button"
          className="recovery-button"
          disabled={isBusy}
          onClick={() => store.loadRecoverySource()}
        >
          Refresh source
        </button>
        <button
          type="button"
          className="recovery-button recovery-button-primary"
          disabled={isBusy || !snapshot || store.recoveryEventSequenceSelected === null}
          onClick={() => store.replayRecovery(store.recoveryEventSequenceSelected)}
        >
          Replay to selected step
        </button>
        <button
          type="button"
          className="recovery-button recovery-button-primary"
          disabled={isBusy || !snapshot}
          onClick={() => store.replayRecovery()}
        >
          Replay to last step
        </button>
      </div>

      <div className="recovery-source-grid">
        <div className="recovery-section">
          <div className="recovery-section-title">Last snapshot</div>
          {snapshot ? (
            <SnapshotOverview snapshot={snapshot} />
          ) : (
            <div className="recovery-empty">No complete snapshot is available.</div>
          )}
        </div>
        <div className="recovery-section">
          <div className="recovery-section-title">
            Events after snapshot
            <span className="recovery-count">{store.recoveryEvents.length}</span>
            {store.recoveryEventSequenceSelected !== null ? (
              <span className="recovery-count">
                Selected {store.recoveryEventSequenceSelected}
              </span>
            ) : null}
          </div>
          <div className="recovery-event-list">
            {store.recoveryEvents.length > 0 ? store.recoveryEvents.map((eventItem) => (
              <button
                type="button"
                className={`recovery-event-row ${
                  store.recoveryEventSequenceSelected === eventItem.eventSequence
                    ? 'recovery-event-row-selected'
                    : ''
                }`}
                key={eventItem.eventId ?? eventItem.eventSequence}
                aria-pressed={store.recoveryEventSequenceSelected === eventItem.eventSequence}
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
      </div>

      <div className="recovery-section">
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
        <div className="recovery-section-title">Calculated snapshot</div>
        {calculatedSnapshot ? (
          <SnapshotOverview snapshot={calculatedSnapshot} />
        ) : (
          <div className="recovery-empty">Replay recorded events to calculate a state to restore.</div>
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
            <span>Batch tabs</span>
          </label>
        </div>
      </div>
    </div>
  )
})

const RecoveryWorkspaceControl = observer(function RecoveryWorkspaceControl({
  value
}: ConfigCustomControlProps) {
  const store = value as PopupStore | null
  if (!store) return <div className="recovery-empty">Loading recovery data...</div>
  return <RecoveryPanel store={store} />
})

function SnapshotOverview({ snapshot }: { snapshot: SnapshotDetailData }) {
  return (
    <div className="recovery-overview">
      <div className="recovery-overview-summary">
        <span>{snapshot.snapshotGenerateAtText}</span>
        <span>{snapshot.windows.length} windows</span>
        <span>{snapshot.windows.reduce((count, windowItem) => count + windowItem.tabs.length, 0)} tabs</span>
      </div>
      <div className="recovery-window-list">
        {snapshot.windows.map((windowItem, windowIndex) => (
          <div className="recovery-window-row" key={windowItem.windowSourceId}>
            <span>Window {windowIndex + 1}</span>
            <span>{windowItem.tabs.length} tabs</span>
            <span className="recovery-window-preview">
              {windowItem.tabs.slice(0, 2).map((tab) => tab.title || tab.url || 'Untitled').join(', ')}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function formatDuration(minuteValue: number | null) {
  if (minuteValue === null) return 'Forever'
  const minuteRounded = Math.round(minuteValue)
  const day = Math.floor(minuteRounded / 1440)
  const hour = Math.floor((minuteRounded % 1440) / 60)
  const minute = minuteRounded % 60
  const parts: string[] = []
  if (day > 0) parts.push(`${day} ${day === 1 ? 'day' : 'days'}`)
  if (hour > 0) parts.push(`${hour} ${hour === 1 ? 'hour' : 'hours'}`)
  if (minute > 0 || parts.length === 0) {
    parts.push(`${minute} ${minute === 1 ? 'minute' : 'minutes'}`)
  }
  return parts.join(' ')
}

function formatEventType(eventType: string) {
  return eventType.replace(/([a-z])([A-Z])/g, '$1 $2')
}

function parseDuration(text: string) {
  const textNormalized = text.trim().toLowerCase()
  if (/^\d+(\.\d+)?$/.test(textNormalized)) return Number(textNormalized)
  const unitMinuteByName: Record<string, number> = {
    minute: 1,
    minutes: 1,
    hour: 60,
    hours: 60,
    day: 1440,
    days: 1440
  }
  let minuteTotal = 0
  let isMatched = false
  for (const match of textNormalized.matchAll(/(\d+(?:\.\d+)?)\s*(minutes?|hours?|days?)/g)) {
    minuteTotal += Number(match[1]) * unitMinuteByName[match[2]]
    isMatched = true
  }
  return isMatched && minuteTotal > 0 ? minuteTotal : null
}

function DurationEditor({
  minuteValue,
  isDisabled,
  onCommit
}: {
  minuteValue: number
  isDisabled: boolean
  onCommit: (minuteValue: number) => void
}) {
  const textValue = formatDuration(minuteValue)
  return (
    <div
      className={`duration-editor ${isDisabled ? 'duration-editor-disabled' : ''}`}
      contentEditable={!isDisabled}
      suppressContentEditableWarning
      role="textbox"
      title={`${minuteValue} minutes`}
      onBlur={(event) => {
        const minuteNext = parseDuration(event.currentTarget.textContent ?? '')
        if (minuteNext !== null) onCommit(minuteNext)
        event.currentTarget.textContent = formatDuration(minuteNext ?? minuteValue)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          event.currentTarget.blur()
        }
        if (event.key === 'Escape') {
          event.currentTarget.textContent = textValue
          event.currentTarget.blur()
        }
      }}
    >
      {textValue}
    </div>
  )
}

const RetentionPolicyControl = observer(function RetentionPolicyControl({
  value,
  isDisabled
}: ConfigCustomControlProps) {
  const store = value as PopupStore | null
  if (!store) return <div className="snapshot-workspace-loading">Loading cleaning policy...</div>
  const isLocked = isDisabled === true || store.isSnapshotBusy
  const tiers = store.snapshotConfig.retentionTiers
  const maintenance = store.snapshotMaintenance

  return (
    <div className="retention-panel">
      <div className="retention-tier-list">
        <div className="retention-tier-header">
          <div>Snapshot age up to</div>
          <div>Minimum spacing</div>
        </div>
        {tiers.map((tier, tierIndex) => (
          <div className="retention-tier-row" key={`${tier.ageMaxMinute}-${tierIndex}`}>
            {tier.ageMaxMinute === null ? (
              <div className="retention-tier-forever" title="No maximum age">Older</div>
            ) : (
              <DurationEditor
                minuteValue={tier.ageMaxMinute}
                isDisabled={isLocked}
                onCommit={(minuteNext) => {
                  store.updateSnapshotConfig({
                    retentionTiers: tiers.map((tierCurrent, indexCurrent) => (
                      indexCurrent === tierIndex
                        ? { ...tierCurrent, ageMaxMinute: minuteNext }
                        : tierCurrent
                    ))
                  })
                }}
              />
            )}
            <DurationEditor
              minuteValue={tier.spacingMinMinute}
              isDisabled={isLocked}
              onCommit={(minuteNext) => {
                store.updateSnapshotConfig({
                  retentionTiers: tiers.map((tierCurrent, indexCurrent) => (
                    indexCurrent === tierIndex
                      ? { ...tierCurrent, spacingMinMinute: minuteNext }
                      : tierCurrent
                  ))
                })
              }}
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        className="snapshot-clean-button"
        disabled={isLocked}
        onClick={() => store.cleanSnapshots()}
      >
        Run Cleaning Now
      </button>
      {maintenance.snapshotLastErrorText ? (
        <div className="snapshot-error-text">{maintenance.snapshotLastErrorText}</div>
      ) : null}
    </div>
  )
})

function NumValueConfigControl({
  value,
  isDisabled,
  onValueChange,
  unitText,
  min,
  max,
  step
}: ConfigCustomControlProps & {
  unitText: string
  min: number
  max: number
  step: number
}) {
  return (
    <NumValue
      data={{ value: Number(value) }}
      config={{
        min,
        max,
        step,
        isDisabled,
        unitText
      }}
      onEvent={(eventType, eventData) => {
        if (eventType === 'valueChangeAttempt') {
          onValueChange?.(Number(eventData.value))
        }
      }}
    />
  )
}

function UrlEventIntervalControl(props: ConfigCustomControlProps) {
  return (
    <NumValueConfigControl
      {...props}
      unitText="seconds"
      min={1}
      max={3600}
      step={1}
    />
  )
}

function SnapshotIntervalControl(props: ConfigCustomControlProps) {
  return (
    <NumValueConfigControl
      {...props}
      unitText="minutes"
      min={0.5}
      max={1440}
      step={0.5}
    />
  )
}

function CleanIntervalControl(props: ConfigCustomControlProps) {
  return (
    <NumValueConfigControl
      {...props}
      unitText="minutes"
      min={1}
      max={1440}
      step={1}
    />
  )
}

function StorageUsageControl({ value }: ConfigCustomControlProps) {
  const maintenance = (value ?? {}) as SnapshotMaintenance
  return (
    <div className={`snapshot-storage-usage ${maintenance.isStorageWarning ? 'snapshot-storage-warning' : ''}`}>
      <span>Snapshots {formatByteCount(Number(maintenance.snapshotStorageByte ?? 0))}</span>
      <span>Events {formatByteCount(Number(maintenance.eventStorageByte ?? 0))}</span>
      <span>Total {formatByteCount(Number(maintenance.storageTotalByte ?? 0))}</span>
    </div>
  )
}

const LocalStorageOverviewControl = observer(function LocalStorageOverviewControl({
  value,
  isDisabled
}: ConfigCustomControlProps) {
  const store = value as PopupStore | null
  if (!store) return <div className="local-storage-overview-loading">Loading storage usage...</div>
  const maintenance = store.snapshotMaintenance
  const snapshotCount = Number(maintenance.snapshotCount ?? store.snapshots.length)
  const eventCount = Number(maintenance.eventCount ?? 0)

  return (
    <div className="local-storage-overview">
      <div className="local-storage-overview-header">
        <div>Data</div>
        <div className="local-storage-overview-value">Stored items</div>
        <div className="local-storage-overview-value">Space used</div>
      </div>
      <div className="local-storage-overview-row">
        <div className="local-storage-overview-name">Snapshots</div>
        <div className="local-storage-overview-value">{formatItemCount(snapshotCount, 'snapshot')}</div>
        <div className="local-storage-overview-value">
          {formatByteCount(Number(maintenance.snapshotStorageByte ?? 0))}
        </div>
      </div>
      <div className="local-storage-overview-row">
        <div className="local-storage-overview-name">Events</div>
        <div className="local-storage-overview-value">{formatItemCount(eventCount, 'event')}</div>
        <div className="local-storage-overview-value">
          {formatByteCount(Number(maintenance.eventStorageByte ?? 0))}
        </div>
      </div>
      <div className="local-storage-overview-total">
        <div>Total extension local storage</div>
        <div className="local-storage-overview-value">
          {formatByteCount(Number(maintenance.storageTotalByte ?? 0))}
        </div>
      </div>
      <button
        type="button"
        className="local-storage-refresh-button"
        disabled={isDisabled === true || store.isSnapshotBusy}
        onClick={() => store.refreshSnapshotState(true)}
      >
        Refresh usage
      </button>
    </div>
  )
})

const SnapshotWorkspaceControl = observer(function SnapshotWorkspaceControl({
  value,
  isDisabled
}: ConfigCustomControlProps) {
  const store = value as PopupStore | null
  if (!store) return <div className="snapshot-workspace-loading">Loading snapshots...</div>
  const isBusy = isDisabled === true || store.isSnapshotBusy

  return (
    <div className="snapshot-workspace">
      <TabsOnTop
        defaultTab={store.snapshotTabActiveId}
        defaultKeepMounted={false}
        autoSwitchToNewTab={false}
        allowCloseTab
        onTabChange={store.setSnapshotTabActiveId}
        onTabClose={store.closeSnapshotDetailTab}
      >
        <TabsOnTopTabLabel>
          <SnapshotListTabLabel />
        </TabsOnTopTabLabel>
        <TabsOnTopTab tabKey="snapshot-list" label="Snapshots">
          <div className="snapshot-list-panel">
            <SnapshotList
              data={{
                snapshots: store.snapshots,
                snapshotIdsSelected: store.snapshotIdsSelected,
                buttonOffsetLeft: store.getButtonOffsetLeft('snapshot-list')
              }}
              config={{
                isBusy,
                bodyHeight: 168,
                colWidthById: store.getFolderColWidthById('snapshot-list')
              }}
              onEvent={(eventType, eventData) => {
                if (eventType === 'snapshotIdsSelectedChange') {
                  store.setSnapshotIdsSelected(
                    [...(eventData.snapshotIds as string[] ?? [])].map(String)
                  )
                }
                if (eventType === 'snapshotCreateAttempt') store.createSnapshot()
                if (eventType === 'snapshotPinToggleAttempt') {
                  store.toggleSnapshotsPinned(store.snapshotIdsSelected)
                }
                if (eventType === 'snapshotDeleteAttempt') {
                  store.deleteSnapshots(store.snapshotIdsSelected)
                }
                if (eventType === 'snapshotDetailOpenAttempt') {
                  store.openSnapshotDetail(eventData.snapshotId as string | undefined)
                }
                if (eventType === 'buttonOffsetChange') {
                  store.setButtonOffsetLeft('snapshot-list', Number(eventData.offsetLeft))
                }
                if (eventType === 'colWidthByIdChange') {
                  store.setFolderColWidthById(
                    'snapshot-list',
                    eventData.colWidthById as Record<string, number>
                  )
                }
              }}
            />
          </div>
        </TabsOnTopTab>
        {store.snapshotDetailIds.map((snapshotId) => {
          const snapshot = store.snapshotById.get(snapshotId) ?? null
          const metadata = store.snapshots.find((item) => item.snapshotId === snapshotId)
          return (
            <TabsOnTopTab
              key={snapshotId}
              tabKey={`snapshot:${snapshotId}`}
              label={metadata?.snapshotGenerateAtText ?? snapshotId}
            >
              {snapshot ? (
                <SnapshotView
                  data={{
                    snapshot,
                    windowSourceIdSelected:
                      store.windowSourceIdSelectedBySnapshotId.get(snapshotId) ?? null,
                    tabIdsSelected: store.getTabIdsSelected(snapshotId),
                    buttonOffsetLeft: store.getButtonOffsetLeft(`snapshot-detail:${snapshotId}`),
                    isBatchRestore: store.isBatchRestore
                  }}
                  config={{
                    isBusy,
                    bodyHeight: 220,
                    colWidthById: store.getFolderColWidthById(`snapshot-detail:${snapshotId}`)
                  }}
                  onEvent={(eventType, eventData) => {
                    if (eventType === 'windowSourceIdSelectedChange') {
                      store.setWindowSourceIdSelected(
                        snapshotId,
                        Number(eventData.windowSourceId)
                      )
                    }
                    if (eventType === 'tabIdsSelectedChange') {
                      store.setTabIdsSelected(
                        snapshotId,
                        [...(eventData.tabIds as string[] ?? [])].map(String)
                      )
                    }
                    if (eventType === 'snapshotRestoreAttempt') {
                      store.restoreSnapshot(snapshotId)
                    }
                    if (eventType === 'snapshotRestoreModeChange') {
                      store.setBatchRestore(Boolean(eventData.isBatchRestore))
                    }
                    if (eventType === 'snapshotDeleteAttempt') {
                      store.deleteSnapshots([snapshotId])
                    }
                    if (eventType === 'snapshotRefreshAttempt') {
                      store.refreshSnapshotDetail(snapshotId)
                    }
                    if (eventType === 'buttonOffsetChange') {
                      store.setButtonOffsetLeft(
                        `snapshot-detail:${snapshotId}`,
                        Number(eventData.offsetLeft)
                      )
                    }
                    if (eventType === 'colWidthByIdChange') {
                      store.setFolderColWidthById(
                        `snapshot-detail:${snapshotId}`,
                        eventData.colWidthById as Record<string, number>
                      )
                    }
                  }}
                />
              ) : (
                <div className="snapshot-detail-loading">Loading snapshot detail...</div>
              )}
            </TabsOnTopTab>
          )
        })}
      </TabsOnTop>
    </div>
  )
})

function formatByteCount(byteCount: number) {
  if (byteCount < 1024) return `${byteCount} B`
  if (byteCount < 1024 * 1024) return `${(byteCount / 1024).toFixed(1)} KiB`
  return `${(byteCount / 1024 / 1024).toFixed(1)} MiB`
}

function formatItemCount(itemCount: number, itemName: string) {
  return `${itemCount} ${itemName}${itemCount === 1 ? '' : 's'}`
}

const PopupConfigContent = observer(function PopupConfigContent({
  store
}: {
  store: PopupStore
}) {
  const settings = {
    enable_move_new_tab_next_to_current: store.isMoveNewTabNextToCurrentEnabled,
    badge_tab_counts: store.badgeTabCounts,
    localStorageOverview: store,
    isSnapshotEnabled: store.snapshotConfig.isSnapshotEnabled,
    isEventLogEnabled: store.snapshotConfig.isEventLogEnabled,
    snapshotIntervalMinute: store.snapshotConfig.snapshotIntervalMinute,
    cleanIntervalMinute: store.snapshotConfig.cleanIntervalMinute,
    isPrivateIncluded: store.snapshotConfig.isPrivateIncluded,
    isTabGroupIncluded: store.snapshotConfig.isTabGroupIncluded,
    isTabSelectionIncluded: store.snapshotConfig.isTabSelectionIncluded,
    tabUrlEventIntervalSecond: store.snapshotConfig.tabUrlEventIntervalSecond,
    storageWarningByte: store.snapshotConfig.storageWarningByte,
    storageUsage: store.snapshotMaintenance,
    snapshotWorkspace: store,
    snapshotCleaning: store,
    recoveryWorkspace: store
  }
  const configStruct = {
    activeSubtabId: store.configSubtabId,
    items: [
      {
        id: 'common_subtab',
        name: 'Common',
        type: 'subtab',
        children: [
          {
            id: 'tab_behavior',
            label: 'Tab Behavior',
            type: 'group',
            children: [
              {
                id: 'enable_move_new_tab_next_to_current',
                label: 'Open new tab next to current',
                description: 'New tabs open next to the current tab instead of at the end',
                type: 'boolean',
                defaultValue: true
              }
            ]
          },
          {
            id: 'badge_display',
            label: 'Badge Display',
            type: 'group',
            children: [
              {
                id: 'badge_tab_counts',
                label: 'Tab counts',
                description: 'Choose the tab numbers displayed on the extension icon',
                type: 'custom',
                compName: 'badgeTabCount',
                options: [badgeCurrentWindowValue, badgeTotalValue],
                defaultValue: [badgeCurrentWindowValue, badgeTotalValue]
              }
            ]
          },
          {
            id: 'local_storage',
            label: 'Local Storage',
            type: 'group',
            children: [
              {
                id: 'localStorageOverview',
                label: 'Storage usage',
                type: 'custom',
                compName: 'localStorageOverview',
                isFullWidth: true,
                defaultValue: null
              }
            ]
          }
        ]
      },
      {
        id: 'snapshot_subtab',
        name: 'Snapshots',
        type: 'subtab',
        children: [
          {
            id: 'snapshot_list_group',
            label: 'Snapshots',
            type: 'group',
            isFrameVisible: false,
            children: [
              {
                id: 'snapshotWorkspace',
                label: 'Snapshot workspace',
                type: 'custom',
                compName: 'snapshotWorkspace',
                isFullWidth: true,
                defaultValue: null
              }
            ]
          },
          {
            id: 'snapshot_automatic',
            label: 'Automatic capture',
            type: 'group',
            children: [
              {
                id: 'isSnapshotEnabled',
                label: 'Automatic snapshots',
                type: 'boolean',
                defaultValue: true
              },
              {
                id: 'snapshotIntervalMinute',
                label: 'Snapshot interval',
                description: 'Time between automatic snapshots',
                type: 'custom',
                compName: 'snapshotInterval',
                defaultValue: 5
              },
              {
                id: 'cleanIntervalMinute',
                label: 'Clean interval',
                description: 'Time between automatic snapshot cleaning runs',
                type: 'custom',
                compName: 'cleanInterval',
                defaultValue: 10
              },
              {
                id: 'isEventLogEnabled',
                label: 'Event logging',
                type: 'boolean',
                defaultValue: true
              },
              {
                id: 'tabUrlEventIntervalSecond',
                label: 'URL event interval',
                description: 'Minimum time between URL events for one tab',
                type: 'custom',
                compName: 'urlEventInterval',
                defaultValue: 10
              },
              {
                id: 'isPrivateIncluded',
                label: 'Include private windows',
                type: 'boolean',
                defaultValue: false
              },
              {
                id: 'isTabGroupIncluded',
                label: 'Include tab groups',
                type: 'boolean',
                defaultValue: true
              },
              {
                id: 'isTabSelectionIncluded',
                label: 'Include tab selection',
                type: 'boolean',
                defaultValue: true
              },
              {
                id: 'storageWarningByte',
                label: 'Snapshot warning size',
                description: 'Show a warning after this many bytes',
                type: 'number',
                defaultValue: 8388608
              },
              {
                id: 'storageUsage',
                label: 'Storage used',
                description: 'Local storage currently used by snapshots and events',
                type: 'custom',
                compName: 'storageUsage',
                defaultValue: null
              }
            ]
          },
          {
            id: 'snapshot_cleaning',
            label: 'Cleaning policy',
            type: 'group',
            children: [
              {
                id: 'snapshotCleaning',
                label: 'Cleaning policy',
                type: 'custom',
                compName: 'snapshotCleaning',
                isFullWidth: true,
                defaultValue: null
              }
            ]
          }
        ]
      },
      {
        id: 'restore_subtab',
        name: 'Restore',
        type: 'subtab',
        children: [
          {
            id: 'recovery_group',
            label: 'Restore last known state',
            type: 'group',
            isFrameVisible: false,
            children: [
              {
                id: 'recoveryWorkspace',
                label: 'Recovery workspace',
                type: 'custom',
                compName: 'recoveryWorkspace',
                isFullWidth: true,
                defaultValue: null
              }
            ]
          }
        ]
      }
    ],
    getComp: (compName: string) => {
      if (compName === 'badgeTabCount') return BadgeTabCountControl
      if (compName === 'localStorageOverview') return LocalStorageOverviewControl
      if (compName === 'snapshotInterval') return SnapshotIntervalControl
      if (compName === 'cleanInterval') return CleanIntervalControl
      if (compName === 'urlEventInterval') return UrlEventIntervalControl
      if (compName === 'storageUsage') return StorageUsageControl
      if (compName === 'snapshotWorkspace') return SnapshotWorkspaceControl
      if (compName === 'snapshotCleaning') return RetentionPolicyControl
      if (compName === 'recoveryWorkspace') return RecoveryWorkspaceControl
      return null
    }
  }

  const snapshotConfigKeys = new Set([
    'isSnapshotEnabled',
    'isEventLogEnabled',
    'snapshotIntervalMinute',
    'cleanIntervalMinute',
    'isPrivateIncluded',
    'isTabGroupIncluded',
    'isTabSelectionIncluded',
    'tabUrlEventIntervalSecond',
    'storageWarningByte'
  ])

  return (
    <ConfigPanel
      data={settings}
      config={configStruct}
      onEvent={(eventType, eventData) => {
        if (eventType === 'activeSubtabChange') {
          store.setConfigSubtabId(eventData.subtabId ?? 'common_subtab')
          return undefined
        }
        if (eventType !== 'valueChangeAttempt' && eventType !== 'valueDefaultSetAttempt') {
          return undefined
        }
        const valueId = eventData.valueId ?? ''
        if (snapshotConfigKeys.has(valueId)) {
          const value = (
            valueId === 'snapshotIntervalMinute' ||
            valueId === 'cleanIntervalMinute' ||
            valueId === 'tabUrlEventIntervalSecond' ||
            valueId === 'storageWarningByte'
          )
            ? Number(eventData.value)
            : Boolean(eventData.value)
          return store.updateSnapshotConfig({ [valueId]: value })
        }
        return store.updateCommonSetting(valueId, eventData.value)
      }}
    />
  )
})

const PopupPanel = observer(function PopupPanel({ store }: { store: PopupStore }) {
  return (
    <div className="popup-config-panel">
      <div className="popup-global-message">
        <MessageBar
          data={{
            messageState: store.snapshotMessageState,
            idleText: 'ready'
          }}
          config={{
            isPersistent: true,
            isOneLine: true,
            isBusy: store.isSnapshotBusy,
            heightSize: 'sm'
          }}
          onEvent={(eventType) => {
            if (eventType === 'dismissMessageRequest') {
              store.dismissSnapshotMessage()
            }
          }}
        />
      </div>
      <PopupConfigContent store={store} />
    </div>
  )
})

const App = observer(function App() {
  const [store] = useState(() => new PopupStore())

  useEffect(() => {
    store.initialize()
    return () => store.dispose()
  }, [store])

  return (
    <div className="popup-container">
      <div className="popup-header">
        <div className="popup-title">Tab Utils Settings</div>
      </div>
      {store.isLoading ? (
        <div className="loading">Loading...</div>
      ) : (
        <PopupPanel store={store} />
      )}
    </div>
  )
})

export default App
