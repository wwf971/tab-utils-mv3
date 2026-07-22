if (typeof importScripts === 'function' && !globalThis.TabSnapshot) {
	importScripts(
		'background/snapshot-base.js',
		'background/snapshot-config.js',
		'background/snapshot-storage.js',
		'background/snapshot-retention.js',
		'background/event-log.js',
		'background/snapshot-capture.js',
		'background/recovery.js',
		'background/snapshot-main.js'
	);
}

// Tab Utils Extension - Background Service Worker
// Provides smart tab positioning and keyboard shortcuts for tab management

// Debug flag
let is_debug = false;
let isMoveNewTabNextToCurrentEnabled = true;
let isCurrentWindowTabCountShown = true;
let isTotalTabCountShown = true;

// ============================================================================
// INITIALIZATION & SETTINGS
// ============================================================================

// Load settings from chrome.storage on startup
async function loadSettings() {
	const result = await chrome.storage.sync.get([
		'enable_move_new_tab_next_to_current',
		'enable_badge_show_current_window_tab_count',
		'enable_badge_show_total_tab_count'
	]);
	isMoveNewTabNextToCurrentEnabled = result.enable_move_new_tab_next_to_current ?? true;
	isCurrentWindowTabCountShown = result.enable_badge_show_current_window_tab_count ?? true;
	isTotalTabCountShown = result.enable_badge_show_total_tab_count ?? true;
	console.log('Settings loaded:', {
		isMoveNewTabNextToCurrentEnabled,
		isCurrentWindowTabCountShown,
		isTotalTabCountShown
	});
	await updateBadge("settings");
}

// Initialize settings
loadSettings();

// Listen for messages from popup or other parts of the extension
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message.action === 'updateSettings') {
		const settingsNext = {};
		if ('enable_move_new_tab_next_to_current' in message.settings) {
			isMoveNewTabNextToCurrentEnabled = message.settings.enable_move_new_tab_next_to_current;
			settingsNext.enable_move_new_tab_next_to_current = isMoveNewTabNextToCurrentEnabled;
		}
		if ('enable_badge_show_current_window_tab_count' in message.settings) {
			isCurrentWindowTabCountShown = message.settings.enable_badge_show_current_window_tab_count;
			settingsNext.enable_badge_show_current_window_tab_count = isCurrentWindowTabCountShown;
		}
		if ('enable_badge_show_total_tab_count' in message.settings) {
			isTotalTabCountShown = message.settings.enable_badge_show_total_tab_count;
			settingsNext.enable_badge_show_total_tab_count = isTotalTabCountShown;
		}
		chrome.storage.sync.set(settingsNext).then(async () => {
			if (
				'enable_badge_show_current_window_tab_count' in settingsNext ||
				'enable_badge_show_total_tab_count' in settingsNext
			) {
				await updateBadge("settings");
			}
			console.log('Settings updated and saved:', settingsNext);
			sendResponse({ success: true });
		}).catch((error) => {
			console.error('Error saving settings:', error);
			sendResponse({ success: false, error: error.message });
		});
		return true;
	}
	return false;
});

// Create context menu on install
chrome.runtime.onInstalled.addListener(() => {
	chrome.contextMenus.create({
		id: "open-settings",
		title: "Settings",
		contexts: ["action"]
	});
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
	if (info.menuItemId === "open-settings") {
		// Open the popup (same as clicking the icon)
		chrome.action.openPopup();
	}
});


// Global variables to track tab focus history
let tabLastActiveIdGlobal = null;
let windowLastActiveId = null;
let tabActiveIdGlobal = null;
let windowCurrentIdGlobal = null;

// Recent tabs history per window (windowId -> [tabId1, tabId2, ...])
// Most recent tabs are at the beginning of the array
let tabsRecent = new Map();
const MAX_RECENT_TABS = 10; // Keep track of last 10 tabs per window

// Global cache for current and previous active tabs in each window
let cacheTabActive = new Map(); // windowId -> { tabId, lastUpdated }
let cacheTabActivePrev = new Map(); // windowId -> { tabId, lastUpdated }

// ============================================================================
// TAB FOCUS HISTORY TRACKING
// ============================================================================

