import browser from 'webextension-polyfill';
import { detectBrowser } from './utils/browser-detection';
import { updateCurrentActiveTab, isValidUrl, isBlankPage } from './utils/active-tab-manager';
import { TextHighlightData } from './utils/highlighter';
import { debounce } from './utils/debounce';
import { Settings, Property, Template, PromptVariable, ModelConfig, Provider } from './types/types';

let sidePanelOpenWindows: Set<number> = new Set();
let highlighterModeState: { [tabId: number]: boolean } = {};
let hasHighlights = false;
let isContextMenuCreating = false;
let popupPorts: { [tabId: number]: browser.Runtime.Port } = {};

async function ensureContentScriptLoadedInBackground(tabId: number): Promise<void> {
	try {
		// First, get the tab information
		const tab = await browser.tabs.get(tabId);

		// Check if the URL is valid before proceeding
		if (!tab.url || !isValidUrl(tab.url)) {
			console.log(`Skipping content script injection for invalid URL: ${tab.url}`);
			throw new Error(`Cannot inject content script into invalid URL: ${tab.url}`);
		}

		// Attempt to send a message to the content script
		await browser.tabs.sendMessage(tabId, { action: "ping" });
	} catch (error) {
		// If the error is about invalid URL, re-throw it
		if (error instanceof Error && error.message.includes('invalid URL')) {
			throw error;
		}
		
		// If the message fails, the content script is not loaded, so inject it
		console.log('Content script not loaded, injecting...');
		try {
			// Try using the scripting API (Chrome)
			if (browser.scripting) {
				await browser.scripting.executeScript({
					target: { tabId: tabId },
					files: ['content.js']
				});
			} else {
				// Fallback to tabs.executeScript (Firefox)
				await browser.tabs.executeScript(tabId, {
					file: 'content.js'
				});
			}
		} catch (injectError) {
			console.error('Failed to inject content script:', injectError);
			throw injectError;
		}
	}
}

function getHighlighterModeForTab(tabId: number): boolean {
	return highlighterModeState[tabId] ?? false;
}

async function initialize() {
	try {
		// Set up tab listeners
		await setupTabListeners();

		browser.tabs.onRemoved.addListener((tabId) => {
			delete highlighterModeState[tabId];
		});
		
		// Initialize context menu
		await debouncedUpdateContextMenu(-1);
		
		console.log('Background script initialized successfully');
	} catch (error) {
		console.error('Error initializing background script:', error);
	}
}

// Check if a popup is open for a given tab
function isPopupOpen(tabId: number): boolean {
	return popupPorts.hasOwnProperty(tabId);
}

browser.runtime.onConnect.addListener((port) => {
	if (port.name === 'popup') {
		const tabId = port.sender?.tab?.id;
		if (tabId) {
			popupPorts[tabId] = port;
			port.onDisconnect.addListener(() => {
				delete popupPorts[tabId];
			});
		}
	}
});

async function sendMessageToPopup(tabId: number, message: any): Promise<void> {
	if (isPopupOpen(tabId)) {
		try {
			await popupPorts[tabId].postMessage(message);
		} catch (error) {
			console.warn(`Error sending message to popup for tab ${tabId}:`, error);
		}
	}
}



