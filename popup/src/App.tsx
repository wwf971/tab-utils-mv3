import { useState, useEffect } from 'react'
import './App.css'

interface Settings {
  enable_move_new_tab_next_to_current: boolean
}

function App() {
  const [settings, displaySettings] = useState<Settings>({
    enable_move_new_tab_next_to_current: true
  })
  const [loading, setLoading] = useState(true)

  // Load settings from chrome.storage on mount
  useEffect(() => {
    if (chrome?.storage?.sync) {
      chrome.storage.sync.get(['enable_move_new_tab_next_to_current'], (result) => {
        displaySettings({
          enable_move_new_tab_next_to_current: result.enable_move_new_tab_next_to_current ?? true
        })
        setLoading(false)
      })
    } else {
      // Fallback for dev environment
      setLoading(false)
    }
  }, [])

  // Update setting - background script handles storage
  const updateSetting = async () => {
    const newValue = !settings.enable_move_new_tab_next_to_current
    
    // Update local state immediately for responsive UI
    displaySettings({
      enable_move_new_tab_next_to_current: newValue
    })

    // Send to background script - it will handle storage
    if (chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        action: 'updateSettings',
        settings: { enable_move_new_tab_next_to_current: newValue }
      })
    }
  }

  if (loading) {
    return (
      <div className="popup-container">
        <div className="loading">Loading...</div>
      </div>
    )
  }

  return (
    <div className="popup-container">
      <header className="popup-header">
        <h1>Tab Utils Settings</h1>
      </header>
      
      <div className="settings-list">
        <div className="setting-item">
          <div className="setting-info">
            <div className="setting-title">Open new tab next to current</div>
            <div className="setting-description">
              New tabs open next to the current tab instead of at the end
            </div>
          </div>
          
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={settings.enable_move_new_tab_next_to_current}
              onChange={updateSetting}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>
      </div>
    </div>
  )
}

export default App

