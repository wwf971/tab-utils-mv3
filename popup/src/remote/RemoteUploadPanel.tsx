import { observer } from 'mobx-react-lite'
import { FolderView } from '@wwf971/react-comp-misc'
import { TabItem, type TabItemStatus } from '@wwf971/tab-manage-frontend-common'
import { PopupStore } from '../PopupStore'
import { RemoteWindowSelect } from './RemoteWindowSelect'
import './RemoteUploadPanel.css'

// Confirm popup of one upload from the local Search tab: listed tabs go to a
// remote window one by one. A failed tab does not block the remaining tabs,
// and a tab is closed right after its own upload is confirmed when the
// checkbox is on. Clicking the backdrop closes the popup when idle; while the
// run is active the popup stays open and only Stop stays usable, which
// breaks the run after the current tab completes.
export const RemoteUploadPanel = observer(function RemoteUploadPanel({
  store
}: {
  store: PopupStore
}) {
  const remote = store.remote
  const panel = remote.uploadPanel
  if (!panel) return null
  const isBusy = panel.isApplying
  const progress = remote.uploadProgress
  const countToUpload = panel.tabList.filter((tab) => tab.status !== 'success').length

  const rows = panel.tabList.map((tab) => ({
    id: String(tab.tabSourceId),
    rowClassName: tab.status === 'fail'
      ? 'remote-upload-row-fail'
      : tab.status === 'success' ? 'remote-upload-row-success' : '',
    data: {
      tab: {
        id: String(tab.tabSourceId),
        title: tab.title,
        url: tab.url,
        status: tab.status,
        errorText: tab.errorText
      }
    }
  }))

  return (
    <div
      className="remote-upload-backdrop"
      onClick={() => {
        if (!isBusy) remote.closeUploadPanel()
      }}
    >
      <div
        className="remote-upload-panel"
        onClick={(event) => event.stopPropagation()}
      >
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
          <span className="remote-upload-option-label">
            Close each uploaded tab after its upload is confirmed
          </span>
        </div>

        {progress !== null && (isBusy || progress.countDone > 0) ? (
          <div className="remote-upload-progress">
            {isBusy
              ? `Uploading ${Math.min(progress.countDone + 1, progress.countTotal)}/${progress.countTotal}...`
              : `Processed ${progress.countDone}/${progress.countTotal}.`}
            {' '}
            {progress.countSuccess} uploaded, {progress.countFail} failed
          </div>
        ) : null}

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
            disabled={isBusy || countToUpload === 0}
            onClick={() => void store.applyRemoteUpload()}
          >
            {isBusy
              ? 'Uploading...'
              : countToUpload < panel.tabList.length
                ? `Retry Failed (${countToUpload})`
                : `Upload (${countToUpload})`}
          </button>
          {isBusy ? (
            <button
              type="button"
              className="tab-search-control-button"
              disabled={panel.isStopRequested}
              onClick={() => remote.requestUploadStop()}
            >
              {panel.isStopRequested ? 'Stopping...' : 'Stop'}
            </button>
          ) : null}
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
    </div>
  )
})

function UploadTabCell({
  data
}: {
  data?: {
    id: string
    title: string
    url: string
    status: 'pending' | 'uploading' | 'success' | 'fail'
    errorText: string
  }
}) {
  if (!data) return null
  const statuses: TabItemStatus[] = [
    {
      id: 'uploading',
      labelText: 'Uploading',
      tone: 'info',
      isVisible: data.status === 'uploading'
    },
    {
      id: 'uploaded',
      labelText: 'Uploaded',
      tone: 'success',
      isVisible: data.status === 'success'
    },
    {
      id: 'fail',
      labelText: data.errorText ? `Failed: ${data.errorText}` : 'Failed',
      tone: 'danger',
      isVisible: data.status === 'fail'
    }
  ]
  return (
    <TabItem
      data={{
        id: data.id,
        title: data.title || 'Untitled tab',
        url: data.url,
        matchTexts: [],
        statuses
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
