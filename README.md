# Graph Explorer

A web application for exploring, visualizing, and curating biological knowledge graphs stored in **Neo4j**, with **PostgreSQL** literature-reference lookup, RNEF pathway import, a multi-tab graph workspace, Excel/CSV export — and an integrated **AI chat agent** that can translate natural-language questions into Cypher/SQL, visualize the results, and (only with your confirmation) write curated relations back to the graph.

> **Documentation**
> 📘 [Graph_Explorer_User_Manual.docx](Graph_Explorer_User_Manual.docx) — step-by-step guide for end users
> 📗 [Graph_Explorer_FRD.docx](Graph_Explorer_FRD.docx) — complete functional requirements for developers

---

## Project files

```
graph-explorer/
  server.js                       Backend server (Node.js/Express) — auth, graph/DB APIs, agent process supervisor
  agent_service.py                AI agent backend (Python/FastAPI) — LLM chat loop, Cypher/SQL execution
  requirements_agent.txt          Python dependencies for the agent service
  cypher_examples.json            Curated few-shot Cypher examples the agent learns this graph's conventions from
  agentic_ai_block.js             Standalone/legacy agent UI fragment (see note below)
  rnef_to_json.py                 RNEF → JSON converter for a single pathway (invoked by server.js per-file)
  rnef_index.py                   Walks an entire pathway collection directory once, building the lightweight
                                   index that powers Pathway Collection Browse/Search/Statistics/Anatomy Index
                                   and Pathway Alias resolution (invoked by server.js, separate from rnef_to_json.py)
  package.json                    Node dependency list
  settings.example.json           Template for settings.json (copy and fill in your own credentials)
  settings.json                   Real DB/LLM credentials — created locally, never committed
  users.json                      User accounts (bcrypt-hashed passwords) — created locally, never committed
  agent_library/user_vocabulary.json  Starter vocabulary shared in the repo (see below) — everything else in
                                   agent_library/ (saved workflow snapshots, which can embed a live LLM API
                                   key) is per-installation state and never committed
  public/
    index.html                    App HTML, dialogs, and menus
    app.js                        All frontend logic
    app.css                       Styles
    vendor/                       Bundled third-party JS libraries (Cytoscape.js + its dagre/klay layout
                                   extensions, D3 + d3-sankey, ExcelJS, JSZip) — loaded locally, not from a CDN
  Graph_Explorer_User_Manual.docx End-user guide
  Graph_Explorer_FRD.docx         Functional requirements document
```

> **Note on `agentic_ai_block.js`:** this file is not currently wired into `public/index.html`'s script tags. Confirm whether it's dead code left over from an earlier extraction or a fragment still awaiting integration before relying on it.

---

## Prerequisites

**Node.js v18 or later** — https://nodejs.org (LTS installer).

**Python 3.10+** — required both for RNEF file conversion and for the AI agent service. Install dependencies with:
```bash
pip install -r requirements_agent.txt
```

**An LLM API key** — the agent supports Anthropic Claude (native), Google Gemini (via an OpenAI-compatible endpoint), or any other OpenAI-compatible provider. An admin sets up the provider **URL** once (Settings → Agentic AI / LLM — admin-managed the same way as the Neo4j/Postgres connection URLs under URL Connections for Database Endpoints); each user then picks that provider and enters their own **API key** under My Connection after first login. No key is required just to browse the graph without the AI agent.

The machine also needs network access to:
- Neo4j at your configured host
- PostgreSQL at your configured host
- Your chosen LLM provider's API endpoint

---

## Installation

```bash
cd graph-explorer
npm install
pip install -r requirements_agent.txt
```

---

## Configuration

Credentials are **never hardcoded in source**. There are two tiers:

