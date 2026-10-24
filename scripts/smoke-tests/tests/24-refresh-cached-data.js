// "Refresh cached data" (My Account > DATA, js/data-refresh.js):
//   - replaces the local FTCScout team list, makes THIS device treat every cached copy of event
//     data (event lists, rosters, schedules, scores, team stats) as expired and clears the
//     in-memory copies — WITHOUT writing or deleting a single shared Firestore doc — and nothing
//     else: scouting entries, form configs, scrimmage data and the signed-in session are untouched
//   - the open event/scrimmage screen keeps working; the event reloads FRESH the next time it is opened
//   - progress ("Refreshing..."), then "Refreshed. Event data will reload when you next open it."
//   - the per-device cooldown starts ONLY after a SUCCESS, survives a reload, disables the button with
//     the time left ("Available again in 12 min"), ends by itself, and a refresh can't be started twice
//   - a part-way failure says so and starts NO cooldown

const assert = require('node:assert/strict');
const { FIXTURE_EVENT } = require('../lib/harness');
const {
  signInUI, createTeamUI, selectFixtureEvent, createScrimmageUI, openScrimmageUI, openScoutingSubtab
} = require('../lib/app');

module.exports = {
  name: 'Refresh cached data: team list replaced, event caches expire on this device (no shared doc written), in-memory cleared, event reloads fresh, cooldown only after success + survives reload, no double start, failure = no cooldown',
  async run(ctx) {
    const user = await ctx.makeUser('Refresh Scout');
    const page = await ctx.newPage('refresh');
    await signInUI(page, user);
    await createTeamUI(page, 'Refresh Smoke Team');
    const teamId = await page.evaluate(() => currentTeamData.id);
    await selectFixtureEvent(page);                       // writes events/SMOKE1, its teams' teamDetails and the season's eventCache doc
    const code = FIXTURE_EVENT.code;
    const season = await page.evaluate(() => getSelectedSeason());

    const cachedAtMs = (path) => page.evaluate(async (p) => {
      const d = await db.doc(p).get();
      const t = d.exists && d.data().cachedAt;
      return d.exists ? (t ? t.toMillis() : null) : undefined;
    }, path);
    const field = (path, f) => page.evaluate(async ([p, name]) => { const d = await db.doc(p).get(); return d.exists ? d.data()[name] : undefined; }, [path, f]);
    const millis = (v) => (v && typeof v.seconds === 'number' ? v.seconds * 1000 : v);

    // Things that must NOT be touched: an unrelated shared cache doc, an unrelated event, a pit entry,
    // a form config, a draft, and a scrimmage with a linked team.
    await page.evaluate(async ([tid, c]) => {
      const now = firebase.firestore.Timestamp.now();
      await db.collection('teamDetails').doc('9999').set({ teamNumber: 9999, name: 'Unrelated Team', season: '2026', cachedAt: now });
      await db.collection('teamDetails').doc('5555').set({ teamNumber: 5555, name: 'Five Star Robotics', season: '2026', opr: 1, cachedAt: now });
      await db.collection('events').doc('OTHER1').set({ name: 'Some Other Event', ftcTeams: [{ teamNumber: 9999, name: 'Unrelated Team' }], season: '2026', cachedAt: now });
      await db.collection('teams').doc(tid).collection('pitScouting').doc(tid + '_' + c + '_101').set({
        eventCode: c, teamNumber: 101, teamId: tid, season: '2026', driveType: 'Mecanum', scoutedBy: currentUser.uid, scoutedByName: 'Me', checkpoint: { driveType: 'Mecanum' }, activeEditors: {}
      });
      await db.collection('teams').doc(tid).collection('formConfig').doc('2026_pitScouting').set({ fields: [{ id: 'driveType', label: 'Drive', type: 'text', sortOrder: 0 }] });
    }, [teamId, code]);
    const before = {
      unrelatedTeam: await cachedAtMs('teamDetails/9999'),
      otherEvent: await cachedAtMs('events/OTHER1'),
      pit: await field(`teams/${teamId}/pitScouting/${teamId}_${code}_101`, 'driveType'),
      form: JSON.stringify(await field(`teams/${teamId}/formConfig/2026_pitScouting`, 'fields'))
    };
    assert.ok(before.unrelatedTeam > 0 && before.otherEvent > 0);
    assert.ok((await cachedAtMs('teamDetails/101')) > 1000, 'the open event\'s team stats are cached (fresh)');
    const sharedPaths = [`events/${code}`, 'events/OTHER1', `eventCache/season_${season}`, 'teamDetails/101', 'teamDetails/202', 'teamDetails/303', 'teamDetails/5555', 'teamDetails/9999'];
    const sharedSnapshot = async () => JSON.stringify(await Promise.all(sharedPaths.map(async (path) => [path, await page.evaluate(async (pp) => { const d = await db.doc(pp).get(); const norm = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : Array.isArray(v) ? v.map(norm) : (v && typeof v === 'object') ? Object.fromEntries(Object.keys(v).sort().map(k => [k, norm(v[k])])) : v); return d.exists ? JSON.stringify(norm(d.data())) : null; }, path)])));
    const sharedBefore = await sharedSnapshot();
    const deviceView = () => page.evaluate(async ([c, sn]) => ({
      teamStats101: !!(await getCachedTeamDetail(101)), teamStats9999: !!(await getCachedTeamDetail(9999)), linked5555: !!(await getCachedTeamDetail(5555, '2026')),
      roster: !!(await getCachedEvent(c, sn))
    }), [code, season]);
    assert.deepEqual(await deviceView(), { teamStats101: true, teamStats9999: true, linked5555: true, roster: true }, 'before: every cache is usable on this device');
    const seasonDoc = `eventCache/season_${season}`;
    assert.ok((await cachedAtMs(seasonDoc)) > 1000, 'the season event list is cached');

    // an open scrimmage with a linked team: it is what the "open screen keeps working" check looks at
    await createScrimmageUI(page, { name: 'Refresh Scrim' });
    await openScrimmageUI(page, 'Refresh Scrim');
    await page.evaluate(async (tid) => {
      await db.collection('teams').doc(tid).collection('scrimmages').doc(selectedEvent.scrimmageId).update({
        'teams.5555': { number: 5555, name: 'Five Star Robotics', manualName: 'Five', linked: true, location: 'Boise, ID, USA', opr: 1, linkedAt: new Date() },
        'teams.6666': { number: 6666, name: 'Plain Team', manualName: 'Plain Team', linked: false, location: '', opr: null, linkedAt: null }
      });
    }, teamId);
    await page.waitForFunction(() => currentScrimmage.teams['5555'] && currentScrimmage.teams['6666']);
    const scrimBefore = JSON.stringify(await page.evaluate(() => { const t = currentScrimmage.teams; return [t['5555'].name, t['6666'].name, Object.keys(t)]; }));

    const openAccount = async () => {
      await page.click('#btn-open-my-account-from-dashboard');
      await page.waitForSelector('#dtab-account.active, #dtab-account:not(.hidden)');
      await page.waitForSelector('#btn-refresh-cached-data', { state: 'visible' });
    };
    const btnText = async () => (await page.textContent('#btn-refresh-cached-data')).trim();
    const lastSuccess = () => page.evaluate(() => localStorage.getItem('fe2o3-data-refresh-last-success'));

    // ---------- the card ----------
    await openAccount();
    assert.equal(await btnText(), 'Refresh cached data');
    assert.ok(!(await page.isDisabled('#btn-refresh-cached-data')));
    assert.match(await page.textContent('#refresh-data-help'), /never touched\. Available once every 15 minutes\./, 'one line of help; the cooldown wording comes from the constant');
    assert.equal(await page.evaluate(() => DATA_REFRESH_COOLDOWN_MS), 15 * 60 * 1000, 'the cooldown is one named constant (15 min)');
    assert.equal(await lastSuccess(), null);

    // ---------- the refresh: progress, then a short result ----------
    const lists0 = ctx.state.ftcScoutListRequests;
    ctx.state.ftcScoutListDelay = 900;
    await page.click('#btn-refresh-cached-data');
    await page.waitForFunction(() => document.getElementById('btn-refresh-cached-data').textContent.trim() === 'Refreshing...');
    assert.ok(await page.isDisabled('#btn-refresh-cached-data'), 'disabled while it runs');
    // ...and it can't be started twice
    const twice = await page.evaluate(async () => { const started = dataRefreshBusy; await runDataRefresh(); return started; });
    assert.equal(twice, true, 'a second start while one is running does nothing');
    await page.waitForFunction(() => /Refreshed\./.test(document.getElementById('refresh-data-success').textContent));
    ctx.state.ftcScoutListDelay = 0;
    assert.equal((await page.textContent('#refresh-data-success')).trim(), 'Refreshed. Event data will reload when you next open it.');
    assert.equal((await page.textContent('#refresh-data-error')).trim(), '');
    assert.equal(ctx.state.ftcScoutListRequests, lists0 + 1, 'exactly ONE team-list request (the double start did not send a second)');

    // ---------- what it did ----------
    assert.equal(await sharedSnapshot(), sharedBefore, 'NOT ONE shared Firestore doc was written or deleted (events, event lists, team stats — all byte-identical)');
    assert.deepEqual(await deviceView(), { teamStats101: false, teamStats9999: false, linked5555: false, roster: false },
      'but THIS device now treats every cached copy (event roster, team stats incl. the open scrimmage\'s linked team) as expired');
    assert.ok(await page.evaluate(() => dataCacheEpochMs() > 0), 'the per-device stamp is stored');
    // ---------- and what it did NOT ----------
    assert.equal(await field(`events/${code}`, 'name'), FIXTURE_EVENT.name, 'the roster itself is kept');
    assert.ok((await field(`events/${code}`, 'ftcTeams')).length >= 3);
    assert.equal(await field(`teams/${teamId}/pitScouting/${teamId}_${code}_101`, 'driveType'), before.pit, 'a scouting entry is untouched');
    assert.equal(JSON.stringify(await field(`teams/${teamId}/formConfig/2026_pitScouting`, 'fields')), before.form, 'a form config is untouched');
    assert.ok(await page.evaluate(() => !!currentUser && !!auth.currentUser), 'still signed in');
    assert.deepEqual(await page.evaluate(() => [Object.keys(eventCache).length, Object.keys(matchScoresCacheByEvent).length, formConfigCache.size]), [0, 0, 0], 'the in-memory copies are cleared');
    // the season event list is re-fetched from the worker the next time it is needed
    const events0 = ctx.state.workerRequests.filter(u => u.startsWith('/events')).length;
    await page.evaluate((sn) => ensureEventsLoaded(sn), season);
    assert.equal(ctx.state.workerRequests.filter(u => u.startsWith('/events')).length, events0 + 1, 'the event list reloads from the worker, not the (older) cached copy');
    const stored = await page.evaluate(() => new Promise((resolve) => {
      const open = indexedDB.open('fe2o3-ftc-team-list', 1);
      open.onsuccess = () => { const g = open.result.transaction('lists').objectStore('lists').get('all-teams'); g.onsuccess = () => resolve({ n: g.result.teams.length, age: Date.now() - g.result.fetchedAt }); };
    }));
    assert.ok(stored.n >= 20 && stored.age < 20000, 'the stored team list was replaced just now');

    // ---------- the open screen keeps working; the event reloads FRESH when next opened ----------
    await page.click('#btn-account-page-sign-out', { trial: true }).catch(() => {});   // (just proving the page is intact — not clicked)
    await page.click('#btn-my-account-standalone-back').catch(() => {});
    await page.click('#dashboard-tabs .tab[data-dtab="scouting"]');
    await openScoutingSubtab(page, 'info');
    assert.equal(scrimBefore, JSON.stringify(await page.evaluate(() => { const t = currentScrimmage.teams; return [t['5555'].name, t['6666'].name, Object.keys(t)]; })), 'the open scrimmage is unchanged');
    assert.equal(await page.locator('#team-list-info .team-item[data-team-number="5555"]').count(), 1, 'its roster still lists');
    await page.click('#btn-deselect-event');
    const teamsCalls0 = ctx.state.workerRequests.filter(u => u.startsWith('/teams')).length;
    await page.click('#dashboard-tabs .tab[data-dtab="scouting"]');
    await page.fill('#input-event-search', 'Smoke');
    await page.click('#btn-search-events');
    await page.click(`.event-item[data-code="${code}"]`);
    await page.waitForFunction(() => /team\(s\) registered/.test(document.getElementById('selected-event-teams-count')?.textContent || ''));
    assert.equal(ctx.state.workerRequests.filter(u => u.startsWith('/teams')).length, teamsCalls0 + 1, 'the event roster was fetched FRESH on its next open');
    assert.ok((await cachedAtMs(`events/${code}`)) > (await page.evaluate(() => dataCacheEpochMs())), '...and re-cached fresh (newer than the refresh)');
    assert.deepEqual((await deviceView()).roster, true, 'so the roster is valid on this device again');

    // ---------- cooldown: started by the success, survives a reload ----------
    assert.ok(await lastSuccess(), 'the cooldown start is stored on this device');
    await openAccount();
    assert.ok(await page.isDisabled('#btn-refresh-cached-data'), 'disabled during the cooldown');
    assert.match(await btnText(), /^Available again in (14|15) min$/, 'with the time left');
    await page.reload();
    await page.waitForSelector('#screen-main.active');
    // (a refresh restores the page you were on — the account page — so only open it if it is not showing)
    await page.waitForTimeout(1500);   // let the session restore settle
    if (!(await page.isVisible('#btn-refresh-cached-data'))) await page.click('#btn-open-my-account-from-dashboard');
    await page.waitForSelector('#btn-refresh-cached-data', { state: 'visible' });
    assert.ok(await page.isDisabled('#btn-refresh-cached-data'), 'still disabled after a reload');
    assert.match(await btnText(), /^Available again in (14|15) min$/);
    // 3 minutes in: "Available again in 12 min"; clicking does nothing
    await page.evaluate((ms) => { localStorage.setItem('fe2o3-data-refresh-last-success', String(Date.now() - 3 * 60 * 1000)); renderDataRefreshControl(); }, null);
    assert.equal(await btnText(), 'Available again in 12 min');
    const lists1 = ctx.state.ftcScoutListRequests;
    await page.evaluate(() => runDataRefresh());
    assert.equal(ctx.state.ftcScoutListRequests, lists1, 'inside the cooldown nothing runs, even if called directly');
    // 16 minutes in: available again, by itself (the control re-renders on its own timer)
    await page.evaluate(() => { localStorage.setItem('fe2o3-data-refresh-last-success', String(Date.now() - 16 * 60 * 1000)); });
    await page.waitForFunction(() => !document.getElementById('btn-refresh-cached-data').disabled, null, { timeout: 20000 });
    assert.equal(await btnText(), 'Refresh cached data');

    // ---------- a part-way failure: says so, NO cooldown, nothing replaced ----------
    await page.evaluate(() => localStorage.removeItem('fe2o3-data-refresh-last-success'));
    const fetchedBefore = await page.evaluate(() => new Promise((resolve) => {
      const open = indexedDB.open('fe2o3-ftc-team-list', 1);
      open.onsuccess = () => { const g = open.result.transaction('lists').objectStore('lists').get('all-teams'); g.onsuccess = () => resolve(g.result.fetchedAt); };
    }));
    ctx.state.ftcScoutListMode = 'error';
    try {
      await page.click('#btn-refresh-cached-data');
      await page.waitForFunction(() => /Couldn't finish refreshing/.test(document.getElementById('refresh-data-error').textContent));
      assert.match(await page.textContent('#refresh-data-error'), /Couldn't finish refreshing \(FTCScout's team list\)\. Nothing you created was changed\. Try again in a moment\./);
      assert.equal((await page.textContent('#refresh-data-success')).trim(), '');
      assert.equal(await lastSuccess(), null, 'a failed refresh does NOT start the cooldown');
      assert.ok(!(await page.isDisabled('#btn-refresh-cached-data')), 'so it can be tried again straight away');
      assert.equal(await btnText(), 'Refresh cached data');
      const fetchedAfter = await page.evaluate(() => new Promise((resolve) => {
        const open = indexedDB.open('fe2o3-ftc-team-list', 1);
        open.onsuccess = () => { const g = open.result.transaction('lists').objectStore('lists').get('all-teams'); g.onsuccess = () => resolve(g.result.fetchedAt); };
      }));
      assert.equal(fetchedAfter, fetchedBefore, 'the old stored team list is kept when the new one could not be fetched');
    } finally {
      ctx.state.ftcScoutListMode = 'ok';
    }
    await page.click('#btn-refresh-cached-data');                // retry works and now starts the cooldown
    await page.waitForFunction(() => /Refreshed\./.test(document.getElementById('refresh-data-success').textContent));
    assert.ok(await lastSuccess());
    assert.ok(await page.isDisabled('#btn-refresh-cached-data'));
  }
};