browser.runtime.onMessage.addListener((request: unknown, sender: browser.Runtime.MessageSender, sendResponse: (response?: any) => void): true | undefined => {
	if (typeof request === 'object' && request !== null) {
		const typedRequest = request as { action: string; isActive?: boolean; hasHighlights?: boolean; tabId?: number; text?: string };
		
		if (typedRequest.action === 'copy-to-clipboard' && typedRequest.text) {
			// Use content script to copy to clipboard
			browser.tabs.query({active: true, currentWindow: true}).then(async (tabs) => {
				const currentTab = tabs[0];
				if (currentTab && currentTab.id) {
					try {
						const response = await browser.tabs.sendMessage(currentTab.id, {
							action: 'copy-text-to-clipboard',
							text: typedRequest.text
						});
						if ((response as any) && (response as any).success) {
							sendResponse({success: true});
						} else {
							sendResponse({success: false, error: 'Failed to copy from content script'});
						}
					} catch (err) {
						sendResponse({ success: false, error: (err as Error).message });
					}
				} else {
					sendResponse({success: false, error: 'No active tab found'});
				}
			});
			return true;
		}

		if (typedRequest.action === "extractContent" && sender.tab && sender.tab.id) {
			browser.tabs.sendMessage(sender.tab.id, request).then(sendResponse);
			return true;
		}

		if (typedRequest.action === "ensureContentScriptLoaded") {
			const tabId = typedRequest.tabId || sender.tab?.id;
			if (tabId) {
				ensureContentScriptLoadedInBackground(tabId)
					.then(() => sendResponse({ success: true }))
					.catch((error) => sendResponse({ 
						success: false, 
						error: error instanceof Error ? error.message : String(error) 
					}));
				return true;
			} else {
				sendResponse({ success: false, error: 'No tab ID provided' });
				return true;
			}
		}

		if (typedRequest.action === "sidePanelOpened") {
			if (sender.tab && sender.tab.windowId) {
				sidePanelOpenWindows.add(sender.tab.windowId);
				updateCurrentActiveTab(sender.tab.windowId);
			}
		}

		if (typedRequest.action === "sidePanelClosed") {
			if (sender.tab && sender.tab.windowId) {
				sidePanelOpenWindows.delete(sender.tab.windowId);
			}
		}

		if (typedRequest.action === "highlighterModeChanged" && sender.tab && typedRequest.isActive !== undefined) {
			const tabId = sender.tab.id;
			if (tabId) {
				highlighterModeState[tabId] = typedRequest.isActive;
				sendMessageToPopup(tabId, { action: "updatePopupHighlighterUI", isActive: typedRequest.isActive });
				debouncedUpdateContextMenu(tabId);
			}
		}

		if (typedRequest.action === "highlightsCleared" && sender.tab) {
			hasHighlights = false;
			debouncedUpdateContextMenu(sender.tab.id!);
		}

		if (typedRequest.action === "updateHasHighlights" && sender.tab && typedRequest.hasHighlights !== undefined) {
			hasHighlights = typedRequest.hasHighlights;
			debouncedUpdateContextMenu(sender.tab.id!);
		}

		if (typedRequest.action === "getHighlighterMode") {
			const tabId = typedRequest.tabId || sender.tab?.id;
			if (tabId) {
				sendResponse({ isActive: getHighlighterModeForTab(tabId) });
			} else {
				sendResponse({ isActive: false });
			}
			return true;
		}

		if (typedRequest.action === "toggleHighlighterMode" && typedRequest.tabId) {
			toggleHighlighterMode(typedRequest.tabId)
				.then(newMode => sendResponse({ success: true, isActive: newMode }))
				.catch(error => sendResponse({ success: false, error: error.message }));
			return true;
		}

		if (typedRequest.action === "openPopup") {
			browser.action.openPopup()
				.then(() => {
					sendResponse({ success: true });
				})
				.catch((error: unknown) => {
					console.error('Error opening popup in background script:', error);
					sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
				});
			return true;
		}

		if (typedRequest.action === "toggleReaderMode" && typedRequest.tabId) {
			injectReaderScript(typedRequest.tabId).then(() => {
				browser.tabs.sendMessage(typedRequest.tabId!, { action: "toggleReaderMode" })
					.then(sendResponse);
			});
			return true;
		}

		if (typedRequest.action === "getActiveTabAndToggleIframe") {
			browser.tabs.query({active: true, currentWindow: true}).then(async (tabs) => {
				const currentTab = tabs[0];
				if (currentTab && currentTab.id) {
					try {
						// Check if the URL is valid before trying to inject content script
						if (!currentTab.url || !isValidUrl(currentTab.url) || isBlankPage(currentTab.url)) {
							sendResponse({success: false, error: 'Cannot open iframe on this page'});
							return;
						}

						// Ensure content script is loaded first
						await ensureContentScriptLoadedInBackground(currentTab.id);
						await browser.tabs.sendMessage(currentTab.id, { action: "toggle-iframe" });
						sendResponse({success: true});
					} catch (error) {
						console.error('Error sending toggle-iframe message:', error);
						sendResponse({success: false, error: error instanceof Error ? error.message : String(error)});
					}
				} else {
					sendResponse({success: false, error: 'No active tab found'});
				}
			});
			return true;
		}

		if (typedRequest.action === "getActiveTab") {
			browser.tabs.query({active: true, currentWindow: true}).then(async (tabs) => {
				let currentTab = tabs[0];
				// Fallback for when currentWindow has no tabs (e.g., debugging popup in DevTools)
				if (!currentTab || !currentTab.id) {
					const allActiveTabs = await browser.tabs.query({active: true});
					currentTab = allActiveTabs.find(tab =>
						tab.id && tab.url && !tab.url.startsWith('chrome-extension://') && !tab.url.startsWith('moz-extension://')
					) || allActiveTabs[0];
				}
				if (currentTab && currentTab.id) {
					sendResponse({tabId: currentTab.id});
				} else {
					sendResponse({error: 'No active tab found'});
				}
			});
			return true;
		}

		if (typedRequest.action === "openOptionsPage") {
			try {
				if (typeof browser.runtime.openOptionsPage === 'function') {
					// Chrome way
					browser.runtime.openOptionsPage();
				} else {
					// Firefox way
					browser.tabs.create({
						url: browser.runtime.getURL('settings.html')
					});
				}
				sendResponse({success: true});
			} catch (error) {
				console.error('Error opening options page:', error);
				sendResponse({success: false, error: error instanceof Error ? error.message : String(error)});
			}
			return true;
		}

		if (typedRequest.action === "getTabInfo") {
			browser.tabs.get(typedRequest.tabId as number).then((tab) => {
				sendResponse({
					success: true,
					tab: {
						id: tab.id,
						url: tab.url
					}
				});
			}).catch((error) => {
				console.error('Error getting tab info:', error);
				sendResponse({
					success: false,
					error: error instanceof Error ? error.message : String(error)
				});
			});
			return true;
		}

		if (typedRequest.action === "sendMessageToTab") {
			const tabId = (typedRequest as any).tabId;
			const message = (typedRequest as any).message;
			if (tabId && message) {
				// Ensure content script is loaded before sending message
				ensureContentScriptLoadedInBackground(tabId).then(() => {
					return browser.tabs.sendMessage(tabId, message);
				}).then((response) => {
					sendResponse(response);
				}).catch((error) => {
					console.error('Error sending message to tab:', error);
					sendResponse({
						success: false,
						error: error instanceof Error ? error.message : String(error)
					});
				});
				return true;
			} else {
				sendResponse({
					success: false,
					error: 'Missing tabId or message'
				});
				return true;
			}
		}

		if (typedRequest.action === "processInterpreterAndSave") {
			const data = (typedRequest as any).data as ProcessInterpreterPayload;
			// Fire and forget - processing happens in background
			processInterpreterAndSave(data).catch(err => {
				console.error('processInterpreterAndSave error:', err);
			});
			sendResponse({ success: true });
			return true;
		}

		if (typedRequest.action === "openObsidianUrl") {
			const url = (typedRequest as any).url;
			if (url) {
				browser.tabs.query({active: true, currentWindow: true}).then((tabs) => {
					const currentTab = tabs[0];
					if (currentTab && currentTab.id) {
						browser.tabs.update(currentTab.id, { url: url }).then(() => {
							sendResponse({ success: true });
						}).catch((error) => {
							console.error('Error opening Obsidian URL:', error);
							sendResponse({
								success: false,
								error: error instanceof Error ? error.message : String(error)
							});
						});
					} else {
						sendResponse({
							success: false,
							error: 'No active tab found'
						});
					}
				}).catch((error) => {
					console.error('Error querying tabs:', error);
					sendResponse({
						success: false,
						error: error instanceof Error ? error.message : String(error)
					});
				});
				return true;
			} else {
				sendResponse({
					success: false,
					error: 'Missing URL'
				});
				return true;
			}
		}

		// For other actions that use sendResponse
		if (typedRequest.action === "extractContent" || 
			typedRequest.action === "ensureContentScriptLoaded" ||
			typedRequest.action === "getHighlighterMode" ||
			typedRequest.action === "toggleHighlighterMode" ||
			typedRequest.action === "openObsidianUrl") {
			return true;
		}
	}
	return undefined;
});

