

const SYSTEM_PROMPT = "You are an analytical engine. Read the provided webpage text and determine the logical next step or correct option. You must return YOUR ENTIRE RESPONSE as a single, valid JSON object.";

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

    while (isAutoPilot) {
        try {
            console.log("Sending data to Local Python Server...");
            const result = await handleLocalServerFlow(tab.id);

            if (!result.success) {
                console.log("AutoPilot stopping due to:", result.message);
                isAutoPilot = false;
                break;
            }

            console.log("Waiting 3 seconds before next cycle...");
            await new Promise(resolve => setTimeout(resolve, 3000));
            
        } catch (e) {
            console.error("Error in AutoPilot:", e);
            if (isAutoPilot) {
                console.log("Connection hiccup or page still loading. Retrying in 5 seconds...");
                await new Promise(resolve => setTimeout(resolve, 5000));
                // We DO NOT break here. It will loop back and try again!
            } else {
                break;
            }
        }
    }
});

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
async function handleLocalServerFlow(tabId) {
    // 1. Extract text
    const response = await browser.tabs.sendMessage(tabId, { action: "extract_text" });
    if (!response || !response.text) {
        throw new Error("Failed to extract text from the page.");
    }

    // 2. Send data to local HTTP server
    console.log("Sending text to local python server...");
    const serverRes = await fetch("http://localhost:5000/process", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            system_prompt: SYSTEM_PROMPT,
            page_text: response.text
        })
    });

    const actionData = await serverRes.json();

    if (actionData.error) {
        throw new Error("Server error: " + actionData.error);
    }

    // 3. Send target back to content script to perform interaction
    if (actionData && actionData.target_element_text) {
        const clickResponse = await browser.tabs.sendMessage(tabId, {
            action: "click_element",
            target_element_text: actionData.target_element_text
        });

        // 4. Wait 500ms and click the 'Next' button ONLY if the click succeeded
        if (clickResponse && clickResponse.success) {
            console.log("Option clicked successfully. Waiting 500ms before clicking next...");
            await new Promise(resolve => setTimeout(resolve, 500));
            const nextResp = await browser.tabs.sendMessage(tabId, { action: "click_next" });
            if (!nextResp.success) {
                return { success: false, message: "No next button found." };
            }
        } else {
            console.warn("Failed to mark the option. Aborting next button click.");
            return { success: false, message: "Failed to mark option." };
        }

        return { success: true };
    } else if (actionData && actionData.code_to_paste) {
        // --- NEW: CODING QUESTION LOGIC ---
        await browser.tabs.sendMessage(tabId, {
            action: "copy_to_clipboard",
            text: actionData.code_to_paste
        });
        
        console.log("Code copied to clipboard. Halting AutoPilot for manual paste and testing.");
        return { success: false, message: "Coding question detected. Code copied to clipboard. AutoPilot paused." };
    }
    
    return { success: false, message: "No target_element_text or code_to_paste provided by local server." };
}
