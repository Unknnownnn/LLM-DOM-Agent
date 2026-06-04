function extractHumanReadableText() {
    let text = document.body.innerText || "";
    return text.replace(/\n\s*\n/g, '\n').trim();
}

// ─── Junk filter for option extraction ──────────────────────────────────────

// Patterns that are definitely NOT answer options
const JUNK_PATTERNS = [
    /^answered(\s+\d+)?$/i,                          // "Answered" or "Answered 15/30"
    /^\d+\s*\/\s*\d+$/,                               // "15/30"
    /^marks\s*[:\-]/i,                                // "Marks : 2"
    /^negative\s+marks/i,                             // "Negative Marks : 0"
    /^marking\s*[:\-]/i,                              // "Marking Scheme:"
    /^(next|previous|submit|clear|save\s*&\s*next|mark for review|next question)$/i,
    /^question\s*(no|number)?\s*[:\-\d]/i,           // "Question No : 1"
    /^category\s*:/i,
    /^quiz\s*progress/i,
    /^(system|internet|network)\s*(status|connection)/i, // "Internet Status:", "System Status"
    /^(online|offline|connected|disconnected)$/i,     // "Online", "Offline"
    /^answer\s*here$/i,                               // "Answer here"
    /^touch\s+to\s+/i,                               // "Touch to View Question", "Touch to Answer"
    /^(tap|click|swipe|view)\s+to\s+/i,              // similar mobile UI prompts
    /^time\s*(left|remaining)\s*[:\-]/i,
    /^\d+\s*(sec|min|hr|second|minute|hour)/i,
    /^(easy|medium|hard|difficulty)\s*[:\-]?$/i,
    /^(multi\s*choice|single\s*choice|multiple\s*choice)/i, // question type labels
    // ── Coding IDE UI elements (never answer options) ─────────────────────────
    /^provide\s*custom\s*input$/i,                    // "Provide Custom Input"
    /^compile\s*(&|and)\s*run$/i,                     // "Compile & Run"
    /^submit\s*code$/i,                               // "Submit Code"
    /^debugger\s*loading/i,                           // "Debugger Loading..."
    /^compiling/i,                                    // "Compiling..."
    /^running/i,                                      // "Running..."
    /^(fill\s*your|write)\s*code/i,                   // "Fill your code here"
    /^\/\//,                                          // code comments like "// You are using GCC"
    /^#include/i,                                     // C++ includes
];

function isJunk(text) {
    const t = text.trim();
    if (!t || t.length < 2) return true;
    // Pure numbers or single chars
    if (/^\d+$/.test(t)) return true;
    // Single letter (A, B, C, D option labels by themselves)
    // Note: we keep them IF they're longer
    for (const pat of JUNK_PATTERNS) {
        if (pat.test(t)) return true;
    }
    return false;
}

/**
 * Extract clickable option texts by walking text nodes inside likely option elements.
 * Uses the SAME TreeWalker approach as clickElementByText so texts are guaranteed to match.
 */
function extractAvailableOptions() {
    const results = [];
    const seen = new Set();

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node;

    while ((node = walker.nextNode())) {
        const val = node.nodeValue.trim();
        if (!val || val.length < 2 || val.length > 250) continue;
        if (seen.has(val.toLowerCase())) continue;
        if (isJunk(val)) continue;

        // Check if this text node lives inside something clickable / option-like
        let el = node.parentElement;
        let depth = 0;
        let isOption = false;

        while (el && el.tagName !== 'BODY' && depth < 6) {
            const tag = el.tagName.toUpperCase();
            const role = el.getAttribute('role') || '';
            const cName = typeof el.className === 'string' ? el.className.toLowerCase() : '';

            if (
                tag === 'LABEL' ||
                role === 'radio' || role === 'checkbox' || role === 'option' ||
                cName.includes('option') || cName.includes('choice') ||
                cName.includes('answer') || cName.includes('radio')
            ) {
                isOption = true;
                break;
            }

            // Only check DIRECT children for radio/checkbox — NOT deep querySelector.
            // Deep search would flag any element in a large container that happens to
            // have a radio button somewhere inside (e.g. the entire question wrapper).
            for (const child of el.children) {
                const ct = child.tagName.toUpperCase();
                if (ct === 'INPUT' && (child.type === 'radio' || child.type === 'checkbox')) {
                    isOption = true;
                    break;
                }
            }
            if (isOption) break;

            el = el.parentElement;
            depth++;
        }

        if (isOption) {
            seen.add(val.toLowerCase());
            results.push(val);
        }
    }

    return results;
}

// ─── Local Levenshtein fuzzy match ───────────────────────────────────────────

function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

/**
 * Find the best matching text from `candidates` for `target`.
 * Returns { match, score } where score is 0–1 (1 = perfect).
 * Returns null if nothing exceeds the threshold.
 */
