import { observer } from 'mobx-react-lite'
import { FileIcon, RefreshIcon } from '@wwf971/react-comp-misc'
import { TabItem } from '@wwf971/tab-manage-frontend-common'
import { PopupStore } from './PopupStore'
import './CurrentTabPanel.css'

// The 'Current Tab' panel mode of the Search tab: shows only the currently
// active tab and uploads it to remote with tags. The upload button opens the
// shared upload panel (RemoteUploadPanel) prefilled with this tab; the tags
// and the target window are picked there. Refer to /doc/tab_ops.md.
export const CurrentTabPanel = observer(function CurrentTabPanel({
  store
}: {
  store: PopupStore
}) {
  const tab = store.tabCurrentActive
  const remote = store.remote

  return (
    <div className="current-tab-panel">
      <div className="current-tab-header">
        <span className="current-tab-header-text">Currently active tab</span>
        <span
          className="current-tab-refresh"
          title="Refresh"
          onClick={() => void store.loadTabCurrentActive()}
        >
          <RefreshIcon />
        </span>
      </div>

      {store.isTabCurrentLoading ? (
        <div className="current-tab-empty">Loading the active tab...</div>
      ) : tab === null ? (
        <div className="current-tab-empty">No active tab found</div>
      ) : (
        <div className="current-tab-item">
          <TabItem
            data={{
              id: String(tab.tabSourceId),
              icon: tab.favIconUrl
                ? <img className="tab-item-icon-image" src={tab.favIconUrl} alt="" />
                : <FileIcon />,
              title: tab.title || 'Untitled tab',
              url: tab.url,
              matchTexts: [],
              statuses: []
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
        </div>
      )}

      <div className="current-tab-actions">
        <button
          type="button"
          className="tab-search-control-button"
          disabled={tab === null || !remote.isLoggedIn || remote.uploadPanel !== null}
          onClick={() => store.openRemoteUploadForCurrentTab()}
        >
          Upload to Remote with Tags...
        </button>
      </div>
      {!remote.isLoggedIn ? (
        <div className="current-tab-note">Log in to Tab Cloud before uploading</div>
      ) : null}
    </div>
  )
})
