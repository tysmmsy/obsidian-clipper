// DOM-free LLM client that can be used by both popup and service worker.

import { PromptVariable, ModelConfig, Provider } from '../types/types';

interface LLMResponse {
	prompts_responses: { [key: string]: string };
}

export async function sendToLLM(
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
		`You are a helpful assistant. Please respond with one JSON object named \`prompts_responses\` — no explanatory text before or after. Use the keys provided, e.g. \`prompt_1\`, \`prompt_2\`, and fill in the values. Values should be Markdown strings unless otherwise specified. Make your responses concise. For example, your response should look like: {"prompts_responses":{"prompt_1":"tag1, tag2, tag3","prompt_2":"- bullet1\\n- bullet 2\\n- bullet3"}}`;

	const promptContent = {
		prompts: promptVariables.reduce((acc, { key, prompt }) => {
			acc[key] = prompt;
			return acc;
		}, {} as { [key: string]: string })
	};

	let requestUrl: string;
	let requestBody: any;
	let headers: HeadersInit = {
		'Content-Type': 'application/json',
	};

	if (provider.name.toLowerCase().includes('hugging')) {
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
		headers = {
			...headers,
			'Authorization': `Bearer ${provider.apiKey}`
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
		headers = {
			...headers,
			'api-key': provider.apiKey
		};
	} else if (provider.name.toLowerCase().includes('anthropic')) {
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
		headers = {
			...headers,
			'x-api-key': provider.apiKey,
			'anthropic-version': '2023-06-01',
			'anthropic-dangerous-direct-browser-access': 'true'
		};
	} else if (provider.name.toLowerCase().includes('perplexity')) {
		requestUrl = provider.baseUrl;
		requestBody = {
			model: model.providerModelId,
			max_tokens: 1600,
			messages: [
				{ role: 'system', content: systemContent },
				{ role: 'user', content: `
					"${promptContext}"
					"${JSON.stringify(promptContent)}"`
				}
			],
			temperature: 0.3
		};
		headers = {
			...headers,
			'HTTP-Referer': 'https://obsidian.md/',
			'X-Title': 'Obsidian Web Clipper',
			'Authorization': `Bearer ${provider.apiKey}`
		};
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
	} else {
		// Default request format
		requestUrl = provider.baseUrl;
		requestBody = {
			model: model.providerModelId,
			messages: [
				{ role: 'system', content: systemContent },
				{ role: 'user', content: `${promptContext}` },
				{ role: 'user', content: `${JSON.stringify(promptContent)}` }
			]
		};
		headers = {
			...headers,
			'HTTP-Referer': 'https://obsidian.md/',
			'X-Title': 'Obsidian Web Clipper',
			'Authorization': `Bearer ${provider.apiKey}`
		};
	}

	const response = await fetch(requestUrl, {
		method: 'POST',
		headers: headers,
		body: JSON.stringify(requestBody)
	});

	if (!response.ok) {
		const errorText = await response.text();
		console.error(`${provider.name} error response:`, errorText);

		// Add specific message for Ollama 403 errors
		if (provider.name.toLowerCase().includes('ollama') && response.status === 403) {
			throw new Error(
				`Ollama cannot process requests originating from a browser extension without setting OLLAMA_ORIGINS. ` +
				`See instructions at https://help.obsidian.md/web-clipper/interpreter`
			);
		}

		throw new Error(`${provider.name} error: ${response.statusText} ${errorText}`);
	}

	const responseText = await response.text();

	let data;
	try {
		data = JSON.parse(responseText);
	} catch (error) {
		console.error('Error parsing JSON response:', error);
		throw new Error(`Failed to parse response from ${provider.name}`);
	}

	let llmResponseContent: string;
	if (provider.name.toLowerCase().includes('anthropic')) {
		// Handle Anthropic's nested content structure
		const textContent = data.content[0]?.text;
		if (textContent) {
			try {
				const parsed = JSON.parse(textContent);
				llmResponseContent = JSON.stringify(parsed);
			} catch {
				llmResponseContent = textContent;
			}
		} else {
			llmResponseContent = JSON.stringify(data);
		}
	} else if (provider.name.toLowerCase().includes('ollama')) {
		const messageContent = data.message?.content;
		if (messageContent) {
			try {
				const parsed = JSON.parse(messageContent);
				llmResponseContent = JSON.stringify(parsed);
			} catch {
				llmResponseContent = messageContent;
			}
		} else {
			llmResponseContent = JSON.stringify(data);
		}
	} else {
		llmResponseContent = data.choices[0]?.message?.content || JSON.stringify(data);
	}

	return parseLLMResponse(llmResponseContent, promptVariables);
}

export function parseLLMResponse(responseContent: string, promptVariables: PromptVariable[]): { promptResponses: any[] } {
	try {
		let parsedResponse: LLMResponse;

		// If responseContent is already an object, convert to string
		if (typeof responseContent === 'object') {
			responseContent = JSON.stringify(responseContent);
		}

		// Helper function to sanitize JSON string
		const sanitizeJsonString = (str: string) => {
			// First, normalize all newlines to \n
			let result = str.replace(/\r\n/g, '\n');

			// Escape newlines properly
			result = result.replace(/\n/g, '\\n');

			// Escape quotes that are part of the content
			result = result.replace(/(?<!\\)"/g, '\\"');

			// Then unescape the quotes that are JSON structural elements
			result = result.replace(/(?<=[{[,:]\s*)\\"/g, '"')
				.replace(/\\"(?=\s*[}\],:}])/g, '"');

			return result
				// Replace curly quotes
				.replace(/[\u201C\u201D]/g, '\\"')
				// Remove any bad control characters
				.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
				// Remove any whitespace between quotes and colons
				.replace(/"\s*:/g, '":')
				.replace(/:\s*"/g, ':"')
				// Fix any triple or more backslashes
				.replace(/\\{3,}/g, '\\\\');
		};

		// First try to parse the content directly
		try {
			const sanitizedContent = sanitizeJsonString(responseContent);
			parsedResponse = JSON.parse(sanitizedContent);
		} catch (e) {
			// If direct parsing fails, try to extract and parse the JSON content
			const jsonMatch = responseContent.match(/\{[\s\S]*\}/);
			if (!jsonMatch) {
				throw new Error('No JSON object found in response');
			}

			// Try parsing with minimal sanitization first
			try {
				const minimalSanitized = jsonMatch[0]
					.replace(/[\u201C\u201D]/g, '"')
					.replace(/\r\n/g, '\\n')
					.replace(/\n/g, '\\n');
				parsedResponse = JSON.parse(minimalSanitized);
			} catch (minimalError) {
				// If minimal sanitization fails, try full sanitization
				const sanitizedMatch = sanitizeJsonString(jsonMatch[0]);

				try {
					parsedResponse = JSON.parse(sanitizedMatch);
				} catch (fullError) {
					// Last resort: try to manually rebuild the JSON structure
					const prompts_responses: { [key: string]: string } = {};

					// Extract each prompt response separately
					promptVariables.forEach((variable, index) => {
						const promptKey = `prompt_${index + 1}`;
						const promptRegex = new RegExp(`"${promptKey}"\\s*:\\s*"([^]*?)(?:"\\s*,|"\\s*})`, 'g');
						const match = promptRegex.exec(jsonMatch[0]);
						if (match) {
							let content = match[1]
								.replace(/"/g, '\\"')
								.replace(/\r\n/g, '\\n')
								.replace(/\n/g, '\\n');
							prompts_responses[promptKey] = content;
						}
					});

					const rebuiltJson = JSON.stringify({ prompts_responses });
					parsedResponse = JSON.parse(rebuiltJson);
				}
			}
		}

		// Validate the response structure
		if (!parsedResponse?.prompts_responses) {
			return { promptResponses: [] };
		}

		// Convert escaped newlines to actual newlines in the responses
		Object.keys(parsedResponse.prompts_responses).forEach(key => {
			if (typeof parsedResponse.prompts_responses[key] === 'string') {
				parsedResponse.prompts_responses[key] = parsedResponse.prompts_responses[key]
					.replace(/\\n/g, '\n')
					.replace(/\r/g, '');
			}
		});

		// Map the responses to their prompts
		const promptResponses = promptVariables.map(variable => ({
			key: variable.key,
			prompt: variable.prompt,
			user_response: parsedResponse.prompts_responses[variable.key] || ''
		}));

		return { promptResponses };
	} catch (parseError) {
		console.error('Failed to parse LLM response:', parseError);
		return { promptResponses: [] };
	}
}
