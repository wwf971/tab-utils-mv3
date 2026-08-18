import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import {
  ConfigPanel,
  TabsOnTop,
  TabsOnTopTab,
  type ConfigCustomControlProps
} from '@wwf971/react-comp-misc'
import { RemoteStore } from './RemoteStore'

// Settings popup of the Remote tab: backend endpoint, login, and the aws-side
// integrity area (check / initialize / index repair). Built from the
// config-panel component series; all state lives in RemoteStore.
export const RemoteSettingsPanel = observer(function RemoteSettingsPanel({
  store
}: {
  store: RemoteStore
}) {
  const settings = {
    remote_endpoint_url: store.endpointUrl,
    loginControl: store,
    awsStatus: store
  }
  const [configStruct] = useState(() => ({
    items: [
      {
        id: 'remote_endpoint_group',
        label: 'Backend Endpoint',
        type: 'group',
        children: [
          {
            id: 'remote_endpoint_url',
            label: 'Endpoint URL',
            description: 'Base URL of the tab cloud backend, e.g. http://192.168.1.10:8300',
            type: 'string',
            defaultValue: ''
          },
          {
            id: 'loginControl',
            label: 'Account',
            type: 'custom',
            compName: 'loginControl',
            isFullWidth: true,
            defaultValue: null
          }
        ]
      },
      {
        id: 'remote_aws_group',
        label: 'Cloud Status',
        type: 'group',
        children: [
          {
            id: 'awsStatus',
            label: 'Cloud resources',
            type: 'custom',
            compName: 'awsStatus',
            isFullWidth: true,
            defaultValue: null
          }
        ]
      }
    ],
    getComp: (compName: string) => {
      if (compName === 'loginControl') return RemoteLoginControl
      if (compName === 'awsStatus') return RemoteAwsStatusControl
      return null
    }
  }))

  return (
    <div className="remote-settings-backdrop" onClick={() => store.setSettingsOpen(false)}>
      <div className="remote-settings-panel" onClick={(event) => event.stopPropagation()}>
        <div className="remote-settings-title">
          <span>Remote Settings</span>
          <button
            type="button"
            className="remote-settings-close"
            onClick={() => store.setSettingsOpen(false)}
          >
            Close
          </button>
        </div>
        <div className={`remote-settings-message tab-search-message-${store.settingsMessageStatus}`}>
          {store.settingsMessageText || 'Set the endpoint URL, then log in'}
        </div>
        <ConfigPanel
          data={settings}
          config={configStruct}
          onEvent={(eventType: string, eventData: Record<string, unknown>) => {
            if (eventType !== 'valueChangeAttempt' && eventType !== 'valueDefaultSetAttempt') {
              return undefined
            }
            const valueId = String(eventData.valueId ?? '')
            const value = String(eventData.value ?? '')
            if (valueId === 'remote_endpoint_url') return store.updateEndpointUrl(value)
            return { code: 0 }
          }}
        />
        {store.isLoginOpen ? <RemoteLoginPopup store={store} /> : null}
      </div>
    </div>
  )
})

const RemoteLoginControl = observer(function RemoteLoginControl({
  value
}: ConfigCustomControlProps) {
  const store = value as RemoteStore | null
  if (!store) return null
  const isBusy = store.settingsAction !== null
  return (
    <div className="remote-login-control">
      <div className="remote-login-state">
        {store.isLoggedIn ? `Logged in as ${store.userId}` : 'Not logged in'}
      </div>
      <div className="remote-login-buttons">
        {store.isLoggedIn ? (
          <button
            type="button"
            className="tab-search-control-button"
            disabled={isBusy}
            onClick={() => void store.logout()}
          >
            Logout
          </button>
        ) : (
          <button
            type="button"
            className="tab-search-control-button"
            disabled={isBusy}
            onClick={() => store.setLoginOpen(true)}
          >
            Login
          </button>
        )}
      </div>
    </div>
  )
})

const RemoteLoginPopup = observer(function RemoteLoginPopup({
  store
}: {
  store: RemoteStore
}) {
  const isBusy = store.settingsAction !== null
  return (
    <div className="remote-login-backdrop" onClick={() => store.setLoginOpen(false)}>
      <form
        className="remote-login-popup"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          void store.login()
        }}
      >
        <div className="remote-login-popup-title">Log in to Tab Cloud</div>
        <label className="remote-login-field">
          <span>Username</span>
          <input
            type="text"
            className="remote-login-input"
            value={store.settingsUsername}
            disabled={isBusy}
            autoFocus
            onChange={(event) => store.setSettingsUsername(event.currentTarget.value)}
          />
        </label>
        <label className="remote-login-field">
          <span>Password</span>
          <input
            type="password"
            className="remote-login-input"
            value={store.settingsPassword}
            disabled={isBusy}
            onChange={(event) => store.setSettingsPassword(event.currentTarget.value)}
          />
        </label>
        <div className="remote-login-buttons">
          <button
            type="submit"
            className="tab-search-control-button"
            disabled={isBusy || !store.settingsUsername || !store.settingsPassword}
          >
            Login
          </button>
          <button
            type="button"
            className="tab-search-control-button"
            disabled={isBusy}
            onClick={() => store.setLoginOpen(false)}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
})

