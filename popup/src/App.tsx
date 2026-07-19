import { useState, useEffect } from 'react'
import {
  ConfigPanel,
  type ConfigCustomControlProps
} from '@wwf971/react-comp-misc'
import './App.css'

const badgeCurrentWindowValue = 'currentWindow'
const badgeTotalValue = 'total'

interface Settings extends Record<string, unknown> {
  enable_move_new_tab_next_to_current: boolean
  badge_tab_counts: string[]
}

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

const configStruct = {
  items: [
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
    }
  ],
  getComp: (compName: string) => (
    compName === 'badgeTabCount' ? BadgeTabCountControl : null
  )
}

function App() {
  const [settings, displaySettings] = useState<Settings>({
    enable_move_new_tab_next_to_current: true,
    badge_tab_counts: [badgeCurrentWindowValue, badgeTotalValue]
  })
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    if (chrome?.storage?.sync) {
      chrome.storage.sync.get([
        'enable_move_new_tab_next_to_current',
        'enable_badge_show_current_window_tab_count',
        'enable_badge_show_total_tab_count'
      ], (result) => {
        const badgeTabCounts: string[] = []
        if (result.enable_badge_show_current_window_tab_count ?? true) {
          badgeTabCounts.push(badgeCurrentWindowValue)
        }
        if (result.enable_badge_show_total_tab_count ?? true) {
          badgeTabCounts.push(badgeTotalValue)
        }
        displaySettings({
          enable_move_new_tab_next_to_current: result.enable_move_new_tab_next_to_current ?? true,
          badge_tab_counts: badgeTabCounts
        })
        setIsLoading(false)
      })
    } else {
      setIsLoading(false)
    }
  }, [])

  const updateSetting = async (valueId: string, valueNext: unknown) => {
    if (valueId === 'enable_move_new_tab_next_to_current') {
      const isEnabledNext = Boolean(valueNext)
      displaySettings((settingsCurrent) => ({
        ...settingsCurrent,
        enable_move_new_tab_next_to_current: isEnabledNext
      }))
      if (chrome?.runtime?.sendMessage) {
        chrome.runtime.sendMessage({
          action: 'updateSettings',
          settings: { enable_move_new_tab_next_to_current: isEnabledNext }
        })
      }
      return
    }

    if (valueId === 'badge_tab_counts') {
      const valueList = Array.isArray(valueNext) ? valueNext : []
      displaySettings((settingsCurrent) => ({
        ...settingsCurrent,
        badge_tab_counts: valueList
      }))
      if (chrome?.runtime?.sendMessage) {
        chrome.runtime.sendMessage({
          action: 'updateSettings',
          settings: {
            enable_badge_show_current_window_tab_count: valueList.includes(badgeCurrentWindowValue),
            enable_badge_show_total_tab_count: valueList.includes(badgeTotalValue)
          }
        })
      }
    }
  }

  if (isLoading) {
    return (
      <div className="popup-container">
        <div className="loading">Loading...</div>
      </div>
    )
  }

  return (
    <div className="popup-container">
      <header className="popup-header">
        <div className="popup-title">Tab Utils Settings</div>
      </header>
      <div className="popup-config-panel">
        <ConfigPanel
          data={settings}
          config={configStruct}
          onEvent={(eventType, eventData) => {
            if (eventType === 'valueChangeAttempt' || eventType === 'valueDefaultSetAttempt') {
              return updateSetting(eventData.valueId ?? '', eventData.value)
            }
            return undefined
          }}
        />
      </div>
    </div>
  )
}

export default App

