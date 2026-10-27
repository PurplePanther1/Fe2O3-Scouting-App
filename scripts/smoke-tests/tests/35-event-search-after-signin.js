// Live event-search suggestions right after signing in (no refresh), and when the event list is slow, failed or empty.
// Root cause that was found: the ONLY startup load of the event list ran while the page was still signed out (first-api.js,
// at script load). Its Firestore eventCache read is signed-in-only, so it was rejected and the error swallowed; nothing ever
// retried after sign-in, and the typing path (updateSuggestionsForCurrentQuery) just hid the dropdown when the list was
// not in memory. Only the Search button (doSearch -> ensureEventsLoaded) loaded it.
// Now: the list loads at sign-in, a failed Firestore cache read falls back to the worker, loads are shared (one request in
// flight), typing shows "Loading events..." while it waits and retries a failed or empty load (on the next keystroke and
// again after a short delay), and a stale answer for another season is never shown.

const assert = require('node:assert/strict');
const { gotoApp, createTeamUI, signOutUI } = require('../lib/app');
const { FIXTURE_EVENT, FIXTURE_OLD_EVENT, FIXTURE_SEASON, FIXTURE_OLD_SEASON } = require('../lib/harness');

const items = (page) => page.$$eval('#search-suggestions .suggestion-item', els => els.map(e => e.dataset.code));
const statusText = (page) => page.evaluate(() => {
  const el = document.querySelector('#search-suggestions:not(.hidden) .suggestion-status');
  return el ? el.textContent.trim() : null;
});
const dropdownVisible = (page) => page.evaluate(() => !document.getElementById('search-suggestions').classList.contains('hidden'));
const waitItem = (page, code, timeout = 5000) => page.waitForFunction(
  (c) => !!document.querySelector(`#search-suggestions:not(.hidden) .suggestion-item[data-code="${c}"]`), code, { timeout });
const waitStatus = (page, re, timeout = 5000) => page.waitForFunction(
  (src) => { const el = document.querySelector('#search-suggestions:not(.hidden) .suggestion-status'); return !!el && new RegExp(src).test(el.textContent); }, re.source, { timeout });
const openScouting = (page) => page.click('#dashboard-tabs .tab[data-dtab="scouting"]');
// Signs in on the login screen of an ALREADY loaded page (no reload), the way a person does: the startup code has long
// finished by the time the password is typed, so a load that only ran at startup (signed out) is long over.
const submitSignIn = async (page, user) => {
  await page.fill('#input-signin-email', user.email);
  await page.fill('#input-signin-password', user.password);
  await page.click('#btn-signin');
  await page.waitForSelector('#screen-set-display-name.active, #screen-team.active, #screen-main.active');
  if (await page.isVisible('#screen-set-display-name.active')) {
    await page.click('#btn-set-display-name-continue');
    await page.waitForSelector('#screen-team.active, #screen-main.active');
  }
};
const typeInBox = async (page, text) => {
  await page.click('#input-event-search');
  await page.fill('#input-event-search', '');
  await page.keyboard.type(text, { delay: 40 });
};

