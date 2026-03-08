// DOM-free prompt variable replacement that can be used by both popup and service worker.

import { PromptVariable } from '../types/types';

// Replaces prompt variable placeholders in text with LLM responses.
// Accepts an optional filterFn for applying filters in popup contexts.
// In service worker contexts, filters are pre-applied before sending the payload.
export function replacePromptVariablesInText(
	text: string,
	promptVariables: PromptVariable[],
	promptResponses: any[],
	filterFn?: (value: string, filterString: string) => string
): string {
	return text.replace(/{{(?:prompt:)?"([\s\S]*?)"(\|[\s\S]*?)?}}/g, (match, promptText, filters) => {
		const variable = promptVariables.find(v => v.prompt === promptText);
		if (!variable) return match;

		const response = promptResponses.find(r => r.key === variable.key);
		if (response && response.user_response !== undefined) {
			let value = response.user_response;

			// Handle array or object responses
			if (typeof value === 'object') {
				try {
					value = JSON.stringify(value, null, 2);
				} catch (error) {
					console.error('Error stringifying object:', error);
					value = String(value);
				}
			}

			if (filters && filterFn) {
				value = filterFn(value, filters.slice(1));
			}

			return value;
		}
		return match;
	});
}
