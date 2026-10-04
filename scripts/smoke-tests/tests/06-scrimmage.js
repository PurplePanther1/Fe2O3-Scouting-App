// Unofficial scrimmages, end to end: create -> whole-row open/deselect (buttons
// don't trigger the row) -> banner and hidden controls -> Add Team to Roster ->
// "+ Add & scout a team" (new and existing team, modal reset, no orphan drafts)
// -> reload restores -> unlinked Team Details never hits FTCScout -> a plain
// member's view -> Manage's Add Team + Delete -> SEASON CHANGE (danger confirm
// with totals, Cancel/click-out change nothing, Export First on a scrimmage that
// is not open, confirm deletes the entries + resets matchCount + keeps the roster,
// a teammate with an entry open is disconnected) -> no-prompt cases -> removing a
// team WITH entries -> export isolation -> delete cascade.

const assert = require('node:assert/strict');
const {
  signInUI, createTeamUI, joinTeamUI, openScoutingSubtab, openScrimmagesTab,
  createScrimmageUI, scrimmageRow, openScrimmageUI, addAndScoutUI, submitScrimmageTeamModal, teamRow, fillRequiredFields
} = require('../lib/app');

const countEntries = (page, teamId, code) => page.evaluate(async ([tid, c]) => {
  const out = { pit: 0, match: 0 };
  for (const [key, col] of [['pit', 'pitScouting'], ['match', 'matchScouting']]) {
    out[key] = (await db.collection('teams').doc(tid).collection(col).where('eventCode', '==', c).get()).size;
  }
  return out;
}, [teamId, code]);

const readScrimmage = (page, teamId, scrimmageId) => page.evaluate(async ([tid, sid]) =>
  (await db.collection('teams').doc(tid).collection('scrimmages').doc(sid).get()).data(), [teamId, scrimmageId]);

const waitConfirm = (page, titleRe) => page.waitForFunction((src) =>
  !document.getElementById('generic-confirm-modal').classList.contains('hidden')
  && new RegExp(src).test(document.getElementById('generic-confirm-title').textContent), titleRe.source);

