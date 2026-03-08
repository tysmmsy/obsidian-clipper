// Re-export all DOM-free utilities from core module
export {
	escapeRegExp,
	escapeMarkdown,
	escapeValue,
	unescapeValue,
	escapeDoubleQuotes,
	escapeHtml,
	formatDuration,
	getDomain,
} from './string-utils-core';

import { sanitizeFileNameCore, escapeHtml as coreEscapeHtml } from './string-utils-core';

// Navigator-aware sanitizeFileName for use in popup/content contexts
export function sanitizeFileName(fileName: string): string {
	const platform = (navigator as any).userAgentData?.platform || navigator.platform || '';
	return sanitizeFileNameCore(fileName, platform);
}

export function formatVariables(variables: { [key: string]: string }): string {
	return Object.entries(variables)
		.map(([key, value]) => {
			// Remove the outer curly braces from the key
			const cleanKey = key.replace(/^{{|}}$/g, '');

			return `
				<div class="variable-item is-collapsed">
					<span class="variable-key" data-variable="${coreEscapeHtml(key)}">${coreEscapeHtml(cleanKey)}</span>
					<span class="variable-value">${coreEscapeHtml(value)}</span>
					<span class="chevron-icon" aria-label="Expand">
						<i data-lucide="chevron-right"></i>
					</span>
				</div>
			`;
		})
		.join('');
}

// Cases to handle:
// Full URLs: https://example.com/x.png
// URLs without protocol: //example.com/x.png
// Relative URLs:
// - x.png
// - /x.png
// - img/x.png
// - ../x.png

export function makeUrlAbsolute(element: Element, attributeName: string, baseUrl: URL) {
	const attributeValue = element.getAttribute(attributeName);
	if (attributeValue) {
		try {
			// Create a new URL object from the base URL
			const resolvedBaseUrl = new URL(baseUrl.href);

			// If the base URL points to a file, remove the filename to get the directory
			if (!resolvedBaseUrl.pathname.endsWith('/')) {
				resolvedBaseUrl.pathname = resolvedBaseUrl.pathname.substring(0, resolvedBaseUrl.pathname.lastIndexOf('/') + 1);
			}

			const url = new URL(attributeValue, resolvedBaseUrl);

			if (!['http:', 'https:'].includes(url.protocol)) {
				// Handle non-standard protocols (chrome-extension://, moz-extension://, brave://, etc.)
				const parts = attributeValue.split('/');
				const firstSegment = parts[2]; // The segment after the protocol

				if (firstSegment && firstSegment.includes('.')) {
					// If it looks like a domain, replace the non-standard protocol with the current page's protocol
					const newUrl = `${baseUrl.protocol}//` + attributeValue.split('://')[1];
					element.setAttribute(attributeName, newUrl);
				} else {
					// If it doesn't look like a domain it's probably the extension URL, remove the non-standard protocol part and use baseUrl
					const path = parts.slice(3).join('/');
					const newUrl = new URL(path, resolvedBaseUrl.origin + resolvedBaseUrl.pathname).href;
					element.setAttribute(attributeName, newUrl);
				}
			} else {
				// Handle other cases (relative URLs, protocol-relative URLs)
				const newUrl = url.href;
				element.setAttribute(attributeName, newUrl);
			}
		} catch (error) {
			console.warn(`Failed to process URL: ${attributeValue}`, error);
			element.setAttribute(attributeName, attributeValue);
		}
	}
}

export function processUrls(htmlContent: string, baseUrl: URL): string {
	const parser = new DOMParser();
	const doc = parser.parseFromString(htmlContent, 'text/html');

	// Handle relative URLs for images, links, videos, and audio embeds.
	doc.querySelectorAll('img').forEach(img => makeUrlAbsolute(img, 'srcset', baseUrl));
	doc.querySelectorAll('img').forEach(img => makeUrlAbsolute(img, 'src', baseUrl));
	doc.querySelectorAll('a').forEach(link => makeUrlAbsolute(link, 'href', baseUrl));
	doc.querySelectorAll('video').forEach(video => makeUrlAbsolute(video, 'src', baseUrl));
	doc.querySelectorAll('audio').forEach(audio => makeUrlAbsolute(audio, 'src', baseUrl));
	doc.querySelectorAll(':is(video, audio) :is(source, track)').forEach(sourceOrTrack => makeUrlAbsolute(sourceOrTrack, 'src', baseUrl));

	// Serialize back to HTML
	const serializer = new XMLSerializer();
	let result = '';
	Array.from(doc.body.childNodes).forEach(node => {
		if (node.nodeType === Node.ELEMENT_NODE) {
			result += serializer.serializeToString(node);
		} else if (node.nodeType === Node.TEXT_NODE) {
			result += node.textContent;
		}
	});

	return result;
}