const RemoteAwsStatusControl = observer(function RemoteAwsStatusControl({
  value
}: ConfigCustomControlProps) {
  const store = value as RemoteStore | null
  if (!store) return null
  const isBusy = store.settingsAction !== null
  const status = store.statusData
  return (
    <div className="remote-aws-status">
      <div className="remote-aws-status-row">
        <span>Backend</span>
        <span className={status ? 'remote-aws-ok' : 'remote-aws-bad'}>
          {status ? 'reachable' : 'unreachable'}
        </span>
        <span>DynamoDB</span>
        <span className={status?.isDbOk ? 'remote-aws-ok' : 'remote-aws-bad'}>
          {status?.isDbOk ? 'ok' : 'not ok'}
        </span>
        <span>Search index</span>
        <span className={status?.isIndexOk ? 'remote-aws-ok' : 'remote-aws-bad'}>
          {status?.isIndexOk ? 'ok' : 'not ok'}
        </span>
      </div>
      {status && !status.isDbOk ? (
        <div className="remote-cloud-error">
          <span className="remote-cloud-error-label">DynamoDB:</span>
          <span>{status.dbMessage || 'not ready'}</span>
        </div>
      ) : null}
      {status && !status.isIndexOk ? (
        <div className="remote-cloud-error">
          <span className="remote-cloud-error-label">Index:</span>
          <span>{status.indexMessage || 'missing'}</span>
        </div>
      ) : null}
      <div className="remote-login-buttons">
        <button
          type="button"
          className="tab-search-control-button"
          disabled={isBusy}
          onClick={() => void store.statusFetch()}
        >
          Refresh Status
        </button>
      </div>
      <div className={`remote-upload-readiness ${
        store.isUploadAllowed ? 'remote-aws-ok' : 'remote-aws-bad'
      }`}>
        Upload: {store.isUploadAllowed ? 'allowed' : `blocked — ${store.uploadBlockReason}`}
      </div>
      <TabsOnTop
        defaultTab={store.settingsCloudTabId}
        defaultKeepMounted={false}
        onTabChange={store.setSettingsCloudTabId}
      >
        <TabsOnTopTab tabKey="tables" label="DynamoDB Tables">
          <RemoteTableStatus store={store} />
        </TabsOnTopTab>
        <TabsOnTopTab tabKey="index" label="Search Index">
          <RemoteIndexStatus store={store} />
        </TabsOnTopTab>
        <TabsOnTopTab tabKey="history" label="Check History">
          <RemoteCheckHistory store={store} />
        </TabsOnTopTab>
      </TabsOnTop>
    </div>
  )
})

const RemoteTableStatus = observer(function RemoteTableStatus({
  store
}: {
  store: RemoteStore
}) {
  const isBusy = store.settingsAction !== null
  const tableList = store.awsCheckData?.tableList ?? []
  return (
    <div className="remote-cloud-tab-panel">
      <div className="remote-login-buttons">
        <button
          type="button"
          className="tab-search-control-button"
          disabled={isBusy || !store.isLoggedIn}
          onClick={() => void store.tableCheck()}
        >
          Check Tables
        </button>
        <button
          type="button"
          className="tab-search-control-button"
          disabled={isBusy || !store.isLoggedIn}
          onClick={() => void store.tableInit()}
        >
          Initialize Missing Tables
        </button>
      </div>
      {tableList.length > 0 ? (
        <div className="remote-aws-table">
          {tableList.map((tableItem) => (
            <div className="remote-cloud-resource" key={tableItem.tableName}>
              <div className="remote-aws-table-row">
                <span className="remote-aws-table-name">{tableItem.tableName}</span>
                <span className={tableItem.isReady ? 'remote-aws-ok' : 'remote-aws-bad'}>
                  {tableItem.statusText}
                  {tableItem.isExisting && !tableItem.isConfigConsistent ? ' / CONFIG DIFFERS' : ''}
                </span>
              </div>
              {tableItem.configIssueList.map((issue) => (
                <div className="remote-config-issue" key={issue}>{issue}</div>
              ))}
            </div>
          ))}
          <div className="remote-aws-table-row">
            <span>Pending index journals</span>
            <span>{store.awsCheckData?.journalPendingCount ?? '-'}</span>
          </div>
        </div>
      ) : (
        <div className="remote-cloud-empty">Run Check Tables to load table information.</div>
      )}
    </div>
  )
})

