import { makeAutoObservable } from 'mobx'
import { TabSearchCore, createLiveTabQuerySource } from './TabSearchCore'

// State of one bring operation: bring one or many source tabs to
// before/after one target tab.
//
// One side of the operation is fixed when the operation is opened from the
// right-click menu (the clicked tab, or the selected tabs). The other side is
// picked inside the panel, through a secondary search over the live browser
// state and through the special "current tab" option:
// - pickSide 'source': the target is fixed; the panel picks source tabs
//   (multiple). Ticking the current tab adds it next to the searched picks.
// - pickSide 'target': the source tabs are fixed; the panel picks the target
//   tab (single). Ticking the current tab decides the target, so searching
//   is forbidden while it is ticked.

export interface TabBringRef {
  tabSourceId: number
  titleText: string
}

export interface TabBringCoreOptions {
  pickSide: 'source' | 'target'
  tabTargetFixed?: TabBringRef | null
  tabsSourceFixed?: TabBringRef[]
  tabCurrent: TabBringRef | null
  isTabCurrentPicked?: boolean
  getContextCountSide: () => number
}

export class TabBringCore {
  pickSide: 'source' | 'target'
  placement: 'before' | 'after' = 'after'
  tabTargetFixed: TabBringRef | null
  tabsSourceFixed: TabBringRef[]
  tabCurrent: TabBringRef | null
  isTabCurrentPicked: boolean
  isApplying = false
  search: TabSearchCore

  constructor(options: TabBringCoreOptions) {
    this.pickSide = options.pickSide
    this.tabTargetFixed = options.tabTargetFixed ?? null
    this.tabsSourceFixed = options.tabsSourceFixed ?? []
    this.tabCurrent = options.tabCurrent
    this.isTabCurrentPicked = options.isTabCurrentPicked === true
    this.search = new TabSearchCore({
      source: createLiveTabQuerySource(),
      getContextCountSide: options.getContextCountSide,
      searchLimit: 100,
      emptyMessageText: this.pickSide === 'source'
        ? 'Enter text to search tabs to bring'
        : 'Enter text to search the target tab'
    })
    makeAutoObservable(this, { search: false }, { autoBind: true })
  }

  // Picking the current tab as the target decides the single pick entirely.
  get isSearchForbidden() {
    return this.pickSide === 'target' && this.isTabCurrentPicked
  }

  // Tabs that cannot be picked in the result list: the fixed side of the
  // operation, and the current tab when it is already picked by its option.
  get tabSourceIdsUnpickable() {
    const tabSourceIds = new Set<number>()
    if (this.tabTargetFixed) tabSourceIds.add(this.tabTargetFixed.tabSourceId)
    for (const tab of this.tabsSourceFixed) tabSourceIds.add(tab.tabSourceId)
    if (this.isTabCurrentPicked && this.tabCurrent) {
      tabSourceIds.add(this.tabCurrent.tabSourceId)
    }
    return tabSourceIds
  }

  // The resolved target tab, no matter which side it comes from.
  get tabTarget(): TabBringRef | null {
    if (this.pickSide === 'source') return this.tabTargetFixed
    if (this.isTabCurrentPicked) return this.tabCurrent
    const tabSourceIdPicked = this.search.selectedIds[0]
    const tabPicked = this.search.items.find(
      (tab) => tab.tabSourceId === tabSourceIdPicked
    )
    if (!tabPicked) return null
    return { tabSourceId: tabPicked.tabSourceId, titleText: tabPicked.title }
  }

  // The resolved source tab IDs in bring order, the target excluded.
  get tabSourceIdsApply() {
    const tabTargetSourceId = this.tabTarget?.tabSourceId ?? null
    let tabSourceIds: number[]
    if (this.pickSide === 'target') {
      tabSourceIds = this.tabsSourceFixed.map((tab) => tab.tabSourceId)
    } else {
      tabSourceIds = []
      if (this.isTabCurrentPicked && this.tabCurrent) {
        tabSourceIds.push(this.tabCurrent.tabSourceId)
      }
      // Picked search results are taken in row order, not in click order.
      const tabSourceIdPickedSet = new Set(this.search.selectedIds)
      for (const tab of this.search.items) {
        if (!tabSourceIdPickedSet.has(tab.tabSourceId)) continue
        if (!tabSourceIds.includes(tab.tabSourceId)) tabSourceIds.push(tab.tabSourceId)
      }
    }
    return tabSourceIds.filter((tabSourceId) => tabSourceId !== tabTargetSourceId)
  }

  get isApplyReady() {
    return this.tabTarget !== null && this.tabSourceIdsApply.length > 0
  }

  setPlacement(placement: 'before' | 'after') {
    this.placement = placement
  }

  setTabCurrentPicked(isPicked: boolean) {
    if (!this.tabCurrent) return
    this.isTabCurrentPicked = isPicked
    if (this.pickSide === 'target' && isPicked) {
      this.search.setSelectedIds([])
    }
  }

  toggleTabPicked(tabSourceId: number) {
    if (this.isSearchForbidden) return
    if (this.tabSourceIdsUnpickable.has(tabSourceId)) return
    const selectedIds = this.search.selectedIds
    const isPicked = selectedIds.includes(tabSourceId)
    if (this.pickSide === 'target') {
      this.search.setSelectedIds(isPicked ? [] : [tabSourceId])
      return
    }
    this.search.setSelectedIds(
      isPicked
        ? selectedIds.filter((tabSourceIdPicked) => tabSourceIdPicked !== tabSourceId)
        : [...selectedIds, tabSourceId]
    )
  }

  setApplying(isApplying: boolean) {
    this.isApplying = isApplying
  }

  dispose() {
    this.search.dispose()
  }
}
