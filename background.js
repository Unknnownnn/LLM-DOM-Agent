

const SYSTEM_PROMPT = "You are an analytical engine. Read the provided webpage text and determine the logical next step or correct option. You must return YOUR ENTIRE RESPONSE as a single, valid JSON object.";

const LOCAL_SERVER_URL = "http://localhost:5000";
const FETCH_TIMEOUT_MS = 120000;  
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000; 

const FATAL_STOP_REASONS = [
    "Local server is not reachable",
    "No next button found",
    "Coding question detected"
];

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

async function setAutoPilot(val) {
    isAutoPilot = val;
    await browser.storage.session.set({ isAutoPilot: val });
}

function startKeepalive() {
    browser.alarms.create('keepalive', { periodInMinutes: 0.4 }); 
}
function stopKeepalive() {
    browser.alarms.clear('keepalive');
}

browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'keepalive') {
        console.log('[keepalive] SW pinged to stay alive.');
    }
});

browser.runtime.onStartup.addListener(async () => {
    const { isAutoPilot: wasRunning } = await browser.storage.session.get('isAutoPilot');
    if (wasRunning) {
        console.log('[startup] Autopilot was running before SW restart — resuming...');
        resumeAutoPilot();
    }
});

// Also check on SW install/update
browser.runtime.onInstalled.addListener(async () => {
    // Clear stale state on fresh install
    await browser.storage.session.set({ isAutoPilot: false });
});

browser.commands.onCommand.addListener((command) => {
    if (command === "stop_autopilot") {
        setAutoPilot(false);
        stopKeepalive();
        console.log("AutoPilot STOPPED by user (Alt+X)!");
    }
});

browser.action.onClicked.addListener(async (tab) => {
    if (isAutoPilot) {
        console.log("AutoPilot is already running. Press Alt+X to stop.");
        return;
    }
    await runAutoPilot(tab.id);
});

async function resumeAutoPilot() {
    // Find the active tab to resume on
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) {
        console.warn('[resume] No active tab found — cannot resume autopilot.');
        await setAutoPilot(false);
        return;
    }
    await runAutoPilot(tabs[0].id);
}

async function runAutoPilot(tabId) {
    await setAutoPilot(true);
    startKeepalive();
    console.log("AutoPilot STARTED!");

    let lastPageText = '';

    while (isAutoPilot) {
        try {
            console.log("Sending data to Local Python Server...");
            const result = await handleLocalServerFlow(tabId, lastPageText);

            if (result.newPageText) {
                lastPageText = result.newPageText;
            }

            if (!result.success) {
                const msg = result.message || '';
                const isFatal = FATAL_STOP_REASONS.some(r => msg.includes(r));
                if (isFatal) {
                    console.log("AutoPilot stopping due to:", msg);
                    await setAutoPilot(false);
                    stopKeepalive();
                    break;
                } else {
                    console.warn(`[!] Transient failure: "${msg}" — retrying in 4s...`);
                    await new Promise(resolve => setTimeout(resolve, 4000));
                }
            }

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

    // Clean up if we exited normally
    if (!isAutoPilot) {
        stopKeepalive();
    }
    console.log("AutoPilot loop exited.");
}


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

// Poll /result/<job_id> every 2s until status === "done" or timeout.
async function pollJobResult(jobId, timeoutMs = 180000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        await new Promise(r => setTimeout(r, 2000));
        try {
            const res = await fetchWithTimeout(`${LOCAL_SERVER_URL}/result/${jobId}`, { method: 'GET' }, 5000);
            if (!res.ok) {
                console.warn(`[poll] /result/${jobId} returned ${res.status}`);
                continue;
            }
            const job = await res.json();
            if (job.status === 'done') {
                console.log(`[poll] Job ${jobId} done:`, job.result);
                return job.result;
            } else if (job.status === 'error') {
                console.error(`[poll] Job ${jobId} failed:`, job.result);
                return null;
            }
            console.log(`[poll] Job ${jobId} still pending...`);
        } catch (e) {
            console.warn(`[poll] Error polling job ${jobId}:`, e.message);
        }
    }
    console.error(`[poll] Job ${jobId} timed out after ${timeoutMs / 1000}s`);
    return null;
}


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
        }
    }
    console.warn('[!] Page did not change within timeout — proceeding anyway.');
    return false;
}

