# Graph Explorer — Installation & User Guide

A web app for exploring and curating Neo4j graph data with PostgreSQL reference lookup.

---

## Files to share with colleagues

Send the entire `graph-explorer` folder containing exactly these files:

```
graph-explorer/
  server.js           <- Backend server
  package.json        <- Dependency list (do not edit)
  public/
    index.html        <- App HTML
    app.js            <- Frontend logic
    app.css           <- Styles
```

Zip the folder and share it. Do **not** include `public/INDEX~1.zip` if present — it is a temp file.

---

## Prerequisites

**Node.js v18 or later** must be installed on the machine running the server.

- Download: https://nodejs.org/en/download (choose the LTS installer for your OS)
- Verify installation: open a terminal and run `node --version`

The machine also needs network access to:
- Neo4j at `neo4j.lifesciencepsg.com:7687`
- PostgreSQL at `postgres.cldbkt9huzvb.us-east-2.rds.amazonaws.com:5432`

(VPN may be required if you are off-site.)

---

## Configuring database credentials

Each user must set their own Neo4j and PostgreSQL credentials in `server.js` before starting the app. Open `server.js` in any text editor and update the two sections near the top of the file:

**Neo4j** (lines ~15–19):
```javascript
const neo4jDriver = neo4j.driver(
  'bolt+ssc://neo4j.lifesciencepsg.com:7687',
  neo4j.auth.basic('YOUR_NEO4J_USERNAME', 'YOUR_NEO4J_PASSWORD')
);
const NEO4J_DB = 'mammaloct2025new';   // <- change if your database name differs
```

**PostgreSQL** (lines ~22–32):
```javascript
const pgPool = new Pool({
  host: 'postgres.cldbkt9huzvb.us-east-2.rds.amazonaws.com',
  port: 5432,
  database: 'psgdev',
  user: 'YOUR_PG_USERNAME',
  password: 'YOUR_PG_PASSWORD',
  ssl: { rejectUnauthorized: false },
  ...
});
```

Replace `YOUR_NEO4J_USERNAME`, `YOUR_NEO4J_PASSWORD`, `YOUR_PG_USERNAME`, and `YOUR_PG_PASSWORD` with your own credentials. The host, port, and database name are shared and should stay the same unless your DBA tells you otherwise.

**PostgreSQL schema** (line ~35):
```javascript
const PG_SCHEMA = process.env.PG_SCHEMA || 'resnetcustomnov';
```

Change `'resnetcustomnov'` to your own schema name. Alternatively, set it without editing the file by passing an environment variable when starting the server:

```
PG_SCHEMA=myschema node server.js          # Mac / Linux
set PG_SCHEMA=myschema && node server.js   # Windows Command Prompt
$env:PG_SCHEMA="myschema"; node server.js  # Windows PowerShell
```

---

## Installation (one-time)

1. Unzip the folder to any location, e.g. `C:\graph-explorer\`

2. Open a terminal (**Command Prompt** or **PowerShell** on Windows; **Terminal** on Mac/Linux)

3. Navigate to the folder:
   ```
   cd C:\graph-explorer
   ```

4. Install dependencies (downloads ~10 MB of libraries into a `node_modules` subfolder):
   ```
   npm install
   ```

---

## Starting the app

Each time you want to use the app:

1. Open a terminal and go to the project folder:
   ```
   cd C:\graph-explorer
   ```

2. Start the server:
   ```
   node server.js
   ```
   You should see:
   ```
   Graph Explorer running at http://localhost:3000
   ```

3. Open your browser and go to: **http://localhost:3000**

4. To stop the server, press **Ctrl+C** in the terminal.

---

## First login

A default admin account is created automatically on the very first run:

| Username | Password   |
|----------|------------|
| `admin`  | `admin123` |

**Change this password immediately** after logging in — click "Change Password" in the top-right header.

The admin account can create additional user accounts via the **Users** button in the header.

---

## Features

| Feature | How to use |
|---------|------------|
| Run a Cypher query | Type in the query box, press **▶ Run** or Ctrl+Enter |
| Change graph layout | Toolbar: Force / Hierarchical / Circular / Concentric / Grid |
| Move nodes | Drag nodes to reposition manually |
| Node/edge tooltip | Hover over a node or edge |
| Edit properties | Right-click any node or edge → **Edit Properties** |
| Table view | Click **Table** in the toolbar top-right |
| Filter table | Type in the "Filter rows..." box |
| Export CSV | Table view → **⬇ Export CSV** |
| Save subgraph | Click **💾 Save** → enter a name → downloads a `.json` file |
| Load subgraph | Click **📂 Load** → pick a previously saved `.json` file |

---

## Sample Cypher queries

```cypher
-- Fetch 50 relations
MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 50

-- Genes connected to a specific protein
MATCH (g:Gene)-[r]->(p:Protein {name:'TP53'}) RETURN g, r, p LIMIT 30

-- Path between two nodes (up to 2 hops)
MATCH path=(a {name:'BRCA1'})-[*1..2]-(b) RETURN path LIMIT 40
```

---

## Running on a shared server (optional)

If you want colleagues to access the app without running it locally on each machine,
deploy it once on a shared Linux server:

```bash
# Install Node.js (Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Copy project files to the server, then:
cd /path/to/graph-explorer
npm install
node server.js
```

To keep the server running after you log out, use **pm2**:
```bash
npm install -g pm2
pm2 start server.js --name graph-explorer
pm2 save
pm2 startup   # follow the printed instructions to auto-start on reboot
```

Colleagues then open: `http://<server-ip>:3000`

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `node: command not found` | Install Node.js from https://nodejs.org |
| `Cannot find module 'express'` | Run `npm install` inside the project folder |
| Login page is blank / errors in browser console | Check the terminal window for error messages |
| Cannot reach Neo4j or PostgreSQL | Confirm you have VPN/network access to those servers |
| Port 3000 already in use | Use a different port: `PORT=3001 node server.js` (Mac/Linux) or `set PORT=3001 && node server.js` (Windows) |