const RemoteIndexStatus = observer(function RemoteIndexStatus({
  store
}: {
  store: RemoteStore
}) {
  const isBusy = store.settingsAction !== null
  const index = store.awsCheckData?.index
  return (
    <div className="remote-cloud-tab-panel">
      <div className="remote-login-buttons">
        <button
          type="button"
          className="tab-search-control-button"
          disabled={isBusy || !store.isLoggedIn}
          onClick={() => void store.indexCheck()}
        >
          Check Index
        </button>
        <button
          type="button"
          className="tab-search-control-button"
          disabled={isBusy || !store.isLoggedIn || index?.isExisting === true}
          onClick={() => void store.indexInit()}
        >
          Initialize Missing Index
        </button>
        <button
          type="button"
          className="tab-search-control-button"
          disabled={isBusy || !store.isLoggedIn}
          onClick={() => store.requestIndexRecreate()}
        >
          Recreate Index
        </button>
        <button
          type="button"
          className="tab-search-control-button"
          disabled={isBusy || !store.isLoggedIn || index?.isExisting !== true}
          onClick={() => void store.indexRepair()}
        >
          Repair Pending Writes
        </button>
        <button
          type="button"
          className="tab-search-control-button"
          disabled={isBusy || !store.isLoggedIn || index?.isExisting !== true}
          onClick={() => void store.indexRebuild()}
        >
          Rebuild My Documents
        </button>
      </div>
      {store.isIndexRecreateConfirmOpen ? (
        <div className="remote-index-confirm">
          <div>
            Recreating deletes {store.indexRecreateDocumentCount ?? 'the existing'} indexed
            document(s). DynamoDB data is not deleted.
          </div>
          <div className="remote-login-buttons">
            <button
              type="button"
              className="tab-search-control-button remote-destructive-button"
              disabled={isBusy}
              onClick={() => void store.indexRecreate(true)}
            >
              Confirm Recreate
            </button>
            <button
              type="button"
              className="tab-search-control-button"
              disabled={isBusy}
              onClick={() => store.cancelIndexRecreate()}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {index ? (
        <div className="remote-aws-table">
          <div className="remote-aws-table-row">
            <span className="remote-aws-table-name">{index.indexName}</span>
            <span className={index.isExisting ? 'remote-aws-ok' : 'remote-aws-bad'}>
              {index.isExisting ? 'EXISTS' : 'MISSING'}
            </span>
          </div>
          <div className="remote-aws-table-row">
            <span>Configuration</span>
            <span className={index.isConfigConsistent ? 'remote-aws-ok' : 'remote-aws-bad'}>
              {index.isConfigConsistent === null
                ? '-'
                : index.isConfigConsistent ? 'CONSISTENT' : 'DIFFERS'}
            </span>
          </div>
          <div className="remote-aws-table-row">
            <span>Indexed documents</span>
            <span>{index.documentCount ?? '-'}</span>
          </div>
          {index.message ? <div className="remote-config-issue">{index.message}</div> : null}
          {index.configIssueList.map((issue) => (
            <div className="remote-config-issue" key={issue}>{issue}</div>
          ))}
        </div>
      ) : (
        <div className="remote-cloud-empty">Run Check Index to load index information.</div>
      )}
    </div>
  )
})

const RemoteCheckHistory = observer(function RemoteCheckHistory({
  store
}: {
  store: RemoteStore
}) {
  const checkList = store.configCheckHistory?.checkList ?? []
  return (
    <div className="remote-cloud-tab-panel">
      <div className="remote-login-buttons">
        <button
          type="button"
          className="tab-search-control-button"
          disabled={!store.isLoggedIn}
          onClick={() => void store.configCheckHistoryFetch()}
        >
          Refresh History
        </button>
      </div>
      {checkList.length > 0 ? (
        <div className="remote-check-history">
          {checkList.map((record) => (
            <div className="remote-check-history-row" key={record.checkId}>
              <span>{record.checkType === 'dynamodbTables' ? 'DynamoDB tables' : 'Search index'}</span>
              <span className={record.isPassed ? 'remote-aws-ok' : 'remote-aws-bad'}>
                {record.isPassed ? 'PASSED' : 'FAILED'}
              </span>
              <span>{formatCheckTime(record.checkAtMs)}</span>
              <span>{record.trigger}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="remote-cloud-empty">No cached configuration checks.</div>
      )}
    </div>
  )
})

function formatCheckTime(timeMs: number) {
  if (!Number.isFinite(timeMs)) return '-'
  return new Date(timeMs).toLocaleString()
}