// Listen for tab activation events to track tab focus history
chrome.tabs.onActivated.addListener((activeInfo) => {
	// Store the previous active tab info
	tabLastActiveIdGlobal = tabActiveIdGlobal;
	windowLastActiveId = windowCurrentIdGlobal;
	
	// Update current active tab info
	tabActiveIdGlobal = activeInfo.tabId;
	windowCurrentIdGlobal = activeInfo.windowId;
	
	// Update recent tabs history for this window
	updateTabsRecent(activeInfo.windowId, activeInfo.tabId);
	
	// Update active tab cache
	onTabOpenActivated(activeInfo.windowId, activeInfo.tabId);
});

// Function to update recent tabs history
function updateTabsRecent(windowId, tabId) {
	if (!tabsRecent.has(windowId)) {
		tabsRecent.set(windowId, []);
	}
	
	const windowHistory = tabsRecent.get(windowId);
	
	// Remove tabId if it already exists
	const indexExisting = windowHistory.indexOf(tabId);
	if (indexExisting > -1) {
		windowHistory.splice(indexExisting, 1);
	}
	
	// Add tabId to the beginning
	windowHistory.unshift(tabId);
	
	// Keep only MAX_RECENT_TABS
	if (windowHistory.length > MAX_RECENT_TABS) {
		windowHistory.splice(MAX_RECENT_TABS);
	}
}

function onTabOpenActivated(windowId, tabId) {
	const tabActive = cacheTabActive.get(windowId);
	if (tabActive && tabActive.tabId !== tabId) {
		cacheTabActivePrev.set(windowId, { // Store current active tab as previous before updating
			tabId: tabActive.tabId,
			lastUpdated: Date.now()
		});
	}
	
	// Update current active tab
	cacheTabActive.set(windowId, {
		tabId: tabId,
		lastUpdated: Date.now()
	});
	
	if (is_debug) {
		let tabActiveId = cacheTabActive.get(windowId)?.tabId;
		let tabActivePrevId = cacheTabActivePrev.get(windowId)?.tabId;
		
		// Get current tab details for enhanced logging
		chrome.tabs.get(tabId, (currentTab) => {
			if (chrome.runtime.lastError) {
				console.log(`onTabOpenActivated(): windowId: ${windowId}, cacheTabActiveId: ${tabActiveId}, cacheTabActivePrevId: ${tabActivePrevId} (could not fetch tab details)`);
			} else {
				console.log(`onTabOpenActivated(): windowId: ${windowId}, cacheTabActiveId: ${tabActiveId}, cacheTabActivePrevId: ${tabActivePrevId}, currentTab: "${currentTab.title}" (index: ${currentTab.index})`);
			}
		});
	}
}

function initTabActive(){
	console.log("initTabActive(): Initializing active tab cache...");
	
	// Get all windows and their active tabs
	chrome.windows.getAll({ populate: true }, (windows) => {
		if (chrome.runtime.lastError) {
			console.error("initTabActive(): Error getting windows:", chrome.runtime.lastError);
			return;
		}
		
		windows.forEach((window) => {
			if (window.tabs && window.tabs.length > 0) {
				// Find the active tab in this window
				const activeTab = window.tabs.find(tab => tab.active);
				if (activeTab) {
					// Initialize current active tab cache
					cacheTabActive.set(window.id, {
						tabId: activeTab.id,
						lastUpdated: Date.now()
					});

					// Initialize previous active tab cache (set to same for now, will be updated on first activation)
					cacheTabActivePrev.set(window.id, {
						tabId: activeTab.id,
						lastUpdated: Date.now()
					});
					
					if (is_debug) {
						console.log(`initTabActive(): Window ${window.id} - active tab: ${activeTab.id}`);
					}
				}
			}
		});
		if (is_debug) {
			console.log(`initTabActive(): Initialized cache for ${windows.length} windows`);
			console.log("initTabActive(): cacheTabActive size:", cacheTabActive.size);
			console.log("initTabActive(): cacheTabActivePrev size:", cacheTabActivePrev.size);
		}
	});
}

// Initialize on extension load
initTabActive();

// ============================================================================
// TAB REMOVAL AND WINDOW CLEANUP
// ============================================================================

// Handle tab removal
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
	// Remove the tab from all window histories
	for (const [windowId, tabHistory] of tabsRecent.entries()) {
		const index = tabHistory.indexOf(tabId);
		if (index > -1) {
			tabHistory.splice(index, 1);
		}
	}
	
	// Clean up if this was the current or last active tab
	if (tabId === tabActiveIdGlobal) {
		tabActiveIdGlobal = null;
	}
	if (tabId === tabLastActiveIdGlobal) {
		tabLastActiveIdGlobal = null;
	}
	
	// Remove from cache
	removeTabFromCache(tabId, removeInfo.windowId);
});

