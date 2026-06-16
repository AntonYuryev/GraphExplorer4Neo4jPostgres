# Graph Explorer

A web application for exploring and curating biological knowledge graphs stored in **Neo4j**, with **PostgreSQL** reference lookup, RNEF pathway import, multi-tab workspace, and Excel export.

> **Documentation**  
> 📘 [Graph_Explorer_User_Manual.docx](Graph_Explorer_User_Manual.docx) — step-by-step guide for end users  
> 📗 [Graph_Explorer_FRD.docx](Graph_Explorer_FRD.docx) — complete functional requirements for developers

---

## Project files

```
graph-explorer/
  server.js                       Backend server (Node.js/Express)
  package.json                    Dependency list
  rnef_to_json.py                 RNEF → JSON converter (called by server)
  settings.json                   DB credentials (not committed to source control)
  public/
    index.html                    App HTML & modals
    app.js                        All frontend logic (~8 000 lines)
    app.css                       Styles
  Graph_Explorer_User_Manual.docx End-user guide
  Graph_Explorer_FRD.docx         Functional requirements document
```

---

## Prerequisites

**Node.js v18 or later** — download from https://nodejs.org (choose the LTS installer).

**Python 3** — required for RNEF file conversion. Usually pre-installed on Mac/Linux; download from https://python.org on Windows.

The machine also needs network access to:
- Neo4j at your configured host
- PostgreSQL at your configured host

---

## Configuration

Database credentials are **no longer hardcoded in `server.js`**. They are stored in `settings.json` and managed through the application UI.

### First-time setup

