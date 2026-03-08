// DOM-free string utilities that can be safely imported by both popup and service worker.

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function escapeMarkdown(str: string): string {
	return str.replace(/([[\]])/g, '\\$1');
}

export function escapeValue(value: string): string {
	return value.replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export function unescapeValue(value: string): string {
	return value.replace(/\\"/g, '"').replace(/\\n/g, '\n');
}

export function escapeDoubleQuotes(str: string): string {
	return str.replace(/"/g, '\\"');
}

export function escapeHtml(unsafe: string): string {
	return unsafe
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

export function formatDuration(ms: number): string {
	if (ms < 1000) {
		return `${Math.round(ms)}ms`;
	} else {
		return `${(ms / 1000).toFixed(2)}s`;
	}
}

export function getDomain(url: string): string {
	try {
		const urlObj = new URL(url);
		const hostname = urlObj.hostname;

		// Handle local development URLs
		if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.match(/^(\d{1,3}\.){3}\d{1,3}$/)) {
			return hostname;
		}

		const hostParts = hostname.split('.');

		// Handle special cases like co.uk, com.au, etc.
		if (hostParts.length > 2) {
			const lastTwo = hostParts.slice(-2).join('.');
			if (lastTwo.match(/^(co|com|org|net|edu|gov|mil)\.[a-z]{2}$/)) {
				return hostParts.slice(-3).join('.');
			}
		}

		return hostParts.slice(-2).join('.');
	} catch (error) {
		console.warn('Invalid URL:', url);
		return '';
	}
}

// Platform-independent sanitizeFileName. Accepts an optional platform hint
// to apply platform-specific rules. When no platform is provided (e.g. in a
// service worker where navigator is unavailable), a safe cross-platform
// fallback is used.
export function sanitizeFileNameCore(fileName: string, platform?: string): string {
	const isWindows = platform ? /win/i.test(platform) : false;
	const isMac = platform ? /mac/i.test(platform) : false;
	const hasPlatform = !!platform;

	// First remove Obsidian-specific characters that should be sanitized across all platforms
	let sanitized = fileName.replace(/[#|\^\[\]]/g, '');

	if (hasPlatform && isWindows) {
		sanitized = sanitized
			.replace(/[<>:"\/\\?*\x00-\x1F]/g, '')
			.replace(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i, '_$1$2')
			.replace(/[\s.]+$/, '');
	} else if (hasPlatform && isMac) {
		sanitized = sanitized
			.replace(/[\/:\x00-\x1F]/g, '')
			.replace(/^\./, '_');
	} else if (hasPlatform) {
		// Linux and other known systems
		sanitized = sanitized
			.replace(/[<>:"\/\\|?*\x00-\x1F]/g, '')
			.replace(/^\./, '_');
	} else {
		// No platform info (service worker fallback) - apply most restrictive rules
		sanitized = sanitized
			.replace(/[<>:"\/\\|?*\x00-\x1F]/g, '')
			.replace(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i, '_$1$2')
			.replace(/[\s.]+$/, '')
			.replace(/^\./, '_');
	}

	// Common operations for all platforms
	sanitized = sanitized
		.replace(/^\.+/, '') // Remove leading periods
		.trim()
		.slice(0, 245); // Trim to 245 characters, leaving room to append ' 1.md'

	// Ensure the file name is not empty
	if (sanitized.length === 0) {
		sanitized = 'Untitled';
	}

	return sanitized;
}