browser.commands.onCommand.addListener(async (command, tab) => {
	if (command === 'quick_clip') {
		browser.tabs.query({active: true, currentWindow: true}).then((tabs) => {
			if (tabs[0]?.id) {
				browser.action.openPopup();
				setTimeout(() => {
					browser.runtime.sendMessage({action: "triggerQuickClip"})
						.catch(error => console.error("Failed to send quick clip message:", error));
				}, 500);
			}
		});
	}
	if (command === "toggle_highlighter" && tab && tab.id) {
		await ensureContentScriptLoadedInBackground(tab.id);
		toggleHighlighterMode(tab.id);
	}
	if (command === "copy_to_clipboard" && tab && tab.id) {
		await browser.tabs.sendMessage(tab.id, { action: "copyToClipboard" });
	}
	if (command === "toggle_reader" && tab && tab.id) {
		await ensureContentScriptLoadedInBackground(tab.id);
		await injectReaderScript(tab.id);
		await browser.tabs.sendMessage(tab.id, { action: "toggleReaderMode" });
	}
});

const debouncedUpdateContextMenu = debounce(async (tabId: number) => {
	if (isContextMenuCreating) {
		return;
	}
	isContextMenuCreating = true;

	try {
		await browser.contextMenus.removeAll();

		let currentTabId = tabId;
		if (currentTabId === -1) {
			const tabs = await browser.tabs.query({ active: true, currentWindow: true });
			if (tabs.length > 0) {
				currentTabId = tabs[0].id!;
			}
		}

		const isHighlighterMode = getHighlighterModeForTab(currentTabId);

		const menuItems: {
			id: string;
			title: string;
			contexts: browser.Menus.ContextType[];
		}[] = [
				{
					id: "open-obsidian-clipper",
					title: "Save this page",
					contexts: ["page", "selection", "image", "video", "audio"]
				},
				{
					id: 'copy-markdown-to-clipboard',
					title: browser.i18n.getMessage('copyToClipboard'),
					contexts: ["page", "selection"]
				},
				// {
				// 	id: "toggle-reader",
				// 	title: "Reading view",
				// 	contexts: ["page", "selection"]
				// },
				{
					id: isHighlighterMode ? "exit-highlighter" : "enter-highlighter",
					title: isHighlighterMode ? "Exit highlighter" : "Highlight this page",
					contexts: ["page","image", "video", "audio"]
				},
				{
					id: "highlight-selection",
					title: "Add to highlights",
					contexts: ["selection"]
				},
				{
					id: "highlight-element",
					title: "Add to highlights",
					contexts: ["image", "video", "audio"]
				},
				{
					id: 'open-embedded',
					title: browser.i18n.getMessage('openEmbedded'),
					contexts: ["page", "selection"]
				}
			];

		const browserType = await detectBrowser();
		if (browserType === 'chrome') {
			menuItems.push({
				id: 'open-side-panel',
				title: browser.i18n.getMessage('openSidePanel'),
				contexts: ["page", "selection"]
			});
		}

		for (const item of menuItems) {
			await browser.contextMenus.create(item);
		}
	} catch (error) {
		console.error('Error updating context menu:', error);
	} finally {
		isContextMenuCreating = false;
	}
}, 100); // 100ms debounce time

