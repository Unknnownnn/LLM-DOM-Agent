

const SYSTEM_PROMPT = "You are an analytical engine. Read the provided webpage text and determine the logical next step or correct option. You must return YOUR ENTIRE RESPONSE as a single, valid JSON object.";

const LOCAL_SERVER_URL = "http://localhost:5000";
const FETCH_TIMEOUT_MS = 90000;   // 90 seconds — plenty for LLM round-trip
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000; // 2s, 4s, 8s exponential backoff

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Allows manual triggers from other parts of the extension if added later
    if (message.action === "process_page_via_api") {
        handleApiFlow(message.tabId)
            .then(result => sendResponse(result))
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }

    if (message.action === "process_page_via_native") {
        handleNativeFlow(message.tabId)
            .then(result => sendResponse(result))
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }
});

let isAutoPilot = false;

browser.commands.onCommand.addListener((command) => {
    if (command === "stop_autopilot") {
        isAutoPilot = false;
        console.log("AutoPilot STOPPED by user (Alt+X)!");
    }
});

// Listener for the extension icon click (or Alt+A)
browser.action.onClicked.addListener(async (tab) => {
    if (isAutoPilot) {
        console.log("AutoPilot is already running. Press Alt+X to stop.");
        return;
    }

    isAutoPilot = true;
    console.log("AutoPilot STARTED!");

    let lastPageText = '';

    while (isAutoPilot) {
        try {
            console.log("Sending data to Local Python Server...");
            const result = await handleLocalServerFlow(tab.id, lastPageText);

            if (result.newPageText) {
                lastPageText = result.newPageText;
            }

            if (!result.success) {
                console.log("AutoPilot stopping due to:", result.message);
                isAutoPilot = false;
                break;
            }

            // No fixed delay here — handleLocalServerFlow already waited for page change
            
        } catch (e) {
            console.error("Error in AutoPilot:", e);
            if (isAutoPilot) {
                console.log("Connection hiccup or page still loading. Retrying in 5 seconds...");
                await new Promise(resolve => setTimeout(resolve, 5000));
            } else {
                break;
            }
        }
    }
});

// ─── Utility: Fetch with timeout + retries ──────────────────────────────────

async function fetchWithTimeout(url, options, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (err) {
        clearTimeout(id);
        if (err.name === 'AbortError') {
            throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
        }
        throw err;
    }
}

