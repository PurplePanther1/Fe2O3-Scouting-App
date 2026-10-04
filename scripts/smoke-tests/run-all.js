#!/usr/bin/env node
// Runs the whole smoke suite: `npm test` (or `node run-all.js`) from this folder.
//
//   node run-all.js                      full suite (emulators + local server)
//   node run-all.js --only pit           only tests whose filename contains "pit" (rules tests included)
//   node run-all.js --headed             watch the browser (same as SMOKE_HEADED=1)
//   node run-all.js --deployed <url>...  ALSO verify each live host serves exactly
//                                        the files in the working tree (see README)
//
// Exit code 0 = every test passed, 1 = at least one failed.

const fs = require('fs');
const path = require('path');
const harness = require('./lib/harness');

const args = process.argv.slice(2);
const flagValues = (flag) => {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) continue;
    for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]);
  }
  return out;
};
const only = flagValues('--only')[0];
const deployedUrls = flagValues('--deployed');
if (args.includes('--headed')) process.env.SMOKE_HEADED = '1';

// Two kinds of test, run in this order against the same emulators:
//   rules-tests/  Firestore security-rules tests (real firestore.rules, no browser)
//   tests/        Playwright browser tests
const listTests = (dir) => fs.readdirSync(path.join(__dirname, dir))
  .filter(f => f.endsWith('.js'))
  .filter(f => !only || f.includes(only))
  .sort()
  .map(file => ({ dir, file }));
const ruleTests = listTests('rules-tests');
const browserTests = listTests('tests');
const testFiles = [...ruleTests, ...browserTests];

async function main() {
  const results = [];
  let staticServer, emulators, browser, rulesEnv;
  const state = { blockedRequests: [], pageErrors: [], consoleErrors: [], workerRequests: [], ftcScoutRequests: [] };

  try {
    if (testFiles.length > 0) {
      console.log('Starting Firebase emulators' + (browserTests.length > 0 ? ' + local server' : '') + ' (first run can take ~20s)...');
      emulators = await harness.startEmulators();
      if (ruleTests.length > 0) rulesEnv = await harness.createRulesTestEnv();
      if (browserTests.length > 0) {
        staticServer = await harness.startStaticServer();
        browser = await harness.launchBrowser();
      }
    }

    for (const { dir, file } of testFiles) {
      const test = require(path.join(__dirname, dir, file));
      const openContexts = [];
      const ctx = {
        baseUrl: staticServer && staticServer.baseUrl,
        state,
        rulesEnv,
        log: (msg) => process.stdout.write(`[${msg}] `),
        async newPage(label = 'page') {
          const made = await harness.newPage(browser, staticServer.baseUrl, state, `${file}:${label}`);
          openContexts.push(made);
          return made.page;
        },
        async makeUser(displayName = 'Smoke Scout') {
          const { uniqueEmail } = require('./lib/app');
          return harness.createVerifiedUser(uniqueEmail(), 'smoke-pass-123', displayName);
        }
      };
      const errorsBefore = state.pageErrors.length;
      const started = Date.now();
      process.stdout.write(`▶ ${test.name} ... `);
      try {
        await test.run(ctx);
        const newErrors = state.pageErrors.slice(errorsBefore);
        if (newErrors.length > 0) throw new Error(`Uncaught page error(s):\n  ${newErrors.join('\n  ')}`);
        results.push({ name: test.name, ok: true, ms: Date.now() - started });
        console.log(`PASS (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      } catch (err) {
        results.push({ name: test.name, ok: false, ms: Date.now() - started, err });
        console.log('FAIL');
        console.log(`    ${String(err.stack || err).split('\n').join('\n    ')}`);
        for (let i = 0; i < openContexts.length; i++) {
          await harness.screenshotOnFailure(openContexts[i].page, `${file.replace(/\.js$/, '')}-${i}`);
        }
      } finally {
        for (const { context } of openContexts) await context.close().catch(() => {});
      }
    }
  } finally {
    if (rulesEnv) await rulesEnv.cleanup().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (emulators) emulators.stop();
    if (staticServer) staticServer.server.close();
  }

  for (const url of deployedUrls) {
    const { verifyDeployed } = require('./lib/deployed');
    const started = Date.now();
    process.stdout.write(`▶ deployed files match working tree: ${url} ... `);
    try {
      const summary = await verifyDeployed(url);
      results.push({ name: `deployed: ${url}`, ok: true, ms: Date.now() - started });
      console.log(`PASS (${summary})`);
    } catch (err) {
      results.push({ name: `deployed: ${url}`, ok: false, ms: Date.now() - started, err });
      console.log('FAIL');
      console.log(`    ${String(err.message || err).split('\n').join('\n    ')}`);
    }
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (state.blockedRequests.length > 0) {
    const unique = [...new Set(state.blockedRequests.map(u => new URL(u).hostname))];
    console.log(`(blocked external requests to: ${unique.join(', ')} — expected, the suite is hermetic)`);
  }
  if (failed.length > 0) {
    console.log(`Failed: ${failed.map(f => f.name).join('; ')}`);
    console.log('Failure screenshots (if any): scripts/smoke-tests/artifacts/');
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Smoke runner crashed:', err);
  process.exit(1);
});