// Handle tab moving between windows
chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
	// Add to new window's history
	updateTabsRecent(attachInfo.newWindowId, tabId);
});

chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
	// Remove from old window's history
	if (tabsRecent.has(detachInfo.oldWindowId)) {
		const windowHistory = tabsRecent.get(detachInfo.oldWindowId);
		const index = windowHistory.indexOf(tabId);
		if (index > -1) {
			windowHistory.splice(index, 1);
		}
	}
	
	// Remove from cache
	removeTabFromCache(tabId, detachInfo.oldWindowId);
});

// Handle window closure
chrome.windows.onRemoved.addListener((windowId) => {
	// Clean up history for closed window
	tabsRecent.delete(windowId);
	
	// Clean up active tab cache for closed window
	cacheTabActive.delete(windowId);
	cacheTabActivePrev.delete(windowId);
	
	if (is_debug) {
		console.log(`Window ${windowId} closed - cleaned up active tab cache`);
	}
});

// Function to remove tab from cache when tabs are removed
function removeTabFromCache(tabId, windowId) {
	// Check if removed tab was the current active tab
	const currentActive = cacheTabActive.get(windowId);
	if (currentActive && currentActive.tabId === tabId) {
		// Clear current active tab cache for this window
		cacheTabActive.delete(windowId);
		if (is_debug) {
			console.log(`removeTabFromCache(): Removed current active tab ${tabId} from window ${windowId} cache`);
		}
	}
	
	// Check if removed tab was the previous active tab
	const prevActive = cacheTabActivePrev.get(windowId);
	if (prevActive && prevActive.tabId === tabId) {
		// Clear previous active tab cache for this window
		cacheTabActivePrev.delete(windowId);
		if (is_debug) {
			console.log(`removeTabFromCache(): Removed previous active tab ${tabId} from window ${windowId} cache`);
		}
	}
}

// ============================================================================
// SMART TAB POSITIONING
// ============================================================================

// Note: onCreated listener is registered in the BADGE DISPLAY section below
// to combine badge update and tab positioning in one listener

async function getTabIndex(tabId) {
	try {
		const tab = await chrome.tabs.get(tabId);
		return tab.index;
	} catch (error) {
		console.error('Error getting tab index:', error);
		return null;
	}
}