module.exports = {
  name: 'event search right after sign-in: suggestions without Search or refresh; slow / failed / empty first load shows Loading and retries; season change; sign-out/in as another account',
  async run(ctx) {
    const state = ctx.state;
    // A page that starts signed out, with the stored Firestore event list treated as stale (so the worker is really asked).
    const startPage = async (label, user, teamName) => {
      const page = await ctx.newPage(label);
      await page.addInitScript(() => { try { localStorage.setItem('fe2o3-data-cache-epoch', String(Date.now() + 3600 * 1000)); } catch (e) {} });
      await gotoApp(page);
      await page.waitForSelector('#screen-login.active');
      await page.waitForTimeout(1500);
      await submitSignIn(page, user);
      await createTeamUI(page, teamName);
      await openScouting(page);
      return page;
    };

    // ---------- 1. right after sign-in, nothing special: typing alone shows suggestions ----------
    state.eventsMode = 'ok'; state.eventsDelay = 0;
    const u1 = await ctx.makeUser('Search One');
    const requestsBefore = state.eventsRequests;
    const p1 = await startPage('one', u1, 'Search Team One');
    await p1.waitForFunction((s) => !!eventCache[s], FIXTURE_SEASON, { timeout: 5000 }); // loaded at sign-in, nobody has typed yet
    assert.ok(state.eventsRequests > requestsBefore, 'the event list was requested at sign-in, before any typing');
    await typeInBox(p1, 'Smoke');
    await waitItem(p1, FIXTURE_EVENT.code);
    assert.deepEqual(await items(p1), [FIXTURE_EVENT.code], 'suggestions appear from typing alone, right after sign-in');
    // the Search button still works
    await p1.click('#btn-search-events');
    await p1.waitForSelector(`.event-item[data-code="${FIXTURE_EVENT.code}"]`);

    // ---------- 2. the first load FAILS: never silent, retried after a delay AND on the next keystroke ----------
    state.eventsMode = 'error';
    const u2 = await ctx.makeUser('Search Two');
    const p2 = await startPage('two', u2, 'Search Team Two');
    const failedBefore = state.eventsRequests;
    await typeInBox(p2, 'Smo');
    await waitStatus(p2, /Loading events|Couldn't load events/); // a status, never an empty box
    assert.ok(await dropdownVisible(p2));
    await waitStatus(p2, /Couldn't load events/);
    assert.ok(state.eventsRequests > failedBefore, 'the failed load was really attempted');
    // the request starts working again: the pending automatic retry shows suggestions with NO keystroke and NO Search press
    state.eventsMode = 'ok';
    await waitItem(p2, FIXTURE_EVENT.code, 9000);
    assert.equal(await statusText(p2), null, 'the status is gone once the list is there');

    const u3 = await ctx.makeUser('Search Three');
    state.eventsMode = 'error';
    const p3 = await startPage('three', u3, 'Search Team Three');
    await typeInBox(p3, 'Smo');
    await waitStatus(p3, /Couldn't load events/);
    state.eventsMode = 'ok';
    const t0 = Date.now();
    await p3.keyboard.type('k', { delay: 20 }); // the next keystroke retries at once
    await waitItem(p3, FIXTURE_EVENT.code, 2500);
    assert.ok(Date.now() - t0 < 2500, 'the next keystroke retried without waiting for the timer');

    // ---------- 3. the first load is SLOW: "Loading events..." then suggestions with no further typing ----------
    state.eventsMode = 'ok'; state.eventsDelay = 5000;
    const u4 = await ctx.makeUser('Search Four');
    const slowBefore = state.eventsRequests;
    const p4 = await startPage('four', u4, 'Search Team Four');
    await typeInBox(p4, 'Smoke');
    await waitStatus(p4, /Loading events\.\.\./, 3000);
    await p4.keyboard.type('x', { delay: 30 }); await p4.keyboard.press('Backspace'); // more keystrokes while it is still loading
    await p4.waitForTimeout(400);
    assert.equal(state.eventsRequests - slowBefore, 1, 'typing during a slow load shares the one request in flight');
    assert.deepEqual(await items(p4), [], 'nothing to pick yet');
    await waitItem(p4, FIXTURE_EVENT.code, 12000);
    state.eventsDelay = 0;

    // ---------- 4. the worker answers with NO events: shown, and retried on the next keystroke ----------
    state.eventsMode = 'empty';
    const u5 = await ctx.makeUser('Search Five');
    const p5 = await startPage('five', u5, 'Search Team Five');
    await typeInBox(p5, 'Smo');
    await waitStatus(p5, /No events/);
    state.eventsMode = 'ok';
    await p5.keyboard.type('k', { delay: 20 });
    await waitItem(p5, FIXTURE_EVENT.code, 3000);

    // ---------- 5. season changes ----------
    await p5.selectOption('#select-season', String(FIXTURE_OLD_SEASON));
    await p5.waitForFunction(() => document.getElementById('input-event-search').value === '');
    assert.equal(await dropdownVisible(p5), false, 'a season change clears the old suggestions');
    state.eventsMode = 'error';
    await typeInBox(p5, 'Old');
    await waitStatus(p5, /Couldn't load events/);
    state.eventsMode = 'ok';
    await waitItem(p5, FIXTURE_OLD_EVENT.code, 9000);
    assert.deepEqual(await items(p5), [FIXTURE_OLD_EVENT.code], 'the new season\'s events (not the old season\'s)');
    // changing the season while a load is still pending never shows the old season's answer
    state.eventsDelay = 3000;
    await p5.evaluate((s) => { eventCache[s] && delete eventCache[s]; }, String(FIXTURE_SEASON));
    await p5.selectOption('#select-season', String(FIXTURE_SEASON));
    await typeInBox(p5, 'Smoke');
    await waitStatus(p5, /Loading events/, 2500);
    await p5.selectOption('#select-season', String(FIXTURE_OLD_SEASON)); // box cleared, a pending answer must not pop up
    await p5.waitForTimeout(3600);
    assert.equal(await dropdownVisible(p5), false, 'a late answer for another season shows nothing');
    state.eventsDelay = 0;
    await p5.selectOption('#select-season', String(FIXTURE_SEASON));
    await typeInBox(p5, 'Smoke');
    await waitItem(p5, FIXTURE_EVENT.code);

    // ---------- 6. sign out and sign in as ANOTHER account in the same tab (no reload) ----------
    const u6 = await ctx.makeUser('Search Six');
    await p5.click('#dashboard-tabs .tab[data-dtab="myteam"]').catch(() => {});
    await signOutUI(p5);
    await p5.evaluate((s) => { eventCache[s] && delete eventCache[s]; }, String(FIXTURE_SEASON)); // a cold list for the next account
    await submitSignIn(p5, u6);
    await createTeamUI(p5, 'Search Team Six');
    await openScouting(p5);
    await typeInBox(p5, 'Smoke');
    await waitItem(p5, FIXTURE_EVENT.code);
    assert.deepEqual(await items(p5), [FIXTURE_EVENT.code], 'another account in the same tab: suggestions right after sign-in');

    // ---------- 6b. the automatic retries stop after a few tries; the next keystroke starts over ----------
    state.eventsMode = 'error';
    await p5.evaluate((s) => { delete eventCache[s]; }, String(FIXTURE_SEASON));
    await typeInBox(p5, 'Smo');
    await waitStatus(p5, /Keep typing to try again, or press Search/, 30000);
    const stopped = state.eventsRequests;
    await p5.waitForTimeout(4500);
    assert.equal(state.eventsRequests, stopped, 'no more automatic requests once the retries are used up');
    state.eventsMode = 'ok';
    await p5.keyboard.type('k', { delay: 20 });
    await waitItem(p5, FIXTURE_EVENT.code, 3000);

    // ---------- 7. the Firestore copy of the list cannot be read (refused / offline): the worker is asked instead ----------
    await p5.evaluate((s) => {
      delete eventCache[s];
      const real = db.collection.bind(db);
      db.collection = (name) => (name === 'eventCache' ? { doc: () => ({ get: () => Promise.reject(new Error('smoke: cache read refused')) }) } : real(name));
    }, String(FIXTURE_SEASON));
    await typeInBox(p5, 'Smo');
    await waitItem(p5, FIXTURE_EVENT.code);
    assert.deepEqual(await items(p5), [FIXTURE_EVENT.code], 'a refused cache read falls back to the worker');
  }
};
