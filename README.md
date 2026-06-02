# AutoPilot DOM Exam Agent

An autonomous browser extension and local Python server that extracts exam questions from the DOM, queries an LLM for the answer, and automatically clicks the correct option to navigate through the quiz.

## Features

- **Full AutoPilot Loop:** Press `Alt+A` to start. The agent will read the question, answer it, click the DOM element, hit "Next", and automatically loop to the next question until the exam is finished. Press `Alt+X` to stop at any time.
- **Smart DOM Extraction:** Bypasses copy-paste blocks and right-click restrictions by reading raw text nodes directly from the DOM using a TreeWalker.
- **Advanced Text Heuristics:** The Python server uses a multi-tiered heuristic system to perfectly isolate the question and options from raw UI noise. It supports standard platforms (e.g., `Question No:`), question marks, and fallback logic, flawlessly preserving complex formats like Python code blocks.
- **Fuzzy Click Matching:** The extension doesn't rely on brittle HTML classes or IDs. It uses string similarity to match the LLM's text output with the physical DOM elements on the page, accurately clicking even obfuscated or math-heavy options (like fractions).
- **Intelligent Caching:** Remembers previously answered questions to avoid redundant API calls, saving time and API credits.


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

1. Open your quiz or exam page.
2. Ensure `server.py` is running in your terminal.
3. Press **`Alt+A`** (or click the extension icon) to engage AutoPilot.
4. Watch the agent answer questions and navigate automatically!
5. Press **`Alt+X`** to emergency-stop the AutoPilot loop.