browser.contextMenus.onClicked.addListener(async (info, tab) => {
	if (info.menuItemId === "open-obsidian-clipper") {
		browser.action.openPopup();
	} else if (info.menuItemId === "enter-highlighter" && tab && tab.id) {
		await setHighlighterMode(tab.id, true);
	} else if (info.menuItemId === "exit-highlighter" && tab && tab.id) {
		await setHighlighterMode(tab.id, false);
	} else if (info.menuItemId === "highlight-selection" && tab && tab.id) {
		await highlightSelection(tab.id, info);
	} else if (info.menuItemId === "highlight-element" && tab && tab.id) {
		await highlightElement(tab.id, info);
	// } else if (info.menuItemId === "toggle-reader" && tab && tab.id) {
	// 	await ensureContentScriptLoadedInBackground(tab.id);
	// 	await injectReaderScript(tab.id);
	// 	await browser.tabs.sendMessage(tab.id, { action: "toggleReaderMode" });
	} else if (info.menuItemId === 'open-embedded' && tab && tab.id) {
		await ensureContentScriptLoadedInBackground(tab.id);
		await browser.tabs.sendMessage(tab.id, { action: "toggle-iframe" });
	} else if (info.menuItemId === 'open-side-panel' && tab && tab.id && tab.windowId) {
		chrome.sidePanel.open({ tabId: tab.id });
		sidePanelOpenWindows.add(tab.windowId);
		await ensureContentScriptLoadedInBackground(tab.id);
	} else if (info.menuItemId === 'copy-markdown-to-clipboard' && tab && tab.id) {
		await ensureContentScriptLoadedInBackground(tab.id);
		await browser.tabs.sendMessage(tab.id, { action: "copyMarkdownToClipboard" });
	}
});

browser.runtime.onInstalled.addListener(() => {
	debouncedUpdateContextMenu(-1); // Use a dummy tabId for initial creation
});

async function isSidePanelOpen(windowId: number): Promise<boolean> {
	return sidePanelOpenWindows.has(windowId);
}

async function setupTabListeners() {
	const browserType = await detectBrowser();
	if (['chrome', 'brave', 'edge'].includes(browserType)) {
		browser.tabs.onActivated.addListener(handleTabChange);
		browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
			if (changeInfo.status === 'complete') {
				handleTabChange({ tabId, windowId: tab.windowId });
			}
		});
	}
}

const debouncedPaintHighlights = debounce(async (tabId: number) => {
	if (!getHighlighterModeForTab(tabId)) {
		await setHighlighterMode(tabId, false);
	}
	await paintHighlights(tabId);
}, 250);

async function handleTabChange(activeInfo: { tabId: number; windowId?: number }) {
	if (activeInfo.windowId && await isSidePanelOpen(activeInfo.windowId)) {
		updateCurrentActiveTab(activeInfo.windowId);
		await debouncedPaintHighlights(activeInfo.tabId);
	}
}

async function paintHighlights(tabId: number) {
	try {
		const tab = await browser.tabs.get(tabId);
		if (!tab || !tab.url || !isValidUrl(tab.url) || isBlankPage(tab.url)) {
			return;
		}

		await ensureContentScriptLoadedInBackground(tabId);
		await browser.tabs.sendMessage(tabId, { action: "paintHighlights" });

	} catch (error) {
		console.error('Error painting highlights:', error);
	}
}