async function handleApiFlow(tabId) {
    const response = await browser.tabs.sendMessage(tabId, { action: "extract_text" });
    if (!response || !response.text) {
        throw new Error("Failed to extract text from the page.");
    }

    const pageText = response.text;

    const llmResponse = await queryLLM(pageText);
    let actionData;
    try {
        actionData = JSON.parse(llmResponse);
    } catch (e) {
        console.error("LLM did not return valid JSON.", llmResponse);
        throw new Error("Invalid JSON from LLM");
    }

    if (actionData && actionData.target_element_text) {
        const clickResponse = await browser.tabs.sendMessage(tabId, {
            action: "click_element",
            target_element_text: actionData.target_element_text
        });
        return clickResponse;
    }

    return { success: false, message: "No target_element_text provided by LLM." };
}

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
    };

    const res = await fetch(LLM_API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${LLM_API_KEY}`,
            "HTTP-Referer": "https://github.com/extension", 
            "X-Title": "LLM DOM Agent"
        },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        throw new Error(`LLM API request failed with status ${res.status}`);
    }

    const data = await res.json();
    return data.choices[0].message.content;
}


async function handleLocalServerFlow(tabId, lastPageText = '') {
    const isHealthy = await checkServerHealth();
    if (!isHealthy) {
        console.error("[!] Local server is not reachable. Is server.py running?");
        return { success: false, message: "Local server is not reachable. Start server.py first." };
    }

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

    const availableOptions = await extractAvailableOptions(tabId);
    console.log(`[*] Found ${availableOptions.length} clickable options on page.`);

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
        }, 15000); 
    } catch (e) {
        console.warn('[!] Fetch to /process failed (connection dropped):', e.message);
        console.log('[→] Attempting to recover via /last_result...');
        try {
            const pollRes = await fetchWithTimeout(`${LOCAL_SERVER_URL}/last_result`, { method: 'GET' }, 6000);
            if (pollRes.ok) {
                const recovered = await pollRes.json();
                if (recovered && !recovered.error && (recovered.target_element_text || recovered.code_to_paste)) {
                    console.log('[→] Recovered result from /last_result:', recovered);
                    serverRes = { ok: true, _recoveredData: recovered };
                } else {
                    return { success: false, message: `Connection lost and no result to recover: ${e.message}` };
                }
            } else {
                return { success: false, message: `Server communication failed: ${e.message}` };
            }
        } catch (pollErr) {
            console.error('[!] Recovery poll also failed:', pollErr.message);
            return { success: false, message: `Server communication failed: ${e.message}` };
        }
    }

    let actionData;
    if (serverRes._recoveredData) {
        actionData = serverRes._recoveredData;
    } else {
        let ack;
        try {
            ack = await serverRes.json();
        } catch (e) {
            console.error("[!] Could not parse server ACK as JSON:", e.message);
            return { success: false, message: "Invalid response from server." };
        }

        if (ack.error) {
            throw new Error("Server error: " + ack.error);
        }

        if (ack.job_id) {
            console.log(`[*] Job ${ack.job_id} queued. Polling for result...`);
            actionData = await pollJobResult(ack.job_id);
            if (!actionData) {
                return { success: false, message: 'Job polling timed out or failed.' };
            }
        } else {
            actionData = ack;
        }
    }

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
        await browser.tabs.sendMessage(tabId, {
            action: 'copy_to_clipboard',
            text: actionData.code_to_paste
        });
        console.log('Code copied to clipboard. Halting AutoPilot for manual paste and testing.');
        return { success: false, message: 'Coding question detected. Code copied to clipboard. AutoPilot paused.' };
    }

    return { success: false, message: 'No target_element_text or code_to_paste provided by local server.' };
}
