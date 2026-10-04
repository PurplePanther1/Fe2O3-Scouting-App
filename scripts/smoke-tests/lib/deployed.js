// Post-deploy check: does a live host serve byte-for-byte the files in the
// working tree? Mirrors the "verify live with genuinely fresh requests"
// convention — every request carries a cache-busting query string and
// no-cache headers so a stale edge/browser copy can't pass for the new deploy.

const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('./harness');

// The files whose staleness actually breaks the app: every JS file, the
// stylesheet, the app shell, and the service worker.
function filesToCheck() {
  const out = ['scouting/index.html', 'css/style.css', 'scouting/sw.js'];
  for (const f of fs.readdirSync(path.join(REPO_ROOT, 'js'))) if (f.endsWith('.js')) out.push(`js/${f}`);
  return out;
}

async function verifyDeployed(baseUrl) {
  const base = baseUrl.replace(/\/$/, '');
  const mismatches = [];
  const files = filesToCheck();
  const bust = `smoke=${Date.now()}`;
  for (const rel of files) {
    const res = await fetch(`${base}/${rel}?${bust}`, { headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } });
    if (!res.ok) { mismatches.push(`${rel}: HTTP ${res.status}`); continue; }
    const live = Buffer.from(await res.arrayBuffer());
    const local = fs.readFileSync(path.join(REPO_ROOT, rel));
    if (!live.equals(local)) mismatches.push(`${rel}: live ${live.length} bytes != local ${local.length} bytes`);
  }
  if (mismatches.length > 0) throw new Error(`${mismatches.length} of ${files.length} file(s) differ from the working tree:\n${mismatches.join('\n')}`);
  return `${files.length} files identical`;
}

module.exports = { verifyDeployed };
