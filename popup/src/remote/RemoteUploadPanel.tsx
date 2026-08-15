import { observer } from 'mobx-react-lite'
import { FolderView } from '@wwf971/react-comp-misc'
import { TabItem } from '@wwf971/tab-manage-frontend-common'
import { PopupStore } from '../PopupStore'
import { RemoteWindowSelect } from './RemoteWindowSelect'
import './RemoteUploadPanel.css'

// Inline panel in the local Search tab (same pattern as the bring-tabs panel):
// upload the listed local tabs to a remote window in one backend transaction,
// and close them locally on confirmed success when the checkbox is on.
export const RemoteUploadPanel = observer(function RemoteUploadPanel({
  store
}: {
  store: PopupStore
}) {
  const remote = store.remote
  const panel = remote.uploadPanel
  if (!panel) return null
  const isBusy = panel.isApplying

  const rows = panel.tabList.map((tab) => ({
    id: String(tab.tabSourceId),
    data: {
      tab: {
        id: String(tab.tabSourceId),
        title: tab.title,
        url: tab.url
      }
    }
  }))

  return (
    <div className="remote-upload-panel">
      <div className="remote-upload-title">
        Upload {panel.tabList.length} tab(s) from {panel.sourceText} to remote
      </div>

      <div className="remote-upload-target">
        <span className="remote-upload-target-label">Target window</span>
        <RemoteWindowSelect
          store={remote}
          selectorId="upload-target"
          windowIdSelected={panel.windowIdSelected}
          emptyText="default remote window"
          isDisabled={isBusy}
          onEvent={(eventType, eventData) => {
            if (eventType === 'windowPick') {
              remote.setUploadWindowId((eventData.windowId as string | null) ?? null)
            }
          }}
        />
      </div>

      <div
        className={`remote-upload-option ${isBusy ? 'remote-upload-option-disabled' : ''}`}
        onClick={() => {
          if (!isBusy) remote.setUploadCloseOnSuccess(!panel.isCloseOnSuccess)
        }}
      >
        <span
          className={`tab-bring-check ${panel.isCloseOnSuccess ? 'tab-bring-check-checked' : ''}`}
        >
          {panel.isCloseOnSuccess ? (
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
        <span>Close uploaded tabs after success is confirmed</span>
      </div>

      <div className="remote-upload-results tab-search-results">
        <FolderView
          data={{
            columns: {
              tab: { data: 'Tabs to upload', align: 'left' }
            },
            colsOrder: ['tab'],
            rows,
            rowIdsSelected: [],
            viewCurrent: 'list',
            statusBar: { itemCount: panel.tabList.length, messageState: null }
          }}
          config={{
            bodyHeight: 140,
            colSizeById: {
              tab: { width: 560, minWidth: 140, resizable: false }
            },
            isLastColFilled: true,
            isListOnly: true,
            isStatusBarVisible: false,
            isLocked: isBusy,
            isRowReorderAllowed: false,
            selectionMode: 'none',
            compBodyByColId: (colId: string) => (
              colId === 'tab' ? UploadTabCell : undefined
            )
          }}
          onEvent={() => ({ code: 0 })}
        />
      </div>

      <div className="remote-upload-actions">
        <button
          type="button"
          className="tab-search-control-button"
          disabled={isBusy || panel.tabList.length === 0}
          onClick={() => void store.applyRemoteUpload()}
        >
          {isBusy ? 'Uploading...' : `Upload (${panel.tabList.length})`}
        </button>
        <button
          type="button"
          className="tab-search-control-button"
          disabled={isBusy}
          onClick={() => remote.closeUploadPanel()}
        >
          Cancel
        </button>
      </div>
    </div>
  )
})

function UploadTabCell({
  data
}: {
  data?: { id: string, title: string, url: string }
}) {
  if (!data) return null
  return (
    <TabItem
      data={{
        id: data.id,
        title: data.title || 'Untitled tab',
        url: data.url,
        matchTexts: [],
        statuses: []
      }}
      config={{
        layoutMode: 'list',
        sizeMode: 'compact',
        responsiveMode: 'container',
        isIconVisible: false,
        isCloseVisible: false,
        isCloseEnabled: false
      }}
    />
  )
}
