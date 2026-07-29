import {
  useEffect,
  useRef,
  useState
} from 'react'
import {
  TabItem,
  type TabItemConfig,
  type TabItemData
} from '@wwf971/tab-manage-frontend-common'
import './tabItemExamples.css'

const SEARCH_DELAY_MS = 180

const itemsExample: TabItemData[] = [
  {
    id: 'tab-google',
    icon: <img className="tab-item-icon-image" src="https://www.google.com/favicon.ico" alt="" />,
    title: 'Google Search Console performance report',
    url: 'https://search.google.com/search-console/performance/search-analytics',
    statuses: [
      { id: 'active', labelText: 'Active', tone: 'info' },
      { id: 'selected', labelText: 'Selected', tone: 'neutral' }
    ]
  },
  {
    id: 'tab-youtube',
    icon: <img className="tab-item-icon-image" src="https://www.youtube.com/favicon.ico" alt="" />,
    title: 'YouTube music playlist for focused work',
    url: 'https://www.youtube.com/playlist?list=PL-example-focused-work',
    statuses: [
      { id: 'local', labelText: 'Closed, saved locally', tone: 'success' }
    ]
  },
  {
    id: 'tab-x',
    icon: <img className="tab-item-icon-image" src="https://x.com/favicon.ico" alt="" />,
    title: 'X developer platform API documentation',
    url: 'https://developer.x.com/en/docs/x-api',
    statuses: [
      { id: 'remote', labelText: 'Closed, uploaded', tone: 'warning' }
    ]
  },
  {
    id: 'tab-github',
    icon: <img className="tab-item-icon-image" src="https://github.com/favicon.ico" alt="" />,
    title: 'GitHub pull request review checklist',
    url: 'https://github.com/example/tab-utils/pull/24',
    statuses: [
      { id: 'selected', labelText: 'Selected', tone: 'neutral' }
    ]
  },
  {
    id: 'tab-mdn',
    icon: <img className="tab-item-icon-image" src="https://developer.mozilla.org/favicon.ico" alt="" />,
    title: 'MDN Web Docs tabs API reference',
    url: 'https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/API/tabs',
    statuses: []
  }
]

const itemExample = itemsExample[0] as TabItemData
const itemIdsExample = itemsExample.map((item) => item.id)

export function TabItemExamples() {
  const [eventText, setEventText] = useState('No close attempt')
  const [searchTextInput, setSearchTextInput] = useState('')
  const [searchTextCommitted, setSearchTextCommitted] = useState('')
  const searchFieldRef = useRef<HTMLDivElement>(null)
  const searchTimeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchTokenRef = useRef(0)
  const configList: TabItemConfig = {
    layoutMode: 'list',
    sizeMode: 'compact',
    responsiveMode: 'container',
    isIconVisible: true,
    isCloseVisible: true,
    isCloseEnabled: true
  }
  const matchTexts = searchTextCommitted ? [searchTextCommitted] : []

  useEffect(() => {
    return () => {
      if (searchTimeoutIdRef.current !== null) {
        clearTimeout(searchTimeoutIdRef.current)
      }
    }
  }, [])

  function queueSearchCommit(searchTextNext: string) {
    setSearchTextInput(searchTextNext)
    const searchToken = searchTokenRef.current + 1
    searchTokenRef.current = searchToken
    if (searchTimeoutIdRef.current !== null) {
      clearTimeout(searchTimeoutIdRef.current)
    }
    searchTimeoutIdRef.current = setTimeout(() => {
      searchTimeoutIdRef.current = null
      if (searchToken !== searchTokenRef.current) return
      setSearchTextCommitted(searchTextNext.trim())
    }, SEARCH_DELAY_MS)
  }

  return (
    <div className="tab-item-examples">
      <div className="tab-item-example-intro">
        The close control stays fixed. Hover the content area and use the mouse wheel when text extends beyond the available width.
      </div>

      <div className="tab-item-example-section">
        <div className="tab-item-example-title">List layout at three widths</div>
        <div className="tab-item-example-width-wide">
          <TabItem
            data={itemExample}
            config={configList}
            onEvent={(eventType) => setEventText(eventType)}
          />
        </div>
        <div className="tab-item-example-width-medium">
          <TabItem data={itemExample} config={configList} />
        </div>
        <div className="tab-item-example-width-narrow">
          <TabItem data={itemExample} config={configList} />
        </div>
        <div className="tab-item-example-event">{eventText}</div>
      </div>

      <div className="tab-item-example-section">
        <div className="tab-item-example-title">Configured fields and status filters</div>
        <TabItem
          data={itemsExample[1] as TabItemData}
          config={{
            layoutMode: 'list',
            sizeMode: 'compact',
            textOrder: ['url', 'title'],
            statusIdsVisible: ['active', 'local'],
            isIconVisible: false,
            isCloseVisible: false
          }}
        />
      </div>

      <div className="tab-item-example-section">
        <div className="tab-item-example-title">Search highlight</div>
        <div
          ref={searchFieldRef}
          className={`tab-item-example-search-field ${searchTextInput ? '' : 'tab-item-example-search-field-empty'}`}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          role="textbox"
          data-placeholder="Search title or URL"
          onInput={(event) => {
            queueSearchCommit(event.currentTarget.textContent ?? '')
          }}
        />
        <div className="tab-item-example-search-list">
          {itemIdsExample.map((itemId) => {
            const item = itemsExample.find((entry) => entry.id === itemId)
            if (!item) return null
            return (
              <TabItem
                data={{
                  ...item,
                  matchTexts
                }}
                config={{
                  layoutMode: 'list',
                  sizeMode: 'compact',
                  isIconVisible: true,
                  isCloseVisible: true,
                  isCloseEnabled: true
                }}
                key={itemId}
              />
            )
          })}
        </div>
      </div>

      <div className="tab-item-example-section">
        <div className="tab-item-example-title">Grid layout with responsive cells</div>
        <div className="tab-item-example-grid">
          {Array.from({ length: 8 }, (_, index) => (
            <TabItem
              data={{
                ...(itemsExample[index % itemsExample.length] as TabItemData),
                id: `tab-grid-${index}`
              }}
              config={{
                layoutMode: 'grid',
                sizeMode: 'compact',
                responsiveMode: 'container',
                statusIdsVisible: index % 2 === 0 ? ['active', 'local'] : ['remote'],
                isIconVisible: true,
                isCloseVisible: index === 0
              }}
              key={index}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