1. Start the server (see [Starting the server](#starting-the-server)).
2. Log in as `admin` (default password: `admin123`).
3. Open **⚙ Settings ▾ → Database → Neo4j** and enter your Neo4j URL, database name, username, and password. Click **Test & Save**.
4. Open **⚙ Settings ▾ → Database → Postgres** and enter your PostgreSQL host, port, database, schema, username, and password. Click **Test & Save**.

Settings are tested against the live databases before saving. If the test fails, credentials are not stored.

### settings.json

Credentials are saved to `settings.json` in the project root. **Never commit this file to a public repository.** It is listed in `.gitignore`.

If you need to set credentials before the UI is available, create `settings.json` manually:

```json
{
  "neo4j": {
    "url": "bolt+ssc://YOUR_NEO4J_HOST:7687",
    "database": "YOUR_DATABASE",
    "username": "YOUR_USER",
    "password": "YOUR_PASSWORD"
  },
  "postgres": {
    "host": "YOUR_PG_HOST",
    "port": 5432,
    "database": "YOUR_PG_DATABASE",
    "schema": "YOUR_SCHEMA",
    "username": "YOUR_PG_USER",
    "password": "YOUR_PG_PASSWORD"
  }
}
```

---

## Installation

```bash
cd graph-explorer
npm install
```

---

## Starting the server

```bash
node server.js
# → Graph Explorer running at http://localhost:3000
```

Open **http://localhost:3000** in your browser.  
Stop the server with **Ctrl+C**.

### Default admin account

| Username | Password  |
|----------|-----------|
| `admin`  | `admin123` |

Change this password immediately after first login via **⚙ Settings ▾ → Admin → Change Password**.

---

## Feature overview

| Category | Feature |
|---|---|
| **Graph** | Cytoscape.js canvas with node/edge tooltips, neighborhood highlighting, drag-to-reposition |
| **Layouts** | CoSE (default), Dagre, Circle, Concentric, Grid |
| **Node types** | Color-coded by biological type (Protein, Gene, SmallMol, Disease, …); readable labels with white text halo on light-colored node types |
| **Edge types** | Color-coded by relation type; thickness ∝ reference count; solid = direct, dashed = indirect |
| **Clone nodes** | Nodes that appear more than once (RNEF pathways); gold double-border; manual cloning via right-click |
| **Reaction nodes** | Hyperedge intermediaries for multi-participant reactions (from RNEF) |
| **Tabs** | Multiple independent graph sessions in one browser window; tab renames automatically after save |
| **File I/O** | Open/Save JSON subgraphs (Save dialog pre-fills current tab name); open RNEF pathway files (single or multi-pathway with tab per pathway) |
| **Header toolbar** | Undo (Ctrl+Z), zoom controls, Align H/V, Highlight, Node Color, Find (Ctrl+F), Resize nodes ⊕/⊖ |
| **Focus node** | Click a node to set it as the alignment anchor; Align H/V aligns all selected nodes to the focus node's axis |
| **Undo** | Ctrl+Z undoes graph modifications including node moves, added relations, and expand operations; each drag is independently undoable |
| **Cypher autocomplete** | Schema-aware dropdown in the query bar: node labels, relationship types, and property keys fetched from Neo4j and suggested as you type |
| **Cypher lint** | Structural and semantic checks run before and after EXPLAIN; catches space-after-dot, bare property used as boolean, and other common mistakes |
| **Query row-count guard** | Queries returning > 20 000 rows show a confirmation dialog before loading; warns that sentence coloring will be disabled |
| **Table view** | References mode (one row/reference) and Relations mode (one row/edge) |
| **Columns** | Add/remove/reorder/resize columns; Graph, Neo4j, Reference, Scopus, and Node Property columns; Reset to defaults button |
| **Load node properties** | Database → Load node properties fetches additional Neo4j properties for current graph nodes; properties appear in tooltips and table |
| **Sentence coloring** | MedScan entity markup highlighted red (regulator) and green (target) |
| **Export** | CSV and Excel (.xlsx) with rich-text sentence coloring and hyperlinked PMIDs/DOIs; also export references or relations for the current query directly |
| **Find relations** | Database → Find relations between groups — queries Neo4j for relations connecting selected vs. unselected nodes; filter by All / Direct / Biomarker / Indirect |
| **Load similar relations** | Database → Load similar relations — matches RNEF pathway edges to Neo4j relations and pulls in additional similar edges with RelationIDs |
| **Expand selected nodes** | Database → Expand → five modes (Expand All, Expand To…, Find relations between selected and unselected, Expand similar, Expand direct); previews before committing |
| **Selection** | Click, box-select, select all, invert; Move mode vs. box-select mode |
| **Clipboard** | Copy/paste nodes and edges across tabs; paste merges nodes with the same URN and skips duplicate edges (by RelationID or structure) |
| **Curation** | Right-click any node or edge → Edit Properties → saves directly to Neo4j |
| **Merge clones** | Right-click two or more nodes with the same identity → Merge selected clones |
| **User management** | Admin can add/remove users and assign roles (admin/user) |
| **DB settings** | Admin can update Neo4j and Postgres connection credentials at runtime without restarting the server |
| **SQL query** | Admin can run read-only PostgreSQL SELECT queries from the browser |
| **Security** | JWT auth (12 h), bcrypt passwords, rate limiting, credentials stored in settings.json (not in source code) |

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

// Fetch neighbors and relations (high sentence-count relations)
MATCH (a)-[r]-(b) WHERE r.RelationNumberOfSentences = 3 RETURN a, r, b LIMIT 50
```

---

## Running on a shared server

```bash
# Ubuntu/Debian — install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs python3

cd /path/to/graph-explorer
npm install
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
| RNEF conversion fails | Ensure Python 3 is installed and on PATH |
| Cannot reach Neo4j / PostgreSQL | Check VPN; update credentials via ⚙ Settings ▾ → Database |
| "Connection test failed" in settings | Verify host, port, and credentials; check VPN |
| Port 3000 already in use | `PORT=3001 node server.js` (Mac/Linux) · `set PORT=3001 && node server.js` (Windows) |
| Session expired after 12 hours | Log in again; save your work with File → Save Subgraph before long breaks |
| Node labels unreadable on light nodes | Update to latest app.js — white text halo fix is included |
| Tooltip blocks node drag | Update to latest app.js — tooltip hides on node grab |
| Undo skips node moves | Update to latest app.js — node drag now pushes its own undo snapshot |
| Autocomplete not appearing | Schema is fetched on login; ensure Neo4j connection is configured in Settings |

---

## Security notes

- Database credentials are stored in `settings.json` — **never commit this file** to a public repository. Add it to `.gitignore`.
- The `/api/sql-query` endpoint accepts SELECT/WITH statements only and is restricted to admin users.
- The Database settings endpoints (`/api/settings/neo4j`, `/api/settings/postgres`) are restricted to admin users.
- JWT tokens expire after 12 hours.
