import { useEffect, useRef } from 'react'
import { observer } from 'mobx-react-lite'
import { EditIcon, CrossIcon } from '@wwf971/react-comp-misc'
import { RemoteStore } from './RemoteStore'
import './RemoteWindowSelect.css'

// Remote window selector (single selection), conforming to selector.md:
// a search-bar-like area shows the picked window as a tag with a cross icon,
// an edit icon at the rightmost opens a dropdown with a search field, a
// Fetch All button, and the list of cached windows. All ui state lives in
// RemoteStore.selectorStateById keyed by selectorId and is cleared on unmount.
export const RemoteWindowSelect = observer(function RemoteWindowSelect({
  store,
  selectorId,
  windowIdSelected,
  emptyText,
  isDisabled,
  onEvent
}: {
  store: RemoteStore
  selectorId: string
  windowIdSelected: string | null
  emptyText: string
  isDisabled?: boolean
  onEvent: (eventType: string, eventData: Record<string, unknown>) => void
}) {
  const tagTrackRef = useRef<HTMLDivElement>(null)
  const state = store.selectorState(selectorId)

  useEffect(() => {
    return () => store.selectorClear(selectorId)
  }, [store, selectorId])

  // hidden overflowing tags are reached by wheel-scrolling the tag track
  useEffect(() => {
    const trackEl = tagTrackRef.current
    if (!trackEl) return undefined
    const handleWheel = (event: WheelEvent) => {
      if (trackEl.scrollWidth <= trackEl.clientWidth) return
      event.preventDefault()
      trackEl.scrollLeft += event.deltaX + event.deltaY
    }
    trackEl.addEventListener('wheel', handleWheel, { passive: false })
    return () => trackEl.removeEventListener('wheel', handleWheel)
  })

  const windowSelected = windowIdSelected ? store.windowById.get(windowIdSelected) ?? null : null
  const windowIdsVisible = store.selectorWindowIdsVisible(selectorId)

  return (
    <div className="remote-window-select">
      <div className="remote-window-select-bar">
        <div className="remote-window-select-tags" ref={tagTrackRef}>
          {windowSelected ? (
            <span className="remote-window-select-tag" title={windowSelected.title}>
              <span className="remote-window-select-tag-text">
                {windowSelected.title || 'Untitled window'}
              </span>
              <span
                className="remote-window-select-tag-cross"
                onClick={() => {
                  if (!isDisabled) onEvent('windowPick', { windowId: null })
                }}
              >
                <CrossIcon />
              </span>
            </span>
          ) : (
            <span className="remote-window-select-empty">{emptyText}</span>
          )}
        </div>
        <span
          className={`remote-window-select-edit ${state.isOpen ? 'remote-window-select-edit-open' : ''}`}
          onClick={() => {
            if (!isDisabled) store.selectorSetOpen(selectorId, !state.isOpen)
          }}
        >
          <EditIcon />
        </span>
      </div>

      {state.isOpen ? (
        <div className="remote-window-select-dropdown">
          <div
            className={`remote-window-select-search ${state.searchText ? '' : 'remote-window-select-search-empty'}`}
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            role="textbox"
            data-placeholder="Search remote windows"
            onInput={(event) => {
              store.selectorSetSearchText(selectorId, event.currentTarget.textContent ?? '')
            }}
          />
          <div className="remote-window-select-buttons">
            <button
              type="button"
              className="remote-window-select-button"
              disabled={store.isWindowsLoading}
              onClick={() => void store.windowsFetch()}
            >
              Fetch All
            </button>
            {store.windowsFetchedAt > 0 ? (
              <span className="remote-window-select-count">
                {store.windowIds.length} window(s) cached
              </span>
            ) : null}
          </div>
          <div className="remote-window-select-list">
            {store.isWindowsLoading ? (
              <div className="remote-window-select-loading">
                <span className="remote-window-select-spinner" />
                <span>Fetching windows from server...</span>
              </div>
            ) : windowIdsVisible.length === 0 ? (
              <div className="remote-window-select-loading">
                {store.windowsFetchedAt === 0
                  ? 'No cached windows. Use Fetch All'
                  : 'No matching window'}
              </div>
            ) : windowIdsVisible.map((windowId) => {
              const windowItem = store.windowById.get(windowId)
              if (!windowItem) return null
              return (
                <div
                  className={`remote-window-select-item ${windowId === windowIdSelected ? 'remote-window-select-item-selected' : ''}`}
                  key={windowId}
                  onClick={() => {
                    onEvent('windowPick', { windowId })
                    store.selectorSetOpen(selectorId, false)
                  }}
                >
                  <span className="remote-window-select-item-title">
                    <MatchHighlightText
                      text={windowItem.title || 'Untitled window'}
                      matchText={state.searchText.trim()}
                    />
                  </span>
                  <span className="remote-window-select-item-info">
                    {windowItem.tabCount ?? 0} tabs
                    {windowId === store.windowDefaultId ? ' · default' : ''}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
})

// matched places are marked with a yellow background
export function MatchHighlightText({ text, matchText }: { text: string, matchText: string }) {
  if (!matchText) return <>{text}</>
  const parts: Array<{ text: string, isMatch: boolean }> = []
  const textLower = text.toLocaleLowerCase()
  const matchLower = matchText.toLocaleLowerCase()
  let position = 0
  while (position < text.length) {
    const indexMatch = textLower.indexOf(matchLower, position)
    if (indexMatch === -1) {
      parts.push({ text: text.slice(position), isMatch: false })
      break
    }
    if (indexMatch > position) {
      parts.push({ text: text.slice(position, indexMatch), isMatch: false })
    }
    parts.push({ text: text.slice(indexMatch, indexMatch + matchText.length), isMatch: true })
    position = indexMatch + matchText.length
  }
  return (
    <>
      {parts.map((part, partIndex) => part.isMatch
        ? <span className="remote-match-highlight" key={partIndex}>{part.text}</span>
        : <span key={partIndex}>{part.text}</span>)}
    </>
  )
}