// Function to position a new tab according to the setting
async function positionNewTab(tabNew) {
	if (!tabNew || tabNew.id === undefined || tabNew.windowId === undefined){
		console.log("new tab created but no windowId", tabNew);
		return;
	}
	if (!isMoveNewTabNextToCurrentEnabled) {
		await chrome.tabs.move(tabNew.id, { index: -1 });
		return;
	}
	
	if(is_debug){
		console.log("positionNewTab(): tabNew", tabNew);
	}
	// Check if the new tab is active (extension-created tabs often become active immediately)
	const isNewTabActive = tabNew.active;
	if (isNewTabActive) { // New tab is active - move it next to the previous active tab
		const tabActive = cacheTabActive.get(tabNew.windowId);
		const cachedTabActivePrev = cacheTabActivePrev.get(tabNew.windowId)
		if(is_debug){
			// Enhanced debug logging with titles
			if (tabActive) {
				try {
					const activeTab = await chrome.tabs.get(tabActive.tabId);
					console.log("tabActive", { ...tabActive, title: activeTab.title });
				} catch (e) {
					console.log("tabActive", tabActive, "(could not fetch title)");
				}
			} else {
				console.log("tabActive", tabActive);
			}
			
			if (cachedTabActivePrev) {
				try {
					const prevTab = await chrome.tabs.get(cachedTabActivePrev.tabId);
					console.log("cacheTabActivePrev", { ...cachedTabActivePrev, title: prevTab.title });
				} catch (e) {
					console.log("cacheTabActivePrev", cachedTabActivePrev, "(could not fetch title)");
				}
			} else {
				console.log("cacheTabActivePrev", cachedTabActivePrev);
			}
		}
		let tabActiveTitle, tabNewTitle;
		if(tabActive && tabActive.tabId !== tabNew.id){ // onTabOpenActivated() is not triggered yet
			// Query for current active tab's index
			const activeTabDetails = await chrome.tabs.get(tabActive.tabId);
			let activeTabIndex = activeTabDetails.index;
			console.log("tabNew.index:", tabNew.index);
			console.log("activeTab.index:", activeTabDetails.index);
			if (activeTabDetails !== null) {
				if(is_debug){
					// Get tab titles for enhanced logging
					tabActiveTitle = "unknown";
					tabNewTitle = tabNew.title || "unknown";
					try {
						tabActiveTitle = activeTabDetails.title;
					} catch (e) {
						console.log("Could not fetch active tab title:", e);
					}
					console.log("tabNew.index: before", tabNew.index);
				}
				let indexNew;
				if(tabNew.index < activeTabIndex){
					indexNew = activeTabIndex;
				}else{
					indexNew = activeTabIndex + 1;
				}
				await chrome.tabs.move(tabNew.id, {
					index: indexNew
				});
				if(is_debug){
					let tabNewIndexAfterMove = await getTabIndex(tabNew.id);
					console.log(`tabNew: ${tabNew.id} ("${tabNewTitle}") index after move: ${tabNewIndexAfterMove}`)
					let tabActiveIndexAfterMove = await getTabIndex(tabActive.tabId);
					console.log(`tabActive: ${tabActive.tabId} ("${tabActiveTitle}") index after move: ${tabActiveIndexAfterMove}`);
				}
				return;
			}
		}

		const tabActivePrev = cacheTabActivePrev.get(tabNew.windowId);
		console.log("tabActivePrev", tabActivePrev);
		
		// Check if we have valid cached previous active tab data
		if (tabActivePrev && tabActivePrev.tabId) {
			// Query for previous active tab's current index
			const prevTabIndex = await getTabIndex(tabActivePrev.tabId);
			if (prevTabIndex !== null && tabNew.index !== prevTabIndex + 1) {
				chrome.tabs.move(tabNew.id, {
					index: prevTabIndex + 1
				});
				console.log(`tabNew(id:${tabNew.id}) moved tabActivePrev(id=:${tabActivePrev.tabId}) at index ${prevTabIndex}`);
			}
		} else {
			console.log(`No valid previous active tab cache for window ${tabNew.windowId}, skipping move`);
		}
	} else {
		// New tab is not active - move it next to the current active tab
		const tabActiveCached = cacheTabActive.get(tabNew.windowId);
		console.log("tabActiveCached", tabActiveCached);
		
		// Check if we have valid cached current active tab data
		if (tabActiveCached && tabActiveCached.tabId) {
			// Query for current active tab's index
			const activeTabIndex = await getTabIndex(tabActiveCached.tabId);
			if (activeTabIndex !== null && tabNew.index !== activeTabIndex + 1) {
				chrome.tabs.move(tabNew.id, {
					index: activeTabIndex + 1
				});
			}
		} else {
			console.log(`No valid current active tab cache for window ${tabNew.windowId}, skipping move`);
		}
	}
}

// ============================================================================
// KEYBOARD COMMAND HANDLERS
// ============================================================================

chrome.commands.onCommand.addListener((command) => {
	if (command === "move_tab_to_last") {
		chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
			const currentTab = tabs[0];
			if (!currentTab) return;

			chrome.tabs.query({ windowId: currentTab.windowId }, (allTabs) => {
				const lastIndex = allTabs.length - 1;
				chrome.tabs.move(currentTab.id, { index: lastIndex });
			});
		});
	}
	else if (command === "move_tab_to_first") {
		chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
			const currentTab = tabs[0];
			if (!currentTab) return;
			chrome.tabs.move(currentTab.id, { index: 0 });
		});
	}
	else if (command === "move_current_tab_to_recent") {
		// First, get the current active tab
		chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
			const currentTab = tabs[0];
			if (!currentTab) return;
			
			// Check if we have a valid last active tab
			if (!tabLastActiveIdGlobal) {
				console.log("No recent tab to move to");
				return;
			}
			
			// Get information about the last active tab
			chrome.tabs.get(tabLastActiveIdGlobal, (lastTab) => {
				// Handle potential error if the last tab no longer exists
				if (chrome.runtime.lastError) {
					console.log("Last active tab no longer exists");
					return;
				}
				
				// if the last active tab is in the same window
				if (lastTab.windowId === currentTab.windowId) {
					// Move the current tab to the position right after the last active tab
					chrome.tabs.move(currentTab.id, {
						index: lastTab.index
					});
				} else {
					// Move the current tab to another window
					chrome.tabs.move(currentTab.id, {
						windowId: lastTab.windowId,
						index: lastTab.index
					});
				}
			});
		});
	}
	else if (command === "move_recent_tab_to_current") {
		// First, get the current active tab
		chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
			const currentTab = tabs[0];
			if (!currentTab) return;
			
			// Check if we have a valid last active tab
			if (!tabLastActiveIdGlobal) {
				console.log("No recent tab to move");
				return;
			}
			
			// Get information about the last active tab
			chrome.tabs.get(tabLastActiveIdGlobal, (lastTab) => {
				// Handle potential error if the last tab no longer exists
				if (chrome.runtime.lastError) {
					console.log("Last active tab no longer exists");
					return;
				}
				
				// If the last active tab is in the same window
				if (lastTab.windowId === currentTab.windowId) {
					// Move the last active tab to the position right after the current tab
					chrome.tabs.move(lastTab.id, {
						index: currentTab.index
					});
				} else {
					// Move the last active tab from another window to this one
					chrome.tabs.move(lastTab.id, {
						windowId: currentTab.windowId,
						index: currentTab.index
					});
				}
			});
		});
	}
	else if (command === "duplicate_tab") {
		chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
			if (tabs.length > 0) {
				chrome.tabs.duplicate(tabs[0].id);
			}
		});
	}
});