- **Admin-level (shared) settings** — the Neo4j bolt URL and the PostgreSQL host/port are set once by an admin under **⚙ Settings ▾ → URL Connections for Database Endpoints**. The list of approved **LLM provider URLs** (e.g. Google Gemini, Anthropic Claude, or any self-hosted/OpenAI-compatible endpoint) is managed the same way — admin-configured once, shared by everyone — but lives in its own **⚙ Settings ▾ → Agentic AI / LLM** admin section rather than that same menu. Either way, the backend only ever calls out to an LLM URL already on the admin's list; a request naming an unlisted URL is rejected.
- **Per-user settings** — every user (including admins) configures their *own* database name/schema/username/password for both Neo4j and Postgres, plus picks a provider from the admin's list and supplies their *own* API key/model/temperature, under **⚙ Settings ▾ → My Connection**. Each save is tested against the live service before it's stored, so a bad credential never silently persists.

### First-time setup

1. Copy `settings.example.json` to `settings.json` and adjust the placeholder values, or leave `settings.json` absent — the app will create one automatically on first save from the UI.
2. Start the server (see below).
3. Log in as `admin` (default password: `admin123`) and change the password immediately.
4. Open **⚙ Settings ▾ → URL Connections for Database Endpoints** and enter the shared Neo4j URL and Postgres host/port. Separately, open **⚙ Settings ▾ → Agentic AI / LLM** and add the LLM provider URL(s) you want available (e.g. Google Gemini's endpoint, Anthropic's endpoint, or a self-hosted OpenAI-compatible one) — admin-managed the same way as the database endpoints, not something individual users type in freely.
5. Open **⚙ Settings ▾ → My Connection** and enter your own Neo4j database/username/password, Postgres database/schema/username/password, and pick an LLM provider from the admin's list plus your own API key.

`settings.json` and `users.json` are listed in `.gitignore` — **never commit them**. The `agent_library/` folder is also gitignored: saved agent workflow snapshots can embed your LLM API key in their stored configuration, so it must stay local too.

---

## Starting the server

```bash
node server.js
# → Graph Explorer running at http://localhost:3000
```

`server.js` automatically spawns `agent_service.py` as a child process (auto-detecting `python3`/`python`/`py`), waits for its health check, and pushes your Neo4j/Postgres/LLM configuration and schema to it. If the agent process crashes, it's restarted automatically. The agent service listens only on `127.0.0.1` — it is never reachable directly, only through `server.js`'s own proxy.

Open **http://localhost:3000** in your browser. Stop the server with **Ctrl+C**.

### Default admin account

| Username | Password   |
|----------|------------|
| `admin`  | `admin123` |

**Change this password immediately** after first login via **⚙ Settings ▾ → Change Password** — this default account is a known, public value once this repo is public.

---

## Feature overview

### Graph, tables, and diagrams