async function setHighlighterMode(tabId: number, activate: boolean) {
	try {
		// First, check if the tab exists
		const tab = await browser.tabs.get(tabId);
		if (!tab || !tab.url) {
			return;
		}

		// Check if the URL is valid and not a blank page
		if (!isValidUrl(tab.url) || isBlankPage(tab.url)) {
			return;
		}

		// Then, ensure the content script is loaded
		await ensureContentScriptLoadedInBackground(tabId);

		// Now try to send the message
		highlighterModeState[tabId] = activate;
		await browser.tabs.sendMessage(tabId, { action: "setHighlighterMode", isActive: activate });
		debouncedUpdateContextMenu(tabId);
		await sendMessageToPopup(tabId, { action: "updatePopupHighlighterUI", isActive: activate });

	} catch (error) {
		console.error('Error setting highlighter mode:', error);
		// If there's an error, assume highlighter mode should be off
		highlighterModeState[tabId] = false;
		debouncedUpdateContextMenu(tabId);
		await sendMessageToPopup(tabId, { action: "updatePopupHighlighterUI", isActive: false });
	}
}

async function toggleHighlighterMode(tabId: number): Promise<boolean> {
	try {
		const currentMode = getHighlighterModeForTab(tabId);
		const newMode = !currentMode;
		highlighterModeState[tabId] = newMode;
		await browser.tabs.sendMessage(tabId, { action: "setHighlighterMode", isActive: newMode });
		debouncedUpdateContextMenu(tabId);
		await sendMessageToPopup(tabId, { action: "updatePopupHighlighterUI", isActive: newMode });
		return newMode;
	} catch (error) {
		console.error('Error toggling highlighter mode:', error);
		throw error;
	}
}

async function highlightSelection(tabId: number, info: browser.Menus.OnClickData) {
	highlighterModeState[tabId] = true;
	
	const highlightData: Partial<TextHighlightData> = {
		id: Date.now().toString(),
		type: 'text',
		content: info.selectionText || '',
	};

	await browser.tabs.sendMessage(tabId, { 
		action: "highlightSelection", 
		isActive: true,
		highlightData,
	});
	hasHighlights = true;
	debouncedUpdateContextMenu(tabId);
}

async function highlightElement(tabId: number, info: browser.Menus.OnClickData) {
	highlighterModeState[tabId] = true;

	await browser.tabs.sendMessage(tabId, { 
		action: "highlightElement", 
		isActive: true,
		targetElementInfo: {
			mediaType: info.mediaType === 'image' ? 'img' : info.mediaType,
			srcUrl: info.srcUrl,
			pageUrl: info.pageUrl
		}
	});
	hasHighlights = true;
	debouncedUpdateContextMenu(tabId);
}

async function injectReaderScript(tabId: number) {
	try {
		await browser.scripting.insertCSS({
			target: { tabId },
			files: ['reader.css']
		});

		// Inject scripts in sequence for all browsers
		await browser.scripting.executeScript({
			target: { tabId },
			files: ['browser-polyfill.min.js']
		});
		await browser.scripting.executeScript({
			target: { tabId },
			files: ['reader-script.js']
		});

		return true;
	} catch (error) {
		console.error('Error injecting reader script:', error);
		return false;
	}
}

// Background interpreter processing - all functions are self-contained
// to avoid importing DOM-dependent modules into the service worker.

interface ProcessInterpreterPayload {
	noteContent: string;
	noteName: string;
	path: string;
	properties: Property[];
	vault: string;
	behavior: Template['behavior'];
	promptContext: string;
	promptVariables: PromptVariable[];
	contentForLLM: string;
	modelId: string;
	settings: Settings;
	tabId: number;
}

async function setBadge(text: string, color: string): Promise<void> {
	try {
		await browser.action.setBadgeText({ text });
		await browser.action.setBadgeBackgroundColor({ color });
	} catch (e) {
		console.warn('Failed to set badge:', e);
	}
}

async function clearBadgeAfter(ms: number): Promise<void> {
	setTimeout(async () => {
		try {
			await browser.action.setBadgeText({ text: '' });
		} catch (e) {
			// Ignore
		}
	}, ms);
}

