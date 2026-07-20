import React from 'react'
import ReactDOM from 'react-dom/client'
import {
  ExtensionDevPage,
  installExtensionBrowserMock,
  type ExtensionDevSurface
} from '@wwf971/tab-manage-frontend-common'
import App from '../App'
import './dev.css'

installExtensionBrowserMock({
  storageValues: {
    enable_move_new_tab_next_to_current: true,
    enable_badge_show_current_window_tab_count: true,
    enable_badge_show_total_tab_count: true
  }
})

const surfaces: ExtensionDevSurface[] = [
  {
    id: 'popup',
    label: 'Popup',
    description: 'Deployed extension popup at 620px width',
    preset: 'popup-620',
    content: <App />
  }
]

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ExtensionDevPage title="Tab Utils" surfaces={surfaces} />
  </React.StrictMode>
)
