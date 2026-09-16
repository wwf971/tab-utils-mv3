import { useEffect, useRef } from 'react'
import { observer } from 'mobx-react-lite'
import { ChevronDown, CrossIcon, SpinningCircle } from '@wwf971/react-comp-misc'
import { RemoteStore } from './RemoteStore'
import { MatchHighlightText } from './RemoteWindowSelect'
import {
  getSearchFieldText,
  handleSearchFieldKeyDown,
  handleSearchFieldPaste
} from '../searchFieldPlain'
import './RemoteTagSelect.css'

// Remote tag selector (multi selection), conforming to selector.md: the
// picked tags show as chips with a cross icon; clicking the bar (or its
// chevron at the right) toggles a dropdown open/closed, whose search field
// queries the backend tag name index (unlike the window selector, which
// filters a local cache). When isCreateAllowed and no listed tag matches the
// entered text exactly, a create row offers making the tag in place; the
// created tag is not selected automatically — it shows in the list (it
// matches the entered text) and the user clicks it to select it. Callers
// that only filter by existing tags (the remote search tag filter) pass
// isCreateAllowed=false, which hides the create row.
// Open/close state lives in RemoteStore.selectorStateById; the search text
// and result list live in the store's shared tag search state (one tag
// dropdown is open at a time).
export const RemoteTagSelect = observer(function RemoteTagSelect({
  store,
  selectorId,
  tagIdsSelected,
  isCreateAllowed,
  isDisabled,
  onEvent
}: {
  store: RemoteStore
  selectorId: string
  tagIdsSelected: string[]
  isCreateAllowed: boolean
  isDisabled?: boolean
  onEvent: (eventType: string, eventData: Record<string, unknown>) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const tagTrackRef = useRef<HTMLDivElement>(null)
  const state = store.selectorState(selectorId)

  useEffect(() => {
    return () => store.selectorClear(selectorId)
  }, [store, selectorId])

  useEffect(() => {
    if (!state.isOpen) return undefined
    const closeOnOutside = (event: Event) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (rootRef.current?.contains(target)) return
      store.tagSelectorSetOpen(selectorId, false)
    }
    document.addEventListener('pointerdown', closeOnOutside, true)
    document.addEventListener('contextmenu', closeOnOutside, true)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside, true)
      document.removeEventListener('contextmenu', closeOnOutside, true)
    }
  }, [state.isOpen, store, selectorId])

  // hidden overflowing chips are reached by wheel-scrolling the chip track
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

  const toggleTag = (tagId: string) => {
    const tagIds = tagIdsSelected.includes(tagId)
      ? tagIdsSelected.filter((tagIdItem) => tagIdItem !== tagId)
      : [...tagIdsSelected, tagId]
    onEvent('tagsChange', { tagIds })
  }

  const searchText = store.tagSearchText.trim()
  const isCreateVisible = isCreateAllowed && searchText !== '' &&
    !store.tagIdsVisible.some(
      (tagId) => store.tagById.get(tagId)?.name === searchText
    )

  return (
    <div className="remote-tag-select" ref={rootRef}>
      <div
        className="remote-tag-select-bar"
        onClick={() => {
          if (!isDisabled) store.tagSelectorSetOpen(selectorId, !state.isOpen)
        }}
      >
        <div className="remote-tag-select-tags" ref={tagTrackRef}>
          {tagIdsSelected.length === 0 ? (
            <span className="remote-tag-select-empty">no tags</span>
          ) : tagIdsSelected.map((tagId) => {
            const tag = store.tagById.get(tagId)
            return (
              <span className="remote-tag-select-tag" title={tag?.name ?? tagId} key={tagId}>
                <span className="remote-tag-select-tag-text">{tag?.name ?? tagId}</span>
                <span
                  className="remote-tag-select-tag-cross"
                  onClick={(event) => {
                    // removing a chip must not toggle the dropdown
                    event.stopPropagation()
                    if (!isDisabled) toggleTag(tagId)
                  }}
                >
                  <CrossIcon />
                </span>
              </span>
            )
          })}
        </div>
        <span
          className={`remote-tag-select-chevron ${state.isOpen ? 'remote-tag-select-chevron-open' : ''}`}
        >
          <ChevronDown />
        </span>
      </div>

      {state.isOpen ? (
        <div className="remote-tag-select-dropdown">
          <div
            className={`remote-tag-select-search ${store.tagSearchText ? '' : 'remote-tag-select-search-empty'}`}
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            role="textbox"
            data-placeholder="Search tags"
            onPaste={(event) => {
              handleSearchFieldPaste(event)
              store.setTagSearchText(getSearchFieldText(event.currentTarget))
            }}
            onKeyDown={handleSearchFieldKeyDown}
            onInput={(event) => {
              store.setTagSearchText(getSearchFieldText(event.currentTarget))
            }}
          />
          {store.tagSearchMessageText ? (
            <div className="remote-tag-select-message">{store.tagSearchMessageText}</div>
          ) : null}
          <div className="remote-tag-select-list">
            {isCreateVisible ? (
              <div
                className="remote-tag-select-item remote-tag-select-item-create"
                onClick={() => {
                  void store.tagCreate(searchText)
                }}
              >
                {store.isTagCreating ? 'Creating...' : `Create tag "${searchText}"`}
              </div>
            ) : null}
            {store.tagSearchAction === 'search' ? (
              // full-list spinner only for a fresh search; loading the next
              // page keeps the loaded tags visible (its row shows below)
              <div className="remote-tag-select-loading">
                <SpinningCircle width={13} height={13} color="#6b7280" />
                <span>Searching tags...</span>
              </div>
            ) : store.tagIdsVisible.length === 0 && !isCreateVisible ? (
              <div className="remote-tag-select-loading">
                {searchText
                  ? 'No matching tag'
                  : isCreateAllowed ? 'No tags yet. Type a name to create one' : 'No tags yet'}
              </div>
            ) : (
              <>
                {store.tagIdsVisible.map((tagId) => {
                  const tag = store.tagById.get(tagId)
                  if (!tag) return null
                  return (
                    <div
                      className={`remote-tag-select-item ${tagIdsSelected.includes(tagId) ? 'remote-tag-select-item-selected' : ''}`}
                      key={tagId}
                      onClick={() => toggleTag(tagId)}
                    >
                      <span className="remote-tag-select-item-title">
                        <MatchHighlightText text={tag.name} matchText={searchText} />
                      </span>
                    </div>
                  )
                })}
                {store.isTagsMore ? (
                  <div
                    className="remote-tag-select-item remote-tag-select-item-more"
                    onClick={() => {
                      void store.tagSearchLoadMore()
                    }}
                  >
                    {store.tagSearchAction === 'searchMore' ? 'Loading...' : 'Load more tags'}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
})
