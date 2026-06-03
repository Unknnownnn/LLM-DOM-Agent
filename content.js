function extractHumanReadableText() {
    let text = document.body.innerText || "";

    return text.replace(/\n\s*\n/g, '\n').trim();
}

function clickElementByText(targetText) {
    if (!targetText) {
        console.error("No target text provided for clicking.");
        return false;
    }

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

    if (targetNode) {
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

        console.log(`Match found for text "${targetText}":`, element);

        if (element) {
            element.click();

            const radio = element.querySelector('input[type="radio"], input[type="checkbox"]');
            if (radio && !radio.checked) {
                radio.checked = true;
                radio.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return true;
        }
    }

    console.warn(`Could not find any suitable element for text: "${targetText}".`);
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
    } else if (request.action === "click_element") {
        const success = clickElementByText(request.target_element_text);
        return Promise.resolve({ success: success, message: success ? "Clicked successfully." : "Element not found." });
    } else if (request.action === "click_next") {
        const success = clickNextButton();
        return Promise.resolve({ success: success });
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