async function fetchWithRetry(url, options, maxRetries = MAX_RETRIES, timeoutMs = FETCH_TIMEOUT_MS) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`[Fetch] Attempt ${attempt}/${maxRetries} → ${url}`);
            const response = await fetchWithTimeout(url, options, timeoutMs);
            return response;
        } catch (err) {
            lastError = err;
            console.warn(`[Fetch] Attempt ${attempt} failed: ${err.message}`);
            if (attempt < maxRetries) {
                const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                console.log(`[Fetch] Retrying in ${delay / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw new Error(`All ${maxRetries} fetch attempts failed. Last error: ${lastError.message}`);
}

// ─── Utility: Check server health ───────────────────────────────────────────

async function checkServerHealth() {
    try {
        const res = await fetchWithTimeout(`${LOCAL_SERVER_URL}/health`, { method: "GET" }, 5000);
        if (res.ok) {
            const data = await res.json();
            return data.status === "ok";
        }
        return false;
    } catch {
        return false;
    }
}

// ─── Utility: Extract clickable option texts from the page ──────────────────

async function extractAvailableOptions(tabId) {
    try {
        const response = await browser.tabs.sendMessage(tabId, { action: "get_options" });
        if (response && response.options) {
            return response.options;
        }
    } catch (e) {
        console.warn("Could not extract options from page:", e.message);
    }
    return [];
}

// Fuzzy matching is handled locally inside content.js (Levenshtein, no server round-trip).

// ─── Utility: Wait for page to navigate to a new question ───────────────────

/**
 * Polls the page text every 600ms until it differs from `originalText`.
 * Returns true if page changed, false if timed out.
 * This prevents the autopilot from re-answering the same question while
 * the browser is still loading the next one.
 */
async function waitForPageChange(tabId, originalText, timeoutMs = 12000) {
    const start = Date.now();
    console.log('[*] Waiting for page to navigate to next question...');
    while (Date.now() - start < timeoutMs) {
        await new Promise(r => setTimeout(r, 600));
        try {
            const res = await browser.tabs.sendMessage(tabId, { action: 'extract_text' });
            if (res && res.text && res.text.trim() !== originalText.trim()) {
                console.log(`[*] Page changed after ${Math.round((Date.now() - start) / 100) / 10}s — starting next cycle.`);
                return true;
            }
        } catch (e) {
            // Page might still be loading (content script temporarily unavailable)
        }
    }
    console.warn('[!] Page did not change within timeout — proceeding anyway.');
    return false;
}

/**
 * Handles the flow of extracting text, querying an external LLM via Fetch API, 
 * and instructing the content script to click the resulting element.
 */
async function handleApiFlow(tabId) {
    // 1. Get text from the content script
    const response = await browser.tabs.sendMessage(tabId, { action: "extract_text" });
    if (!response || !response.text) {
        throw new Error("Failed to extract text from the page.");
    }

    const pageText = response.text;

    // 2. Query the LLM API (All cross-origin requests handled here to avoid CORS)
    const llmResponse = await queryLLM(pageText);

    // 3. Parse JSON response
    let actionData;
    try {
        actionData = JSON.parse(llmResponse);
    } catch (e) {
        console.error("LLM did not return valid JSON.", llmResponse);
        throw new Error("Invalid JSON from LLM");
    }

    // 4. Send target back to content script to perform interaction
    if (actionData && actionData.target_element_text) {
        const clickResponse = await browser.tabs.sendMessage(tabId, {
            action: "click_element",
            target_element_text: actionData.target_element_text
        });
        return clickResponse;
    }

    return { success: false, message: "No target_element_text provided by LLM." };
}

/**
 * Calls the LLM API, strictly instructing it to return a JSON object.
 */
async function queryLLM(pageText) {
    if (LLM_API_KEY === "YOUR_API_KEY_HERE") {
        throw new Error("Please insert your LLM API Key in background.js");
    }

    const payload = {
        model: MODEL_NAME,
        messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: `Here is the webpage text:\n\n${pageText}\n\nProvide the JSON with 'target_element_text' to click.` }
        ]
        // Note: response_format is removed as not all OpenRouter models support it. We rely on the prompt to enforce JSON.
    };

    const res = await fetch(LLM_API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${LLM_API_KEY}`,
            "HTTP-Referer": "https://github.com/extension", // Optional but recommended by OpenRouter
            "X-Title": "LLM DOM Agent" // Optional but recommended by OpenRouter
        },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        throw new Error(`LLM API request failed with status ${res.status}`);
    }

    const data = await res.json();
    return data.choices[0].message.content;
}