function localFuzzyMatch(target, candidates, threshold = 0.45) {
    const tLow = target.trim().toLowerCase();
    let bestMatch = null;
    let bestScore = 0;

    for (const cand of candidates) {
        const cLow = cand.trim().toLowerCase();

        // Exact
        if (cLow === tLow) return { match: cand, score: 1.0 };

        // Substring containment (strong signal)
        if (tLow.includes(cLow) || cLow.includes(tLow)) {
            const score = 0.9;
            if (score > bestScore) { bestScore = score; bestMatch = cand; }
            continue;
        }

        // Levenshtein ratio
        const dist = levenshtein(tLow, cLow);
        const score = 1 - dist / Math.max(tLow.length, cLow.length);
        if (score > bestScore) { bestScore = score; bestMatch = cand; }
    }

    if (bestScore >= threshold && bestMatch) {
        return { match: bestMatch, score: bestScore };
    }
    return null;
}

// ─── Click helpers ────────────────────────────────────────────────────────────

function clickNodeText(targetText) {
    if (!targetText) return false;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node;
    let exactMatch = null;
    let partialMatch = null;

    const targetClean = targetText.trim().toLowerCase();

    while ((node = walker.nextNode())) {
        const val = node.nodeValue.trim();
        if (!val || val.length > 250) continue;

        if (val === targetText.trim()) {
            exactMatch = node;
            break;
        }

        const valClean = val.toLowerCase();
        if (valClean === targetClean) {
            exactMatch = node;
        } else if (valClean.includes(targetClean) || targetClean.includes(valClean)) {
            if (valClean.length > 2 && targetClean.length > 2) {
                if (!partialMatch) partialMatch = node;
            }
        }
    }

    const targetNode = exactMatch || partialMatch;
    if (!targetNode) return false;

    let element = targetNode.parentElement;
    let clickable = element;
    while (clickable && clickable.tagName !== 'BODY') {
        const tag = clickable.tagName.toUpperCase();
        const role = clickable.getAttribute('role');
        const cName = typeof clickable.className === 'string' ? clickable.className.toLowerCase() : '';

        if (
            tag === 'LABEL' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'A' ||
            role === 'button' || role === 'radio' || role === 'checkbox' ||
            cName.includes('option') || cName.includes('radio')
        ) {
            element = clickable;
            break;
        }
        clickable = clickable.parentElement;
    }

    if (element) {
        console.log(`[click] Found "${targetText}" →`, element);
        element.click();
        const radio = element.querySelector('input[type="radio"], input[type="checkbox"]');
        if (radio && !radio.checked) {
            radio.checked = true;
            radio.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return true;
    }

    return false;
}

/**
 * Main click function: tries exact/partial match first, then local fuzzy fallback.
 */
function clickElementByText(targetText) {
    if (!targetText) {
        console.error("No target text provided for clicking.");
        return false;
    }

    // --- Pass 1: Direct TreeWalker match (exact / partial) ---
    if (clickNodeText(targetText)) return true;

    // --- Pass 2: Local fuzzy match against available options ---
    console.warn(`[!] No direct match for "${targetText}". Running local fuzzy match...`);
    const options = extractAvailableOptions();

    if (options.length === 0) {
        console.warn('[✗] No options found on page for fuzzy matching.');
        return false;
    }

    console.log('[fuzzy] Candidates:', options);
    const result = localFuzzyMatch(targetText, options);

    if (result) {
        console.log(`[fuzzy] Best match: "${result.match}" (score: ${result.score.toFixed(2)})`);
        if (clickNodeText(result.match)) {
            console.log(`[fuzzy] ✓ Clicked fuzzy match "${result.match}"`);
            return true;
        }
        console.warn(`[fuzzy] ✗ Found match "${result.match}" but could not click it.`);
    } else {
        console.warn(`[fuzzy] ✗ Nothing similar enough to "${targetText}" found.`);
        console.warn('[fuzzy] Available options were:', options);
    }

    return false;
}

function clickNextButton() {
    console.log("NEXT TRIGGERED");
    const nextTexts = ["next", "save & next", "submit answer", "submit", "next question"];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node;

    while ((node = walker.nextNode())) {
        const val = node.nodeValue.trim().toLowerCase();
        if (nextTexts.includes(val)) {
            let element = node.parentElement;
            let clickable = element;
            while (clickable && clickable.tagName !== 'BODY') {
                if (clickable.tagName === 'BUTTON' || clickable.tagName === 'A' || clickable.tagName === 'INPUT' || clickable.getAttribute('role') === 'button') {
                    element = clickable;
                    break;
                }
                clickable = clickable.parentElement;
            }
            element.click();
            console.log("Clicked NEXT button:", element);
            return true;
        }
    }
    console.warn("Could not find a Next or Submit button.");
    return false;
}

// ─── Message listener ─────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "extract_text") {
        const text = extractHumanReadableText();
        sendResponse({ text: text });

    } else if (request.action === "get_options") {
        const options = extractAvailableOptions();
        console.log("[get_options] Found:", options);
        sendResponse({ options: options });

    } else if (request.action === "click_element") {
        const success = clickElementByText(request.target_element_text);
        return Promise.resolve({ success, message: success ? "Clicked successfully." : "Element not found." });

    } else if (request.action === "click_next") {
        const success = clickNextButton();
        return Promise.resolve({ success });

    } else if (request.action === "copy_to_clipboard") {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(request.text).catch(() => fallbackCopy(request.text));
            } else {
                fallbackCopy(request.text);
            }
        } catch (e) {
            console.error(e);
        }
        return Promise.resolve({ success: true });
    }

    function fallbackCopy(text) {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (e) { }
        document.body.removeChild(ta);
    }

    return true;
});
