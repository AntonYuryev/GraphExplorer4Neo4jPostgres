"""
Graph Explorer — Agentic AI Service
FastAPI microservice wrapping Anthropic Claude + neo4j-graphrag concepts + LangGraph.

Start automatically by server.js, or manually:
    python agent_service.py

Port: 3001 (override with AGENT_PORT env var)
"""

import os
import re
import json
import uuid
import struct
import hashlib
import logging
import time
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Optional, List, Dict, Any
from pathlib import Path

import traceback
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import uvicorn
# Note: register_summarize_routes is imported lazily in startup handler to improve initial startup speed

# ── Optional heavy deps — imported lazily so the service starts even if missing ──
try:
    import anthropic as _anthropic_mod
    HAS_ANTHROPIC = True
except ImportError:
    HAS_ANTHROPIC = False

try:
    import openai as _openai_mod
    HAS_OPENAI = True
except ImportError:
    HAS_OPENAI = False

GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"

try:
    from neo4j import GraphDatabase as _Neo4jDriver
    from neo4j.graph import Node as _Neo4jNode
    from neo4j.graph import Path as _Neo4jPath
    from neo4j import Query as _Neo4jQuery
    HAS_NEO4J = True
except ImportError:
    HAS_NEO4J = False

# Hard server-side timeout (seconds) applied to every agent-issued Cypher query.
# Without this, a runaway query (e.g. an unbounded variable-length path) can hang
# indefinitely — Neo4j has no default per-query timeout of its own. Wrapping the
# query text in neo4j.Query(..., timeout=N) asks the SERVER to abort the query
# after N seconds with a clean, catchable error instead of hanging the request.
# Increased for debugging: was 25, now 120 to accommodate debugger inspection.
CYPHER_QUERY_TIMEOUT_SECONDS = 120

try:
    import psycopg2
    import psycopg2.extras
    HAS_PG = True
except ImportError:
    HAS_PG = False

# ── LangGraph (optional — used for structured multi-step workflows) ────────────
try:
    from langgraph.graph import StateGraph, END
    from typing import TypedDict
    HAS_LANGGRAPH = True
except ImportError:
    HAS_LANGGRAPH = False

logging.basicConfig(level=logging.INFO, format="%(asctime)s [agent] %(message)s")
log = logging.getLogger("agent")

# ── Log injection hardening (CodeQL: py/log-injection, CWE-117) ─────────────
# Many log.info/log.warning/log.error calls throughout this file interpolate
# request-derived, LLM-generated, or external-system-derived strings (chat
# messages, Cypher/SQL query text, vocabulary terms, driver exception text)
# without stripping newlines first. A value containing \r/\n could forge
# what looks like a separate, fake log line. Rather than sanitizing each of
# the 15+ call sites individually (easy to miss one, and easy for a new call
# site added later to reintroduce the gap), this Filter is attached once,
# here, and strips newline/control characters from every log record's
# message and substitution arguments before they're ever formatted/written.
_LOG_CONTROL_RE = re.compile(r'[\r\n\x00-\x08\x0b\x0c\x0e-\x1f]+')

def _log_safe(value):
    """Strip newline/control characters from a single value, for use INLINE
    at a specific log call's argument list — e.g. log.info("...%s...",
    _log_safe(user_message)). CodeQL's py/log-injection check requires the
    sanitization to be visible at the call site, on each individual tainted
    argument; it does NOT recognize _SanitizeLogFilter below (a
    logging.Filter that cleans a record after it's already built) as a
    sanitizer, even though the Filter is real, independently-working
    protection — the two are complementary defense-in-depth, not
    alternatives. Non-string values (ints, lists, bools) pass through
    unchanged since they can't carry injected newlines."""
    return _LOG_CONTROL_RE.sub(" ", value) if isinstance(value, str) else value

class _SanitizeLogFilter(logging.Filter):
    def _clean(self, value):
        return _LOG_CONTROL_RE.sub(" ", value) if isinstance(value, str) else value

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = self._clean(record.msg)
        if record.args:
            if isinstance(record.args, dict):
                record.args = {k: self._clean(v) for k, v in record.args.items()}
            else:
                record.args = tuple(self._clean(a) for a in record.args)
        return True

log.addFilter(_SanitizeLogFilter())

app = FastAPI(title="Graph Explorer Agent Service", version="1.0.0")

# This service is only ever called by server.js's own reverse proxy
# (127.0.0.1, see the AGENT_PORT/uvicorn.run() setup at the bottom of this
# file) — no browser talks to it directly, so a wide-open CORS policy serves
# no legitimate purpose here and only widens the blast radius if the port
# were ever accidentally exposed. allow_origins=["*"] combined with
# allow_credentials=True is also individually flagged by CodeQL
# (py/insecure-cors-policy): browsers reject wildcard-origin + credentials in
# practice, but the pattern is still worth avoiding outright.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1", "http://localhost"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def _attach_user_context(request: Request, call_next):
    """Carries the trusted `x-ge-username` header (set only by server.js's
    /api/agent/* proxy, never the client directly) through to run_cypher() /
    run_postgres() via a request-scoped context var, so those helpers can
    resolve the CALLING user's own Neo4j/Postgres credentials — see
    _resolve_neo4j_cfg / _resolve_pg_cfg below."""
    token = _current_username.set(request.headers.get("x-ge-username", ""))
    try:
        return await call_next(request)
    finally:
        _current_username.reset(token)

_CREDENTIAL_LIKE_RE = re.compile(
    r'(password|passwd|pwd|apikey|api[_-]?key|secret|token|authorization)\s*[=:]\s*\S+',
    re.IGNORECASE,
)
_URL_CREDENTIALS_RE = re.compile(r'://[^/\s@]+:[^/\s@]+@')

def _sanitize_public_text(text: str, max_len: int = 300) -> str:
    """Redact credential-shaped substrings and cap length on any text that's
    about to be shown to a user — shared by _safe_exc_str() below (for Python
    exceptions) and by every place that reads an external HTTP error response
    body (he.read().decode(...) from urllib) before returning it to a client.
    An external server's error response is just as capable of accidentally
    (or, from a malicious/compromised provider, deliberately) including
    something credential-shaped as a Python exception's str() is."""
    text = _URL_CREDENTIALS_RE.sub("://***:***@", text)
    text = _CREDENTIAL_LIKE_RE.sub(lambda m: m.group(1) + "=***", text)
    if len(text) > max_len:
        text = text[:max_len] + "... (truncated)"
    return text

def _safe_exc_str(exc: BaseException, max_len: int = 300) -> str:
    """Render an exception as a short, user-facing string — CodeQL flags several
    spots (py/stack-trace-exposure) where a raw exception's str() reaches an
    HTTP response, because driver/library exceptions can incidentally embed a
    password, API key, or full connection string. This is the single place
    that sanitizes an exception before it's shown to a user: redact anything
    that looks like embedded credentials and cap the length so a huge driver
    stack-trace-like message never reaches the client. Every place in this
    file that surfaces an exception to a chat reply or an API response
    (tool_msg text, /ping-llm, /list-models, /workflow/execute, /batch-write)
    should go through this instead of str(exc)/f"{exc}" directly — the goal is
    to keep the message genuinely useful for debugging (e.g. a Neo4j syntax
    error, a timeout notice) without the credential-leak risk of the raw
    exception text.

    Prefixed with "<line>@<file>: " — just the SOURCE FILE'S BASENAME (never
    the full server-side path) and the line number of the single deepest
    traceback frame (where the exception actually occurred), not a full
    stack trace. This intentionally stops short of str(traceback.format_exc())
    or an absolute path, which would hand a client the server's directory
    layout and every call frame in between — still information disclosure
    (OWASP A05), just narrowed to the one detail that actually speeds up
    debugging a chat-visible error."""
    where = ""
    tb = exc.__traceback__
    if tb is not None:
        frames = traceback.extract_tb(tb)
        if frames:
            last = frames[-1]
            where = f"{last.lineno}@{os.path.basename(last.filename)}: "
    return f"{where}{type(exc).__name__}: {_sanitize_public_text(str(exc), max_len)}"


def _safe_http_error_str(he, max_len: int = 300) -> str:
    """Render an urllib HTTPError as a short, user-facing string — same
    rationale as _safe_exc_str(), but reads and sanitizes the response BODY
    (he.read()), not just str(he), since these call sites want the external
    provider's actual error detail (e.g. a Gemini/Anthropic/OpenAI-compatible
    API's JSON error message), not just the generic 'HTTP Error 429' text.
    CodeQL (py/stack-trace-exposure, 'Information exposure through an
    exception') flags he.read().decode()[:200] reaching a response directly —
    the exception's payload is still external, untrusted content and gets the
    same credential-redaction/length-cap treatment before it's shown."""
    try:
        body = he.read().decode("utf-8", errors="replace")
    except Exception:
        body = ""
    return f"HTTP {he.code}: {_sanitize_public_text(body, max_len)}"

@app.exception_handler(Exception)
async def _global_exception_handler(request: Request, exc: Exception):
    """Log full traceback for any unhandled exception — prevents silent socket hang-up."""
    log.error("Unhandled exception on %s %s:\n%s",
              request.method, request.url.path, traceback.format_exc())
    return JSONResponse(status_code=500,
                        content={"error": _safe_exc_str(exc)})

_ALLOWED_LLM_URL_SCHEMES = {"http", "https"}

