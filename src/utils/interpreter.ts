import { generalSettings, saveSettings } from './storage-utils';
import { PromptVariable, Template, ModelConfig } from '../types/types';
import { compileTemplate } from './template-compiler';
import { applyFilters } from './filters';
import { formatDuration } from './string-utils';
import { adjustNoteNameHeight } from './ui-utils';
import { debugLog } from './debug';
import { getMessage } from './i18n';
import { updateTokenCount } from './token-counter';
import { sendToLLM as sendToLLMCore } from './llm-client';
import { replacePromptVariablesInText as replacePromptVariablesInTextCore } from './prompt-utils';

const RATE_LIMIT_RESET_TIME = 60000; // 1 minute in milliseconds
let lastRequestTime = 0;

// Store event listeners for cleanup
const eventListeners = new WeakMap<HTMLElement, { [key: string]: EventListener }>();

// Wrapper that adds rate limiting and passes providers from generalSettings
export async function sendToLLM(promptContext: string, content: string, promptVariables: PromptVariable[], model: ModelConfig): Promise<{ promptResponses: any[] }> {
	debugLog('Interpreter', 'Sending request to LLM...');

	const now = Date.now();
	if (now - lastRequestTime < RATE_LIMIT_RESET_TIME) {
		throw new Error(`Rate limit cooldown. Please wait ${Math.ceil((RATE_LIMIT_RESET_TIME - (now - lastRequestTime)) / 1000)} seconds before trying again.`);
	}

	lastRequestTime = now;
	const result = await sendToLLMCore(promptContext, content, promptVariables, model, generalSettings.providers);
	return result;
}

export function collectPromptVariables(template: Template | null): PromptVariable[] {
	const promptMap = new Map<string, PromptVariable>();
	const promptRegex = /{{(?:prompt:)?"([\s\S]*?)"(\|.*?)?}}/g;
	let match;

	function addPrompt(prompt: string, filters: string) {
		if (!promptMap.has(prompt)) {
			const key = `prompt_${promptMap.size + 1}`;
			promptMap.set(prompt, { key, prompt, filters });
		}
	}

	if (template?.noteContentFormat) {
		while ((match = promptRegex.exec(template.noteContentFormat)) !== null) {
			addPrompt(match[1], match[2] || '');
		}
	}

	if (template?.properties) {
		for (const property of template.properties) {
			let propertyValue = property.value;
			while ((match = promptRegex.exec(propertyValue)) !== null) {
				addPrompt(match[1], match[2] || '');
			}
		}
	}

	const allInputs = document.querySelectorAll('input, textarea');
	allInputs.forEach((input) => {
		if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
			let inputValue = input.value;
			while ((match = promptRegex.exec(inputValue)) !== null) {
				addPrompt(match[1], match[2] || '');
			}
		}
	});

	return Array.from(promptMap.values());
}

