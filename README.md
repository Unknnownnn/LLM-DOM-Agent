# LLM DOM Navigation Agent

An autonomous browser extension and local Python server that extracts targeted information from the DOM, queries a Large Language Model (LLM) to determine the next action, and automatically clicks the correct element to navigate through the page.

## Features

- **Full AutoPilot Loop:** Press `Alt+A` to start. The agent will extract the page text, query the LLM to determine the correct target, click the corresponding DOM element, trigger the "Next" button, and automatically loop to the next page. Press `Alt+X` to stop at any time.
- **Smart DOM Extraction:** Bypasses copy-paste restrictions by reading raw text nodes directly from the DOM using a TreeWalker.
- **Advanced Text Heuristics:** The Python server uses a multi-tiered heuristic system to perfectly isolate the relevant content and options from raw UI noise, flawlessly preserving complex formats like code blocks.
- **Fuzzy Click Matching:** The extension doesn't rely on brittle HTML classes or IDs. It uses string similarity to match the LLM's text output with the physical DOM elements on the page, accurately clicking even obfuscated or complex elements.
- **Intelligent Caching:** Remembers previously processed pages to avoid redundant API calls, saving time and API credits.

## Architecture

1. **`content.js`:** Lives in the browser. Reads the DOM and performs synthetic clicks.
2. **`background.js`:** The brain of the extension. Manages the AutoPilot loop and bridges the gap between the webpage and the local Python server.
3. **`server.py`:** A lightweight Python HTTP server running on `localhost:5000`. It receives the raw text, cleans it, queries the OpenRouter LLM API, caches the result, and returns the exact string to click.

## Installation & Setup

1. **Set up the Python Server:**
   - Install dependencies: `pip install requests`
   - Create a `.env` file based on `.env.example` and insert your OpenRouter API Key and preferred Model ID.
   - Run the server: `python server.py`

2. **Load the Extension (Firefox):**
   - Open Firefox and navigate to `about:debugging`.
   - Click **This Firefox** -> **Load Temporary Add-on...**
   - Select the `manifest.json` file in this directory.

## Usage

1. Open your target webpage.
2. Ensure `server.py` is running in your terminal.
3. Press **`Alt+A`** (or click the extension icon) to engage AutoPilot.
4. Watch the agent determine targets and navigate automatically!
5. Press **`Alt+X`** to emergency-stop the AutoPilot loop.
