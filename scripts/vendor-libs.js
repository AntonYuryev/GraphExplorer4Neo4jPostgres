/**
 * vendor-libs.js — one-time script to download CDN libraries into public/vendor/
 *
 * Run once from the project root:
 *   node scripts/vendor-libs.js
 *
 * After it completes, index.html already references /vendor/* paths.
 * The CDN <script> tags are no longer needed.
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const VENDOR_DIR = path.join(__dirname, '..', 'public', 'vendor');
fs.mkdirSync(VENDOR_DIR, { recursive: true });

const LIBS = [
  { url: 'https://unpkg.com/cytoscape@3.27.0/dist/cytoscape.min.js',               file: 'cytoscape.min.js' },
  { url: 'https://unpkg.com/dagre@0.8.5/dist/dagre.min.js',                        file: 'dagre.min.js' },
  { url: 'https://unpkg.com/cytoscape-dagre@2.5.0/cytoscape-dagre.js',             file: 'cytoscape-dagre.js' },
  { url: 'https://unpkg.com/klayjs@0.4.1/klay.js',                                 file: 'klay.js' },
  { url: 'https://unpkg.com/cytoscape-klay@3.1.4/cytoscape-klay.js',               file: 'cytoscape-klay.js' },
  { url: 'https://cdn.jsdelivr.net/npm/exceljs@4.3.0/dist/exceljs.min.js',         file: 'exceljs.min.js' },
  { url: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',            file: 'jszip.min.js' },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js',             file: 'd3.min.js' },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/d3-sankey/0.12.3/d3-sankey.min.js', file: 'd3-sankey.min.js' },
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    function get(u) {
      client.get(new URL(u), res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // follow redirect
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, u).href;
          return get(next);
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(dest, () => {});
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error',  reject);
      }).on('error', reject);
    }
    get(url);
  });
}

(async () => {
  for (const lib of LIBS) {
    const dest = path.join(VENDOR_DIR, lib.file);
    if (fs.existsSync(dest)) {
      console.log(`  skip  ${lib.file}  (already exists)`);
      continue;
    }
    process.stdout.write(`  fetch ${lib.file} ... `);
    try {
      await download(lib.url, dest);
      const kb = Math.round(fs.statSync(dest).size / 1024);
      console.log(`OK  (${kb} KB)`);
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      process.exitCode = 1;
    }
  }
  console.log('\nDone. Restart the server — index.html now loads libraries from /vendor/');
})();
