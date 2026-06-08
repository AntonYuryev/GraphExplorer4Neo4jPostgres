# Graph Explorer

A local web app for visualizing Neo4j graphs with PostgreSQL bibliographic support.

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later

## Setup & Run

```bash
# 1. Open a terminal in the graph-explorer folder
cd graph-explorer

# 2. Install dependencies (one-time)
npm install

# 3. Start the server
npm start

# 4. Open your browser
# http://localhost:3000
```

## First login

On first run, a default admin account is created:

| Field    | Value     |
|----------|-----------|
| Username | `admin`   |
| Password | `admin123` |

**Change this password immediately** via the "Change Password" button in the top-right.

## Adding more users

Log in as admin, click **Users** in the header, and add accounts there.
Each user gets their own login — they all connect to the same databases.

## Features

| Feature | How |
|---------|-----|
| Run a Cypher query | Type in the query box, press **Run** or Ctrl+Enter |
| Change layout | Toolbar: Force / Hierarchical / Circular / Concentric / Grid |
| Manual layout | Drag nodes; positions are remembered per session |
| Save subgraph | Click **💾 Save**, enter a name → downloads a `.json` file |
| Load subgraph | Click **📂 Load**, pick a previously saved `.json` file |
| Edge tooltip | Hover over any edge → shows references from PostgreSQL |
| Table view | Click **Table** in the toolbar |
| Export CSV | Table view → **⬇ Export CSV** |

## Edge legend

- **Line thickness** — proportional to `RelationNumberOfReferences` (0 → thin, ≥3 → thick)  
- **Line style** — solid = direct relation (Binding, DirectRegulation, ProtModification, PromoterBinding, ChemicalReaction); dashed = indirect  
- **Color** — one color per relation type (shown in the right-side legend)

## Sample queries

```cypher
-- Fetch 50 relations
MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 50

-- Genes connected to a specific protein
MATCH (g:Gene)-[r]->(p:Protein {name:'TP53'}) RETURN g, r, p LIMIT 30

-- Path between two nodes (up to 2 hops)
MATCH path=(a {name:'BRCA1'})-[*1..2]-(b) RETURN path LIMIT 40
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Cannot find module 'express'` | Run `npm install` first |
| Neo4j connection refused | Check the neo4juri and credentials in `server.js` |
| PostgreSQL SSL error | Already handled — SSL is enabled with `rejectUnauthorized: false` |
| Port 3000 in use | Set `PORT=3001 npm start` |