// ------------------------------------------------------------------
// Local HTTP Server Flow
// Routes data to a local Python HTTP server running on port 5000
// ------------------------------------------------------------------
async function handleLocalServerFlow(tabId, lastPageText = '') {
    // 0. Health check — verify server is reachable before doing work
    const isHealthy = await checkServerHealth();
    if (!isHealthy) {
        console.error("[!] Local server is not reachable. Is server.py running?");
        return { success: false, message: "Local server is not reachable. Start server.py first." };
    }

    // 1. Extract text
    let response;
    try {
        response = await browser.tabs.sendMessage(tabId, { action: "extract_text" });
    } catch (e) {
        console.error("[!] Could not communicate with content script:", e.message);
        return { success: false, message: "Content script not responding. Try reloading the page." };
    }

    if (!response || !response.text) {
        throw new Error("Failed to extract text from the page.");
    }

    // 1b. Extract available clickable options from the page
    const availableOptions = await extractAvailableOptions(tabId);
    console.log(`[*] Found ${availableOptions.length} clickable options on page.`);

    // 2. Send data to local HTTP server.
    // NOTE: We use fetchWithTimeout directly (NO retry) because /process is not idempotent.
    // If the server processed the request but the connection broke before the extension read
    // the response, retrying would cause the same answer to be clicked multiple times.
    console.log('Sending text to local python server...');
    let serverRes;
    try {
        serverRes = await fetchWithTimeout(`${LOCAL_SERVER_URL}/process`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                system_prompt: SYSTEM_PROMPT,
                page_text: response.text,
                available_options: availableOptions
            })
        });
    } catch (e) {
        console.error('[!] Request to local server failed:', e.message);
        return { success: false, message: `Server communication failed: ${e.message}` };
    }

    let actionData;
    try {
        actionData = await serverRes.json();
    } catch (e) {
        console.error("[!] Could not parse server response as JSON:", e.message);
        return { success: false, message: "Invalid response from server." };
    }

    if (actionData.error) {
        throw new Error("Server error: " + actionData.error);
    }

    // 3. Send target back to content script to perform interaction
    //    content.js handles fuzzy matching locally if exact/partial match fails.
    if (actionData && actionData.target_element_text) {
        let targetText = actionData.target_element_text;
        console.log(`[*] Instructing content script to click: "${targetText}"`);

        let clickResponse;
        try {
            clickResponse = await browser.tabs.sendMessage(tabId, {
                action: "click_element",
                target_element_text: targetText
            });
        } catch (e) {
            console.error("[!] Content script click failed:", e.message);
            clickResponse = { success: false };
        }

        // 4. If click succeeded: click Next, then wait for page to actually change.
        //    If click failed: log verbosely and try to skip anyway.
        if (clickResponse && clickResponse.success) {
            console.log('Option clicked. Clicking Next...');
            await new Promise(resolve => setTimeout(resolve, 500));

            let nextResp;
            try {
                nextResp = await browser.tabs.sendMessage(tabId, { action: 'click_next' });
            } catch (e) {
                console.warn('[!] Could not send click_next:', e.message);
                nextResp = { success: false };
            }

            if (!nextResp.success) {
                return { success: false, message: 'No next button found.' };
            }

            // Wait until the page actually changes before starting the next cycle.
            // This is what prevents the "same answer 3 times" bug — without this,
            // autopilot would immediately re-process the same question from cache.
            await waitForPageChange(tabId, response.text);
            return { success: true };

        } else {
            console.warn(`[✗] FAILED to mark any option. LLM said: "${targetText}"`);
            console.warn('[✗] This question may need manual intervention.');
            console.log('[→] Attempting to skip to next question anyway...');
            await new Promise(resolve => setTimeout(resolve, 500));
            try {
                const skipResp = await browser.tabs.sendMessage(tabId, { action: 'click_next' });
                if (skipResp && skipResp.success) {
                    console.log('[→] Skipped to next question.');
                    await waitForPageChange(tabId, response.text);
                    return { success: true };
                }
            } catch (e) {
                console.warn('[!] Skip-next also failed:', e.message);
            }
            return { success: false, message: 'Failed to mark option and could not skip.' };
        }

    } else if (actionData && actionData.code_to_paste) {
        // --- CODING QUESTION LOGIC ---
        await browser.tabs.sendMessage(tabId, {
            action: 'copy_to_clipboard',
            text: actionData.code_to_paste
        });
        console.log('Code copied to clipboard. Halting AutoPilot for manual paste and testing.');
        return { success: false, message: 'Coding question detected. Code copied to clipboard. AutoPilot paused.' };
    }

    return { success: false, message: 'No target_element_text or code_to_paste provided by local server.' };
}