// ============================================================================
// BADGE DISPLAY - TAB COUNT
// ============================================================================

// Display text over extension icon
let isCurrentWindowTabCountNext = true;
let badgeTimeoutId = null;
let isBadgeUpdateRunning = false;
let isBadgeUpdatePending = false;

function stopBadgeInterval() {
	if (badgeTimeoutId === null) return;
	clearTimeout(badgeTimeoutId);
	badgeTimeoutId = null;
}

function updateBadgeInterval() {
	if (!isCurrentWindowTabCountShown || !isTotalTabCountShown) {
		stopBadgeInterval();
		return;
	}
	if (badgeTimeoutId === null) {
		badgeTimeoutId = setTimeout(() => {
			badgeTimeoutId = null;
			updateBadge();
		}, 1500);
	}
}

async function updateBadge(event_name) {
	// Check if chrome.action API is available
	if (!chrome.action) {
		console.error("chrome.action API is not available");
		return;
	}

	// If this is an event-triggered update, reset the timer
	if (event_name) {
		stopBadgeInterval();
		isCurrentWindowTabCountNext = true;
	}
	if (isBadgeUpdateRunning) {
		isBadgeUpdatePending = true;
		return;
	}
	isBadgeUpdateRunning = true;

	try {
		if (!isCurrentWindowTabCountShown && !isTotalTabCountShown) {
			stopBadgeInterval();
			await chrome.action.setBadgeText({ text: '' });
			return;
		}
		const allTabs = await chrome.tabs.query({});
		const tab_num_total = allTabs.length;

		const currentWindow = await chrome.windows.getCurrent({ populate: true });
		const tab_num_current = currentWindow.tabs.length;

		const isCurrentWindowCountDisplayed = isCurrentWindowTabCountShown && (
			!isTotalTabCountShown || isCurrentWindowTabCountNext
		);
		const text = isCurrentWindowCountDisplayed ? `${tab_num_current}` : `${tab_num_total}`;
		if (isCurrentWindowCountDisplayed) {
			await chrome.action.setBadgeBackgroundColor({ color: '#157017' }); // Green for current window
		} else {
			await chrome.action.setBadgeBackgroundColor({ color: '#C72A1C' }); // Red for total
		}
		await chrome.action.setBadgeText({ text });

		if (isCurrentWindowTabCountShown && isTotalTabCountShown) {
			isCurrentWindowTabCountNext = !isCurrentWindowTabCountNext;
		}
		updateBadgeInterval();
	} catch (error) {
		console.error("Error updating badge:", error);
	} finally {
		isBadgeUpdateRunning = false;
		if (isBadgeUpdatePending) {
			isBadgeUpdatePending = false;
			updateBadge("pending");
		} else {
			updateBadgeInterval();
		}
	}
}

// Register event listeners for badge updates
chrome.tabs.onCreated.addListener((tabNew) => {
	updateBadge("create");
	if (!globalThis.TabSnapshot?.isTabPositioningSuppressed) {
		positionNewTab(tabNew);
	}
});
chrome.tabs.onRemoved.addListener(() => updateBadge("remove"));
chrome.windows.onFocusChanged.addListener(() => updateBadge("focus_change"));

console.log("Tab Utils extension loaded successfully");


