/**
 * popup.js
 *
 * This script runs in the context of the extension's popup window.
 * It handles user interactions, captures page data, calls the Gemini API,
 * and displays the analysis results. It securely manages the user's API
 * key and persists the last analysis result and persona using chrome.storage.sync.
 */

document.addEventListener('DOMContentLoaded', () => {
    // Get references to all the DOM elements
    const apiKeyInput = document.getElementById('apiKey');
    const saveApiKeyBtn = document.getElementById('saveApiKey');
    const personaInput = document.getElementById('persona');
    const taskInput = document.getElementById('task');
    const analyzeBtn = document.getElementById('analyzeBtn');
    const keepPersonaCheckbox = document.getElementById('keepPersona');
    const clearPersonaBtn = document.getElementById('clearPersonaBtn');
    
    // View containers
    const inputView = document.getElementById('input-view');
    const resultsView = document.getElementById('results-view');
    const resultsContent = document.getElementById('results-content');
    const clearBtn = document.getElementById('clearBtn');
    const copyBtn = document.getElementById('copyBtn');

    // --- Initial Setup ---
    // Load saved data when the popup opens
    chrome.storage.sync.get(['geminiApiKey', 'lastAnalysisResult', 'savedPersona', 'keepPersona'], (data) => {
        if (chrome.runtime.lastError) {
            console.error("Error loading data:", chrome.runtime.lastError);
            return;
        }
        if (data.geminiApiKey) apiKeyInput.value = data.geminiApiKey;
        if (data.keepPersona && data.savedPersona) {
            personaInput.value = data.savedPersona;
            keepPersonaCheckbox.checked = true;
        }
        if (data.lastAnalysisResult) {
            displayResults(data.lastAnalysisResult);
        } else {
            inputView.classList.remove('hidden');
            resultsView.classList.add('hidden');
        }
    });

    // --- Event Listeners ---
    saveApiKeyBtn.addEventListener('click', () => {
        const apiKey = apiKeyInput.value.trim();
        if (apiKey) {
            chrome.storage.sync.set({ geminiApiKey: apiKey }, () => {
                if (chrome.runtime.lastError) {
                    displayError("Failed to save API key.");
                    return;
                }
                const originalText = saveApiKeyBtn.textContent;
                saveApiKeyBtn.textContent = 'Saved!';
                setTimeout(() => { saveApiKeyBtn.textContent = originalText; }, 1500);
            });
        }
    });

    clearBtn.addEventListener('click', () => {
        chrome.storage.sync.remove('lastAnalysisResult', () => window.location.reload());
    });

    copyBtn.addEventListener('click', () => {
        const textToCopy = resultsContent.innerText;
        const tempTextArea = document.createElement('textarea');
        tempTextArea.value = textToCopy;
        document.body.appendChild(tempTextArea);
        tempTextArea.select();
        document.execCommand('copy');
        document.body.removeChild(tempTextArea);
        const originalText = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = originalText; }, 1500);
    });

    clearPersonaBtn.addEventListener('click', () => {
        personaInput.value = '';
        chrome.storage.sync.remove('savedPersona');
    });

    personaInput.addEventListener('change', () => {
        if (keepPersonaCheckbox.checked) {
            chrome.storage.sync.set({ savedPersona: personaInput.value });
        }
    });

    keepPersonaCheckbox.addEventListener('change', () => {
        const keep = keepPersonaCheckbox.checked;
        chrome.storage.sync.set({ keepPersona: keep });
        if (keep) {
            chrome.storage.sync.set({ savedPersona: personaInput.value });
        } else {
            chrome.storage.sync.remove('savedPersona');
        }
    });

    analyzeBtn.addEventListener('click', async () => {
        const persona = personaInput.value.trim();
        const task = taskInput.value.trim();
        const apiKey = apiKeyInput.value.trim();

        displayError(null);
        if (!apiKey) return displayError("Please enter and save your Gemini API key.");
        if (!persona) return displayError("Please describe the buyer persona.");
        if (!task) return displayError("Please describe the task to be completed.");

        setLoadingState(true);
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) {
                const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
                const injectionResults = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['content.js']
                });
                const pageData = injectionResults[0].result;
                await performAnalysis(apiKey, persona, task, pageData.html, screenshotDataUrl, pageData.width);
            } else {
                displayError("Could not find an active tab.");
            }
        } catch (error) {
            displayError(`An error occurred: ${error.message}.`);
        } finally {
            setLoadingState(false);
        }
    });

    /**
     * Constructs the prompt, calls the Gemini API, and displays the result.
     */
    async function performAnalysis(apiKey, persona, task, pageHtml, screenshotDataUrl, viewportWidth) {
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;
        const base64ImageData = screenshotDataUrl.split(',')[1];

        let viewportContext = `The analysis is for a desktop view (viewport width: ${viewportWidth}px).`;
        if (viewportWidth < 768) {
            viewportContext = `The user is on a mobile device (viewport width: ${viewportWidth}px). Your analysis MUST be from the perspective of a mobile user.`;
        }

        const prompt = `
            As an expert UX/UI and marketing analyst, your task is to review a webpage.

            **Viewport Context:** ${viewportContext}
            **Buyer Persona:** ${persona}
            **Task to be Completed:** ${task}

            **Analysis Task (Multi-Step):**

            **Step 1: Analyze the HTML.**
            First, analyze the provided HTML to understand the page's structure, content, and interactive elements. Form an initial hypothesis about the page's strengths and weaknesses.

            **Step 2: Visually Validate with the Screenshot.**
            Next, carefully examine the provided screenshot. **Use the visual evidence in the screenshot to validate or correct your initial analysis from the HTML.** The screenshot is the ground truth for what the user sees.

            **Step 3: Synthesize and Report.**
            Combine your findings from both steps into the final JSON output.

            **Instructions:**
            - Your analysis must be based on BOTH the HTML and the visual screenshot.
            - Your entire response must be ONLY the raw JSON object.

            **JSON Structure:**
            {
              "persona_alignment": {
                "summary": "...",
                "pros": ["...", "..."],
                "cons": ["...", "..."]
              },
              "task_completion": {
                "likelihood": "High | Medium | Low",
                "summary": "...",
                "pros": ["...", "..."],
                "cons": ["...", "..."]
              },
              "overall_recommendations": ["...", "...", "..."]
            }

            **HTML Context:** \`\`\`html ${pageHtml.substring(0, 8000)} ... \`\`\`
        `;

        const payload = {
            contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "image/png", data: base64ImageData } }] }]
        };
        const response = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

        if (!response.ok) {
            const errorBody = await response.json();
            throw new Error(`API Error (${response.status}): ${errorBody.error.message}`);
        }

        const result = await response.json();
        const textResponse = result.candidates[0].content.parts[0].text;
        
        let parsedResponse;
        try {
            parsedResponse = JSON.parse(textResponse);
        } catch (e) {
            const jsonMatch = textResponse.match(/```json\n([\s\S]*?)\n```/);
            if (jsonMatch && jsonMatch[1]) {
                parsedResponse = JSON.parse(jsonMatch[1]);
            } else {
                throw new Error("Could not parse the JSON response from the API.");
            }
        }

        chrome.storage.sync.set({ lastAnalysisResult: parsedResponse });
        displayResults(parsedResponse);
    }

    /**
     * Renders the analysis results in the popup.
     */
    function displayResults(data) {
        const createProsConsHtml = (sectionData) => {
            if (!sectionData || !sectionData.pros || !sectionData.cons) return '<p class="pl-4 text-slate-500">No detailed analysis provided.</p>';
            const prosHtml = sectionData.pros.map(pro => `<li>${pro}</li>`).join('');
            const consHtml = sectionData.cons.map(con => `<li>${con}</li>`).join('');
            return `<div class="pl-4">
                        <h4 class="font-semibold text-green-700 mt-2">Pros:</h4><ul class="list-disc list-inside text-slate-600">${prosHtml}</ul>
                        <h4 class="font-semibold text-red-700 mt-2">Cons:</h4><ul class="list-disc list-inside text-slate-600">${consHtml}</ul>
                    </div>`;
        };
        
        const createRecommendationItems = (recommendations) => {
            if (!recommendations || !Array.isArray(recommendations)) return '';
            return recommendations.map(rec => `<li class="mb-2">${rec}</li>`).join('');
        };

        resultsContent.innerHTML = `
            <div class="bg-white p-4 rounded-lg shadow-sm border border-slate-200">
                <h2 class="text-base font-bold text-slate-800 mb-2">Persona Alignment Analysis</h2>
                <p class="text-sm text-slate-600 mb-2">${data.persona_alignment.summary || ''}</p>
                ${createProsConsHtml(data.persona_alignment)}
            </div>
            <div class="bg-white p-4 rounded-lg shadow-sm border border-slate-200">
                <h2 class="text-base font-bold text-slate-800 mb-2">Task Completion Analysis</h2>
                <p class="text-sm text-slate-600 mb-2"><strong>Likelihood:</strong> ${data.task_completion.likelihood || 'N/A'}</p>
                <p class="text-sm text-slate-600 mb-2">${data.task_completion.summary || ''}</p>
                ${createProsConsHtml(data.task_completion)}
            </div>
            <div class="bg-white p-4 rounded-lg shadow-sm border border-slate-200">
                <h2 class="text-base font-bold text-slate-800 mb-2">Overall Recommendations</h2>
                <ul class="list-disc list-inside space-y-2 text-sm text-slate-600">
                    ${createRecommendationItems(data.overall_recommendations)}
                </ul>
            </div>
        `;

        inputView.classList.add('hidden');
        resultsView.classList.remove('hidden');
    }

    function displayError(message) {
        const errorContainer = document.getElementById('error-container');
        if (!errorContainer) return;
        if (message) {
            errorContainer.innerHTML = `<div class="bg-red-100 border-l-4 border-red-500 text-red-700 p-4 rounded-md mt-4" role="alert"><p class="font-bold">Error</p><p>${message}</p></div>`;
        } else {
            errorContainer.innerHTML = '';
        }
    }

    function setLoadingState(isLoading) {
        analyzeBtn.disabled = isLoading;
        if (isLoading) {
            analyzeBtn.innerHTML = `<svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>Analyzing...`;
        } else {
            analyzeBtn.innerHTML = 'Analyze Page';
        }
    }
});