| Category | Feature |
|---|---|
| **Graph view** | Cytoscape.js canvas — tooltips, neighborhood highlighting, drag-to-reposition, right-click Edit Properties / Clone / Merge clones, box-select, undo/redo |
| **Layouts** | CoSE (default/force-directed), Dagre (hierarchical), Circle, Concentric, Grid, Klay (orthogonal, used by Ontology Analysis) |
| **Multi-tab workspace** | Independent graph sessions per tab in one browser window |
| **Table views** | **Nodes**, **Relations** (Neo4j edge properties only), and **References** (edges + PostgreSQL literature + optional Scopus citation metrics) — each sortable/filterable with a configurable column set |
| **Sankey diagram** | Hub-and-spoke flow view aggregating edges by entity label × relation type × effect sign; own Cypher editor with autocomplete/lint, SVG export, round-trip back into Graph view |
| **Ontology Analysis** | Standalone tree viewer rooted at `SemanticConcept` nodes, Hierarchical/Orthogonal layout, per-term entity counts in the current graph, "hide empty branches" toggle, copy-to-clipboard |
| **Cypher History** | Searchable/sortable log of every query run, with date-range filters and "reopen in..." |
| **Explore menu** | Find relations between Selected/Unselected, Connect Selected Nodes, Expand Selected Nodes, Find Common Neighbors, and Shortest Path all share one configuration dialog — per-node-type and per-relation-type checkboxes (grouped into subsections), plus arbitrary "+ Add filter" node/relation property filters; your last-used type selections and filters are remembered per subsection across sessions. Menu items that need 2+ selected nodes dim automatically when fewer are selected |
| **Connectivity Report** | Shared results dialog for the batch/Explore actions above and Find Drugs — sortable by name, node type, target count, reference/snippet count; select rows (including shift-click ranges) to add to the current graph or a new tab; only closes via its own × or Cancel, never an accidental outside click |
| **RNEF pathway import** | Single- or multi-pathway `.rnef`/`.xml` files, saved node positions honored, custom node shapes/colors/gradients from Pathway Studio's own `style_ref` reproduced faithfully (not just the default shape palette) for the handful of node types that use them |
| **Pathway Collection** | Point the app at a curated pathway directory (⚙ Settings → Pathway Collection) and it builds a searchable index: **Browse** (folder tree with recursive pathway counts, including **Pathway Alias** entries — lightweight references to a pathway that lives in a different folder, shown with a 🔗 icon, opening the real pathway on click), **Text/Entity/Combined Search**, **Alphabetical Index**, **Anatomy Index**, and collection-wide **Statistics** |
| **Import/Export** | JSON subgraph save/load, **Save / Save As** for a pathway back into your collection (as a full copy, or as a Pathway Alias pointing at the currently open pathway), Excel/CSV export (with automatic file-splitting for very large result sets), Sankey SVG export |
| **Curation** | Create/Edit Relation dialogs (general multi-node, and a streamlined 2-node pair dialog) — reference management with jump-to-reference-number, Find-by-identifier (DOI/PMID/etc.) with Find-Next cycling through repeat matches, live RelationID preview — restricted to the `user` role, not `admin` |
| **Admin tools** | User management, shared DB endpoint configuration, read-only ad-hoc SQL runner (`SELECT`/`WITH` only) |

### AI Agent

Click **🤖 AI Agent** to open the chat panel. The agent can:

- Translate natural-language questions into Cypher or read-only PostgreSQL and run them, reporting an exact result count (never an estimate from a truncated sample).
- Visualize results as a new graph, added to your current graph, a Sankey diagram, or a Nodes/Relations/References table — always asking which you want rather than picking for you, and never silently replacing a graph view you've already built.
- Look up and navigate the ontology (`is_a`/`part_of` hierarchy) to resolve ambiguous terms.
- Search PubMed live and turn results into references for a new relation.
- Propose a new or updated relation (`write_relation`) or a batch of property updates (`batch_update`, e.g. inferring Effect sign from literature) — both always go through a human-confirmation step (a chat card you check and approve) before anything is written to Neo4j.
- Learn your terminology over time via **Vocabulary** (chat panel → 🧠) — map a term you use (e.g. "drugs") to the correct Neo4j label(s), once, and every future question resolves it automatically.
- Follow curated query patterns via **Cypher Examples** (chat panel → 📚) — a shared, editable library (`cypher_examples.json`) of worked Cypher patterns and house conventions (label unions, `coalesce()` usage, ontology-aware filters, shortest-path pitfalls, etc.) that the agent consults per question so it doesn't have to rediscover them from scratch each time.
- Save and reload named chat/workflow sessions via **Library** (chat panel → 📁), and run configurable multi-step pipelines via **Pipeline Configuration** (chat panel → ⚙).

Supported LLM providers: Anthropic Claude (native SDK), Google Gemini (OpenAI-compatible endpoint), and any other OpenAI-compatible API. The provider **URL** is set up by an admin (⚙ Settings ▾ → Agentic AI / LLM) the same way the Neo4j and Postgres connection URLs are set up under URL Connections for Database Endpoints — admin-managed once, shared by everyone — and each user then picks a provider from that admin-approved list and supplies their own API key/model/temperature under My Connection. A user cannot point the agent at an arbitrary, unlisted URL.

---

## Sample Cypher queries