module.exports = {
  name: 'scrimmage: row open/deselect, add & scout, reload, member view, Manage, SEASON CHANGE (confirm/export/delete), remove team with entries, export, delete cascade',
  async run(ctx) {
    const captain = await ctx.makeUser('Captain Scrim');
    const member = await ctx.makeUser('Member Scrim');
    const page = await ctx.newPage('captain');
    await signInUI(page, captain);
    const joinCode = await createTeamUI(page, 'Scrim Smoke Team');
    const teamId = await page.evaluate(() => currentTeamData.id);

    // ---------- empty state, create ----------
    await openScrimmagesTab(page);
    await page.waitForFunction(() => /No scrimmages yet/.test(document.getElementById('scrimmages-status')?.textContent || ''));
    assert.ok(await page.isVisible('#btn-new-scrimmage'), 'captain sees + New Scrimmage');

    const currentSeason = await page.evaluate(() => String(getCurrentFtcSeason()));
    const oldSeason = String(Number(currentSeason) - 1);
    await createScrimmageUI(page, { name: 'Old Season Scrim', season: oldSeason });
    await createScrimmageUI(page, { name: 'Smoke Scrim', date: '2026-11-15' });
    await createScrimmageUI(page, { name: 'Bystander Scrim' });

    // Newest season first; the row shows UNOFFICIAL, season label, date, teams — and no "matches" yet.
    const rowTexts = await page.$$eval('#scrimmage-list .scrimmage-item', els => els.map(e => e.textContent));
    assert.match(rowTexts[0], /Smoke Scrim|Bystander Scrim/, 'current-season scrimmages sort first');
    assert.match(rowTexts[2], /Old Season Scrim/, 'older season last');
    const smokeText = await scrimmageRow(page, 'Smoke Scrim').textContent();
    assert.match(smokeText, /UNOFFICIAL/);
    assert.match(smokeText, new RegExp(`${currentSeason}-${Number(currentSeason) + 1}`));
    assert.match(smokeText, /2026-11-15/);
    assert.match(smokeText, /0 teams/);
    assert.doesNotMatch(smokeText, /matches/);
    const smokeRow = scrimmageRow(page, 'Smoke Scrim');
    assert.ok(await smokeRow.locator('.btn-scrimmage-manage').isVisible(), 'Manage button for a permission holder');
    assert.ok(await smokeRow.locator('.btn-scrimmage-delete').isVisible(), 'Delete button for a permission holder');
    assert.equal(await page.locator('.btn-scrimmage-open, .btn-scrimmage-edit').count(), 0, 'no separate Open / Rename-Date buttons anymore');

    // ---------- buttons inside a row never trigger the row's select ----------
    await smokeRow.locator('.btn-scrimmage-manage').click();
    await page.waitForSelector('#scrimmage-form-modal:not(.hidden)');
    assert.equal(await page.evaluate(() => selectedEvent), null, 'Manage did not also open the scrimmage');
    assert.match(await page.textContent('#scrimmage-form-title'), /Manage Scrimmage/);
    await page.click('#btn-scrimmage-form-cancel');
    await page.waitForSelector('#scrimmage-form-modal', { state: 'hidden' });
    await smokeRow.locator('.btn-scrimmage-delete').click();
    await page.waitForSelector('#generic-confirm-modal:not(.hidden)');
    await page.click('#btn-generic-confirm-cancel');
    assert.equal(await page.evaluate(() => selectedEvent), null, 'Delete did not also open the scrimmage');

    // ---------- whole-row select / deselect; stays on the Scrimmages tab; switches season ----------
    await scrimmageRow(page, 'Old Season Scrim').locator('.event-name').click();
    await page.waitForFunction(() => selectedEvent && selectedEvent.name === 'Old Season Scrim' && currentScrimmage);
    assert.equal(await page.inputValue('#select-season'), oldSeason, 'opening an old-season scrimmage switches the season dropdown');
    assert.ok(await page.isVisible('#subtab-scrimmages.active'), 'stays on the Scrimmages tab (like Pinned Events)');
    assert.ok(await scrimmageRow(page, 'Old Season Scrim').evaluate(el => el.classList.contains('selected')), 'selected row highlighted');
    await scrimmageRow(page, 'Old Season Scrim').locator('.event-name').click();
    await page.waitForFunction(() => selectedEvent === null);
    assert.ok(!(await scrimmageRow(page, 'Old Season Scrim').evaluate(el => el.classList.contains('selected'))), 'click again deselects');
    assert.equal(await page.locator('[data-scrimmage-banner]:visible').count(), 0, 'no banner after deselect');

    await openScrimmageUI(page, 'Smoke Scrim', { goTo: null });
    assert.equal(await page.inputValue('#select-season'), currentSeason, 'back to the current season');
    assert.ok(await page.isVisible('#subtab-scrimmages.active'), 'still on the Scrimmages tab');

    // Snapshot network traffic: nothing after this point may fetch a roster/schedule for the scrimmage.
    const workerBefore = ctx.state.workerRequests.length;
    const ftcBefore = ctx.state.ftcScoutRequests.length;

    // ---------- banner (text only — no Switch button) + hidden controls ----------
    for (const tab of ['info', 'pit', 'match', 'compare']) {
      await openScoutingSubtab(page, tab);
      const banner = page.locator(`#subtab-${tab} [data-scrimmage-banner]`);
      assert.ok(await banner.isVisible(), `banner visible on ${tab}`);
      assert.equal((await banner.textContent()).trim(), 'SCRIMMAGE: Smoke Scrim — Unofficial, not FIRST data');
      assert.equal(await banner.locator('button').count(), 0, 'the banner has no buttons');
    }
    assert.equal(await page.locator('.scrimmage-banner-switch').count(), 0);
    assert.ok(!(await page.isVisible('#btn-pin-event')), 'Pin button hidden');
    assert.ok(!(await page.isVisible('#match-view-toggle-bar')), 'Match View toggle hidden');
    assert.ok(!(await page.isVisible('#match-schedule-view')), 'Team View forced');
    assert.ok(!(await page.isVisible('#btn-refresh-match-scores')), 'Refresh Scores hidden');
    await openScoutingSubtab(page, 'info');
    assert.match(await page.textContent('#team-list-status-info'), /No teams on this scrimmage yet/);
    assert.equal(await page.locator('#input-scrimmage-scout-pit, #input-scrimmage-scout-match, .scrimmage-scout-strip').count(), 0, 'old Scout team # strips are gone');

    // ---------- Info tab: "+ Add Team to Roster" ----------
    assert.equal((await page.textContent('#btn-scrimmage-add-team')).trim(), '+ Add Team to Roster');
    assert.match(await page.textContent('#subtab-info .scrimmage-add-block .help-text'), /Add a team by number — scouts can also add teams from the Pit and Match tabs\./);
    await page.click('#btn-scrimmage-add-team');
    assert.equal((await page.textContent('#scrimmage-team-title')).trim(), 'Add Team to Roster');
    await submitScrimmageTeamModal(page, { number: 4242, name: 'Robo Cats' });
    await page.locator('#team-list-info .team-item[data-team-number="4242"]').waitFor();
    assert.match(await page.textContent('#team-list-info'), /Robo Cats/);
    assert.match(await page.textContent('#scrimmage-roster-success'), /Added Team #4242/);
    await page.click('#btn-scrimmage-add-team');
    await submitScrimmageTeamModal(page, { number: 4242, name: 'Different Name' });
    assert.match(await page.textContent('#scrimmage-roster-success'), /already on this scrimmage's roster/);
    assert.match(await page.textContent('#team-list-info .team-item[data-team-number="4242"]'), /Robo Cats/, 'existing team untouched');

    // ---------- leaving a view clears its status lines ----------
    await openScoutingSubtab(page, 'pit');
    await openScoutingSubtab(page, 'info');
    assert.equal((await page.textContent('#scrimmage-roster-success')).trim(), '', 'roster status cleared after switching subtabs');

    // ---------- the add-team modal resets on every open AND close ----------
    await page.click('#btn-scrimmage-add-team');
    await page.fill('#input-scrimmage-team-number', '100000');
    await page.fill('#input-scrimmage-team-name', 'leftover text');
    await page.click('#btn-scrimmage-team-save');
    assert.match(await page.textContent('#scrimmage-team-error'), /1 to 99999/);
    await page.click('#btn-scrimmage-team-cancel');
    await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });
    assert.equal(await page.inputValue('#input-scrimmage-team-number'), '', 'number reset on close');
    assert.equal(await page.inputValue('#input-scrimmage-team-name'), '', 'name reset on close');
    assert.equal((await page.textContent('#scrimmage-team-error')).trim(), '', 'error reset on close');
    await page.click('#btn-scrimmage-add-team');
    assert.equal(await page.inputValue('#input-scrimmage-team-number'), '', 'number empty on reopen');
    await page.click('#btn-scrimmage-team-cancel');
    await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });

    // ---------- "+ Add & scout a team" (Pit): button + help text, new team ----------
    await openScoutingSubtab(page, 'pit');
    assert.equal((await page.textContent('#btn-scrimmage-add-scout-pit')).trim(), '+ Add & scout a team');
    assert.match(await page.textContent('#subtab-pit .scrimmage-add-block .help-text'), /Team not on the roster yet\? Add it by number and start scouting it\./);
    const code = await page.evaluate(() => selectedEvent.code);
    await page.click('#btn-scrimmage-add-scout-pit');
    await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
    assert.equal((await page.textContent('#scrimmage-team-title')).trim(), 'Add & Scout a Team');
    assert.equal((await page.textContent('#btn-scrimmage-team-save')).trim(), 'Add & Scout');
    assert.equal(await page.inputValue('#input-scrimmage-team-number'), '', 'number empty');
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'input-scrimmage-team-number', 'number focused');
    assert.ok(!(await page.isVisible('#pit-modal')), 'pit form is NOT open while the add modal is');
    await page.fill('#input-scrimmage-team-number', '777');
    await page.fill('#input-scrimmage-team-name', 'Gear Heads');
    const draftsBefore = await page.evaluate(async ([tid, c]) =>
      (await db.collection('teams').doc(tid).collection('pitScouting').where('eventCode', '==', c).where('teamNumber', '==', 777).get()).size, [teamId, code]);
    assert.equal(draftsBefore, 0, 'no orphan draft before the team is on the roster');
    await page.click('#btn-scrimmage-team-save');
    await page.waitForSelector('#pit-modal:not(.hidden) #pit-dynamic-fields .pit-field');
    assert.ok(!(await page.isVisible('#scrimmage-team-modal')), 'the add modal is fully closed before the pit form shows');
    assert.ok(await page.evaluate(() => !!currentScrimmage.teams['777']), 'team 777 is on the roster by the time the form opens');
    await page.waitForFunction(() => typeof currentPitLiveSession !== 'undefined' && currentPitLiveSession && currentPitLiveSession.isJoined());
    await fillRequiredFields(page, '#pit-modal', 'gear pit note');
    await page.click('#btn-pit-save');
    await page.waitForSelector('#pit-modal', { state: 'hidden' });
    await (await teamRow(page, '#team-list-pit', 777)).locator('.pit-row-meta').waitFor();

    // ...an EXISTING team skips the add and opens the form directly; modal was reset
    const rosterBefore = await page.evaluate(() => Object.keys(currentScrimmage.teams).length);
    await page.click('#btn-scrimmage-add-scout-pit');
    await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
    assert.equal(await page.inputValue('#input-scrimmage-team-number'), '', 'number reset after the previous use');
    assert.equal(await page.inputValue('#input-scrimmage-team-name'), '', 'name reset after the previous use');
    await page.fill('#input-scrimmage-team-number', '4242');
    await page.click('#btn-scrimmage-team-save');
    await page.waitForSelector('#pit-modal:not(.hidden) #pit-dynamic-fields .pit-field');
    assert.equal(await page.evaluate(() => Object.keys(currentScrimmage.teams).length), rosterBefore, 'nothing added for an existing team');
    await page.waitForFunction(() => typeof currentPitLiveSession !== 'undefined' && currentPitLiveSession && currentPitLiveSession.isJoined());
    await fillRequiredFields(page, '#pit-modal', 'scrim pit note');
    await page.click('#btn-pit-save');
    await page.waitForSelector('#pit-modal', { state: 'hidden' });

    // ---------- "+ Add & scout a team" (Match, Team View), new team with no name ----------
    await openScoutingSubtab(page, 'match');
    assert.equal((await page.textContent('#btn-scrimmage-add-scout-match')).trim(), '+ Add & scout a team');
    await addAndScoutUI(page, 'match', { number: 888, name: '' });
    await page.waitForSelector('#match-modal:not(.hidden) #match-dynamic-fields .pit-field');
    await page.fill('#match-modal #dyn-matchNumber', '12');
    await fillRequiredFields(page, '#match-modal', 'scrim match note');
    await page.click('#btn-match-save');
    await page.waitForSelector('#match-modal', { state: 'hidden' });
    await (await teamRow(page, '#team-list-match', 888)).locator('.match-count-badge:not(.hidden)').waitFor();

    // A lower match number must not lower matchCount.
    await (await teamRow(page, '#team-list-match', 4242)).getByRole('button', { name: '+ Match Scout' }).click();
    await page.waitForSelector('#match-modal:not(.hidden) #match-dynamic-fields .pit-field');
    await page.fill('#match-modal #dyn-matchNumber', '3');
    await fillRequiredFields(page, '#match-modal', 'second match');
    await page.click('#btn-match-save');
    await page.waitForSelector('#match-modal', { state: 'hidden' });
    await page.waitForFunction(() => currentScrimmage && currentScrimmage.matchCount === 12);

    // ---------- every entry is tagged; none stores a team name ----------
    const entryAudit = await page.evaluate(async ([tid, c]) => {
      const out = [];
      for (const col of ['pitScouting', 'matchScouting']) {
        const snap = await db.collection('teams').doc(tid).collection(col).where('eventCode', '==', c).get();
        snap.forEach(d => out.push({ col, scrimmageId: d.data().scrimmageId, hasName: 'teamName' in d.data() }));
      }
      return out;
    }, [teamId, code]);
    assert.equal(entryAudit.length, 4, '2 pit + 2 match entries');
    const scrimmageId = await page.evaluate(() => selectedEvent.scrimmageId);
    entryAudit.forEach(e => {
      assert.equal(e.scrimmageId, scrimmageId, `${e.col} entry carries scrimmageId`);
      assert.equal(e.hasName, false, 'entries store no team name');
    });

    // ---------- list now shows teams + matches ----------
    await openScrimmagesTab(page);
    await page.waitForFunction(() => /3 teams/.test(document.querySelector('#scrimmage-list .scrimmage-item.selected')?.textContent || ''));
    assert.match(await scrimmageRow(page, 'Smoke Scrim').textContent(), /12 matches/);

    // ---------- reload restores the open scrimmage (and its cleared search) ----------
    await page.reload();
    await page.waitForSelector('#screen-main.active');
    await page.waitForFunction(() => selectedEvent && selectedEvent.isScrimmage && currentScrimmage && Object.keys(currentScrimmage.teams).length === 3);
    assert.equal(await page.inputValue('#select-season'), currentSeason);
    assert.equal(await page.inputValue('#input-event-search'), '', 'the cleared search box survives the refresh');
    await openScoutingSubtab(page, 'pit');
    assert.ok(await page.locator('#subtab-pit [data-scrimmage-banner]').isVisible(), 'banner survives reload');
    await (await teamRow(page, '#team-list-pit', 4242)).locator('.pit-row-meta').waitFor();

    // ---------- name edit: roster only, visible in every list immediately ----------
    await openScoutingSubtab(page, 'info');
    await (await teamRow(page, '#team-list-info', 4242)).locator('.btn-scrimmage-team-edit').click();
    assert.ok(await page.isDisabled('#input-scrimmage-team-number'), 'number is locked when editing');
    await submitScrimmageTeamModal(page, { name: 'Robo Cats Reborn' });
    for (const [tab, list] of [['info', '#team-list-info'], ['pit', '#team-list-pit'], ['match', '#team-list-match'], ['compare', '#team-list-compare']]) {
      await openScoutingSubtab(page, tab);
      await page.waitForFunction((l) => (document.querySelector(`${l} .team-item[data-team-number="4242"]`)?.textContent || '').includes('Robo Cats Reborn'), list);
    }
    const exportNames = await page.evaluate(async ([tid, c]) => (await gatherEventExportData(c, tid)).pitDocs.map(d => [d.teamNumber, d.teamName]), [teamId, code]);
    assert.deepEqual(exportNames.find(r => r[0] === 4242), [4242, 'Robo Cats Reborn'], 'per-event export uses the roster name');

    // ---------- Team Details on an unlinked team: message, never FTCScout ----------
    await openScoutingSubtab(page, 'info');
    await (await teamRow(page, '#team-list-info', 4242)).getByRole('button', { name: 'View Detail' }).click();
    await page.waitForSelector('#team-detail-modal:not(.hidden) #td-modal-body:not(.hidden)');
    assert.match(await page.textContent('#td-awards-list'), /This team isn't linked to FTCScout\./);
    assert.match(await page.textContent('#td-team-name'), /Robo Cats Reborn/);
    await page.click('#btn-team-detail-close');
    await page.waitForSelector('#team-detail-modal', { state: 'hidden' });

    // ---------- a plain member's view ----------
    const memPage = await ctx.newPage('member');
    await signInUI(memPage, member);
    await joinTeamUI(memPage, joinCode);
    await openScrimmagesTab(memPage);
    await scrimmageRow(memPage, 'Smoke Scrim').waitFor();
    assert.ok(!(await memPage.isVisible('#btn-new-scrimmage')), 'member has no + New Scrimmage');
    assert.equal(await memPage.locator('.btn-scrimmage-manage, .btn-scrimmage-delete').count(), 0, 'member has no Manage/Delete');
    await openScrimmageUI(memPage, 'Smoke Scrim');
    assert.equal(await memPage.inputValue('#select-season'), currentSeason);
    await memPage.locator('#team-list-info .team-item[data-team-number="4242"]').waitFor();
    assert.equal(await memPage.locator('.btn-scrimmage-team-remove').count(), 0, 'member has no roster Remove');
    await memPage.click('#btn-scrimmage-add-team');
    await submitScrimmageTeamModal(memPage, { number: 999, name: 'Member Added' });
    await memPage.locator('#team-list-info .team-item[data-team-number="999"]').waitFor();
    await page.locator('#team-list-info .team-item[data-team-number="999"]').waitFor({ state: 'attached' }); // live on the captain's side
    await (await teamRow(memPage, '#team-list-info', 888)).locator('.btn-scrimmage-team-edit').click();
    await submitScrimmageTeamModal(memPage, { name: 'Named By Member' });
    await page.waitForFunction(() => (document.querySelector('#team-list-info .team-item[data-team-number="888"]')?.textContent || '').includes('Named By Member'));

    // ---------- Manage: "+ Add Team" to a scrimmage that is NOT open, and Delete from inside ----------
    await openScrimmagesTab(page);
    await scrimmageRow(page, 'Old Season Scrim').locator('.btn-scrimmage-manage').click();
    await page.waitForSelector('#scrimmage-form-modal:not(.hidden)');
    assert.ok(await page.isVisible('#btn-scrimmage-manage-add-team'), 'Manage has + Add Team');
    assert.ok(await page.isVisible('#btn-scrimmage-manage-delete'), 'Manage has Delete');
    assert.match(await page.textContent('#scrimmage-season-help'), /Changing the season deletes this scrimmage's scouting entries — you'll be asked to confirm, and can export them first\./);
    await page.click('#btn-scrimmage-manage-add-team');
    await submitScrimmageTeamModal(page, { number: 31337, name: 'Offscreen Team' });
    await page.waitForFunction(() => /Added Team #31337/.test(document.getElementById('scrimmage-manage-team-success')?.textContent || ''));
    const oldScrimId = await page.evaluate(() => scrimmageList.find(s => s.name === 'Old Season Scrim').id);
    assert.deepEqual(Object.keys((await readScrimmage(page, teamId, oldScrimId)).teams), ['31337'], 'the team went onto THAT scrimmage');
    assert.ok(await page.evaluate(() => !currentScrimmage.teams['31337']), "the open scrimmage's roster is untouched");
    await page.click('#btn-scrimmage-form-cancel');
    await page.waitForSelector('#scrimmage-form-modal', { state: 'hidden' });
    await scrimmageRow(page, 'Old Season Scrim').locator('.btn-scrimmage-manage').click();
    await page.waitForSelector('#scrimmage-form-modal:not(.hidden)');
    assert.equal((await page.textContent('#scrimmage-manage-team-success')).trim(), '', 'Manage status line reset on reopen');
    await page.click('#btn-scrimmage-manage-delete');
    await page.waitForSelector('#generic-confirm-modal:not(.hidden)');
    assert.match(await page.textContent('#generic-confirm-message'), /Old Season Scrim.*1 teams \/ 0 pit \/ 0 match entries/);
    await page.click('#btn-generic-confirm-proceed');
    await scrimmageRow(page, 'Old Season Scrim').waitFor({ state: 'detached' });
    await page.waitForSelector('#scrimmage-form-modal', { state: 'hidden' });

    // =====================================================================
    // SEASON CHANGE. The captain has 'Bystander Scrim' OPEN, so 'Smoke Scrim'
    // (which holds the entries) is a scrimmage that is NOT open.
    // =====================================================================
    await openScrimmageUI(page, 'Bystander Scrim', { goTo: null });
    const bystanderSeason = await page.inputValue('#select-season');
    // The member has a pit form open on a fresh draft (team 888 has no pit entry) in Smoke Scrim.
    await openScoutingSubtab(memPage, 'pit');
    await (await teamRow(memPage, '#team-list-pit', 888)).locator('.btn-pit-quick-scout').click();
    await memPage.waitForSelector('#pit-modal:not(.hidden) #pit-dynamic-fields .pit-field');
    await memPage.waitForFunction(() => typeof currentPitLiveSession !== 'undefined' && currentPitLiveSession && currentPitLiveSession.isJoined());

    const before = { entries: await countEntries(page, teamId, code), stored: await readScrimmage(page, teamId, scrimmageId) };
    assert.equal(before.entries.pit, 3, "2 pit entries + the member's open draft");
    assert.equal(before.entries.match, 2);
    assert.equal(before.stored.matchCount, 12);
    const rosterKeysBefore = Object.keys(before.stored.teams).sort();

    await openScrimmagesTab(page);
    await scrimmageRow(page, 'Smoke Scrim').locator('.btn-scrimmage-manage').click();
    await page.waitForSelector('#scrimmage-form-modal:not(.hidden)');
    await page.fill('#input-scrimmage-name', 'Smoke Scrim Renamed');
    await page.selectOption('#select-scrimmage-season', '2025');
    await page.fill('#input-scrimmage-date', '');
    await page.click('#btn-scrimmage-form-save');
    await waitConfirm(page, /Change Season and Delete Entries\?/);

    // the confirm: totals, per-team lines, the roster note, THREE actions
    const msg = await page.textContent('#generic-confirm-message');
    assert.match(msg, /Changing the season to 2025-2026.* deletes all scouting entries in this scrimmage, because the form fields change\./);
    assert.match(msg, /3 teams have data: 3 pit and 2 match entries\./);
    assert.match(msg, /#777 — 1 pit, 0 match/);
    assert.match(msg, /#888 — 1 pit, 1 match/);
    assert.match(msg, /#4242 — 1 pit, 1 match/);
    assert.doesNotMatch(msg, /and \d+ more team/, 'only 3 teams, so no "and K more"');
    assert.match(msg, /The teams stay on the roster\. This can't be undone\./);
    assert.equal((await page.textContent('#btn-generic-confirm-proceed')).trim(), 'Delete & Change Season');
    assert.equal((await page.textContent('#btn-generic-confirm-secondary')).trim(), 'Export First');
    assert.ok(await page.isVisible('#btn-generic-confirm-secondary'));
    assert.ok(await page.isVisible('#btn-generic-confirm-cancel'));
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('generic-confirm-modal')).zIndex), '1002', 'layers above the Manage modal');

    // Cancel / X / click-out change NOTHING; the Manage modal stays as left.
    const assertUntouched = async (label) => {
      const now = { entries: await countEntries(page, teamId, code), stored: await readScrimmage(page, teamId, scrimmageId) };
      assert.deepEqual(now.entries, before.entries, `${label}: entries intact`);
      assert.equal(now.stored.season, currentSeason, `${label}: season unchanged`);
      assert.equal(now.stored.matchCount, 12, `${label}: matchCount unchanged`);
      assert.equal(now.stored.name, 'Smoke Scrim', `${label}: name unchanged`);
      assert.equal(now.stored.date, '2026-11-15', `${label}: date unchanged`);
      assert.ok(await page.isVisible('#scrimmage-form-modal'), `${label}: Manage modal still open`);
      assert.equal(await page.inputValue('#input-scrimmage-name'), 'Smoke Scrim Renamed', `${label}: Manage keeps what I typed`);
      assert.equal(await page.inputValue('#select-scrimmage-season'), '2025');
    };
    await page.click('#btn-generic-confirm-cancel');
    await assertUntouched('Cancel');
    await page.click('#btn-scrimmage-form-save');
    await waitConfirm(page, /Change Season/);
    await page.click('#btn-generic-confirm-close');            // the X
    await assertUntouched('X');
    await page.click('#btn-scrimmage-form-save');
    await waitConfirm(page, /Change Season/);
    await page.mouse.click(5, 5);                              // click-out (overlay)
    await page.waitForSelector('#generic-confirm-modal', { state: 'hidden' });
    await assertUntouched('click-out');

    // Export First: choice opens (confirm closed), dismissing returns to the confirm, and so does an export.
    await page.click('#btn-scrimmage-form-save');
    await waitConfirm(page, /Change Season/);
    await page.click('#btn-generic-confirm-secondary');
    await page.waitForSelector('#export-choice-modal:not(.hidden)');
    assert.match(await page.textContent('#export-choice-title'), /Export Scrimmage Data/);
    assert.ok(!(await page.isVisible('#generic-confirm-modal')), 'the confirm steps aside for the export choice');
    await page.click('#btn-export-choice-close');              // dismiss -> back to the confirm
    await waitConfirm(page, /Change Season/);
    await assertUntouched('dismissed export');
    await page.click('#btn-generic-confirm-secondary');
    await page.waitForSelector('#export-choice-modal:not(.hidden)');
    // The export reads this scrimmage's data under its CURRENT (old) season.
    const exportColumns = await page.evaluate(async ([tid, c]) => (await gatherEventExportData(c, tid)).pitFields.map(f => f.id), [teamId, code]);
    assert.ok(exportColumns.includes('driveType') && !exportColumns.includes('drivetrainType'), 'export columns come from the current (old) season');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#btn-export-choice-excel')
    ]);
    assert.match(download.suggestedFilename(), /Smoke Scrim - All Teams Scouting\.xlsx/, 'exported for THIS (not-open) scrimmage');
    await waitConfirm(page, /Change Season/);
    assert.match(await page.textContent('#generic-confirm-message'), /^Excel file downloaded\./, 'back at the confirm, with the export result');
    assert.match(await page.textContent('#generic-confirm-message'), /3 teams have data/);
    await assertUntouched('after export');

    // Confirm: entries deleted, then name/date/season/matchCount written; roster kept.
    await page.click('#btn-generic-confirm-proceed');
    await page.waitForSelector('#scrimmage-form-modal', { state: 'hidden' });
    const after = { entries: await countEntries(page, teamId, code), stored: await readScrimmage(page, teamId, scrimmageId) };
    assert.deepEqual(after.entries, { pit: 0, match: 0 }, 'every entry (drafts too) deleted');
    assert.equal(after.stored.season, '2025');
    assert.equal(after.stored.name, 'Smoke Scrim Renamed');
    assert.equal('date' in after.stored, false, 'date cleared');
    assert.equal(after.stored.matchCount, 0, 'matchCount reset to 0');
    assert.equal(after.stored.eventCode, code, 'eventCode never changes');
    assert.deepEqual(Object.keys(after.stored.teams).sort(), rosterKeysBefore, 'the roster is kept');
    // The captain's OTHER open scrimmage was untouched.
    assert.equal(await page.evaluate(() => selectedEvent.name), 'Bystander Scrim');
    assert.equal(await page.inputValue('#select-season'), bystanderSeason, "the open scrimmage's season is untouched");
    await scrimmageRow(page, 'Smoke Scrim Renamed').waitFor();
    assert.doesNotMatch(await scrimmageRow(page, 'Smoke Scrim Renamed').textContent(), /matches/, 'row shows no matches again');

    // The teammate who had an entry open: disconnected cleanly, and (they had the
    // scrimmage open) their season follows.
    await memPage.waitForFunction(() => /Entry Deleted/.test(document.getElementById('generic-confirm-title')?.textContent || '')
      && !document.getElementById('generic-confirm-modal').classList.contains('hidden'));
    assert.match(await memPage.textContent('#generic-confirm-message'), /This entry was deleted by another editor while you had it open\. Your changes were not saved\./);
    assert.ok(!(await memPage.isVisible('#pit-modal')), "the teammate's pit form was closed");
    await memPage.click('#btn-generic-confirm-proceed');
    await memPage.waitForFunction(() => selectedEvent && selectedEvent.season === '2025');
    assert.equal(await memPage.inputValue('#select-season'), '2025', "the teammate's season dropdown followed");
    assert.equal(await memPage.inputValue('#input-event-search'), '', 'and their stale search was cleared');

    // ---------- the scrimmage now has NO entries; re-scout under the NEW season ----------
    await openScrimmageUI(page, 'Smoke Scrim Renamed', { goTo: null });
    assert.equal(await page.inputValue('#select-season'), '2025', 'opening it switches the app to its new season');
    await openScoutingSubtab(page, 'pit');
    await (await teamRow(page, '#team-list-pit', 4242)).locator('.btn-pit-quick-scout').click();
    await page.waitForSelector('#pit-modal:not(.hidden) #pit-dynamic-fields .pit-field');
    assert.equal(await page.locator('#pit-modal #dyn-drivetrainType').count(), 1, "new entries use the new season's (2025) fields");
    assert.equal(await page.locator('#pit-modal #dyn-driveType').count(), 0);
    await page.waitForFunction(() => typeof currentPitLiveSession !== 'undefined' && currentPitLiveSession && currentPitLiveSession.isJoined());
    await fillRequiredFields(page, '#pit-modal', 'post-change pit note');
    await page.click('#btn-pit-save');
    await page.waitForSelector('#pit-modal', { state: 'hidden' });
    await openScoutingSubtab(page, 'match');
    await (await teamRow(page, '#team-list-match', 4242)).getByRole('button', { name: '+ Match Scout' }).click();
    await page.waitForSelector('#match-modal:not(.hidden) #match-dynamic-fields .pit-field');
    await page.fill('#match-modal #dyn-matchNumber', '3');
    await fillRequiredFields(page, '#match-modal', 'post-change match note');
    await page.click('#btn-match-save');
    await page.waitForSelector('#match-modal', { state: 'hidden' });
    await page.waitForFunction(() => currentScrimmage && currentScrimmage.matchCount === 3);

    // name/date-only edit on a scrimmage that HAS entries: no prompt.
    await openScrimmagesTab(page);
    await scrimmageRow(page, 'Smoke Scrim Renamed').locator('.btn-scrimmage-manage').click();
    await page.waitForSelector('#scrimmage-form-modal:not(.hidden)');
    await page.fill('#input-scrimmage-name', 'Smoke Scrim Final');
    await page.fill('#input-scrimmage-date', '2026-12-05');
    await page.click('#btn-scrimmage-form-save');
    await page.waitForSelector('#scrimmage-form-modal', { state: 'hidden' });
    assert.ok(!(await page.isVisible('#generic-confirm-modal')), 'name/date-only edits never prompt');
    await page.waitForFunction(() => selectedEvent && selectedEvent.name === 'Smoke Scrim Final');
    assert.deepEqual(await countEntries(page, teamId, code), { pit: 1, match: 1 }, 'entries untouched by a name/date edit');
    assert.equal((await readScrimmage(page, teamId, scrimmageId)).matchCount, 3, 'matchCount untouched by a name/date edit');

    // ---------- removing a roster team: with entries -> listed, then deleted, then the team ----------
    await openScoutingSubtab(page, 'info');
    await page.locator('#team-list-info .team-item[data-team-number="4242"] .btn-scrimmage-team-remove').click();
    await page.waitForSelector('#generic-confirm-modal:not(.hidden)');
    assert.match(await page.textContent('#generic-confirm-title'), /Remove Team and Delete Its Entries\?/);
    const confirmText = await page.textContent('#generic-confirm-message');
    assert.match(confirmText, /1 pit entry/);
    assert.match(confirmText, /1 match entry \(Match 3\)/, 'lists the match entries by match number');
    assert.match(confirmText, /permanently deletes/);
    await page.click('#btn-generic-confirm-cancel');
    assert.equal(await page.locator('#team-list-info .team-item[data-team-number="4242"]').count(), 1, 'cancel changes nothing');
    assert.deepEqual(await countEntries(page, teamId, code), { pit: 1, match: 1 });
    await page.locator('#team-list-info .team-item[data-team-number="4242"] .btn-scrimmage-team-remove').click();
    await page.waitForSelector('#generic-confirm-modal:not(.hidden)');
    await page.click('#btn-generic-confirm-proceed');
    await page.waitForFunction(() => !document.querySelector('#team-list-info .team-item[data-team-number="4242"]'));
    assert.deepEqual(await countEntries(page, teamId, code), { pit: 0, match: 0 }, 'the entries went with the team');
    await memPage.waitForFunction(() => !document.querySelector('#team-list-info .team-item[data-team-number="4242"]'));
    // (report-only: removing a team's entries this way does NOT touch matchCount — it stays at 3.)
    assert.equal((await readScrimmage(page, teamId, scrimmageId)).matchCount, 3);

    // a team with NO entries: the plain confirm, as before
    await page.locator('#team-list-info .team-item[data-team-number="999"] .btn-scrimmage-team-remove').click();
    await page.waitForSelector('#generic-confirm-modal:not(.hidden)');
    assert.match(await page.textContent('#generic-confirm-title'), /^Remove Team$/);
    assert.match(await page.textContent('#generic-confirm-message'), /Remove Team #999/);
    await page.click('#btn-generic-confirm-proceed');
    await page.waitForFunction(() => !document.querySelector('#team-list-info .team-item[data-team-number="999"]'));

    // ---------- season change on the OPEN scrimmage with NO entries: no prompt; everything follows ----------
    await openScrimmagesTab(page);
    await scrimmageRow(page, 'Smoke Scrim Final').locator('.btn-scrimmage-manage').click();
    await page.waitForSelector('#scrimmage-form-modal:not(.hidden)');
    await page.selectOption('#select-scrimmage-season', currentSeason);
    await page.click('#btn-scrimmage-form-save');
    await page.waitForSelector('#scrimmage-form-modal', { state: 'hidden' });
    assert.ok(!(await page.isVisible('#generic-confirm-modal')), 'no entries -> no prompt');
    await page.waitForFunction((s) => selectedEvent && selectedEvent.season === s, currentSeason);
    assert.equal(await page.inputValue('#select-season'), currentSeason, 'the season dropdown followed (quietly — the scrimmage stayed open)');
    assert.equal(await page.evaluate(() => selectedEvent && selectedEvent.name), 'Smoke Scrim Final');
    assert.equal(await page.inputValue('#input-event-search'), '', 'search cleared');
    const sessionState = await page.evaluate(() => JSON.parse(sessionStorage.getItem('fe2o3_session_state')).perTeam[currentTeamData.id]);
    assert.equal(sessionState.season, currentSeason, 'session state follows');
    assert.equal(sessionState.selectedEvent.season, currentSeason);
    assert.equal((await readScrimmage(page, teamId, scrimmageId)).matchCount, 0, 'a no-entries season change also zeroes the stale matchCount');
    assert.equal((await readScrimmage(page, teamId, scrimmageId)).season, currentSeason);

    // ---------- direct check: performSeasonChange closes MY open form on the scrimmage ----------
    await openScoutingSubtab(page, 'pit');
    await (await teamRow(page, '#team-list-pit', 777)).locator('.btn-pit-quick-scout').click();
    await page.waitForSelector('#pit-modal:not(.hidden) #pit-dynamic-fields .pit-field');
    await page.waitForFunction(() => typeof currentPitLiveSession !== 'undefined' && currentPitLiveSession && currentPitLiveSession.isJoined());
    await page.evaluate((sid) => performSeasonChange({ scrim: scrimmageDataFor(sid), fields: { name: 'Smoke Scrim Final', date: '2026-12-05', season: '2025' } }), scrimmageId);
    await page.waitForSelector('#pit-modal', { state: 'hidden' });
    assert.deepEqual(await countEntries(page, teamId, code), { pit: 0, match: 0 }, 'my own open draft was removed with the rest');

    // ---------- whole-team export leaves scrimmage data out ----------
    const wholeTeam = await page.evaluate(async (tid) => (await gatherFullTeamExportData(tid)).eventCodes, teamId);
    assert.deepEqual(wholeTeam.filter(c => c.startsWith('SCRIM-')), [], 'no scrimmage in the whole-team export');

    // ---------- nothing above fetched a roster/schedule for the scrimmage ----------
    assert.deepEqual(ctx.state.workerRequests.slice(workerBefore).filter(p => p.startsWith('/teams') || p.startsWith('/schedule')), [],
      'no worker teams/schedule requests for a scrimmage');
    assert.deepEqual(ctx.state.ftcScoutRequests.slice(ftcBefore), [], 'no FTCScout requests for a scrimmage');

    // ---------- delete cascade from the row ----------
    await openScoutingSubtab(page, 'pit');
    await addAndScoutUI(page, 'pit', { number: 321, name: 'Cascade Team' });
    await page.waitForSelector('#pit-modal:not(.hidden) #pit-dynamic-fields .pit-field');
    await page.waitForFunction(() => typeof currentPitLiveSession !== 'undefined' && currentPitLiveSession && currentPitLiveSession.isJoined());
    await fillRequiredFields(page, '#pit-modal', 'something to cascade');
    await page.click('#btn-pit-save');
    await page.waitForSelector('#pit-modal', { state: 'hidden' });
    const left = await countEntries(page, teamId, code);
    const teamsLeft = await page.evaluate(() => Object.keys(currentScrimmage.teams).length);
    assert.equal(left.pit, 1);
    await openScrimmagesTab(page);
    await scrimmageRow(page, 'Smoke Scrim Final').locator('.btn-scrimmage-delete').click();
    await page.waitForSelector('#generic-confirm-modal:not(.hidden)');
    assert.match(await page.textContent('#generic-confirm-message'), new RegExp(`${teamsLeft} teams / ${left.pit} pit / ${left.match} match entries`));
    await page.click('#btn-generic-confirm-proceed');
    await scrimmageRow(page, 'Smoke Scrim Final').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => selectedEvent), null, 'selection cleared');
    assert.deepEqual(await countEntries(page, teamId, code), { pit: 0, match: 0 }, 'every entry deleted');

    // The member (who had it open) is told, and their selection is cleared.
    await memPage.waitForFunction(() => /Scrimmage Deleted/.test(document.getElementById('generic-confirm-title')?.textContent || '')
      && !document.getElementById('generic-confirm-modal').classList.contains('hidden'));
    assert.equal(await memPage.evaluate(() => selectedEvent), null);

    // The other scrimmage is untouched.
    await scrimmageRow(page, 'Bystander Scrim').waitFor();
  }
};