export async function initializeInterpreter(template: Template, variables: { [key: string]: string }, tabId: number, currentUrl: string) {
	const interpreterContainer = document.getElementById('interpreter');
	const interpretBtn = document.getElementById('interpret-btn');
	const promptContextTextarea = document.getElementById('prompt-context') as HTMLTextAreaElement;
	const modelSelect = document.getElementById('model-select') as HTMLSelectElement;

	function removeOldListeners(element: HTMLElement, eventType: string) {
		const listeners = eventListeners.get(element);
		if (listeners && listeners[eventType]) {
			element.removeEventListener(eventType, listeners[eventType]);
		}
	}

	function storeListener(element: HTMLElement, eventType: string, listener: EventListener) {
		let listeners = eventListeners.get(element);
		if (!listeners) {
			listeners = {};
			eventListeners.set(element, listeners);
		}
		removeOldListeners(element, eventType);
		listeners[eventType] = listener;
		element.addEventListener(eventType, listener);
	}

	const promptVariables = collectPromptVariables(template);

	// Hide interpreter if it's disabled or there are no prompt variables
	if (!generalSettings.interpreterEnabled || promptVariables.length === 0) {
		if (interpreterContainer) interpreterContainer.style.display = 'none';
		if (interpretBtn) interpretBtn.style.display = 'none';
		return;
	}

	if (interpreterContainer) interpreterContainer.style.display = 'flex';
	if (interpretBtn) interpretBtn.style.display = 'inline-block';
	
	if (promptContextTextarea) {
		const tokenCounter = document.getElementById('token-counter');
		
		const inputListener = () => {
			template.context = promptContextTextarea.value;
			if (tokenCounter) {
				updateTokenCount(promptContextTextarea.value, tokenCounter);
			}
		};
		
		storeListener(promptContextTextarea, 'input', inputListener);

		let promptToDisplay =
			template.context
			|| generalSettings.defaultPromptContext
			|| '{{fullHtml|remove_html:("#navbar,.footer,#footer,header,footer,style,script")|strip_tags:("script,h1,h2,h3,h4,h5,h6,meta,a,ol,ul,li,p,em,strong,i,b,s,strike,u,sup,sub,img,video,audio,math,table,cite,td,th,tr,caption")|strip_attr:("alt,src,href,id,content,property,name,datetime,title")}}';
		promptToDisplay = await compileTemplate(tabId, promptToDisplay, variables, currentUrl);
		promptContextTextarea.value = promptToDisplay;
		
		// Initial token count
		if (tokenCounter) {
			updateTokenCount(promptContextTextarea.value, tokenCounter);
		}
	}

	if (template) {
		// Only add click listener if auto-run is disabled
		if (interpretBtn && !generalSettings.interpreterAutoRun) {
			const clickListener = async () => {
				const selectedModelId = modelSelect.value;
				const modelConfig = generalSettings.models.find(m => m.id === selectedModelId);
				if (!modelConfig) {
					throw new Error(`Model configuration not found for ${selectedModelId}`);
				}
				await handleInterpreterUI(template, variables, tabId, currentUrl, modelConfig);
			};
			storeListener(interpretBtn, 'click', clickListener);
		}

		if (modelSelect) {
			const changeListener = async () => {
				generalSettings.interpreterModel = modelSelect.value;
				await saveSettings();
			};
			storeListener(modelSelect, 'change', changeListener);

			modelSelect.style.display = 'inline-block';
			
			// Filter enabled models
			const enabledModels = generalSettings.models.filter(model => model.enabled);
			
			// Clear existing options
			modelSelect.textContent = '';
			
			// Add model options
			enabledModels.forEach(model => {
				const option = document.createElement('option');
				option.value = model.id;
				option.textContent = model.name;
				modelSelect.appendChild(option);
			});

			// Check if last selected model exists and is enabled
			const lastSelectedModel = enabledModels.find(model => model.id === generalSettings.interpreterModel);
			
			if (!lastSelectedModel && enabledModels.length > 0) {
				// If last selected model is not available/enabled, use first enabled model
				generalSettings.interpreterModel = enabledModels[0].id;
				await saveSettings();
			}

			modelSelect.value = generalSettings.interpreterModel || (enabledModels[0]?.id ?? '');
		}
	}
}

