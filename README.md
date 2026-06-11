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
  public/
    index.html                    App HTML & modals
    app.js                        All frontend logic (~3 000 lines)
    app.css                       Styles
  Graph_Explorer_User_Manual.docx End-user guide
  Graph_Explorer_FRD.docx         Functional requirements document
```

---

## Prerequisites

**Node.js v18 or later** — download from https://nodejs.org (choose the LTS installer).

**Python 3** — required for RNEF file conversion. Usually pre-installed on Mac/Linux; download from https://python.org on Windows.

The machine also needs network access to:
- Neo4j at `neo4j.lifesciencepsg.com:7687`
- PostgreSQL at `postgres.cldbkt9huzvb.us-east-2.rds.amazonaws.com:5432`

(VPN may be required off-site.)

---

## Configuration

Open `server.js` in any text editor and fill in your credentials near the top of the file:

**Neo4j**
```javascript
const neo4jDriver = neo4j.driver(
  'YOUR_NEO4J_URI',
  neo4j.auth.basic('YOUR_NEO4J_USER', 'YOUR_NEO4J_PASSWORD')
);
const NEO4J_DB = 'YOUR_NEO4J_DATABASE';
```

**PostgreSQL**
```javascript
const pgPool = new Pool({
  host:     'YOUR_PG_HOST',
  port:     5432,
  database: 'YOUR_PG_DATABASE',
  user:     'YOUR_PG_USER',
  password: 'YOUR_PG_PASSWORD',
  ssl: { rejectUnauthorized: false }
});
```

**PostgreSQL schema** — set via environment variable or edit the default in `server.js`:
```
PG_SCHEMA=myschema node server.js          # Mac / Linux
set PG_SCHEMA=myschema && node server.js   # Windows Command Prompt
$env:PG_SCHEMA="myschema"; node server.js  # Windows PowerShell
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

Change this password immediately after first login (header → **Change Password**).

---

## Feature overview

| Category | Feature |
|---|---|
| **Graph** | Cytoscape.js canvas with node/edge tooltips, neighborhood highlighting, drag-to-reposition |
| **Layouts** | CoSE (default), Dagre, Circle, Concentric, Grid |
| **Node types** | Color-coded by biological type (Protein, Gene, SmallMol, Disease, …) |
| **Edge types** | Color-coded by relation type; thickness ∝ reference count; solid = direct, dashed = indirect |
| **Clone nodes** | Nodes that appear more than once (RNEF pathways); gold double-border; manual cloning via right-click |
| **Reaction nodes** | Hyperedge intermediaries for multi-participant reactions (from RNEF) |
| **Tabs** | Multiple independent graph sessions in one browser window |
| **File I/O** | Open/Save JSON subgraphs; open RNEF pathway files (single or multi-pathway with tab per pathway) |
| **Table view** | References mode (one row/reference) and Relations mode (one row/edge) |
| **Columns** | Add/remove/reorder/resize columns; reference, Neo4j, and Scopus data columns |
| **Sentence coloring** | MedScan entity markup highlighted red (regulator) and green (target) |
| **Export** | CSV and Excel (.xlsx) with rich-text sentence coloring and hyperlinked PMIDs/DOIs |
| **Selection** | Click, box-select, select all, invert; Move mode vs. box-select mode |
| **Clipboard** | Copy/paste nodes and edges across tabs |
| **Curation** | Right-click any node or edge → Edit Properties → saves directly to Neo4j |
| **User management** | Admin can add/remove users and assign roles (admin/user) |
| **SQL query** | Admin can run read-only PostgreSQL SELECT queries from the browser |
| **Security** | JWT auth (12 h), bcrypt passwords, rate limiting, credential redaction for GitHub |

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
| Cannot reach Neo4j / PostgreSQL | Check VPN and verify credentials in `server.js` |
| Port 3000 already in use | `PORT=3001 node server.js` (Mac/Linux) · `set PORT=3001 && node server.js` (Windows) |
| Session expired after 12 hours | Log in again; save your work with File → Save Subgraph before long breaks |

---

## Security notes

- Credentials in `server.js` are redacted by `github-upload.js` before upload — **never commit `server.js` directly** without running through the upload script.
- The `/api/sql-query` endpoint accepts SELECT/WITH statements only and is restricted to admin users.
- JWT tokens expire after 12 hours.