def _assert_safe_external_url(url: str) -> str:
    """Validate a user-supplied LLM provider URL before it's ever passed to
    urlopen() — CodeQL flags the /list-models route as SSRF-capable (Critical),
    and correctly so: the LLM provider URL under Settings -> My Connection is a
    genuinely user-editable value (by design — 'any OpenAI-compatible endpoint'
    is a documented feature), so it must be treated the same as any other
    externally-supplied URL, not implicitly trusted just because it's typically
    set by an admin/user configuring their own account.

    Enforces:
      - scheme is http or https only (blocks file://, gopher://, etc.)
      - the hostname does not resolve to a private/loopback/link-local/reserved/
        multicast IP address (blocks SSRF against internal services, the
        169.254.169.254 cloud-metadata endpoint, etc., via a URL that looks
        like an ordinary http(s) address)

    Returns the validated hostname (for exact-match provider routing — see
    callers) or raises ValueError with a safe, user-facing message.
    """
    import ipaddress
    import socket
    from urllib.parse import urlparse

    parsed = urlparse(url)
    if parsed.scheme not in _ALLOWED_LLM_URL_SCHEMES:
        raise ValueError(f"Unsupported URL scheme '{parsed.scheme}' — only http/https are allowed")
    host = parsed.hostname
    if not host:
        raise ValueError("URL has no hostname")
    try:
        addrinfo = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise ValueError(f"Could not resolve host '{host}': {exc}")
    for _family, _type, _proto, _canon, sockaddr in addrinfo:
        ip = ipaddress.ip_address(sockaddr[0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            raise ValueError(
                f"URL host '{host}' resolves to a private/internal address "
                f"({ip}) — not permitted for security reasons"
            )
    return host

LIBRARY_DIR = Path(__file__).parent / "agent_library"
LIBRARY_DIR.mkdir(exist_ok=True)

VOCAB_FILE     = LIBRARY_DIR / "user_vocabulary.json"
EXAMPLES_FILE  = Path(__file__).parent / "cypher_examples.json"

# One subfolder per AI menu agent — see the Agent Skills section below.
SKILLS_DIR = Path(__file__).parent / "agent_skills"
SKILLS_DIR.mkdir(exist_ok=True)
for _skill_agent_name in ("text2cypher", "summarize", "curate", "help"):
    (SKILLS_DIR / _skill_agent_name).mkdir(exist_ok=True)

# ─────────────────────────────────────────────────────────────────────────────
#  Cypher examples (user-editable few-shot examples injected into system prompt)
# ─────────────────────────────────────────────────────────────────────────────

def _load_examples() -> List[Dict]:
    """Load user-provided Cypher examples from cypher_examples.json."""
    if EXAMPLES_FILE.exists():
        try:
            with open(EXAMPLES_FILE, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                return data
        except Exception as e:
            log.warning("Could not load cypher_examples.json: %s", e)
    return []

def _save_examples(examples: List[Dict]) -> None:
    """Overwrite cypher_examples.json with the given list. Read fresh on every
    prompt build (_load_examples has no cache), so edits take effect on the very
    next chat request — no service restart needed."""
    EXAMPLES_FILE.write_text(json.dumps(examples, indent=2, ensure_ascii=False), "utf-8")

_STOPWORDS = frozenset("""
a an the of to for in on with and or but is are was were be been being this that these those
find all any some what which who how many much show get list return does do can i want need
me my you your it its we our them their a's about above after again against as at because
before below between by could did down during each few from further has have having
he her here hers him himself his if into itself just more most no nor not now once only other
ought over own same she should so than then there through too under until up very will
""".split())
# NOTE: "both" is deliberately NOT a stopword — for this app it's a strong signal word
# ("find X that does BOTH A and B") pointing at common-neighbor/intersection-style
# queries, not a low-content function word.

def _stem(word: str) -> str:
    """Crude plural stripping so 'approach'/'approaches', 'drug'/'drugs',
    'compound'/'compounds' etc. count as the same token for relevance scoring.
    _tokenize() is used ONLY for fuzzy example-matching (never exact lookups),
    so a lightweight heuristic here is safe — no risk of breaking a real query."""
    if len(word) > 4 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 4 and word.endswith("es"):
        return word[:-2]
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word

def _tokenize(text: str) -> set:
    """Lowercase, alphanumeric-only tokens with common stopwords removed."""
    words = re.findall(r"[a-zA-Z][a-zA-Z0-9]{2,}", (text or "").lower())
    return {_stem(w) for w in words if w not in _STOPWORDS}

def _select_relevant_examples(user_message: str, examples: List[Dict],
                               max_examples: int = 8, min_fallback: int = 2) -> List[tuple]:
    """Rank examples by keyword overlap with the user's message and return the
    top matches as (original_1based_index, example) tuples — the index matches
    the "Rule #N" numbering shown in the Cypher Examples UI, so users and the
    LLM can refer to the same example by the same number.

    Purely lexical (no embeddings/network calls) — negligible latency, and keeps
    the system prompt from growing linearly with the size of cypher_examples.json.
    The MANDATORY numbered rules elsewhere in the prompt are NOT affected by this
    filtering — this only trims the illustrative worked examples appended at the
    end, so core conventions (label unions, coalesce(), etc.) are never at risk
    of being dropped even if no example scores above zero.
    """
    if not examples:
        return []

    query_tokens = _tokenize(user_message)
    scored = []
    for idx, ex in enumerate(examples, 1):
        if not (ex.get("cypher") or "").strip():
            continue
        # Question words count double — they're the clearest signal of what the
        # example is *for*; notes/cypher contribute supporting matches (e.g. a
        # label or relation-type name mentioned in the query itself). Tags count
        # triple: they exist specifically to catch STRUCTURAL patterns (e.g. "find
        # X connected to BOTH A and B") whose worked example may use placeholder
        # entities (drug names, etc.) that share no vocabulary at all with a real,
        # domain-specific question — the tags are hand-picked trigger phrases that
        # bridge that gap on purpose.
        q_tokens  = _tokenize(ex.get("question", ""))
        n_tokens  = _tokenize(ex.get("notes", ""))
        c_tokens  = _tokenize(ex.get("cypher", ""))
        t_tokens  = _tokenize(" ".join(ex.get("tags") or []))
        score = (2 * len(query_tokens & q_tokens)
                 + len(query_tokens & n_tokens)
                 + len(query_tokens & c_tokens)
                 + 3 * len(query_tokens & t_tokens))
        scored.append((idx, ex, score))

    scored.sort(key=lambda t: (-t[2], t[0]))  # highest score first, stable by original order
    matched = [(idx, ex) for idx, ex, score in scored if score > 0][:max_examples]

    # Safety net: a totally novel/generic question can score 0 against every example.
    # Rather than send none at all, fall back to the first couple of examples in the
    # file so the model still sees at least one worked pattern to imitate the style of.
    if len(matched) < min_fallback:
        seen = {idx for idx, _ in matched}
        for idx, ex, _score in scored:
            if idx not in seen:
                matched.append((idx, ex))
                seen.add(idx)
            if len(matched) >= min_fallback:
                break

    return matched

def _examples_prompt_section(user_message: str = "") -> str:
    """Format the most relevant Cypher examples as a system-prompt section.

    Only the top-scoring examples (by keyword overlap with `user_message`) are
    included instead of the full file — with cypher_examples.json now holding
    ~20 entries and growing, sending every one on every request was inflating
    the prompt (and latency/cost) regardless of relevance to the current question.
    """
    examples = _load_examples()
    if not examples:
        return ""

    selected = _select_relevant_examples(user_message, examples)
    if not selected:
        return ""

    # Sanitized inline at the call site with an explicit, UNCONDITIONAL
    # .replace() chain — the previous version wrapped this in
    # "X.replace(...) if isinstance(user_message, str) else user_message",
    # and CodeQL's py/log-injection check remained flagged: the else-branch
    # returning the raw, unmodified value apparently keeps the expression
    # tainted from the analyzer's perspective, even though that branch is
    # never actually reachable in practice (user_message is always a str
    # here). str(... or "") first removes the need for any such branch.
    log.info("Examples: selected %d of %d (Rule #%s) for message %.60r",
              len(selected), len(examples), ",".join(str(i) for i, _ in selected),
              str(user_message or "").replace("\r\n", " ").replace("\n", " ").replace("\r", " ").replace("\x00", " "))

    lines = ["\n\n## Cypher Query Examples (authoritative patterns for this graph)"]
    lines.append("These examples show correct Cypher for common task types. Follow their patterns exactly. "
                 "Each is numbered to match its \"Rule #N\" label in the app's Cypher Examples dialog — "
                 "refer to that number if you mention a specific example to the user.")
    for i, ex in selected:
        question = ex.get("question", "").strip()
        cypher   = ex.get("cypher", "").strip()
        notes    = ex.get("notes", "").strip()
        lines.append(f"\n### Rule #{i}" + (f": {question}" if question else ""))
        lines.append(f"```cypher\n{cypher}\n```")
        if notes:
            lines.append(f"*Note: {notes}*")
    return "\n".join(lines)

# ─────────────────────────────────────────────────────────────────────────────
#  Agent Skills (file-based capability snippets, shared by all 4 AI agents)
# ─────────────────────────────────────────────────────────────────────────────
# Generalizes the same idea as cypher_examples.json above -- small, individually
# editable units of guidance selected by relevance rather than one big growing
# JSON array -- but as plain files instead, one folder per AI-menu agent
# (agent_skills/text2cypher/, /summarize/, /curate/, /help/), so a new
# capability can be added by dropping in a file, never touching this Python
# file, and it stays entirely out of the prompt on requests it isn't relevant
# to instead of bloating every request regardless of the question asked.
#
# Each skill file looks like:
#
#   ---
#   name: Some short name
#   trigger: comma, separated, trigger, phrases
#   ---
#   Free-text instructions/knowledge for this one capability.
#
# "trigger" phrases are hand-picked words/phrases that should cause this
# skill to be pulled in even if the user's own wording shares little
# vocabulary with the skill body itself -- same role cypher_examples.json's
# "tags" field plays for Cypher examples.

_SKILL_FILE_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)

def _parse_skill_file(path: Path) -> Optional[Dict[str, str]]:
    """Parses one skill file's `--- header ---` block plus body. Returns None
    (logging a warning) for a malformed file rather than raising -- one
    broken skill file should never take down every agent's system prompt."""
    try:
        raw = path.read_text(encoding="utf-8")
    except Exception as e:
        log.warning("Could not read skill file %s: %s", path.name, e)
        return None
    m = _SKILL_FILE_RE.match(raw)
    if not m:
        log.warning("Skill file %s is missing its '--- header ---' block, skipping", path.name)
        return None
    header, body = m.group(1), m.group(2).strip()
    meta: Dict[str, str] = {}
    for line in header.splitlines():
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        meta[key.strip().lower()] = val.strip()
    if not body:
        return None
    return {"name": meta.get("name", path.stem), "trigger": meta.get("trigger", ""),
            "body": body, "file": path.name}

def _load_skills(agent: str) -> List[Dict[str, str]]:
    """Loads every *.md skill file for one agent ('text2cypher' | 'summarize' |
    'curate' | 'help'). Re-read from disk on every call -- same tradeoff as
    _load_examples()/_load_vocabulary(): a saved edit takes effect on the very
    next request, at the cost of a few small file reads per turn, negligible
    next to the LLM call itself."""
    agent_dir = SKILLS_DIR / agent
    if not agent_dir.is_dir():
        return []
    skills = []
    for path in sorted(agent_dir.glob("*.md")):
        parsed = _parse_skill_file(path)
        if parsed:
            skills.append(parsed)
    return skills

def _select_relevant_skills(user_message: str, skills: List[Dict[str, str]],
                            max_skills: int = 3) -> List[Dict[str, str]]:
    """Same lexical keyword-overlap scoring as _select_relevant_examples, over
    a skill's trigger phrases (weighted highest), name, and body. Unlike
    Cypher examples there is no non-empty fallback -- a skill that scores 0
    just isn't relevant to this particular question, and every agent's core
    system prompt already covers its own baseline behavior with no skill
    file loaded at all."""
    if not skills:
        return []
    query_tokens = _tokenize(user_message)
    scored = []
    for skill in skills:
        trigger_tokens = _tokenize(skill.get("trigger", ""))
        name_tokens    = _tokenize(skill.get("name", ""))
        body_tokens    = _tokenize(skill.get("body", ""))
        score = (3 * len(query_tokens & trigger_tokens)
                 + 2 * len(query_tokens & name_tokens)
                 + len(query_tokens & body_tokens))
        if score > 0:
            scored.append((score, skill))
    scored.sort(key=lambda t: -t[0])
    return [skill for _score, skill in scored[:max_skills]]

def _skills_prompt_section(agent: str, user_message: str = "") -> str:
    """Formats the most relevant skill file(s) for one agent as a system-
    prompt section -- generalizes _examples_prompt_section() beyond Cypher."""
    skills = _load_skills(agent)
    if not skills:
        return ""
    selected = _select_relevant_skills(user_message, skills)
    if not selected:
        return ""
    log.info("Skills: selected %d of %d for agent=%s", len(selected), len(skills), agent)
    lines = ["\n\n## Additional Skills (loaded for this question)"]
    for skill in selected:
        lines.append(f"\n### {skill['name']}")
        lines.append(skill["body"])
    return "\n".join(lines)

# ─────────────────────────────────────────────────────────────────────────────
#  Cross-session vocabulary (user term → Neo4j concept mappings)
# ─────────────────────────────────────────────────────────────────────────────

def _load_vocabulary() -> List[Dict]:
    """Load persisted user-term → Neo4j concept mappings."""
    if VOCAB_FILE.exists():
        try:
            return json.loads(VOCAB_FILE.read_text("utf-8")).get("mappings", [])
        except Exception:
            pass
    return []

def _save_vocabulary(mappings: List[Dict]) -> None:
    VOCAB_FILE.write_text(
        json.dumps({"mappings": mappings}, indent=2, ensure_ascii=False), "utf-8"
    )

def _upsert_vocabulary(user_term: str, neo4j_name: str, neo4j_label: str,
                       confirmed: bool = False) -> None:
    """Add or increment a term mapping. Existing entries are updated in place."""
    if not user_term or not neo4j_name:
        return
    # Normalize all three inputs once, right here at the point they enter
    # this function, using the same _log_safe() sanitizer used for logging
    # elsewhere in this file plus an explicit str() cast. Every comparison,
    # stored field, and the log call at the bottom of this function all use
    # these sanitized locals instead of the raw parameters — so the
    # newline-stripped form is what's compared, persisted to
    # user_vocabulary.json, AND logged, consistently, rather than sanitizing
    # only at the log call site.
    user_term   = str(user_term).replace("\r\n", " ").replace("\n", " ").replace("\r", " ")
    neo4j_name  = str(neo4j_name).replace("\r\n", " ").replace("\n", " ").replace("\r", " ")
    neo4j_label = str(neo4j_label or "").replace("\r\n", " ").replace("\n", " ").replace("\r", " ")
    mappings = _load_vocabulary()
    today = datetime.utcnow().date().isoformat()
    for m in mappings:
        if m["user_term"].lower() == user_term.lower() and m["neo4j_name"] == neo4j_name:
            m["use_count"] = m.get("use_count", 0) + 1
            m["last_used"] = today
            if confirmed:
                m["confirmed"] = True
            _save_vocabulary(mappings)
            return
    mappings.append({
        "user_term":   user_term,
        "neo4j_name":  neo4j_name,
        "neo4j_label": neo4j_label,
        "use_count":   1,
        "confirmed":   confirmed,
        "last_used":   today,
    })
    _save_vocabulary(mappings)
    # user_term/neo4j_name/neo4j_label were already normalized at the top of
    # this function, but the SAME literal .replace() chain is applied again
    # here, inline, directly in the log call's own arguments — redundant at
    # runtime, but CodeQL's py/log-injection check does not recognize
    # sanitization performed earlier in the function (even via an identical
    # inline chain) or through a call to a separately-defined function
    # (_log_safe was tried and remained flagged) — only a literal
    # transformation self-contained at the sink call satisfies it.
    log.info(
        "Vocabulary: new mapping '%s' → %s (%s)",
        str(user_term).replace("\r\n", " ").replace("\n", " ").replace("\r", " "),
        str(neo4j_name).replace("\r\n", " ").replace("\n", " ").replace("\r", " "),
        str(neo4j_label).replace("\r\n", " ").replace("\n", " ").replace("\r", " "),
    )

def _vocabulary_prompt_section() -> str:
    """Format the vocabulary as a system-prompt section, sorted by use count."""
    mappings = _load_vocabulary()
    if not mappings:
        return ""
    lines = [
        "\n## User Vocabulary (learned from previous sessions)",
        "Map these user terms before writing any Cypher query. Each entry is tagged [entity] or "
        "[category] — they mean very different things, read the tag, don't guess from the words alone:",
        "- **[entity]** (a single real Neo4j label): the term refers to ONE particular NAMED node — "
        "match it with `toLower(n.Name) = toLower('<name>')` under that label.",
        "- **[category]** (label field is blank; the name field holds one or more labels separated by "
        "`|`, e.g. `SmallMol` or `Protein|FunctionalClass|Complex`): the term refers to a whole TYPE of "
        "entity, not one named node. Use that value directly as the node label(s) in your MATCH, e.g. "
        "`(x:SmallMol)` — never try to match a node whose Name property equals the category string, and "
        "never substitute a different label that merely sounds plausible (e.g. using `Treatment` when "
        "the user's vocabulary says `SmallMol` for 'drugs'/'therapeutic approach') — the user has "
        "explicitly told you which label(s) they mean and that overrides your own judgment.\n",
    ]
    for m in sorted(mappings, key=lambda x: -x.get("use_count", 0)):
        tick = " ✓" if m.get("confirmed") else ""
        is_category = not m.get("neo4j_label")
        kind = "category" if is_category else "entity"
        label_display = m["neo4j_label"] if not is_category else "(none)"
        lines.append(
            f'- "{m["user_term"]}" → [{kind}] label=`{label_display}` name=**{m["neo4j_name"]}**{tick}'
            f'  (used {m.get("use_count", 1)}×)'
        )
    return "\n".join(lines)

# ── Runtime state (updated via /schema endpoint from Node.js) ─────────────────
_state: Dict[str, Any] = {
    "neo4j":       {},   # url, database, username, password — LEGACY/FALLBACK values
    "postgres":    {},   # host, port, database, schema, username, password — LEGACY/FALLBACK
    "llm":         {},   # apikey, url, model_name, temperature, top_p, json_mode
    "schema_text": "",   # human-readable schema for LLM system prompt
    "schema_labels":   [],  # Neo4j node labels (structured list, alongside schema_text above)
    "schema_rel_types": [], # Neo4j relationship types (structured list, alongside schema_text above)
}

# ── Per-user Neo4j/Postgres credentials ────────────────────────────────────────
# Mirrors server.js: the connection ENDPOINT (Neo4j url / Postgres host+port) is
# admin-managed and lives in _state["neo4j"/"postgres"] above (pushed via
# /schema). WHICH database/schema and WHICH login a request uses is each Graph
# Explorer user's OWN setting, stored on their account in users.json — read
# directly here since agent_service.py runs alongside server.js on the same
# filesystem. server.js's /api/agent/* proxy stamps a trusted `x-ge-username`
# header (never taken from the client) on every forwarded request; a request
# context var carries it from that header through to run_cypher()/run_postgres()
# without threading a parameter through every helper function.
import contextvars

USERS_FILE = Path(__file__).parent / "users.json"
_current_username: contextvars.ContextVar[str] = contextvars.ContextVar("current_username", default="")

def _load_users() -> List[Dict]:
    try:
        return json.loads(USERS_FILE.read_text("utf-8"))
    except Exception:
        return []

def _resolve_neo4j_cfg(username: str) -> Dict[str, str]:
    base     = _state.get("neo4j") or {}
    user     = next((u for u in _load_users() if u.get("username") == username), None)
    override = (user or {}).get("neo4j") or {}
    return {
        "url":      base.get("url", ""),
        "database": override.get("database") or base.get("database") or "neo4j",
        "username": override.get("username") or base.get("username") or "",
        "password": override.get("password") or base.get("password") or "",
    }

def _resolve_pg_cfg(username: str) -> Dict[str, Any]:
    base     = _state.get("postgres") or {}
    user     = next((u for u in _load_users() if u.get("username") == username), None)
    override = (user or {}).get("postgres") or {}
    return {
        "host":     base.get("host", ""),
        "port":     base.get("port", 5432),
        "database": override.get("database") or base.get("database") or "",
        "schema":   override.get("schema")   or base.get("schema")   or "public",
        "username": override.get("username") or base.get("username") or "",
        "password": override.get("password") or base.get("password") or "",
    }

def _resolve_llm_cfg(username: str) -> Dict[str, Any]:
    """Per-user LLM override, persisted server-side via server.js's
    POST /api/settings/my-llm (stored in users.json) — mirrors
    _resolve_neo4j_cfg/_resolve_pg_cfg above. This is what lets the frontend
    stop caching the user's API key in localStorage: once saved, the browser
    never needs to hold or resend the key again, because this function
    resolves it here from the SAME trusted, server-side users.json file the
    Neo4j/Postgres per-user credentials already come from."""
    user = next((u for u in _load_users() if u.get("username") == username), None)
    return (user or {}).get("llm") or {}

# ─────────────────────────────────────────────────────────────────────────────
#  Pydantic models
# ─────────────────────────────────────────────────────────────────────────────

class SchemaPayload(BaseModel):
    neo4j: Dict[str, Any]
    schema_text: str
    labels: List[str] = []      # Neo4j node labels, structured (mirrors schema_text)
    rel_types: List[str] = []   # Neo4j relationship types, structured (mirrors schema_text)
    llm: Optional[Dict[str, Any]] = None
    postgres: Optional[Dict[str, Any]] = None

# ChatMessage / ChatRequest (used only by the /chat route) now live in
# text2cypher_agent.py, imported below via register_text2cypher_routes().

class LibraryFile(BaseModel):
    name: str
    description: str = ""
    llm_config: Dict[str, Any] = {}
    workflow: List[Dict[str, Any]] = []
    notes: str = ""

class ExecuteWorkflowRequest(BaseModel):
    workflow: List[Dict[str, Any]]
    input: str = ""
    llm: Optional[Dict[str, Any]] = None

class LLMConfigPayload(BaseModel):
    url:        Optional[str] = None
    apikey:     Optional[str] = None
    username:   Optional[str] = None
    password:   Optional[str] = None
    model_name: Optional[str] = None
    temperature: float = 0.2
    top_p:       float = 0.9
    json_mode:   bool = False

class VocabEntry(BaseModel):
    user_term:   str
    neo4j_name:  str
    neo4j_label: str = ""
    confirmed:   bool = False

class BatchUpdateItem(BaseModel):
    relationId:   Any          # RelationID as stored in Neo4j — string or numeric, matched as text
    value:        str          # new property value, e.g. "Positive" / "Negative" / "Unknown"
    relationType: str = ""     # optional — lets the write scope its MATCH to one rel type instead
                                # of scanning every relationship in the database

class BatchWriteRequest(BaseModel):
    property: str = "Effect"
    updates:  List[BatchUpdateItem] = []
    username: str = ""   # logged-in Graph Explorer user, stamped onto r.updatedBy

class CypherExampleItem(BaseModel):
    question: str = ""
    cypher:   str = ""
    notes:    str = ""
    tags:     List[str] = []  # optional trigger phrases boosting relevance-selection score

class ExamplesPayload(BaseModel):
    examples: List[CypherExampleItem]

# ─────────────────────────────────────────────────────────────────────────────
#  Neo4j helpers
# ─────────────────────────────────────────────────────────────────────────────

def _neo4j_driver():
    if not HAS_NEO4J:
        raise RuntimeError("neo4j Python package not installed — run: pip install neo4j")
    cfg = _resolve_neo4j_cfg(_current_username.get())
    if not cfg.get("url"):
        raise RuntimeError("Neo4j not configured — connect via Graph Explorer Settings first")
    return _Neo4jDriver.driver(
        cfg["url"],
        auth=(cfg.get("username", ""), cfg.get("password", "")),
    )

def run_cypher(cypher: str, params: dict = {}) -> List[Dict]:
    driver = _neo4j_driver()
    db = _resolve_neo4j_cfg(_current_username.get()).get("database", "neo4j")
    query = (_Neo4jQuery(cypher, timeout=CYPHER_QUERY_TIMEOUT_SECONDS)
             if HAS_NEO4J else cypher)
    try:
        with driver.session(database=db) as session:
            result = session.run(query, params)
            rows = []
            for r in result:
                rows.append(_row_from_record(r))
            return rows
    finally:
        driver.close()

def _serialize_record(obj: Any) -> Any:
    """Recursively make a Neo4j record JSON-serialisable."""
    if isinstance(obj, dict):
        return {k: _serialize_record(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_serialize_record(i) for i in obj]
    try:
        json.dumps(obj)
        return obj
    except (TypeError, ValueError):
        return str(obj)

def _serialize_path(path) -> Dict:
    """Compact, LLM-friendly summary of a Neo4j Path.

    Backend safety net for a recurring failure: the LLM is repeatedly told (via
    cypher_examples.json) to RETURN lean node-name/relation-type lists instead of
    a raw path object for ranked-path questions, but keeps writing 'RETURN p'
    anyway. A raw Path's default serialization dumps every property of every
    node/relationship on it, which routinely blows past the tool result's
    ~8 000-character sample budget and truncates mid-object — the LLM then
    reports garbled/incomplete rows verbatim to the user. This compacts ANY
    Path-typed column to just names/labels/relationship types/reference counts
    regardless of what RETURN clause the LLM actually wrote, so truncation
    cannot happen here no matter how the query is shaped.
    """
    nodes = list(path.nodes)
    rels  = list(path.relationships)
    return {
        "path_node_names": [n.get("Name") or "" for n in nodes],
        "path_node_labels": [sorted(lbl for lbl in n.labels if lbl != "__Entity__") for n in nodes],
        "path_relationship_types": [r.type for r in rels],
        "path_relationship_references": [r.get("RelationNumberOfReferences") for r in rels],
        "path_hop_count": len(rels),
    }

def _path_signature(path) -> tuple:
    """Hashable identity for a path based on its node-name and relationship-type
    sequence (ignoring internal element IDs). Two separate relationship records
    between the same node pair otherwise show up as visually-identical duplicate
    rows in a ranked path list — this lets callers drop the repeats."""
    node_names = tuple((n.get("Name") or "") for n in path.nodes)
    rel_types  = tuple(r.type for r in path.relationships)
    return (node_names, rel_types)

def _row_from_record(record) -> Dict:
    """Build a JSON-safe row dict from a driver Record, compacting any
    Path-typed column via _serialize_path(). All non-Path columns are
    serialized exactly as before (via record.data()) — zero behavior change
    for the many existing queries that RETURN plain nodes/relationships."""
    data = record.data()
    if HAS_NEO4J:
        for key, value in zip(record.keys(), record.values()):
            if isinstance(value, _Neo4jPath):
                data[key] = _serialize_path(value)
    return _serialize_record(data)

def _run_cypher_analyzed(cypher: str, params: dict = {}) -> tuple:
    """Run a Cypher query once and return
    (serialized_rows, total_count, neighbor_count, neighbor_by_label).

    - serialized_rows / total_count: same as run_cypher() + a separate COUNT(*) would
      have given, but derived from a single pass instead of executing the query twice.
    - neighbor_count / neighbor_by_label: best-effort "neighbor" breakdown, by label.
      Every distinct node seen anywhere in the result is scored by how many ROWS it
      appears in (not how many times — a node counts once per row even if it shows up
      in two columns of that row). Whichever node(s) appear in at least HALF as many
      rows as the single most-frequent node are treated as the SEED/input side — e.g.
      'BRCA1' typically shows up in every row, so it's the max, and anything else that
      frequent is presumably another named seed (like a second entity in a "common to
      both A and B" query). Everything else is a "neighbor", grouped by its primary
      (first, alphabetically) label. This row-frequency approach (rather than picking
      the column with fewest distinct values) is what correctly handles queries that
      UNION branches with swapped source/target roles — a fixed seed entity, dominant
      but not literally 100% column-consistent, still stands out by frequency.
      Requires raw driver Node values (not run_cypher()'s already-serialized output,
      which loses type info — hence this re-implements the fetch instead of calling
      run_cypher()). Returns (None, {}) when fewer than two distinct nodes appear at
      all, or nothing stands out as dominant — callers must treat None as "not
      applicable", not zero.
    """
    driver = _neo4j_driver()
    db = _resolve_neo4j_cfg(_current_username.get()).get("database", "neo4j")
    query = (_Neo4jQuery(cypher, timeout=CYPHER_QUERY_TIMEOUT_SECONDS)
             if HAS_NEO4J else cypher)
    rows: List[Dict] = []
    row_count_per_node: Dict[str, int] = {}
    label_per_node: Dict[str, str] = {}
    seen_path_signatures: set = set()
    try:
        with driver.session(database=db) as session:
            result = session.run(query, params)
            for record in result:
                # Drop rows that are a duplicate LOGICAL path (same node-name +
                # relationship-type sequence) — e.g. two separate relationship
                # records between the same two nodes otherwise show up as
                # visually-identical repeated rows in a ranked path list, even
                # though the query has no DISTINCT on the path shape itself.
                # Only ever applies to rows that actually contain a Path column;
                # every other query shape is completely unaffected.
                if HAS_NEO4J:
                    row_path_sigs = [
                        _path_signature(value) for value in record.values()
                        if isinstance(value, _Neo4jPath)
                    ]
                    if row_path_sigs:
                        combined_sig = tuple(row_path_sigs)
                        if combined_sig in seen_path_signatures:
                            continue
                        seen_path_signatures.add(combined_sig)

                rows.append(_row_from_record(record))
                if HAS_NEO4J:
                    nodes_this_row = set()
                    for value in record.values():
                        if isinstance(value, _Neo4jNode):
                            nodes_this_row.add(value.element_id)
                            if value.element_id not in label_per_node:
                                labels = sorted(value.labels) if value.labels else ["Unknown"]
                                label_per_node[value.element_id] = labels[0]
                    for nid in nodes_this_row:
                        row_count_per_node[nid] = row_count_per_node.get(nid, 0) + 1
    finally:
        driver.close()

    neighbor_count, neighbor_by_label = None, {}
    if len(row_count_per_node) >= 2:
        max_freq       = max(row_count_per_node.values())
        seed_threshold = max_freq / 2.0
        neighbor_ids   = [nid for nid, cnt in row_count_per_node.items() if cnt < seed_threshold]
        if neighbor_ids:
            neighbor_count = len(neighbor_ids)
            for nid in neighbor_ids:
                label = label_per_node.get(nid, "Unknown")
                neighbor_by_label[label] = neighbor_by_label.get(label, 0) + 1

    return rows, len(rows), neighbor_count, neighbor_by_label

# ─────────────────────────────────────────────────────────────────────────────
#  PostgreSQL helper
# ─────────────────────────────────────────────────────────────────────────────

def run_postgres(sql: str, params: tuple = ()) -> List[Dict]:
    """Execute a read-only SQL query against the configured PostgreSQL database."""
    if not HAS_PG:
        raise RuntimeError("psycopg2 not installed — run: pip install psycopg2-binary")
    cfg = _resolve_pg_cfg(_current_username.get())
    if not cfg.get("host"):
        raise RuntimeError("PostgreSQL not configured — connect via Graph Explorer Settings first")

    # Safety: only allow SELECT / WITH statements
    stripped = sql.strip().lstrip("(").upper()
    if not (stripped.startswith("SELECT") or stripped.startswith("WITH")):
        raise RuntimeError("Only SELECT/WITH queries are permitted from the agent")

    schema = cfg.get("schema", "public")
    conn = psycopg2.connect(
        host=cfg["host"],
        port=int(cfg.get("port", 5432)),
        dbname=cfg["database"],
        user=cfg["username"],
        password=cfg.get("password", ""),
        options=f"-c search_path={schema}",
        connect_timeout=20,
    )
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # sql is the full, dynamic query TEXT generated by the LLM agent from a
            # natural-language question — this is the intended feature (a
            # text-to-SQL agent), not an injection bug, and is the same accepted
            # pattern documented in the FRD/README's Security Considerations
            # section. Mitigations already in place: only SELECT/WITH statements
            # are allowed (checked above), the caller's own least-privilege-scoped
            # DB credentials are used, and results are capped at 500 rows. `params`
            # (actual bound values, when the LLM chooses to use them) IS passed
            # through psycopg2's real parameter binding here, not string-formatted
            # into `sql` — so this does not contain a traditional value-concatenation
            # injection bug on top of the inherent dynamic-query-text design.
            # ACCEPTED FINDING (CodeQL: py/sql-injection) — dismiss manually in
            # the repo's Security tab; inline suppression comments are not
            # honored by this repo's CodeQL Action setup (confirmed after
            # repeated testing with verified-correct syntax/query-ID).
            cur.execute(sql, params or None)
            rows = [dict(r) for r in cur.fetchmany(500)]   # cap at 500 rows
        return rows
    finally:
        conn.close()

# ─────────────────────────────────────────────────────────────────────────────
#  PubMed search helper (NCBI E-utilities — free, no API key required)
# ─────────────────────────────────────────────────────────────────────────────

def run_pubmed_search(query: str, min_date: str = "", max_date: str = "",
                      max_results: int = 10) -> Dict[str, Any]:
    """Search PubMed via NCBI E-utilities and return structured reference rows."""
    import urllib.request
    import urllib.parse

    max_results = max(1, min(int(max_results), 50))

    # Step 1 — esearch: get matching PMIDs
    params: Dict[str, str] = {
        "db":      "pubmed",
        "term":    query,
        "retmax":  str(max_results),
        "retmode": "json",
        "sort":    "relevance",
    }
    if min_date or max_date:
        params["datetype"] = "pdat"
        if min_date:
            params["mindate"] = min_date
        if max_date:
            params["maxdate"] = max_date

    search_url = ("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?"
                  + urllib.parse.urlencode(params))
    try:
        with urllib.request.urlopen(search_url, timeout=15) as r:
            search_data = json.loads(r.read())
    except Exception as exc:
        raise RuntimeError(f"PubMed esearch failed: {_safe_exc_str(exc)}")

    pmids = search_data.get("esearchresult", {}).get("idlist", [])
    if not pmids:
        return {"rows": [], "count": 0, "total": int(
            search_data.get("esearchresult", {}).get("count", 0))}

    # Step 2 — esummary: fetch title / authors / journal / year
    sum_url = (
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?"
        f"db=pubmed&id={','.join(pmids)}&retmode=json"
    )
    try:
        with urllib.request.urlopen(sum_url, timeout=15) as r:
            summary = json.loads(r.read())
    except Exception as exc:
        raise RuntimeError(f"PubMed esummary failed: {_safe_exc_str(exc)}")

    rows = []
    result_map = summary.get("result", {})
    for pmid in pmids:
        doc = result_map.get(pmid)
        if not doc or "error" in doc:
            continue
        auths = doc.get("authors", [])
        author_str = ", ".join(a.get("name", "") for a in auths[:5])
        if len(auths) > 5:
            author_str += " et al."
        # pubdate can be "2024 Jan 15" or "2024"
        pub_year = str(doc.get("pubdate", ""))[:4]
        rows.append({
            "pmid":    pmid,
            "title":   doc.get("title", ""),
            "authors": author_str,
            "pubyear": pub_year,
            "journal": doc.get("source", ""),
        })

    total = int(search_data.get("esearchresult", {}).get("count", len(rows)))
    return {"rows": rows, "count": len(rows), "total": total}

# ─────────────────────────────────────────────────────────────────────────────
#  Ontology lookup helper
# ─────────────────────────────────────────────────────────────────────────────

_REL_TOKEN_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')

def _sanitize_rel_types(via: str) -> str:
    """
    Accept only pipe-separated valid Neo4j relationship-type identifiers.
    Any token that isn't a clean identifier is dropped; falls back to 'is_a|part_of'.
    This prevents Cypher injection via the 'via' parameter.
    """
    tokens = [t.strip() for t in via.split("|")]
    safe   = [t for t in tokens if _REL_TOKEN_RE.match(t)]
    return "|".join(safe) if safe else "is_a|part_of"

def run_ontology_lookup(sub_action: str, term: str = "", concept: str = "",
                        via: str = "is_a|part_of", depth: int = 2) -> Dict[str, Any]:
    """
    Execute an ontology navigation query against Neo4j.
    sub_action: 'alias_search' | 'broaden' | 'narrow'
    """
    safe_via = _sanitize_rel_types(via)
    depth    = min(max(int(depth), 1), 5)   # clamp 1–5

    if sub_action == "alias_search":
        # Search nodes by Alias string OR Name, return ranked matches
        cypher = """
MATCH (n)
WHERE toLower(coalesce(n.Name,  '')) CONTAINS toLower($term)
   OR toLower(coalesce(n.Alias, '')) CONTAINS toLower($term)
RETURN labels(n)[0]          AS label,
       n.Name                AS name,
       n.Alias               AS aliases
ORDER BY
  CASE
    WHEN toLower(coalesce(n.Name,'')) = toLower($term)            THEN 0
    WHEN toLower(coalesce(n.Name,'')) STARTS WITH toLower($term)  THEN 1
    WHEN toLower(coalesce(n.Alias,'')) = toLower($term)           THEN 2
    WHEN toLower(coalesce(n.Alias,'')) CONTAINS toLower($term)    THEN 3
    ELSE 4
  END
LIMIT 15
"""
        rows = run_cypher(cypher, {"term": term})
        return {"sub_action": "alias_search", "term": term, "matches": rows}

    elif sub_action == "broaden":
        # Navigate UP the ontology (towards parent / broader concepts)
        cypher = f"""
MATCH (n)-[:{safe_via}*1..{depth}]->(parent)
WHERE n.Name = $concept
   OR toLower(coalesce(n.Alias,'')) CONTAINS toLower($concept)
RETURN DISTINCT
       labels(parent)[0] AS label,
       parent.Name       AS name,
       parent.Alias      AS aliases
LIMIT 25
"""
        rows = run_cypher(cypher, {"concept": concept})
        return {"sub_action": "broaden", "concept": concept, "direction": "up",
                "via": safe_via, "depth": depth, "parents": rows}

    elif sub_action == "narrow":
        # Navigate DOWN the ontology (towards child / more specific concepts)
        cypher = f"""
MATCH (parent)<-[:{safe_via}*1..{depth}]-(child)
WHERE parent.Name = $concept
   OR toLower(coalesce(parent.Alias,'')) CONTAINS toLower($concept)
RETURN DISTINCT
       labels(child)[0] AS label,
       child.Name       AS name,
       child.Alias      AS aliases
LIMIT 25
"""
        rows = run_cypher(cypher, {"concept": concept})
        return {"sub_action": "narrow", "concept": concept, "direction": "down",
                "via": safe_via, "depth": depth, "children": rows}

    else:
        raise ValueError(f"Unknown ontology sub_action: {sub_action!r}. "
                         "Use 'alias_search', 'broaden', or 'narrow'.")

# Summarize agent implementation lives in summarize_agent.py.

# ─────────────────────────────────────────────────────────────────────────────
#  RelationID calculation  (mirrors server.js calcRelationId / _myhash exactly)
# ─────────────────────────────────────────────────────────────────────────────

def _rid_py_repr(val) -> str:
    """Matches server.js _pyRepr — Python str()-style repr of a list or scalar."""
    if isinstance(val, list):
        if not val:
            return '[]'
        parts = []
        for v in val:
            s = str(v)
            if re.match(r'^-?\d+$', s):
                parts.append(s)
            else:
                parts.append("'" + s.replace('\\', '\\\\').replace("'", "\\'") + "'")
        return '[' + ', '.join(parts) + ']'
    s = str(val)
    return "'" + s.replace('\\', '\\\\').replace("'", "\\'") + "'"

def _rid_myhash(text: str) -> str:
    """MD5-based hash matching server.js _myhash."""
    d = hashlib.md5(text.encode('utf-8')).digest()
    high, = struct.unpack_from('>Q', d, 0)   # bytes 0-7 as unsigned 64-bit BE
    low,  = struct.unpack_from('>Q', d, 8)   # bytes 8-15
    MASK  = 0x7FFFFFFFFFFFFFFF
    r     = high ^ low
    if r > MASK:
        r = -(r & MASK)
    return str(r)

def calc_relation_id(inref=None, inoutref=None, outref=None,
                     control_type: str = '', ontology: str = '',
                     relationship: str = '', effect: str = '',
                     mechanism: str = '') -> str:
    """
    Calculate RelationID — identical to server.js calcRelationId.
    inref    : NodeID values of source nodes  (direction →), sorted desc
    inoutref : NodeID values of bidirectional nodes
    outref   : NodeID values of target nodes  (direction ←), sorted desc
    """
    def _desc(lst):
        """Sort list descending by integer value, matching JS BigInt sort."""
        try:
            return sorted(lst or [], key=lambda x: -int(str(x)))
        except (ValueError, TypeError):
            return sorted(lst or [], reverse=True)

    inref    = _desc(inref)
    inoutref = _desc(inoutref)
    outref   = _desc(outref)

    s = '(' + ', '.join([
        _rid_py_repr(inref),
        _rid_py_repr(inoutref),
        _rid_py_repr(outref),
        _rid_py_repr(control_type),
        _rid_py_repr(ontology),
        _rid_py_repr(relationship),
        _rid_py_repr(str(effect).lower()),
        _rid_py_repr(mechanism),
    ]) + ')'
    return _rid_myhash(s)

# ─────────────────────────────────────────────────────────────────────────────
#  LLM helpers
# ─────────────────────────────────────────────────────────────────────────────

def _effective_llm(override: Optional[Dict]) -> Dict:
    """Layers three sources, lowest to highest priority:
      1. _state['llm']       — shared/admin-configured defaults
      2. per-user server-side override — from users.json via _resolve_llm_cfg(),
         saved through POST /api/settings/my-llm; this is what the browser's
         API key now persists to instead of localStorage
      3. request-level override — an explicit 'llm' field sent with THIS
         request, e.g. the Settings dialog's 'Test connection' flow trying
         out a new key the user hasn't clicked Save on yet
    Empty-string / None values never clobber an already-set value from a
    lower-priority source, so a request that omits apikey still resolves to
    the per-user stored key rather than wiping it out."""
    base = dict(_state["llm"])
    base.update({k: v for k, v in _resolve_llm_cfg(_current_username.get()).items()
                 if v is not None and v != ""})
    if override:
        base.update({k: v for k, v in override.items()
                     if v is not None and v != ""})
    return base

def _is_gemini_model(model: str) -> bool:
    return (model or "").lower().startswith("gemini")

def _anthropic_client(llm: Dict):
    if not HAS_ANTHROPIC:
        raise RuntimeError("anthropic package not installed — run: pip install anthropic")
    api_key = llm.get("apikey") or os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise RuntimeError("Anthropic API key not set — configure in Settings → Agentic AI")
    base_url = llm.get("url") or None
    kwargs = {"api_key": api_key}
    if base_url and "anthropic.com" not in (base_url or ""):
        kwargs["base_url"] = base_url
    return _anthropic_mod.Anthropic(**kwargs)

def _openai_client(llm: Dict):
    """OpenAI-compatible client — used for Gemini and any OpenAI-compatible endpoint."""
    if not HAS_OPENAI:
        raise RuntimeError("openai package not installed — run: pip install openai")
    model    = llm.get("model_name", "")
    url      = llm.get("url", "") or ""
    is_gemini = _is_gemini_model(model) or "generativelanguage.googleapis.com" in url
    # Auto-select Gemini base URL when model is gemini-* and no custom URL was set
    default_url = GEMINI_BASE_URL if is_gemini else None
    base_url = llm.get("url") or default_url
    env_key  = "GEMINI_API_KEY" if is_gemini else "OPENAI_API_KEY"
    api_key  = llm.get("apikey") or os.environ.get(env_key, "")
    if not api_key:
        raise RuntimeError(f"API key not set — configure in Settings → Agentic AI (env: {env_key})")
    kwargs: Dict[str, Any] = {"api_key": api_key}
    if base_url:
        kwargs["base_url"] = base_url
    return _openai_mod.OpenAI(**kwargs)

# Text2Cypher action-parsing helpers (_strip_actions_from_reply, _extract_action,
# _extract_cypher_action), _current_graph_prompt_section, and the Cypher-agent
# _system_prompt() builder now live in text2cypher_agent.py — imported below.
# _extract_cypher_action and _system_prompt are re-imported here because other
# routes in this file (execute_workflow, _call_llm's fallback path, ping_llm)
# still call them directly.
from text2cypher_agent import _extract_cypher_action, _system_prompt, register_text2cypher_routes

def _call_llm(messages: List[Dict], llm: Dict, system_prompt: str = "") -> tuple:
    """Call the configured LLM and return (text_reply, was_truncated).

    Routes to Anthropic SDK for claude-* models / anthropic.com URLs and
    OpenAI-compatible SDK for everything else (Gemini, OpenAI, Groq, Together…).

    `was_truncated` is True when the provider stopped generating because it hit the
    max-tokens cap (Anthropic `stop_reason == "max_tokens"` / OpenAI-compatible
    `finish_reason == "length"`) rather than finishing naturally. A truncated reply
    can leave an action block (```json {"action": ...}```) unterminated — invalid JSON
    that neither executes nor gets stripped from the visible text — so callers use this
    flag to retry instead of showing broken JSON to the user.
    """
    url          = llm.get("url", "")
    model        = llm.get("model_name") or ""
    temperature  = float(llm.get("temperature", 0.2))
    top_p        = float(llm.get("top_p", 0.9))
    call_timeout = float(llm.get("call_timeout", 180))
    max_tokens   = int(llm.get("max_tokens", 8192))

    # Gemini 2.5 models have "thinking" enabled by default, and on the
    # OpenAI-compatible endpoint the invisible reasoning tokens are drawn from
    # the SAME max_tokens budget as the visible answer. With only the default
    # 8192-token budget, a long internal reasoning pass can consume nearly all
    # of it, leaving the visible reply cut off after just a couple hundred
    # tokens even though the provider reports finish_reason == "length"
    # (truncated). Raise the effective ceiling for these models (unless the
    # user explicitly configured a larger one already) so there's enough room
    # left for the actual answer after reasoning.
    if not llm.get("max_tokens") and model.startswith("gemini-2.5"):
        max_tokens = max(max_tokens, 32768)

    # Determine provider from URL first (reliable), fall back to model name.
    # This prevents routing to Anthropic when the URL is Gemini/OpenAI but the
    # model name hasn't been saved yet — will raise a clear error below.
    is_anthropic = (
        "anthropic.com" in url
        or (not url and model.startswith("claude"))
    )

    # Detect provider-model mismatch: e.g. user previously saved a Claude model
    # but has since switched to a Gemini/OpenAI/Groq provider URL.  Clear the
    # stale model so the user is prompted to pick a correct one.
    if model and not is_anthropic:
        if "generativelanguage.googleapis.com" in url and not model.startswith("gemini"):
            model = ""
        elif "openai.com" in url and model.startswith("claude"):
            model = ""
        elif "groq.com" in url and model.startswith("claude"):
            model = ""
        elif "together.xyz" in url and model.startswith("claude"):
            model = ""
        elif "replicate.com" in url and model.startswith("claude"):
            model = ""

    # If model still not set, try the user's saved model from users.json
    if not model:
        model = _resolve_llm_cfg(_current_username.get()).get("model_name", "")

    if not model:
        raise RuntimeError(
            "No model selected. Please open Settings → Agentic AI / LLM, "
            "choose a provider and select a model, then click Save."
        )

    if system_prompt:
        sp = system_prompt
    else:
        # Fallback path (e.g. workflow steps that don't pre-build a system prompt):
        # use the most recent user message for example-relevance scoring.
        _last_user = next((m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), "")
        sp = _system_prompt(_last_user)
    log.info("LLM call → model=%s prompt_tokens≈%d msg_turns=%d timeout=%ss",
             model, len(sp) // 4, len(messages), int(call_timeout))

    t0 = time.time()
    truncated = False

    if not is_anthropic:
        # ── OpenAI-compatible path (Gemini, OpenAI, Groq, Together, etc.) ────
        # Run in a daemon thread so the synchronous httpx call can't freeze
        # uvicorn's async event loop — mirrors the entity-lookup timeout pattern.
        client = _openai_client(llm)
        oai_messages = [{"role": "system", "content": sp}] + messages
        kwargs_oai: Dict[str, Any] = dict(
            model=model,
            messages=oai_messages,
            max_tokens=max_tokens,
            temperature=temperature,
            timeout=call_timeout,
        )
        if top_p < 1.0:
            kwargs_oai["top_p"] = top_p
        if model.startswith("gemini-2.5"):
            # Trim how much of the token budget goes to invisible reasoning so
            # more is left for the visible answer (see max_tokens note above).
            kwargs_oai["reasoning_effort"] = "low"

        result_holder: List = []
        error_holder:  List = []

        def _do_oai_call():
            try:
                resp = client.chat.completions.create(**kwargs_oai)
                result_holder.append(resp)
            except Exception as _e:
                error_holder.append(_e)

        oai_thread = threading.Thread(target=_do_oai_call, daemon=True)
        oai_thread.start()
        oai_thread.join(timeout=call_timeout + 10)   # +10s buffer over SDK timeout
        if oai_thread.is_alive():
            raise RuntimeError(
                f"LLM call timed out after {int(call_timeout)}s — "
                "model may be unavailable or the endpoint is not responding"
            )
        if error_holder:
            raise error_holder[0]
        resp  = result_holder[0] if result_holder else None
        text  = (resp.choices[0].message.content or "") if resp else ""
        truncated = bool(resp) and getattr(resp.choices[0], "finish_reason", "") == "length"
    else:
        # ── Anthropic SDK path (Claude models / anthropic.com URL) ───────────
        client = _anthropic_client(llm)
        kwargs = dict(
            model=model,
            max_tokens=max_tokens,
            system=sp,
            messages=messages,
            temperature=temperature,
            timeout=call_timeout,
        )
        if top_p < 1.0:
            kwargs["top_p"] = top_p
        response  = client.messages.create(**kwargs)
        text      = response.content[0].text
        truncated = getattr(response, "stop_reason", "") == "max_tokens"

    log.info("LLM call ← %.1f s  reply_tokens≈%d  truncated=%s", time.time() - t0, len(text) // 4, truncated)
    return text, truncated

# ─────────────────────────────────────────────────────────────────────────────
#  Routes — health & schema
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status":        "ok",
        "schema_loaded": bool(_state["schema_text"]),
        "schema_chars":  len(_state["schema_text"]),
        "neo4j_url":     _state["neo4j"].get("url", ""),
        "postgres_host": _state["postgres"].get("host", ""),
        "llm_model":     _state["llm"].get("model_name") or _resolve_llm_cfg(_current_username.get()).get("model_name") or "(not configured)",
        "has_anthropic": HAS_ANTHROPIC,
        "has_openai":    HAS_OPENAI,
        "has_neo4j":     HAS_NEO4J,
        "has_postgres":  HAS_PG,
        "has_langgraph": HAS_LANGGRAPH,
    }

class PingRequest(BaseModel):
    llm: Optional[Dict[str, Any]] = None   # preferred: { url, apikey, model_name, ... }
    # flat fields accepted as fallback for backwards-compat
    url:        Optional[str] = None
    apikey:     Optional[str] = None
    model_name: Optional[str] = None
    test_message: Optional[str] = None

@app.post("/ping-llm")
def ping_llm(req: PingRequest = None):
    """Minimal LLM round-trip — returns model name, provider, and wall-clock time."""
    import urllib.request as _urllib_req
    import urllib.error  as _urllib_err

    # Merge flat top-level fields into llm dict (for backwards-compat with old frontend)
    req_llm = dict(req.llm or {}) if req else {}
    if req and req.url        and not req_llm.get("url"):        req_llm["url"]        = req.url
    if req and req.apikey     and not req_llm.get("apikey"):     req_llm["apikey"]     = req.apikey
    if req and req.model_name and not req_llm.get("model_name"): req_llm["model_name"] = req.model_name

    llm   = _effective_llm(req_llm or None)
    url   = llm.get("url", "")
    model = llm.get("model_name") or ""

    # If model not set, try user's saved settings then raise a clear error
    if not model:
        model = _resolve_llm_cfg(_current_username.get()).get("model_name", "")
    if not model:
        raise HTTPException(status_code=400, detail=(
            "No model selected. Please open Settings → Agentic AI / LLM, "
            "choose a provider and select a model, then click Save."
        ))
    sp    = _system_prompt()
    t0    = time.time()
    try:
        if _is_gemini_model(model):
            api_key = llm.get("apikey") or os.environ.get("GEMINI_API_KEY", "")
            if not api_key:
                return {"ok": False, "error": "Gemini API key not set — configure in Settings → Agentic AI"}
            ping_url  = (f"https://generativelanguage.googleapis.com/v1beta/models/"
                         f"{model}:generateContent")
            ping_body = json.dumps({
                "contents": [{"parts": [{"text": "Reply with only the word PONG."}]}],
                "generationConfig": {"maxOutputTokens": 16},
            }).encode()
            http_req = _urllib_req.Request(
                ping_url, data=ping_body,
                headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
            )
            log.info("Gemini ping → %s", ping_url)

            HARD_TIMEOUT = 15
            ping_result: List = []
            ping_error:  List = []

            def _do_gemini_ping():
                import socket as _sock
                _sock.setdefaulttimeout(HARD_TIMEOUT)
                try:
                    with _urllib_req.urlopen(http_req, timeout=HARD_TIMEOUT) as r:
                        ping_result.append(json.loads(r.read()))
                except _urllib_err.HTTPError as he:
                    try:
                        raw_body = he.read().decode("utf-8", errors="replace")
                    except Exception:
                        raw_body = ""
                    ping_error.append(("http", he.code, _sanitize_public_text(raw_body, 400)))
                except Exception as _e:
                    ping_error.append(("err", 0, str(_e)))

            pt = threading.Thread(target=_do_gemini_ping, daemon=True)
            pt.start()
            pt.join(timeout=HARD_TIMEOUT + 2)

            if pt.is_alive():
                return {"ok": False,
                        "error": (f"Gemini API did not respond within {HARD_TIMEOUT}s. "
                                  "Possible causes: corporate firewall blocking outbound HTTPS, "
                                  "API key not activated, or model name incorrect."),
                        "elapsed_s": round(time.time() - t0, 2), "model": model}

            if ping_error:
                kind, code, msg = ping_error[0]
                if kind == "http":
                    return {"ok": False, "error": f"HTTP {code}: {msg}",
                            "elapsed_s": round(time.time() - t0, 2), "model": model}
                return {"ok": False, "error": msg, "elapsed_s": round(time.time() - t0, 2), "model": model}

            resp_body = ping_result[0] if ping_result else {}
            reply = (resp_body.get("candidates", [{}])[0]
                              .get("content", {})
                              .get("parts", [{}])[0]
                              .get("text", "PONG"))
        elif "anthropic.com" in url or (not url and HAS_ANTHROPIC):
            # Anthropic (native SDK)
            if not HAS_ANTHROPIC:
                return {"ok": False, "error": "anthropic package not installed — run: pip install anthropic"}
            client   = _anthropic_client(llm)
            response = client.messages.create(
                model=model, max_tokens=16,
                system="Reply with only the word PONG.",
                messages=[{"role": "user", "content": "ping"}],
                timeout=30,
            )
            reply = response.content[0].text.strip()
        else:
            # OpenAI-compatible endpoint (OpenAI, Groq, Together, Replicate, etc.)
            if not HAS_OPENAI:
                return {"ok": False, "error": "openai package not installed — run: pip install openai"}
            client   = _openai_client(llm)
            response = client.chat.completions.create(
                model=model, max_tokens=16,
                messages=[
                    {"role": "system", "content": "Reply with only the word PONG."},
                    {"role": "user",   "content": "ping"},
                ],
                timeout=30,
            )
            reply = response.choices[0].message.content.strip()
        elapsed  = time.time() - t0
        if "anthropic.com" in url:
            provider = "anthropic"
        elif _is_gemini_model(model):
            provider = "gemini"
        else:
            provider = "openai-compatible"
        log.info("Ping OK: model=%s elapsed=%.1fs reply=%r", model, elapsed, reply)
        return {"ok": True, "model": model, "provider": provider,
                "elapsed_s": round(elapsed, 2),
                "system_prompt_tokens": len(sp) // 4,
                "reply": reply}
    except Exception:
        log.exception("Ping failed")
        return {"ok": False, "error": "Ping failed due to an internal error.", "elapsed_s": round(time.time() - t0, 2), "model": model}

@app.post("/schema")
def update_schema(payload: SchemaPayload):
    _state["neo4j"]       = payload.neo4j
    _state["schema_text"] = payload.schema_text
    _state["schema_labels"]    = payload.labels
    _state["schema_rel_types"] = payload.rel_types
    if payload.llm:
        _state["llm"].update({k: v for k, v in payload.llm.items() if v is not None})
    if payload.postgres:
        _state["postgres"] = payload.postgres
        # Sanitized fully inline, directly as the log.info() arguments — no
        # intermediate variable, even one line above, since CodeQL's
        # py/log-injection check does not reliably trace a sanitizing
        # transformation across a statement boundary; it needs the literal
        # .replace() chain visible within the sink call's own arguments.
        log.info(
            "PostgreSQL config received: host=%s db=%s",
            str(payload.postgres.get("host") or "").replace("\r\n", " ").replace("\n", " ").replace("\r", " "),
            str(payload.postgres.get("database") or "").replace("\r\n", " ").replace("\n", " ").replace("\r", " "),
        )
    log.info("Schema updated — %d chars", len(payload.schema_text))
    return {"ok": True}

@app.post("/llm-config")
def update_llm_config(payload: LLMConfigPayload):
    data = payload.dict(exclude_none=True)
    _state["llm"].update(data)
    log.info("LLM config updated: model=%s", _state["llm"].get("model_name"))
    return {"ok": True}

# /chat route (Text2Cypher agentic loop) now lives in text2cypher_agent.py —
# see the register_text2cypher_routes(...) call further down this file.


def _call_llm_with_retries(messages: List[Dict], llm: Dict, system_prompt: str, attempts: int = 3) -> tuple:
    """Same short-backoff retry _chat() already applies inline around its own
    _call_llm() calls, factored out so /summarize-chat (which needs it for
    TWO separate calls -- the initial reply and, on a resummarize action, the
    follow-up reply) doesn't duplicate that loop twice."""
    last_exc = None
    for attempt in range(attempts):
        try:
            return _call_llm(messages, llm, system_prompt)
        except Exception as exc:
            last_exc = exc
            if attempt < attempts - 1:
                log.warning("LLM call failed (attempt %d/%d): %s — retrying", attempt + 1, attempts, exc)
                time.sleep(1.5 * (attempt + 1))
    log.error("LLM call failed after %d attempts: %s", attempts, last_exc)
    raise HTTPException(
        status_code=502,
        detail=(f"The AI provider didn't respond after {attempts} attempts ({last_exc}). "
                "This is usually a temporary network or provider issue — please try again in a moment.")
    )


# Lazy import of summarize routes — deferred to improve startup speed
try:
    from summarize_agent import register_summarize_routes
    register_summarize_routes(
        app,
        {
            "effective_llm": _effective_llm,
            "call_llm_with_retries": _call_llm_with_retries,
            "skills_prompt_section": _skills_prompt_section,
            "run_postgres": run_postgres,
            "run_cypher": run_cypher,
            "run_ontology_lookup": run_ontology_lookup,
            "resolve_pg_cfg": _resolve_pg_cfg,
            "current_username": _current_username,
            "log": log,
            "neo4j_node_types": lambda: list(_state.get("schema_labels") or []),
            "neo4j_relation_types": lambda: list(_state.get("schema_rel_types") or []),
        },
    )
    log.info("Summarize routes registered successfully")
except Exception as e:
    log.warning("Failed to register summarize routes: %s", e)


# Text2Cypher (/chat) routes — a core, non-optional feature (unlike the summarize
# routes above), so registered directly rather than deferred/best-effort.
register_text2cypher_routes(
    app,
    {
        "effective_llm": _effective_llm,
        "call_llm": _call_llm,
        "run_cypher_analyzed": _run_cypher_analyzed,
        "safe_exc_str": _safe_exc_str,
        "run_postgres": run_postgres,
        "run_ontology_lookup": run_ontology_lookup,
        "upsert_vocabulary": _upsert_vocabulary,
        "run_pubmed_search": run_pubmed_search,
        "calc_relation_id": calc_relation_id,
        "state": _state,
        "resolve_llm_cfg": _resolve_llm_cfg,
        "current_username": _current_username,
        "load_vocabulary": _load_vocabulary,
        "examples_prompt_section": _examples_prompt_section,
        "skills_prompt_section": _skills_prompt_section,
        "vocabulary_prompt_section": _vocabulary_prompt_section,
        "resolve_pg_cfg": _resolve_pg_cfg,
        "cypher_query_timeout_seconds": CYPHER_QUERY_TIMEOUT_SECONDS,
        "log": log,
    },
)
log.info("Text2Cypher routes registered successfully")


# ─────────────────────────────────────────────────────────────────────────────
#  Route — list available models from a provider
# ─────────────────────────────────────────────────────────────────────────────

class ListModelsRequest(BaseModel):
    url:    str
    apikey: str = ""

def _resolve_allowlisted_provider_url(base_url: str) -> str:
    """Match base_url against the admin-configured provider list
    (_state['llm']['providers'] — the same list shown in the Settings ->
    Agentic AI / LLM dropdown) and return the exact, trusted URL string from
    that list, or raise ValueError.

    This is the CodeQL-recognized-safe SSRF pattern (per Copilot Autofix's
    suggestion on this exact finding): compare a request-supplied value
    against a maintained allowlist and use ONLY the matched allowlist literal
    for the actual outbound request, rather than trusting the request-
    supplied string itself even after other validation. It replaces relying
    solely on _assert_safe_external_url()'s DNS/IP-range check, which is
    real protection but — being a hand-written function — isn't something
    CodeQL's static analysis can verify as a sanitizer.

    This costs nothing functionally: the legitimate UI never sends a URL
    outside this admin-managed list in the first place (users pick a
    provider from a dropdown populated by it, they don't type a free-form
    URL) — this only closes the gap where a raw API call bypassing that UI
    could have sent an arbitrary URL the backend would previously have
    accepted at face value. Admins can still add any custom/self-hosted
    OpenAI-compatible endpoint they want via POST /api/settings/llm; nothing
    about "any OpenAI-compatible provider" as a feature is removed, only
    where that trust decision is enforced (admin-managed list, not a
    per-request client-supplied string).
    """
    normalized = (base_url or "").rstrip("/").lower()
    if not normalized:
        raise ValueError("No URL provided")
    
    # Combine default_providers and custom_providers into a single list
    llm_config = _state.get("llm", {})
    default_providers = llm_config.get("default_providers") or []
    custom_providers = llm_config.get("custom_providers") or []
    all_providers = list(default_providers) + list(custom_providers)
    
    for p in all_providers:
        allowed = (p.get("url") or "").rstrip("/").lower()
        if allowed and allowed == normalized:
            # Return the CONFIGURED literal (p["url"]), not `normalized` —
            # `normalized` is still derived from the request, even though it
            # matched. Only a value sourced from _state['llm']['providers']
            # itself counts as trusted configuration for this function's
            # contract: outbound URL must come from configuration, never
            # request data, full stop, with no exceptions for "but it matched
            # a known hostname." No fallback exists for Gemini/Anthropic
            # hostnames anymore — if a provider isn't in this list, admins add
            # it via POST /api/settings/llm (including Gemini/Anthropic, if
            # not already present); there is no other path to a valid result.
            return (p.get("url") or "").rstrip("/")
    raise ValueError(
        "This provider URL is not in the configured provider list — ask an "
        "admin to add it under Settings -> Agentic AI / LLM first."
    )

@app.post("/list-models")
def list_models(req: ListModelsRequest):
    """Return model IDs available on the given provider URL."""
    import urllib.request as _urllib_req
    import urllib.error   as _urllib_err

    apikey = req.apikey or ""

    try:
        # base_url is now the ALLOWLISTED literal (see
        # _resolve_allowlisted_provider_url) — every branch below, including
        # the open-ended OpenAI-compatible one, builds its request from this
        # value, never from req.url directly.
        base_url = _resolve_allowlisted_provider_url(req.url)
        host = _assert_safe_external_url(base_url)
    except ValueError as exc:
        log.exception("Invalid provider URL in /list-models: %s", _safe_exc_str(exc))
        return {"models": [], "error": "Invalid provider configuration"}

    # ── Gemini native REST ─────────────────────────────────────────────────────
    # Exact hostname match — NOT a substring check — so a URL merely containing
    # "generativelanguage.googleapis.com" somewhere (e.g. as a query parameter
    # on an attacker-controlled host) can no longer be mistaken for the real
    # provider host (CodeQL: py/incomplete-url-substring-sanitization).
    if host == "generativelanguage.googleapis.com":
        if not apikey:
            return {"models": [], "error": "API key required for Gemini"}
        try:
            # The API key travels in the x-goog-api-key HEADER, not the URL
            # (Gemini's REST API supports both; the header form is used here
            # deliberately). Fixes CodeQL: py/partial-ssrf — "part of the URL
            # depends on a user-provided value" — by removing tainted data
            # from the URL string entirely, rather than just escaping it.
            # The URL is now a fixed literal with no interpolation at all.
            murl = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=100"
            gemini_req = _urllib_req.Request(murl, headers={"x-goog-api-key": apikey})
            with _urllib_req.urlopen(gemini_req, timeout=10) as r:
                data = json.loads(r.read())
            models = sorted([
                m["name"].split("/")[-1]
                for m in data.get("models", [])
                if "generateContent" in m.get("supportedGenerationMethods", [])
            ])
            return {"models": models}
        except _urllib_err.HTTPError as he:
            # Full detail (status + response body) goes to the server log
            # only — the client gets a fixed, generic string. CodeQL
            # (py/stack-trace-exposure, "Information exposure through an
            # exception") flags ANY exception-derived text reaching the
            # response, even redacted/truncated text from _safe_http_error_str
            # — only a message with NO connection to the exception at all
            # satisfies it.
            log.exception("Gemini /list-models HTTP error: %s", _safe_http_error_str(he, 500))
            return {"models": [], "error": "Internal error while listing models"}
        except Exception as e:
            log.exception("Gemini /list-models unexpected error: %s", _safe_exc_str(e))
            return {"models": [], "error": "Internal error while listing models"}

    # ── Anthropic ──────────────────────────────────────────────────────────────
    if host == "api.anthropic.com" or host.endswith(".anthropic.com"):
        try:
            http_req = _urllib_req.Request(
                "https://api.anthropic.com/v1/models",
                headers={"x-api-key": apikey, "anthropic-version": "2023-06-01"}
            )
            with _urllib_req.urlopen(http_req, timeout=10) as r:
                data = json.loads(r.read())
            models = sorted([m["id"] for m in data.get("data", [])], reverse=True)
            return {"models": models}
        except _urllib_err.HTTPError as he:
            log.exception("Anthropic /list-models HTTP error: %s", _safe_http_error_str(he, 500))
            return {"models": [], "error": "Internal error while listing models"}
        except Exception as e:
            log.exception("Anthropic /list-models unexpected error: %s", _safe_exc_str(e))
            return {"models": [], "error": "Internal error while listing models"}

    # ── OpenAI-compatible /models ──────────────────────────────────────────────
    # base_url here is the ALLOWLISTED literal returned by
    # _resolve_allowlisted_provider_url() above — matched against the
    # admin-configured provider list, not req.url directly — plus it has
    # separately passed the DNS/IP-range check in _assert_safe_external_url().
    # Two layers: the allowlist match is the CodeQL-recognized-safe SSRF
    # pattern (a literal-collection comparison), the DNS check is defense in
    # depth in case the allowlist itself is ever misconfigured with a
    # hostname that later re-resolves somewhere unsafe.
    try:
        http_req = _urllib_req.Request(
            base_url + "/models",
            headers={"Authorization": f"Bearer {apikey}"}
        )
        with _urllib_req.urlopen(http_req, timeout=10) as r:
            data = json.loads(r.read())
        models = sorted([m["id"] for m in data.get("data", [])])
        return {"models": models}
    except _urllib_err.HTTPError as he:
        log.exception("OpenAI-compatible /list-models HTTP error: %s", _safe_http_error_str(he, 500))
        return {"models": [], "error": "Internal error while listing models"}
    except Exception as e:
        log.exception("OpenAI-compatible /list-models unexpected error: %s", _safe_exc_str(e))
        return {"models": [], "error": "Internal error while listing models"}


# ─────────────────────────────────────────────────────────────────────────────
#  Routes — library (local .json files in agent_library/)
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/library")
def list_library():
    files = []
    for p in sorted(LIBRARY_DIR.glob("*.json")):
        try:
            data = json.loads(p.read_text("utf-8"))
            files.append({
                "id":          p.stem,
                "name":        data.get("name", p.stem),
                "description": data.get("description", ""),
                "created":     data.get("created", ""),
                "steps":       len(data.get("workflow", [])),
            })
        except Exception:
            pass
    return {"files": files}

_LIBRARY_FILE_ID_RE = re.compile(r'^[a-zA-Z0-9_\-]{1,64}$')

def _safe_library_path(file_id: str) -> Optional[Path]:
    """Look up file_id against the files ALREADY PRESENT in LIBRARY_DIR,
    rather than constructing a path by joining LIBRARY_DIR with file_id.
    Returns the matching Path, or None if there is no match.

    This is a deliberately different approach from a validate-then-join
    pattern (regex-check file_id, then build LIBRARY_DIR / f"{file_id}.json"):
    CodeQL's py/path-injection query kept flagging every downstream use of a
    path built that way, because it cannot verify that a hand-written Python
    validation function actually neutralizes the tainted string used to build
    it. Here, file_id NEVER flows into a path-construction expression at all —
    it is only compared against dict keys derived from LIBRARY_DIR.glob(),
    which enumerates the real filesystem and is not influenced by the
    request. There is no path expression for tainted data to reach, so
    there is nothing for a path-injection sink to flag."""
    if not _LIBRARY_FILE_ID_RE.match(file_id or ""):
        return None
    existing = {p.stem: p for p in LIBRARY_DIR.glob("*.json")}
    return existing.get(file_id)

@app.get("/library/{file_id}")
def load_library_file(file_id: str):
    p = _safe_library_path(file_id)
    if p is None:
        raise HTTPException(404, "File not found")
    return json.loads(p.read_text("utf-8"))

@app.post("/library")
def save_library_file(payload: LibraryFile):
    file_id = str(uuid.uuid4())[:8]
    data = payload.dict()
    data["id"]      = file_id
    data["created"] = datetime.utcnow().isoformat() + "Z"
    p = LIBRARY_DIR / f"{file_id}.json"
    p.write_text(json.dumps(data, indent=2, ensure_ascii=False), "utf-8")
    # file_id is server-generated (uuid4, line ~3369) — not user input, but
    # sanitized the same way regardless for consistency. Both values are
    # fully inline, directly as the log.info() arguments — no intermediate
    # variable and no call to the separately-defined _log_safe() helper,
    # since CodeQL's py/log-injection check only reliably recognizes a
    # literal .replace() chain self-contained within the sink call itself.
    log.info(
        "Library file saved: %s (%s)",
        str(file_id).replace("\r\n", " ").replace("\r", " ").replace("\n", " "),
        (payload.name or "").replace("\r\n", " ").replace("\r", " ").replace("\n", " "),
    )
    return {"id": file_id, "ok": True}

@app.put("/library/{file_id}")
def update_library_file(file_id: str, payload: LibraryFile):
    p = _safe_library_path(file_id)
    if p is None:
        raise HTTPException(404, "File not found")
    existing = json.loads(p.read_text("utf-8"))
    existing.update(payload.dict())
    existing["id"] = file_id
    p.write_text(json.dumps(existing, indent=2, ensure_ascii=False), "utf-8")
    return {"ok": True}

@app.delete("/library/{file_id}")
def delete_library_file(file_id: str):
    p = _safe_library_path(file_id)
    if p is None:
        raise HTTPException(404, "File not found")
    p.unlink()
    return {"ok": True}

# ─────────────────────────────────────────────────────────────────────────────
#  Routes — workflow execution (multi-step)
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/workflow/execute")
async def execute_workflow(req: ExecuteWorkflowRequest):
    llm = _effective_llm(req.llm)
    context: Dict[str, Any] = {"input": req.input}
    step_results = []

    for step in req.workflow:
        step_num  = step.get("step", len(step_results) + 1)
        step_type = step.get("type", "llm")
        step_res  = {"step": step_num, "type": step_type}

        try:
            if step_type == "text2cypher":
                # Ask LLM to translate the prompt into Cypher, then execute
                template = step.get("prompt_template", "{input}")
                prompt   = template.format(**context)
                messages = [{"role": "user",
                             "content": f"Generate a Cypher query to answer: {prompt}"}]
                reply, _ = _call_llm(messages, llm)
                action   = _extract_cypher_action(reply)
                if action and action.get("query"):
                    cypher = action["query"]
                    rows   = run_cypher(cypher)
                    context.update({"last_cypher": cypher, "last_results": rows})
                    step_res.update({"cypher": cypher, "rows": rows[:100],
                                     "row_count": len(rows), "status": "ok"})
                else:
                    step_res.update({"reply": reply, "status": "no_cypher_generated"})

            elif step_type == "write_back":
                # Execute a pre-written Cypher template (may reference context vars)
                template = step.get("cypher_template", "")
                cypher   = template.format(**context)
                rows     = run_cypher(cypher)
                context.update({"last_cypher": cypher, "last_results": rows})
                step_res.update({"cypher": cypher, "rows": rows[:20], "status": "ok"})

            elif step_type == "postgres":
                # Execute a SQL query against the PostgreSQL reference database
                template = step.get("sql_template", "")
                sql      = template.format(**context)
                rows     = run_postgres(sql)
                context.update({"last_sql": sql, "last_pg_results": rows})
                step_res.update({"sql": sql, "rows": rows[:100],
                                 "row_count": len(rows), "status": "ok"})

            elif step_type == "llm":
                # Pure LLM reasoning step (no DB call)
                template = step.get("prompt_template", "{input}")
                prompt   = template.format(**context)
                messages = [{"role": "user", "content": prompt}]
                reply, _ = _call_llm(messages, llm)
                context["last_reply"] = reply
                step_res.update({"reply": reply, "status": "ok"})

            else:
                step_res.update({"status": "unknown_step_type"})

        except Exception as exc:
            step_res.update({"status": "error", "error": _safe_exc_str(exc)})

        step_results.append(step_res)

    safe_context = {k: v for k, v in context.items() if k not in ("last_results", "last_pg_results")}
    return {"steps": step_results, "context": safe_context}

@app.get("/vocabulary")
def list_vocabulary():
    mappings = _load_vocabulary()
    return {"mappings": mappings}

@app.post("/vocabulary")
def add_vocabulary(entry: VocabEntry):
    _upsert_vocabulary(entry.user_term, entry.neo4j_name, entry.neo4j_label, confirmed=entry.confirmed)
    return {"ok": True}

@app.put("/vocabulary/confirm")
def confirm_vocabulary(entry: VocabEntry):
    mappings = _load_vocabulary()
    for m in mappings:
        if m["user_term"].lower() == entry.user_term.lower() and m["neo4j_name"] == entry.neo4j_name:
            m["confirmed"] = True
            m["use_count"] = m.get("use_count", 0) + 1
            _save_vocabulary(mappings)
            return {"ok": True, "updated": True}
    _upsert_vocabulary(entry.user_term, entry.neo4j_name, entry.neo4j_label, confirmed=True)
    return {"ok": True, "created": True}

@app.delete("/vocabulary")
def delete_vocabulary(user_term: str):
    mappings = _load_vocabulary()
    new_mappings = [m for m in mappings if m["user_term"].lower() != user_term.lower()]
    _save_vocabulary(new_mappings)
    return {"ok": True, "deleted": len(mappings) - len(new_mappings)}

# ─────────────────────────────────────────────────────────────────────────────
#  Route — batch property write (chat checkbox-card "Apply selected" action)
#  The agent only ever PROPOSES a batch_update (see system prompt); it never
#  writes bulk property changes itself. The frontend renders one checkbox per
#  proposed edge, and this endpoint is called with just the subset the user
#  left checked. One parameterized query, real Neo4j param binding (unlike the
#  Postgres helper, run_cypher's session.run() genuinely uses $params), and the
#  same type-safe RelationID (string-or-list) match used everywhere else so
#  merged relations are matched correctly.
# ─────────────────────────────────────────────────────────────────────────────

_BATCH_WRITABLE_PROPERTIES = frozenset({"Effect", "Mechanism", "Ontology", "Relationship"})
_REL_TYPE_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')

# Shared WHERE fragment: safely resolves RelationID (string OR list-of-strings,
# per this database's schema) to a list of strings, then checks membership.
_RELID_MATCH_CYPHER = """
        WITH r, u,
             CASE WHEN apoc.meta.cypher.type(r.RelationID) CONTAINS 'LIST'
                  THEN [x IN r.RelationID | toString(x)]
                  ELSE [toString(r.RelationID)]
             END AS relIdList
        WHERE u.relationId IN relIdList
"""

@app.post("/batch-write")
def batch_write(req: BatchWriteRequest):
    prop = req.property.strip()
    if prop not in _BATCH_WRITABLE_PROPERTIES:
        raise HTTPException(400, f"Property '{prop}' is not writable via batch-write "
                                  f"(allowed: {', '.join(sorted(_BATCH_WRITABLE_PROPERTIES))})")
    clean = [{"relationId": str(u.relationId), "value": u.value, "relationType": (u.relationType or "").strip()}
              for u in req.updates if u.value is not None and str(u.value).strip() != ""]
    if not clean:
        return {"ok": True, "updatedCount": 0}

    # Group by relation type so each query can MATCH ()-[r:Type]->() instead of
    # scanning every relationship in the database — with only a handful of
    # updates per batch, an untyped scan was the dominant cost on large graphs.
    # Updates with no (or an unsafe) relationType fall back to one untyped group.
    groups: Dict[str, List[Dict[str, str]]] = {}
    for u in clean:
        key = u["relationType"] if _REL_TYPE_RE.match(u["relationType"] or "") else ""
        groups.setdefault(key, []).append({"relationId": u["relationId"], "value": u["value"]})

    # prop is validated against a fixed allow-list above, so this f-string
    # interpolation of the property name (not the values) is safe.
    total_updated = 0
    try:
        for rel_type, group_updates in groups.items():
            match_clause = f"MATCH ()-[r:`{rel_type}`]->()" if rel_type else "MATCH ()-[r]->()"
            cypher = f"""
                UNWIND $updates AS u
                {match_clause}
                WHERE r.RelationID IS NOT NULL
                {_RELID_MATCH_CYPHER}
                SET r.{prop} = u.value,
                    r.updatedAt = timestamp(),
                    r.updatedBy = $username
                RETURN count(r) AS updatedCount
            """
            # Prefer the trusted x-ge-username context (set by server.js's proxy)
            # over the client-supplied body field, which is kept only as a fallback.
            updated_by = _current_username.get() or req.username or "agent"
            rows = run_cypher(cypher, {"updates": group_updates, "username": updated_by})
            total_updated += rows[0]["updatedCount"] if rows else 0
        # Log a deterministic, trusted boolean derived from the existing
        # allow-list check (line ~3527) instead of the value itself — prop is
        # already guaranteed to be one of a fixed 4-string set by this point,
        # but logging it directly (even sanitized via _log_safe) still counts
        # as "user-controlled data reaching a log call" from CodeQL's
        # perspective, since the check happens earlier in a separate
        # statement, not right here. A boolean carries no injectable content
        # at all and needs no sanitization to be safe. Same treatment applied
        # to `groups.keys()`, which are relation-type strings sourced from
        # user-supplied update requests, not from a fixed set the way `prop`
        # is — kept as a count instead of the actual values.
        log.info("batch_write: propertyAllowed=%s requested=%d matched=%s groupCount=%d",
                  prop in _BATCH_WRITABLE_PROPERTIES, len(clean), total_updated,
                  len(groups))
        return {"ok": True, "updatedCount": total_updated, "requestedCount": len(clean)}
    except Exception as exc:
        log.warning("batch_write failed: %s", exc)
        raise HTTPException(500, f"Batch write failed: {_safe_exc_str(exc)}")

# ─────────────────────────────────────────────────────────────────────────────
#  Routes — Cypher examples (cypher_examples.json)
#  Exposes the file that seeds the "## Cypher Query Examples" system-prompt
#  section, so users can see and grow it from the app instead of hand-editing
#  a file on disk. Saved as a full replace (the frontend edits a local copy of
#  the list and PUTs it back whole) — simplest correct semantics for a small,
#  single-user-curated list with no need for per-row concurrency control.
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/examples")
def list_examples():
    return {"examples": _load_examples()}

@app.put("/examples")
def save_examples(payload: ExamplesPayload):
    cleaned = [e.dict() for e in payload.examples if e.cypher.strip()]
    _save_examples(cleaned)
    log.info("Cypher examples updated: %d example(s) saved", len(cleaned))
    return {"ok": True, "count": len(cleaned)}

if __name__ == "__main__":
    port = int(os.environ.get("AGENT_PORT", 7071))
    log.info("Graph Explorer Agent Service starting on port %d", port)

    # Kill any stale process holding the port before binding.
    # This avoids the "address already in use" error when restarting under
    # a debugger or after an unclean shutdown, since the previous process
    # may still be running (e.g. auto-restarted by server.js).
    import subprocess, sys as _sys
    if _sys.platform == "win32":
        subprocess.call(
            f'FOR /F "tokens=5" %a IN (\'netstat -ano ^| findstr :{port} ^| findstr LISTENING\') DO taskkill /F /PID %a',
            shell=True, stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL
        )
    else:
        subprocess.call(f'lsof -ti tcp:{port} | xargs kill -9', shell=True,
                        stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
    import time as _time; _time.sleep(0.5)  # brief pause after kill

    # 127.0.0.1 only — this service is an internal sidecar for server.js's own
    # reverse proxy (which always connects via 127.0.0.1; see server.js's
    # AGENT_PORT usage). It has no independent auth of its own beyond trusting
    # the x-ge-username header that ONLY server.js's proxy sets, so it must
    # never be reachable from outside localhost — binding to 0.0.0.0 would let
    # any other process/user on the host (or the network, depending on the
    # firewall) impersonate any Graph Explorer user and run arbitrary
    # Cypher/SQL with that user's stored database credentials.
    uvicorn.run(app, host="127.0.0.1", port=port)
