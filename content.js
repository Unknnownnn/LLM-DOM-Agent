function extractHumanReadableText() {
    let text = document.body.innerText || "";
    return text.replace(/\n\s*\n/g, '\n').trim();
}

const JUNK_PATTERNS = [
    /^answered(\s+\d+)?$/i,                         
    /^\d+\s*\/\s*\d+$/,                              
    /^marks\s*[:\-]/i,                                
    /^negative\s+marks/i,                            
    /^marking\s*[:\-]/i,                       
    /^(next|previous|submit|clear|save\s*&\s*next|mark for review|next question)$/i,
    /^question\s*(no|number)?\s*[:\-\d]/i,         
    /^category\s*:/i,
    /^quiz\s*progress/i,
    /^(system|internet|network)\s*(status|connection)/i, 
    /^(online|offline|connected|disconnected)$/i, 
    /^answer\s*here$/i,                              
    /^touch\s+to\s+/i,                              
    /^(tap|click|swipe|view)\s+to\s+/i,              
    /^time\s*(left|remaining)\s*[:\-]/i,
    /^\d+\s*(sec|min|hr|second|minute|hour)/i,
    /^(easy|medium|hard|difficulty)\s*[:\-]?$/i,
    /^(multi\s*choice|single\s*choice|multiple\s*choice)/i, 
    /^provide\s*custom\s*input$/i,                   
    /^compile\s*(&|and)\s*run$/i,                    
    /^submit\s*code$/i,                               
    /^debugger\s*loading/i,                          
    /^compiling/i,                                  
    /^running/i,                                     
    /^(fill\s*your|write)\s*code/i,                   
    /^\/\//,                                         
    /^#include/i,                                    
];

function isJunk(text) {
    const t = text.trim();

    if (!t) return true;
    for (const pat of JUNK_PATTERNS) {
        if (pat.test(t)) return true;
    }
    return false;
}

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


    if (results.length === 0) {
        const candidates = document.querySelectorAll(
            'li, [data-key], [data-value], [data-option], [data-id], [data-index], ' +
            '[data-answer], [data-choice], [onclick], [ng-click], [data-testid]'
        );
        for (const el of candidates) {
            const text = (el.innerText || el.textContent || '').trim();
            if (!text || text.length < 1 || text.length > 120) continue;
            if (seen.has(text.toLowerCase())) continue;
            if (isJunk(text)) continue;
            if (el.children.length > 3) continue;
            seen.add(text.toLowerCase());
            results.push(text);
        }
    }

    return results;
}


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

function localFuzzyMatch(target, candidates, threshold = 0.45) {
    const tLow = target.trim().toLowerCase();
    let bestMatch = null;
    let bestScore = 0;

    for (const cand of candidates) {
        const cLow = cand.trim().toLowerCase();

        if (cLow === tLow) return { match: cand, score: 1.0 };

        if (tLow.includes(cLow) || cLow.includes(tLow)) {
            const score = 0.9;
            if (score > bestScore) { bestScore = score; bestMatch = cand; }
            continue;
        }

        const dist = levenshtein(tLow, cLow);
        const score = 1 - dist / Math.max(tLow.length, cLow.length);
        if (score > bestScore) { bestScore = score; bestMatch = cand; }
    }

    if (bestScore >= threshold && bestMatch) {
        return { match: bestMatch, score: bestScore };
    }
    return null;
}


function clickNodeText(targetText) {
    if (!targetText) return false;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node;
    let exactMatch = null;
    let partialMatch = null;

    const targetClean = targetText.trim().toLowerCase();

    const matches = [];
    while ((node = walker.nextNode())) {
        const val = node.nodeValue.trim();
        if (!val || val.length > 250) continue;
        
        const valClean = val.toLowerCase();
        if (val === targetText.trim()) {
            matches.push({ node, exact: true });
        } else if (valClean === targetClean) {
            matches.push({ node, exact: true });
        } else if (valClean.includes(targetClean) || targetClean.includes(valClean)) {
            if (valClean.length > 2 && targetClean.length > 2) {
                matches.push({ node, exact: false });
            }
        }
    }

    if (matches.length === 0) return false;

    function findClickableWrapper(startNode) {
        let el = startNode.parentElement;
        while (el && el.tagName !== 'BODY') {
            const tag = el.tagName.toUpperCase();
            const role = el.getAttribute('role') || '';
            const cName = typeof el.className === 'string' ? el.className.toLowerCase() : '';

            if (
                tag === 'LABEL' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'A' || tag === 'LI' ||
                role === 'button' || role === 'radio' || role === 'checkbox' || role === 'option' ||
                cName.includes('option') || cName.includes('radio') || cName.includes('choice') || cName.includes('answer') ||
                el.hasAttribute('onclick') || el.hasAttribute('ng-click') || el.hasAttribute('data-value') || 
                el.hasAttribute('data-key') || el.hasAttribute('data-option') || el.hasAttribute('data-id')
            ) {
                return el;
            }
            
            const radio = el.querySelector('input[type="radio"], input[type="checkbox"]');
            if (radio) return el;
            
            el = el.parentElement;
        }
        return null;
    }

    let element = null;
    let bestScore = -1;

    for (const m of matches) {
        const wrapper = findClickableWrapper(m.node);
        let score = 0;
        if (m.exact) score += 10;
        if (wrapper) score += 5; 
        
        if (score > bestScore) {
            bestScore = score;
            element = wrapper || m.node.parentElement; 
        }
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

function clickElementByText(targetText) {
    if (!targetText) {
        console.error("No target text provided for clicking.");
        return false;
    }

    if (clickNodeText(targetText)) return true;

    console.warn(`[!] No direct match for "${targetText}". Running local fuzzy match...`);
    const options = extractAvailableOptions();

    if (options.length === 0) {
        console.warn('[X] No options found on page for fuzzy matching.');
        return false;
    }

    console.log('[fuzzy] Candidates:', options);
    const result = localFuzzyMatch(targetText, options);

    if (result) {
        console.log(`[fuzzy] Best match: "${result.match}" (score: ${result.score.toFixed(2)})`);
        if (clickNodeText(result.match)) {
            console.log(`[fuzzy] Clicked fuzzy match "${result.match}"`);
            return true;
        }
        console.warn(`[fuzzy] Found match "${result.match}" but could not click it.`);
    } else {
        console.warn(`[fuzzy] Nothing similar enough to "${targetText}" found.`);
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
