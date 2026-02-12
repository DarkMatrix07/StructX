async function login(email: string, password: string): Promise<User> {
  const validated = validateEmail(email);
  if (!validated) throw new Error('Invalid email');
  
  const hashed = await hashPassword(password);
  const user = await db.users.findOne({ email, password: hashed });
  
  if (!user) throw new Error('Invalid credentials');
  
  const session = await createSession(user.id);
  await auditLog.record('login', user.id);
  
  return user;
}
```

Context:
- Calls: validateEmail, hashPassword, db.users.findOne, createSession, auditLog.record
- Called by: handleLoginRequest, authenticateUser
- Imports: bcrypt, ./validators, ./database, ./session

Function 2: validateEmail
Location: src/validators.ts:12
Signature: function validateEmail(email: string): boolean
Code: [...]
Context: [...]

Respond ONLY with a JSON array, no markdown, no explanation:
[
  {
    "function_name": "login",
    "purpose": "...",
    "side_effects": [...],
    "behavior": "...",
    "domain": "...",
    "complexity": "..."
  },
  {
    "function_name": "validateEmail",
    ...
  }
]
```

#### Expected Response
```json
[
  {
    "function_name": "login",
    "purpose": "Authenticates user credentials and creates a new session",
    "side_effects": [
      "Database query to find user",
      "Creates session in session store",
      "Writes to audit log"
    ],
    "behavior": "Validates the email format, hashes the provided password using bcrypt, queries the database for a matching user, compares password hashes, generates a new session, and logs the authentication attempt for audit purposes.",
    "domain": "authentication",
    "complexity": "medium"
  },
  {
    "function_name": "validateEmail",
    "purpose": "Validates email address format using regex pattern",
    "side_effects": [],
    "behavior": "Applies a regular expression pattern to check if the provided string matches standard email format. Returns true if valid, false otherwise.",
    "domain": "validation",
    "complexity": "low"
  }
]
```

#### Response Parsing & Storage
```python
# Pseudo-code for response processing

def process_semantic_response(response_json, function_batch):
    results = json.loads(response_json)
    
    for result in results:
        # Validate required fields
        required = ['function_name', 'purpose', 'side_effects', 'behavior', 'domain', 'complexity']
        if not all(field in result for field in required):
            log_error(f"Missing fields in response for {result.get('function_name')}")
            continue
        
        # Sanitize strings
        purpose = sanitize_text(result['purpose'])
        behavior = sanitize_text(result['behavior'])
        side_effects_json = json.dumps(result['side_effects'])
        
        # Update database
        db.execute("""
            UPDATE functions 
            SET purpose = ?,
                behavior_summary = ?,
                side_effects = ?,
                domain = ?,
                complexity = ?,
                semantic_analyzed_at = CURRENT_TIMESTAMP
            WHERE name = ? AND file_id = ?
        """, (purpose, behavior, side_effects_json, 
              result['domain'], result['complexity'],
              result['function_name'], get_file_id(result['function_name'])))
```

#### Cost Optimization

**Strategy:**
- Use Claude Haiku (cheapest model sufficient for this task)
- Batch 5-10 functions per API call (reduce overhead)
- Cache results (never re-analyze unchanged functions)
- Smart re-analysis triggers (only when meaningful changes)

**Cost Estimation:**
- Claude Haiku pricing: $0.25 per million input tokens, $1.25 per million output tokens
- Estimated ~400 input tokens per function (code + context)
- Estimated ~100 output tokens per function (JSON response)
- Batch overhead: ~200 tokens per request

**Example Calculation:**
```
100 functions in batches of 10:
- 10 API calls
- Per call: (10 × 400) + 200 = 4,200 input tokens
- Per call: (10 × 100) = 1,000 output tokens
- Total: 42,000 input + 10,000 output = 52,000 tokens

Cost:
- Input: 0.042M × $0.25 = $0.0105
- Output: 0.010M × $1.25 = $0.0125
- Total: ~$0.023 ≈ $0.03 for 100 functions
```

**Pre-Analysis Cost Display:**
```
Found 247 functions to analyze
Estimated tokens: ~128,000 total
Estimated cost: $0.07 (using Claude Haiku)

Proceed? [y/N]
```

#### Incremental Updates

**Triggers for Re-Analysis:**
1. Function signature changed (params, return type modified)
2. Function body changed >30% (heuristic based on diff size)
3. New function added
4. Function's dependencies changed significantly

**Smart Re-Analysis Logic:**
```python
def should_reanalyze(function_id, old_code, new_code):
    # New function
    if not old_code:
        return True
    
    # Signature changed
    old_sig = extract_signature(old_code)
    new_sig = extract_signature(new_code)
    if old_sig != new_sig:
        return True
    
    # Body changed significantly
    diff_ratio = calculate_diff_ratio(old_code, new_code)
    if diff_ratio > 0.3:  # 30% threshold
        return True
    
    # Dependencies changed
    old_deps = extract_dependencies(old_code)
    new_deps = extract_dependencies(new_code)
    if old_deps != new_deps:
        return True
    
    return False
```

**Queue-Based Processing:**
- Changed functions added to `analysis_queue` table
- Background process (or manual command) processes queue
- Priority-based processing (exported functions first)
- Batch processing for efficiency