// Inline sanitizeFileName for service worker (no navigator dependency)
function bgSanitizeFileName(fileName: string): string {
	// Remove Obsidian-specific characters and common unsafe characters
	return fileName
		.replace(/[#|\^\[\]]/g, '')
		.replace(/[<>:"\/\\?*\x00-\x1F]/g, '')
		.replace(/\.\./g, '.')
		.replace(/^\.+/, '')
		.replace(/\.+$/, '')
		.trim();
}

// Inline escapeDoubleQuotes
function bgEscapeDoubleQuotes(str: string): string {
	return str.replace(/"/g, '\\"');
}

// Inline generateFrontmatter for service worker
async function bgGenerateFrontmatter(properties: Property[], propertyTypes: Settings['propertyTypes']): Promise<string> {
	let frontmatter = '---\n';
	for (const property of properties) {
		const needsQuotes = /[:\s\{\}\[\],&*#?|<>=!%@\\-]/.test(property.name) || /^[\d]/.test(property.name) || /^(true|false|null|yes|no|on|off)$/i.test(property.name.trim());
		const propertyKey = needsQuotes ? (property.name.includes('"') ? `'${property.name.replace(/'/g, "''")}'` : `"${property.name}"`) : property.name;
		frontmatter += `${propertyKey}:`;

		const propertyType = propertyTypes.find(p => p.name === property.name)?.type || 'text';

		switch (propertyType) {
			case 'multitext': {
				let items: string[];
				if (property.value.trim().startsWith('["') && property.value.trim().endsWith('"]')) {
					try {
						items = JSON.parse(property.value);
					} catch (e) {
						items = property.value.split(',').map(item => item.trim());
					}
				} else {
					items = property.value.split(/,(?![^\[]*\]\])/).map(item => item.trim());
				}
				items = items.filter(item => item !== '');
				if (items.length > 0) {
					frontmatter += '\n';
					items.forEach(item => {
						frontmatter += `  - "${bgEscapeDoubleQuotes(item)}"\n`;
					});
				} else {
					frontmatter += '\n';
				}
				break;
			}
			case 'number': {
				const numericValue = property.value.replace(/[^\d.-]/g, '');
				frontmatter += numericValue ? ` ${parseFloat(numericValue)}\n` : '\n';
				break;
			}
			case 'checkbox': {
				const isChecked = typeof property.value === 'boolean' ? property.value : property.value === 'true';
				frontmatter += ` ${isChecked}\n`;
				break;
			}
			case 'date':
			case 'datetime':
				if (property.value.trim() !== '') {
					frontmatter += ` ${property.value}\n`;
				} else {
					frontmatter += '\n';
				}
				break;
			default:
				frontmatter += property.value.trim() !== '' ? ` "${bgEscapeDoubleQuotes(property.value)}"\n` : '\n';
		}
	}
	frontmatter += '---\n';
	if (frontmatter.trim() === '---\n---') {
		return '';
	}
	return frontmatter;
}

// Inline replacePromptVariablesInText (no applyFilters - filters already applied by popup before sending)
function bgReplacePromptVariablesInText(
	text: string,
	promptVariables: PromptVariable[],
	promptResponses: any[]
): string {
	return text.replace(/{{(?:prompt:)?"([\s\S]*?)"(\|[\s\S]*?)?}}/g, (match, promptText, _filters) => {
		const variable = promptVariables.find(v => v.prompt === promptText);
		if (!variable) return match;

		const response = promptResponses.find(r => r.key === variable.key);
		if (response && response.user_response !== undefined) {
			let value = response.user_response;
			if (typeof value === 'object') {
				try {
					value = JSON.stringify(value, null, 2);
				} catch (error) {
					console.error('Error stringifying object:', error);
					value = String(value);
				}
			}
			return value;
		}
		return match;
	});
}

// Inline sendToLLM for service worker (self-contained, no generalSettings dependency)
async function bgSendToLLM(
	promptContext: string,
	content: string,
	promptVariables: PromptVariable[],
	model: ModelConfig,
	providers: Provider[]
): Promise<{ promptResponses: any[] }> {
	const provider = providers.find(p => p.id === model.providerId);
	if (!provider) {
		throw new Error(`Provider not found for model ${model.name}`);
	}
	if (provider.apiKeyRequired && !provider.apiKey) {
		throw new Error(`API key is not set for provider ${provider.name}`);
	}

	const systemContent =
		`You are a helpful assistant. Please respond with one JSON object named \`prompts_responses\` — no explanatory text before or after. Use the keys provided, e.g. \`prompt_1\`, \`prompt_2\`, and fill in the values. Values should be Markdown strings unless otherwise specified. Make your responses concise. For example, your response should look like: {"prompts_responses":{"prompt_1":"tag1, tag2, tag3","prompt_2":"- bullet1\n- bullet 2\n- bullet3"}}`;

	const promptContent = {
		prompts: promptVariables.reduce((acc, { key, prompt }) => {
			acc[key] = prompt;
			return acc;
		}, {} as { [key: string]: string })
	};

	let requestUrl: string;
	let requestBody: any;
	let headers: HeadersInit = { 'Content-Type': 'application/json' };

	if (provider.name.toLowerCase().includes('anthropic')) {
		requestUrl = provider.baseUrl;
		requestBody = {
			model: model.providerModelId,
			max_tokens: 1600,
			messages: [
				{ role: 'user', content: `${promptContext}` },
				{ role: 'user', content: `${JSON.stringify(promptContent)}` }
			],
			temperature: 0.5,
			system: systemContent
		};
		headers = { ...headers, 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' };
	} else if (provider.name.toLowerCase().includes('ollama')) {
		requestUrl = provider.baseUrl;
		requestBody = {
			model: model.providerModelId,
			messages: [
				{ role: 'system', content: systemContent },
				{ role: 'user', content: `${promptContext}` },
				{ role: 'user', content: `${JSON.stringify(promptContent)}` }
			],
			format: 'json',
			num_ctx: 120000,
			temperature: 0.5,
			stream: false
		};
	} else if (provider.baseUrl.includes('openai.azure.com')) {
		requestUrl = provider.baseUrl;
		requestBody = {
			messages: [
				{ role: 'system', content: systemContent },
				{ role: 'user', content: `${promptContext}` },
				{ role: 'user', content: `${JSON.stringify(promptContent)}` }
			],
			max_tokens: 1600,
			stream: false
		};
		headers = { ...headers, 'api-key': provider.apiKey };
	} else if (provider.name.toLowerCase().includes('hugging')) {
		requestUrl = provider.baseUrl.replace('{model-id}', model.providerModelId);
		requestBody = {
			model: model.providerModelId,
			messages: [
				{ role: 'system', content: systemContent },
				{ role: 'user', content: `${promptContext}` },
				{ role: 'user', content: `${JSON.stringify(promptContent)}` }
			],
			max_tokens: 1600,
			stream: false
		};
		headers = { ...headers, 'Authorization': `Bearer ${provider.apiKey}` };
	} else {
		requestUrl = provider.baseUrl;
		requestBody = {
			model: model.providerModelId,
			messages: [
				{ role: 'system', content: systemContent },
				{ role: 'user', content: `${promptContext}` },
				{ role: 'user', content: `${JSON.stringify(promptContent)}` }
			]
		};
		headers = { ...headers, 'Authorization': `Bearer ${provider.apiKey}` };
	}

	const response = await fetch(requestUrl, {
		method: 'POST',
		headers,
		body: JSON.stringify(requestBody)
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`${provider.name} error: ${response.statusText} ${errorText}`);
	}

	const responseText = await response.text();
	let data;
	try {
		data = JSON.parse(responseText);
	} catch (error) {
		throw new Error(`Failed to parse response from ${provider.name}`);
	}

	let llmResponseContent: string;
	if (provider.name.toLowerCase().includes('anthropic')) {
		const textContent = data.content[0]?.text;
		if (textContent) {
			try { llmResponseContent = JSON.stringify(JSON.parse(textContent)); }
			catch { llmResponseContent = textContent; }
		} else {
			llmResponseContent = JSON.stringify(data);
		}
	} else if (provider.name.toLowerCase().includes('ollama')) {
		const messageContent = data.message?.content;
		if (messageContent) {
			try { llmResponseContent = JSON.stringify(JSON.parse(messageContent)); }
			catch { llmResponseContent = messageContent; }
		} else {
			llmResponseContent = JSON.stringify(data);
		}
	} else {
		llmResponseContent = data.choices[0]?.message?.content || JSON.stringify(data);
	}

	// Parse LLM response
	try {
		const jsonMatch = llmResponseContent.match(/\{[\s\S]*\}/);
		const jsonStr = jsonMatch ? jsonMatch[0] : llmResponseContent;
		const parsed = JSON.parse(jsonStr);
		const promptsResponses = parsed?.prompts_responses || parsed;

		// Convert escaped newlines
		Object.keys(promptsResponses).forEach(key => {
			if (typeof promptsResponses[key] === 'string') {
				promptsResponses[key] = promptsResponses[key].replace(/\\n/g, '\n').replace(/\r/g, '');
			}
		});

		const promptResponses = promptVariables.map(variable => ({
			key: variable.key,
			prompt: variable.prompt,
			user_response: promptsResponses[variable.key] || ''
		}));

		return { promptResponses };
	} catch (parseError) {
		console.error('Failed to parse LLM response:', parseError);
		return { promptResponses: [] };
	}
}

// Inline incrementStat for service worker
async function bgIncrementStat(
	action: string,
	vault?: string,
	path?: string,
	url?: string,
	title?: string
): Promise<void> {
	try {
		const data = await browser.storage.sync.get(null) as any;
		const stats = data.stats || { addToObsidian: 0, saveFile: 0, copyToClipboard: 0, share: 0 };
		if (action in stats) {
			stats[action]++;
		}
		await browser.storage.sync.set({ stats });

		// Add history entry
		if (url) {
			const result = await browser.storage.local.get('history');
			const history: any[] = (result.history || []) as any[];
			history.unshift({
				datetime: new Date().toISOString(),
				url,
				action,
				title,
				vault,
				path
			});
			await browser.storage.local.set({ history: history.slice(0, 1000) });
		}
	} catch (e) {
		console.warn('Failed to update stats:', e);
	}
}

async function saveToObsidianFromBackground(
	fileContent: string,
	noteName: string,
	path: string,
	vault: string,
	behavior: Template['behavior'],
	settings: Settings,
	tabId: number
): Promise<void> {
	let obsidianUrl: string;
	const isDailyNote = behavior === 'append-daily' || behavior === 'prepend-daily';

	if (isDailyNote) {
		obsidianUrl = `obsidian://daily?`;
	} else {
		if (path && !path.endsWith('/')) {
			path += '/';
		}
		const formattedNoteName = bgSanitizeFileName(noteName);
		obsidianUrl = `obsidian://new?file=${encodeURIComponent(path + formattedNoteName)}`;
	}

	if (behavior.startsWith('append')) {
		obsidianUrl += '&append=true';
	} else if (behavior.startsWith('prepend')) {
		obsidianUrl += '&prepend=true';
	} else if (behavior === 'overwrite') {
		obsidianUrl += '&overwrite=true';
	}

	const vaultParam = vault ? `&vault=${encodeURIComponent(vault)}` : '';
	obsidianUrl += vaultParam;

	if (settings.silentOpen) {
		obsidianUrl += '&silent=true';
	}

	if (settings.legacyMode) {
		obsidianUrl += `&content=${encodeURIComponent(fileContent)}`;
		await browser.tabs.update(tabId, { url: obsidianUrl });
	} else {
		// Copy to clipboard via content script, then open with clipboard flag
		try {
			await browser.tabs.sendMessage(tabId, {
				action: 'copy-text-to-clipboard',
				text: fileContent
			});
			obsidianUrl += `&clipboard&content=${encodeURIComponent('Clipboard error. See https://help.obsidian.md/web-clipper/troubleshoot')}`;
		} catch (e) {
			console.warn('Clipboard copy failed in background, falling back to URI method:', e);
			obsidianUrl += `&content=${encodeURIComponent(fileContent)}`;
		}
		await browser.tabs.update(tabId, { url: obsidianUrl });
	}
}

async function processInterpreterAndSave(payload: ProcessInterpreterPayload): Promise<void> {
	const { promptContext, contentForLLM, promptVariables, modelId, settings, tabId } = payload;

	await setBadge('...', '#666666');

	try {
		const modelConfig = settings.models.find(m => m.id === modelId);
		if (!modelConfig) {
			throw new Error(`Model configuration not found for ${modelId}`);
		}

		// Call LLM using self-contained function
		const { promptResponses } = await bgSendToLLM(
			promptContext, contentForLLM, promptVariables, modelConfig, settings.providers
		);

		// Replace prompt variables
		const resolvedNoteContent = bgReplacePromptVariablesInText(payload.noteContent, promptVariables, promptResponses);
		const resolvedNoteName = bgReplacePromptVariablesInText(payload.noteName, promptVariables, promptResponses);
		const resolvedProperties = payload.properties.map(p => ({
			...p,
			value: typeof p.value === 'string'
				? bgReplacePromptVariablesInText(p.value, promptVariables, promptResponses)
				: p.value
		}));

		// Generate frontmatter
		const frontmatter = await bgGenerateFrontmatter(resolvedProperties, settings.propertyTypes);
		const fileContent = frontmatter + resolvedNoteContent;

		// Save to Obsidian
		await saveToObsidianFromBackground(
			fileContent, resolvedNoteName, payload.path, payload.vault,
			payload.behavior, settings, tabId
		);

		// Update stats
		try {
			const tab = await browser.tabs.get(tabId);
			await bgIncrementStat('addToObsidian', payload.vault, payload.path, tab.url, tab.title);
		} catch (e) {
			console.warn('Failed to update stats:', e);
		}

		await setBadge('OK', '#4CAF50');
		clearBadgeAfter(3000);

		if (settings.interpreterNotifications) {
			try {
				await browser.notifications.create({
					type: 'basic',
					iconUrl: 'icons/icon128.png',
					title: 'Obsidian Web Clipper',
					message: 'Note saved successfully'
				});
			} catch (e) {
				console.warn('Failed to show notification:', e);
			}
		}
	} catch (error) {
		console.error('Background interpreter processing failed:', error);

		await setBadge('!', '#F44336');
		clearBadgeAfter(5000);

		if (settings.interpreterNotifications) {
			try {
				await browser.notifications.create({
					type: 'basic',
					iconUrl: 'icons/icon128.png',
					title: 'Obsidian Web Clipper',
					message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
				});
			} catch (e) {
				console.warn('Failed to show notification:', e);
			}
		}
	}
}

// Initialize the extension
initialize().catch(error => {
	console.error('Failed to initialize background script:', error);
});
