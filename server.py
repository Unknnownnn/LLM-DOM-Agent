import json
import requests
import re
import time
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

# Load .env manually to avoid requiring python-dotenv
if os.path.exists('.env'):
    with open('.env', 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                os.environ[k.strip()] = v.strip()

API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
MODEL_NAME = os.environ.get("OPENROUTER_MODEL", "")
API_URL = os.environ.get("OPENROUTER_URL", "")

if not API_KEY:
    print("[!] WARNING: OPENROUTER_API_KEY is not set in .env file!")

question_cache = {}

# ─── Fuzzy matching utility ───────────────────────────────────────────────────

def levenshtein_distance(s1, s2):
    """Compute Levenshtein edit distance between two strings."""
    if len(s1) < len(s2):
        return levenshtein_distance(s2, s1)
    if len(s2) == 0:
        return len(s1)

    prev_row = range(len(s2) + 1)
    for i, c1 in enumerate(s1):
        curr_row = [i + 1]
        for j, c2 in enumerate(s2):
            insertions = prev_row[j + 1] + 1
            deletions = curr_row[j] + 1
            substitutions = prev_row[j] + (c1 != c2)
            curr_row.append(min(insertions, deletions, substitutions))
        prev_row = curr_row
    return prev_row[-1]


def similarity_ratio(s1, s2):
    """Return similarity ratio between 0 and 1 (1 = identical)."""
    s1_lower = s1.strip().lower()
    s2_lower = s2.strip().lower()
    if not s1_lower or not s2_lower:
        return 0.0
    max_len = max(len(s1_lower), len(s2_lower))
    dist = levenshtein_distance(s1_lower, s2_lower)
    return 1.0 - (dist / max_len)


def find_best_fuzzy_match(target, candidates, threshold=0.4):
    """
    Find the best fuzzy match for `target` among `candidates`.
    Returns (best_candidate, score) or (None, 0) if nothing passes threshold.
    """
    best_match = None
    best_score = 0.0

    target_lower = target.strip().lower()

    for candidate in candidates:
        cand_lower = candidate.strip().lower()

        # Exact match
        if cand_lower == target_lower:
            return candidate, 1.0

        # Substring containment (high confidence)
        if target_lower in cand_lower or cand_lower in target_lower:
            score = 0.9
        else:
            score = similarity_ratio(target_lower, cand_lower)

        if score > best_score:
            best_score = score
            best_match = candidate

    if best_score >= threshold:
        return best_match, best_score
    return None, 0.0


# ─── Text cleaning ────────────────────────────────────────────────────────────

def is_coding_question(text):
    """
    Classify whether the page is a coding/programming question or an MCQ.

    Strategy: use STRONG signals (structural markers unique to coding pages) that
    immediately return True, plus WEAK signals that need 2+ hits. This avoids
    misclassifying MCQs that happen to mention words like "programming" in the
    question body.
    """
    lower = text.lower()
    lines_lower = [l.strip().lower() for l in text.splitlines() if l.strip()]

    # ── STRONG signals: any one of these alone = coding question ─────────────
    # Note: these are structural/UI markers that ONLY appear on coding pages,
    # never on MCQ pages. Even partial page load signals are included so we
    # catch the IDE before it finishes rendering.
    STRONG = [
        "single file programming question",   # section header on this platform
        "problem statement",                   # coding problem header
        "input format",                        # coding problem input spec
        "output format",                       # coding problem output spec
        "sample test cases",                   # test case block
        "compile & run",                       # coding IDE run button
        "submit code",                         # coding submit button
        "fill your code here",                 # code editor placeholder
        "code constraints",                    # constraints section
        "expected output",                     # test case expected output
        "code editor",                         # code editor label
        "provide custom input",                # coding IDE custom input feature
        "debugger loading",                    # IDE still initializing (partial load)
        "compiling...",                        # compile in progress
        "running...",                          # code running in IDE
    ]
    for signal in STRONG:
        if signal in lower:
            print(f"[classify] CODING (strong signal: '{signal}')")
            return True

    # ── STRUCTURAL: input+output pattern together = unambiguous coding page ──
    has_input_format  = any("input" in l and ("format" in l or ":" in l) for l in lines_lower)
    has_output_format = any("output" in l and ("format" in l or ":" in l) for l in lines_lower)
    if has_input_format and has_output_format:
        print("[classify] CODING (structural: input format + output format both present)")
        return True

    # ── WEAK signals: need 2+ hits to be sure ────────────────────────────────
    WEAK = [
        "coding question", "programming", "test case", "compiler",
        "run code", "compile", "code snippet", "algorithm", "function",
        "write a program", "implement", "return the", "def ", "int main",
        "public static void", "#include",
    ]
    hits = sum(1 for kw in WEAK if kw in lower)
    if hits >= 2:
        print(f"[classify] CODING (weak signals: {hits} hits)")
        return True

    print("[classify] MCQ")
    return False


def clean_extracted_text(text):
    """
    Cleans the jumbled extracted text and isolates the question and options.
    """
    lines = [line.strip() for line in text.split('\n') if line.strip()]
    
    # --- HEURISTIC 1: Exam Platform Pattern ---
    # Look for explicit Exam Platform markers like "Question No :" or "Question 1 of 3"
    start_idx = -1
    for i, line in enumerate(lines):
        lower = line.lower()
        if re.search(r'question\s*no\s*[:\-]', line, re.IGNORECASE) or line.startswith("Question :") or ("question" in lower and "of" in lower and len(lower) < 25):
            start_idx = i
            break
            
    if start_idx != -1:
        end_idx = len(lines)
        for i in range(start_idx + 1, len(lines)):
            low = lines[i].lower()
            if low in ["submit answer", "submit", "next", "next question", "clear", "save & next", "mark for review", "previous", "review"]:
                end_idx = i
                break
                
        q_block = lines[start_idx:end_idx]
        filtered_block = []
        for line in q_block:
            low = line.lower()
            if re.match(r'^(Marks|Negative Marks|Marking)\s*[:\-]', line, re.IGNORECASE): continue
            if low in ["answer here", "multi choice type question", "multiple choice question", "single choice", "quiz progress", "system status"]: continue
            if low.startswith("category:"): continue
            filtered_block.append(line)
            
        return "--- QUESTION BLOCK ---\n\n" + "\n".join(filtered_block)
        
    # --- HEURISTIC 2: Find Question Mark (?) ---
    q_index = -1
    for i in range(len(lines)-1, -1, -1):
        if '?' in lines[i]:
            q_index = i
            break
            
    if q_index != -1:
        end_index = len(lines)
        for i in range(q_index + 1, len(lines)):
            low = lines[i].lower()
            if low in ["submit answer", "submit", "next", "next question", "clear", "save & next", "mark for review", "previous"]:
                end_index = i
                break
                
        start_index = max(0, q_index - 3)
        raw_block = lines[start_index:end_index]
        
        filtered_block = []
        for line in raw_block:
            low = line.lower()
            if "question" in low and "of" in low: continue
            if low.startswith("category:"): continue
            if low.startswith("marks :"): continue
            if low.startswith("negative marks"): continue
            if low in ["answer here", "multi choice type question", "quiz progress", "system status"]: continue
            filtered_block.append(line)
            
        return "--- QUESTION BLOCK ---\n\n" + "\n".join(filtered_block)
        
    # --- HEURISTIC 3: Fallback (Just grab everything before the next button) ---
    end_index = -1
    for i, line in enumerate(lines):
        if line.lower() in ["submit answer", "submit", "next", "save & next"]:
            end_index = i
            break
            
    if end_index != -1:
        start_index = max(0, end_index - 15) 
        raw_block = lines[start_index:end_index]
        filtered_block = []
        for line in raw_block:
            low = line.lower()
            if low in ["answer here", "multi choice type question", "quiz progress", "system status"]: continue
            if re.match(r'^(Marks|Negative Marks|Marking)\s*[:\-]', line, re.IGNORECASE): continue
            filtered_block.append(line)
        return "--- QUESTION BLOCK ---\n\n" + "\n".join(filtered_block)
        
    return "--- RAW CONDENSED TEXT ---\n\n" + "\n".join(lines)


# ─── Threaded HTTP Server ─────────────────────────────────────────────────────

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """Handle requests in separate threads to prevent blocking."""
    daemon_threads = True


class RequestHandler(BaseHTTPRequestHandler):
    # Suppress default logging to keep terminal clean (we log manually)
    def log_message(self, format, *args):
        return

    def do_OPTIONS(self):
        # Handle CORS preflight
        self.send_response(200, "ok")
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header("Access-Control-Allow-Headers", "X-Requested-With, Content-Type")
        self.end_headers()

    def do_GET(self):
        """Health check endpoint for the extension to verify connectivity."""
        if self.path == '/health':
            try:
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "ok"}).encode('utf-8'))
            except (ConnectionAbortedError, BrokenPipeError, ConnectionResetError, OSError):
                pass
            return

    def _safe_send_response(self, data):
        """Safely send JSON response, handling broken connections gracefully."""
        try:
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(json.dumps(data).encode('utf-8'))
            self.wfile.flush()
            return True
        except (ConnectionAbortedError, BrokenPipeError, ConnectionResetError, OSError) as e:
            print(f"[!] Connection lost while sending response: {type(e).__name__}. Extension may have timed out.")
            print(f"[!] The answer was: {json.dumps(data, indent=2)}")
            print(f"[!] ↑ Answer printed above for manual use if needed.")
            return False

    def _safe_send_error(self, status_code, data):
        """Safely send error response."""
        try:
            self.send_response(status_code)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(json.dumps(data).encode('utf-8'))
            self.wfile.flush()
        except (ConnectionAbortedError, BrokenPipeError, ConnectionResetError, OSError):
            print(f"[!] Could not send error response (connection already dead).")

    def do_POST(self):
        if self.path == '/process':
            self._handle_process()
        else:
            self._safe_send_error(404, {"error": "Not found"})

    def _handle_fuzzy_match(self):
        """
        Endpoint for the extension to find the best fuzzy match for a target
        among the available options on the page.
        Expects: { "target": "...", "candidates": ["opt1", "opt2", ...] }
        Returns: { "best_match": "...", "score": 0.85 } or { "best_match": null }
        """
        try:
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))

            target = data.get('target', '')
            candidates = data.get('candidates', [])

            print(f"\n{'─'*50}")
            print(f"[FUZZY MATCH] Target: \"{target}\"")
            print(f"[FUZZY MATCH] Candidates ({len(candidates)}):")
            for i, c in enumerate(candidates):
                print(f"  [{i+1}] \"{c}\"")

            best_match, score = find_best_fuzzy_match(target, candidates)

            if best_match:
                print(f"[FUZZY MATCH] ✓ Best match: \"{best_match}\" (score: {score:.2f})")
            else:
                print(f"[FUZZY MATCH] ✗ No match found above threshold")
            print(f"{'─'*50}\n")

            self._safe_send_response({
                "best_match": best_match,
                "score": score
            })

        except Exception as e:
            print(f"[!] Fuzzy match error: {e}")
            self._safe_send_error(500, {"error": str(e)})

    def _handle_process(self):
        try:
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
        except (ConnectionAbortedError, BrokenPipeError, ConnectionResetError, OSError) as e:
            print(f"[!] Connection lost while reading request body: {type(e).__name__}")
            return

        try:
            data = json.loads(post_data.decode('utf-8'))
            page_text = data.get('page_text', '')
            system_prompt = data.get('system_prompt', "You are an analytical engine...")
            available_options = data.get('available_options', [])
            
            # --- CACHE LOCALLY ---
            with open("extracted_data.txt", "w", encoding="utf-8") as f:
                f.write(page_text)
            print(f"\n[*] Raw extracted text saved to extracted_data.txt ({len(page_text)} chars)")
            
            # --- CLASSIFY & CLEAN ---
            is_coding = is_coding_question(page_text)

            if is_coding:
                cleaned_text = "--- CODING PROBLEM & TEST CASES ---\n\n" + page_text
                # Override prompt for coding: only ask for code, never options
                system_prompt = (
                    "You are an expert programmer. Read the coding problem, constraints, "
                    "and the sample test cases carefully. Write a complete, correct solution. "
                    "Respond ONLY with a valid JSON object with a single key 'code_to_paste' "
                    "mapped to the raw code string. No markdown, no triple-backticks inside the value."
                )
                # NEVER send available_options to the LLM for coding questions.
                # The page may have UI buttons ('Provide Custom Input', 'Compile & Run')
                # that look like options but aren't. Sending them causes the LLM to
                # return target_element_text instead of code_to_paste.
                available_options = []
                print("[classify] Coding question — available_options suppressed.")
            else:
                cleaned_text = clean_extracted_text(page_text)

            print("\n" + "="*50)
            print("EXTRACTED TEXT:")
            print("="*50)
            print(cleaned_text)
            print("="*50)

            # Log available options (MCQ only — will be empty for coding)
            if available_options:
                print(f"\n[*] Available options on page ({len(available_options)}):")
                for i, opt in enumerate(available_options):
                    print(f"    [{i+1}] \"{opt}\"")
            elif not is_coding:
                print("\n[!] No available options detected on page (MCQ with no radio buttons found?)")

            print()
            
            # --- CACHE LOGIC ---
            if cleaned_text in question_cache:
                print(f"[*] CACHE HIT! This exact question was already answered.")
                print(f"[*] Waiting 5 seconds. Check for loops...")
                time.sleep(5)   
                response_data = question_cache[cleaned_text]
            else:
                print(f"[*] Querying {MODEL_NAME}...")
                response_data = self.query_llm(cleaned_text, system_prompt, available_options)
                # Save to cache if successful
                if "error" not in response_data:
                    question_cache[cleaned_text] = response_data

            # --- VERBOSE LOGGING: Show exactly what we're sending back ---
            print(f"\n{'─'*50}")
            print(f"[*] RESPONSE TO EXTENSION:")
            print(json.dumps(response_data, indent=2))
            
            # --- DIAGNOSTIC: Show match status for terminal visibility ---
            target = response_data.get('target_element_text', '')
            if target and available_options:
                exact_found = any(opt.strip().lower() == target.strip().lower() for opt in available_options)
                if exact_found:
                    print(f"[✓] LLM target \'{target}\' found exactly in available options.")
                else:
                    print(f"[~] LLM target \'{target}\' not in options list — content.js will fuzzy-match locally.")
                    print(f"[~] Available: {available_options}")
            
            print(f"{'─'*50}\n")
            
            sent = self._safe_send_response(response_data)
            if sent:
                print(f"[*] Response sent successfully to extension.")
            else:
                print(f"[!] Response could NOT be sent (connection dead).")
                print(f"[!] Answer for manual use: {json.dumps(response_data)}")
            
        except Exception as e:
            print(f"[!] Error processing request: {e}")
            import traceback
            traceback.print_exc()
            self._safe_send_error(500, {"error": str(e)})
                
    def query_llm(self, page_text, system_prompt, available_options=None):
        url = API_URL
        headers = {
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json"
        }

        # Build user message with available options for better accuracy
        user_msg = f"Here is the webpage text:\n\n{page_text}\n\n"
        if available_options and len(available_options) > 0:
            user_msg += f"The available clickable options on the page are:\n"
            for i, opt in enumerate(available_options):
                user_msg += f"  {i+1}. {opt}\n"
            user_msg += f"\nYou MUST pick one of these exact options. "
        user_msg += "Respond ONLY with a valid JSON object containing a single key 'target_element_text' mapped to the exact string of the correct option to click."

        payload = {
            "model": MODEL_NAME,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_msg}
            ]
        }
        
        try:
            response = requests.post(url, headers=headers, json=payload, timeout=120)
            response_json = response.json()
        except requests.exceptions.Timeout:
            print("[!] LLM API timed out after 120 seconds!")
            return {"error": "LLM API timeout"}
        except requests.exceptions.ConnectionError as e:
            print(f"[!] Could not connect to LLM API: {e}")
            return {"error": f"LLM API connection error: {str(e)}"}
        except Exception as e:
            print(f"[!] Unexpected error calling LLM API: {e}")
            return {"error": str(e)}
        
        if 'choices' not in response_json:
            return {"error": f"API Error: {json.dumps(response_json)}"}
            
        content = response_json['choices'][0]['message']['content']
        
        print("\n" + "="*50)
        print("RAW MODEL RESPONSE:")
        print("="*50)
        print(content)
        print("="*50 + "\n")
        
        if content.strip().startswith("```json"):
            content = content.split("```json")[1].split("```")[0].strip()
        elif content.strip().startswith("```"):
            content = content.split("```")[1].split("```")[0].strip()
            
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            # Try to extract JSON from the response
            json_match = re.search(r'\{[^}]+\}', content)
            if json_match:
                try:
                    return json.loads(json_match.group())
                except json.JSONDecodeError:
                    pass
            return {"error": "Failed to parse JSON", "raw_content": content}


def run(server_class=ThreadedHTTPServer, handler_class=RequestHandler, port=5000):
    server_address = ('', port)
    httpd = server_class(server_address, handler_class)
    print(f"[*] Local Python Server running on http://localhost:{port}")
    print(f"[*] Health check: http://localhost:{port}/health")
    print(f"[*] Fuzzy match:  http://localhost:{port}/fuzzy_match")
    print(f"[*] Waiting for data from the browser extension...")
    httpd.serve_forever()

if __name__ == '__main__':
    run()