```cypher
// 50 relations
MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 50

// Genes connected to a protein
MATCH (g:Gene)-[r]->(p:Protein {name:'TP53'}) RETURN g, r, p LIMIT 30

// Paths up to 2 hops from a node
MATCH path=(a {name:'BRCA1'})-[*1..2]-(b) RETURN path LIMIT 40

// Small molecules in a pathway
MATCH (s:SmallMol)-[r]-(t) RETURN s, r, t LIMIT 50

// Fastest way to check if two entities are connected
MATCH p = shortestPath((a)-[:DirectRegulation|Binding*1..3]-(b))
WHERE toLower(a.Name) = toLower('panobinostat') AND toLower(b.Name) = toLower('H3')
RETURN p
```

Ask the AI agent the same questions in plain English and it will build and run the equivalent (or better) query for you.

---

## Running on a shared server

```bash
# Ubuntu/Debian — install Node.js and Python
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs python3 python3-pip

cd /path/to/graph-explorer
npm install
pip install -r requirements_agent.txt
node server.js
```

To keep the server running after logout, use **pm2**:
```bash
npm install -g pm2
pm2 start server.js --name graph-explorer
pm2 save && pm2 startup
```

Colleagues connect at: `http://<server-ip>:3000`

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `node: command not found` | Install Node.js ≥ 18 from https://nodejs.org |
| `Cannot find module 'express'` | Run `npm install` inside the project folder |
| Agent panel shows "disconnected" | Check that Python 3.10+ and `pip install -r requirements_agent.txt` succeeded; check the server console for `[agent]` startup logs |
| RNEF conversion fails | Ensure Python 3 is installed and on PATH |
| Cannot reach Neo4j / PostgreSQL | Check VPN; update credentials via ⚙ Settings ▾ → My Connection |
| "Connection test failed" in settings | Verify host, port, and credentials; check VPN |
| Port 3000 already in use | `PORT=3001 node server.js` (Mac/Linux) · `set PORT=3001 && node server.js` (Windows) |
| Session expired after 12 hours | Log in again; save your work with File → Save Subgraph before long breaks |
| Agent query times out | The agent now applies a 25-second server-side Cypher timeout and reports the exact query that timed out in chat so you (or the agent, on retry) can narrow it — e.g. add `shortestPath()`/`allShortestPaths()` instead of an unbounded variable-length match |
| `Unsafe PostgreSQL schema name rejected` on start | Open `settings.json` and replace the schema placeholder with your actual PostgreSQL schema name, then restart |

---

## Security notes

- Credentials live only in `settings.json`/`users.json`, both gitignored; `settings.example.json` is the committed template. **Never commit real credentials.**
- The agent service (`agent_service.py`) binds to `127.0.0.1` only and is reachable exclusively through `server.js`'s own reverse proxy, which stamps a trusted username header the browser cannot forge.
- `/api/sql-query` and the agent's `postgres` action both enforce `SELECT`/`WITH`-only — no INSERT/UPDATE/DELETE/DDL.
- The agent's LLM provider URL is resolved against the admin-managed allowlist (the `providers` list set up under Agentic AI / LLM, conceptually the same admin-only tier as the URL Connections for Database Endpoints setting) — a request naming a URL not on that list is rejected, so a user cannot redirect the agent's outbound API calls to an arbitrary host.
- The agent's free-form `cypher` action currently has **no code-level restriction** against write clauses (`CREATE`/`MERGE`/`SET`/`DELETE`) — it relies on a system-prompt instruction asking the model to confirm with you first. Structured writes (`write_relation`, `batch_update`) always require an explicit UI confirmation regardless. If you want a hard code-level read-only enforcement on the free-form `cypher` action as well, that's a straightforward follow-up change.
- JWT tokens expire after 12 hours; passwords are bcrypt-hashed; login is rate-limited.
- HTTP security headers (CSP, HSTS, X-Frame-Options, etc.) are set by `helmet`.
- Internal error messages are never forwarded to the client in production mode.
- Change the default `admin`/`admin123` account immediately — this is now a public, known credential.
