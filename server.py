import json
import requests
import re
import time
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

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

class RequestHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        # Handle CORS preflight
        self.send_response(200, "ok")
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header("Access-Control-Allow-Headers", "X-Requested-With, Content-Type")
        self.end_headers()

    def do_POST(self):
        if self.path == '/process':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            
            try:
                data = json.loads(post_data.decode('utf-8'))
                page_text = data.get('page_text', '')
                system_prompt = data.get('system_prompt', "You are an analytical engine...")
                
                # --- CACHE LOCALLY ---
                with open("extracted_data.txt", "w", encoding="utf-8") as f:
                    f.write(page_text)
                print(f"[*] Raw extracted text saved to extracted_data.txt ({len(page_text)} chars)")
                
                # --- HEURISTIC CLEANING ---
                cleaned_text = clean_extracted_text(page_text)
                print("\n" + "="*50)
                print("CLEANED TEXT BEING SENT TO LLM (OR CACHE):")
                print("="*50)
                print(cleaned_text)
                print("="*50 + "\n")
                
                # --- CACHE LOGIC ---
                if cleaned_text in question_cache:
                    print(f"[*] CACHE HIT! This exact question was already answered.")
                    print(f"[*] Waiting 5 seconds. Check for loops...")
                    time.sleep(5)
                    response_data = question_cache[cleaned_text]
                else:
                    print(f"[*] Querying OpenRouter model...")
                    response_data = self.query_llm(cleaned_text, system_prompt)
                    # Save to cache if successful
                    if "error" not in response_data:
                        question_cache[cleaned_text] = response_data
                
                try:
                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(json.dumps(response_data).encode('utf-8'))
                    print(f"[*] Response sent to extension: {response_data}")
                except (ConnectionAbortedError, BrokenPipeError):
                    print("[!] Browser closed the connection early. Ignoring.")
                
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode('utf-8'))
                print(f"[!] Error: {e}")
                
    def query_llm(self, page_text, system_prompt):
        url = API_URL
        headers = {
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json"
        }
        payload = {
            "model": MODEL_NAME,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"Here is the webpage text:\n\n{page_text}\n\nRespond ONLY with a valid JSON object containing a single key 'target_element_text' mapped to the exact string of the correct option to click."}
            ]
        }
        
        response = requests.post(url, headers=headers, json=payload)
        response_json = response.json()
        
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
            return {"error": "Failed to parse JSON", "raw_content": content}

def run(server_class=HTTPServer, handler_class=RequestHandler, port=5000):
    server_address = ('', port)
    httpd = server_class(server_address, handler_class)
    print(f"[*] Local Python Server running on http://localhost:{port}")
    print(f"[*] Waiting for data from the browser extension...")
    httpd.serve_forever()

if __name__ == '__main__':
    run()