export async function handleInterpreterUI(
	template: Template,
	variables: { [key: string]: string },
	tabId: number,
	currentUrl: string,
	modelConfig: ModelConfig
): Promise<void> {
	const interpreterContainer = document.getElementById('interpreter');
	const interpretBtn = document.getElementById('interpret-btn') as HTMLButtonElement;
	const interpreterErrorMessage = document.getElementById('interpreter-error') as HTMLDivElement;
	const responseTimer = document.getElementById('interpreter-timer') as HTMLSpanElement;
	const clipButton = document.getElementById('clip-btn') as HTMLButtonElement;
	const moreButton = document.getElementById('more-btn') as HTMLButtonElement;
	const promptContextTextarea = document.getElementById('prompt-context') as HTMLTextAreaElement;

	try {
		// Hide any previous error message
		interpreterErrorMessage.style.display = 'none';
		interpreterErrorMessage.textContent = '';

		// Remove any previous done or error classes
		interpreterContainer?.classList.remove('done', 'error');

		// Find the provider for this model
		const provider = generalSettings.providers.find(p => p.id === modelConfig.providerId);
		if (!provider) {
			throw new Error(`Provider not found for model ${modelConfig.name}`);
		}

		// Only check for API key if the provider requires it
		if (provider.apiKeyRequired && !provider.apiKey) {
			throw new Error(`API key is not set for provider ${provider.name}`);
		}

		const promptVariables = collectPromptVariables(template);

		if (promptVariables.length === 0) {
			throw new Error('No prompt variables found. Please add at least one prompt variable to your template.');
		}

		const contextToUse = promptContextTextarea.value;
		const contentToProcess = variables.content || '';

		// Start the timer
		const startTime = performance.now();
		let timerInterval: number;

		// Change button text and add class
		interpretBtn.textContent = getMessage('thinking');
		interpretBtn.classList.add('processing');

		// Disable the clip button
		clipButton.disabled = true;
		moreButton.disabled = true;

		// Show and update the timer
		responseTimer.style.display = 'inline';
		responseTimer.textContent = '0ms';

		// Update the timer text with elapsed time
		timerInterval = window.setInterval(() => {
			const elapsedTime = performance.now() - startTime;
			responseTimer.textContent = formatDuration(elapsedTime);
		}, 10);

		const { promptResponses } = await sendToLLM(contextToUse, contentToProcess, promptVariables, modelConfig);
		debugLog('Interpreter', 'LLM response:', { promptResponses });

		// Stop the timer and update UI
		clearInterval(timerInterval);
		const endTime = performance.now();
		const totalTime = endTime - startTime;
		responseTimer.textContent = formatDuration(totalTime);

		// Update button state
		interpretBtn.textContent = getMessage('done').toLowerCase();
		interpretBtn.classList.remove('processing');
		interpretBtn.classList.add('done');
		interpretBtn.disabled = true;

		// Add done class to container
		interpreterContainer?.classList.add('done');
		
		// Update fields with responses
		replacePromptVariables(promptVariables, promptResponses);

		// Re-enable clip button
		clipButton.disabled = false;
		moreButton.disabled = false;

		// Adjust height for noteNameField after content is replaced
		const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement | null;
		if (noteNameField instanceof HTMLTextAreaElement) {
			adjustNoteNameHeight(noteNameField);
		}

	} catch (error) {
		console.error('Error processing LLM:', error);
		
		// Revert button text and remove class in case of error
		interpretBtn.textContent = getMessage('error');
		interpretBtn.classList.remove('processing');
		interpretBtn.classList.add('error');
		interpretBtn.disabled = true;

		// Add error class to interpreter container
		interpreterContainer?.classList.add('error');

		// Hide the timer
		responseTimer.style.display = 'none';

		// Display the error message
		interpreterErrorMessage.textContent = error instanceof Error ? error.message : 'An unknown error occurred while processing the interpreter request.';
		interpreterErrorMessage.style.display = 'block';

		// Re-enable the clip button
		clipButton.disabled = false;
		moreButton.disabled = false;

		if (error instanceof Error) {
			throw new Error(`${error.message}`);
		} else {
			throw new Error('An unknown error occurred while processing the interpreter request.');
		}
	}
}

// Wrapper that passes applyFilters for popup contexts
export function replacePromptVariablesInText(
	text: string,
	promptVariables: PromptVariable[],
	promptResponses: any[]
): string {
	return replacePromptVariablesInTextCore(text, promptVariables, promptResponses, applyFilters);
}

// Similar to replaceVariables, but happens after the LLM response is received
export function replacePromptVariables(promptVariables: PromptVariable[], promptResponses: any[]) {
	const allInputs = document.querySelectorAll('input, textarea');
	allInputs.forEach((input) => {
		if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
			input.value = replacePromptVariablesInText(input.value, promptVariables, promptResponses);

			// Adjust height for noteNameField after updating its value
			if (input.id === 'note-name-field' && input instanceof HTMLTextAreaElement) {
				adjustNoteNameHeight(input);
			}
		}
	});
}