### Query-Time AI Integration

#### Objective
Answer developer questions using graph context

#### Two Implementations for Comparison

**Traditional Agent (Baseline):**

**Process:**
1. Receive user question
2. Read all TypeScript files (or filter by heuristics)
3. Build massive prompt with 50k-150k tokens of code
4. Send to Claude Sonnet 4 (high-quality model)
5. Receive answer
6. Track metrics: tokens (input/output), cost, time

**StructX Agent (Graph-Powered):**

**Process:**
1. Receive user question
2. Parse question to identify information needs
3. Query graph for relevant functions (SQL operations, milliseconds)
4. Retrieve 5-20 functions typically (vs 50-100 files)
5. Build compact prompt with 1k-3k tokens of structured context
6. Send to Claude Sonnet 4 (same quality model as baseline)
7. Receive answer
8. Track metrics: tokens, cost, time, plus graph query time

#### Context Retrieval Strategies

**1. Direct Function Reference**

Question: "What does the login function do?"

Strategy:
- Extract function name from question ("login")
- Look up `login` in functions table
- Retrieve full context (function details + callers + callees)

Context assembled:
```
Function: login
Location: src/auth.ts:45
Signature: async function login(email: string, password: string): Promise<User>
Purpose: Authenticates user credentials and creates a new session
Behavior: Validates email format, hashes password, queries database, creates session, logs attempt
Side Effects: Database query, session creation, audit logging
Domain: authentication
Complexity: medium

Calls:
- validateEmail (src/validators.ts:12) - Validates email address format
- hashPassword (src/crypto.ts:34) - Hashes password with bcrypt
- createSession (src/session.ts:56) - Creates session in Redis

Called By:
- handleLoginRequest (src/routes/auth.ts:23) - HTTP POST /api/login handler
```

Context size: ~500 tokens

**2. Relationship Query**

Question: "What calls the login function?"

Strategy:
- Extract function name ("login")
- Query relationships table for callers
- Return list with purposes

Context assembled:
```
Functions that call login():

1. handleLoginRequest
   Location: src/routes/auth.ts:23
   Purpose: HTTP POST /api/login endpoint handler
   
2. authenticateUser
   Location: src/middleware/auth.ts:45
   Purpose: Middleware for authenticating user sessions
```

Context size: ~300 tokens

**3. Semantic Search**

Question: "What functions handle authentication?"

Strategy:
- Extract keyword ("authentication")
- Full-text search on purpose and behavior fields
- Return top 10 matches

Context assembled:
```
Authentication-related functions:

1. login
   Location: src/auth.ts:45
   Purpose: Authenticates user credentials and creates session
   
2. logout
   Location: src/auth.ts:78
   Purpose: Destroys user session and invalidates token
   
3. refreshToken
   Location: src/auth.ts:112
   Purpose: Generates new JWT token from refresh token
   
4. validateToken
   Location: src/auth.ts:145
   Purpose: Validates JWT token and extracts user claims
   
5. checkPermissions
   Location: src/auth.ts:189
   Purpose: Verifies user has required permissions for action

... (up to 10 functions)
```

Context size: ~2000 tokens

**4. Domain Query**

Question: "Show me all database operations"

Strategy:
- Identify domain ("database")
- Filter functions by domain field
- Return with purposes

Context assembled:
```
Database operation functions:

1. findUserByEmail
   Location: src/db/users.ts:23
   Purpose: Queries users table by email address
   Side Effects: Database read
   
2. createUser
   Location: src/db/users.ts:45
   Purpose: Inserts new user record into database
   Side Effects: Database write, creates audit log entry

... (all database domain functions)
```

Context size: Varies, typically 1k-5k tokens

**5. Impact Analysis**

Question: "What breaks if I change the validateEmail function?"

Strategy:
- Extract function name ("validateEmail")
- Transitive caller query (recursive)
- Return all affected functions

Context assembled:
```
Functions affected by changes to validateEmail():

Direct callers:
1. login (src/auth.ts:45) - Authenticates user credentials
2. register (src/auth.ts:234) - Creates new user account
3. updateEmail (src/profile.ts:67) - Updates user email address

Indirect callers (via direct callers):
4. handleLoginRequest (src/routes/auth.ts:23) - Calls login()
5. handleRegisterRequest (src/routes/auth.ts:89) - Calls register()

Total impact: 5 functions across 4 files
```

Context size: ~1500 tokens

#### Comparison Framework

**Test Questions:**
1. "What functions handle user authentication?"
2. "What does the login function call?"
3. "Show me all functions that use Redis"
4. "What calls the validatePassword function?"
5. "How is session management implemented?"
6. "What database operations modify user data?"
7. "Which functions have side effects?"
8. "Find all async functions in the authentication domain"

**Metrics Collection:**

For each question, collect:
- **Answer text** (to assess quality)
- **Input tokens** used
- **Output tokens** generated
- **Total tokens** (input + output)
- **API cost** (calculated from tokens)
- **Response time** (seconds)
- **Files accessed** (traditional only)
- **Functions retrieved** (StructX only)
- **Graph query time** (StructX only)

**Comparison Table Generation:**