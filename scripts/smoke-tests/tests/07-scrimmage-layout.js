// Layout at phone/tablet/desktop widths for everything the scrimmage work adds:
// the six-tab Scouting subtab bar (it has had overflow bugs before — see the
// long comment in css/style.css), the Scrimmages list rows (Manage/Delete), the
// banner, the Add & scout / Add Team to Roster buttons and their help lines, the
// Add Team and Manage modals, and the Pinned tab's season dropdown and rows —
// plus (phase 3) the Edit modal in all four states with its merge choice and lock
// note, the lookup popup's Look up button under the number box, and the merge
// COMPARE screen with many fields and long values (also on a 320x480 screen), the lookup popup's
// RESULTS list (5 rows: a long name, a greyed roster team, the selected row) at every width and on a
// 320x480 screen (only the middle scrolls; Cancel / Use This Team stay), and the My Account DATA
// card's refresh button in each of its states.

const assert = require('node:assert/strict');
const {
  signInUI, createTeamUI, openScoutingSubtab, createScrimmageUI, openScrimmageUI, openScrimmagesTab, selectFixtureEvent, scrimmageRow, teamRow
} = require('../lib/app');

const WIDTHS = [320, 375, 414, 600, 700, 768, 820, 900, 1024, 1280];
const SUBTABS = ['info', 'pit', 'match', 'pinned', 'scrimmages', 'compare'];
// Viewport width at which css/style.css switches #scouting-subtabs to its
// edge-to-edge layout (the @media (min-width) rule) — keep in sync with it.
const WIDE_MODE_FROM = 800;

module.exports = {
  name: 'scrimmage layout: subtab bar, rows, banner, add buttons, modals and Pinned tab fit from 320px to 1280px',
  async run(ctx) {
    const user = await ctx.makeUser('Layout Scout');
    const page = await ctx.newPage('layout');
    await signInUI(page, user);
    await createTeamUI(page, 'Layout Smoke Team');
    // A pin first (the Pinned tab needs something to lay out), while a real event is selectable.
    await selectFixtureEvent(page);
    await page.click('#btn-pin-event');
    await page.waitForFunction(() => (currentTeamData.pinnedEvents || []).length === 1);
    const longName = 'A Rather Long Scrimmage Name To Stress The Row Layout';
    await createScrimmageUI(page, { name: longName, date: '2026-11-15' });
    await openScrimmageUI(page, longName);

    // Seven teams with entries, so the season-change confirm shows its 5 lines + "and 2 more teams".
    await page.evaluate(async () => {
      const base = db.collection('teams').doc(currentTeamData.id).collection('pitScouting');
      for (let n = 101; n <= 107; n++) {
        await base.doc(`layout_${n}`).set({
          eventCode: selectedEvent.code, scrimmageId: selectedEvent.scrimmageId, teamNumber: n,
          teamId: currentTeamData.id, season: selectedEvent.season, scoutedBy: currentUser.uid, checkpoint: { notes: 'x' }
        });
      }
    });

    // Phase 2: two roster teams with LONG names — #101 unlinked (typed name differs
    // from FTCScout's "Alpha Bots") and
    // #102 linked — so the badges, bulk button and link UI are laid out at every width.
    const LONG_TYPED = 'Alpha With An Absurdly Long Typed Team Name That Has To Wrap Somewhere Sensible';
    await page.evaluate(async ([typed]) => {
      const ref = db.collection('teams').doc(currentTeamData.id).collection('scrimmages').doc(selectedEvent.scrimmageId);
      await ref.update({
        'teams.101': { number: 101, name: typed, manualName: typed, linked: false, location: '', opr: null, linkedAt: null },
        'teams.102': { number: 102, name: 'An Equally Long Official FTCScout Team Name For The Linked Row', manualName: '', linked: true, location: 'Somewhere Far Away, Some State, Some Country', opr: 123.4, linkedAt: new Date() }
      });
    }, [LONG_TYPED]);
    await page.waitForFunction(() => currentScrimmage.teams['101'] && currentScrimmage.teams['102']);

    const problems = [];
    const noPageOverflow = async (label) => {
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      if (m.sw > m.iw + 1) problems.push(`${label}: page scrolls horizontally (${m.sw} > ${m.iw})`);
    };
    const insideViewport = async (selector, label) => {
      const r = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { left: b.left, right: b.right, iw: window.innerWidth };
      }, selector);
      if (r && (r.left < -1 || r.right > r.iw + 1)) problems.push(`${label}: ${selector} sticks out (${Math.round(r.left)}..${Math.round(r.right)} of ${r.iw})`);
    };

    // ---- phase 3: seed the merge Compare screen's worst case ----
    // #101 (unlinked, long typed name) will merge into #103 (linked): BOTH have a pit entry and
    // matches 1 and 2, with long values, a "deleted field" with a long key, and an unbroken
    // token — the worst case for wrapping.
    const LONG_NOTE = 'This is a very long scouting note that keeps going and going so the compare columns have to wrap it. '.repeat(3)
      + ' Unbrokentokenwithnospacesatalltotestwrappingbehaviourinsidethecomparecolumns1234567890abcdefghijklmnopqrstuvwxyz';
    const LONG_KEY = 'aVeryLongDeletedFieldNameThatHasNoSpacesAnywhereInItAtAll';
    await page.evaluate(async ([note, key]) => {
      const tid = currentTeamData.id, c = selectedEvent.code, sid = selectedEvent.scrimmageId, season = selectedEvent.season;
      await db.collection('teams').doc(tid).collection('scrimmages').doc(sid).update({
        'teams.103': { number: 103, name: 'Official Three With A Fairly Long Official Name', manualName: '', linked: true, location: 'Somewhere, Some State, Some Country', opr: 50.5, linkedAt: new Date() },
        'teams.3650': { number: 3650, name: 'Thirty Six Fifty', manualName: '', linked: true, location: 'Tulsa, OK, USA', opr: 40.5, linkedAt: new Date() }
      });
      const pitA = { driveType: 'Tank (2-motor, left/right)', autoCapability: 'Advanced (multi-cycle auto)', claimedAvgAutoScore: 12, claimedAvgTeleopScore: 34, claimedCycleTime: 5, notes: note };
      const pitB = { driveType: 'Swerve', autoCapability: 'Intermediate (scoring + park)', claimedAvgAutoScore: 15, claimedAvgTeleopScore: 30, claimedCycleTime: 5, notes: note + ' (B)' };
      const meta = (n, by) => ({ eventCode: c, scrimmageId: sid, teamNumber: n, teamId: tid, season, scoutedBy: by, scoutedByName: 'A Scout With A Rather Long Display Name ' + by, scoutedAt: new Date(1700000000000), lastEditedBy: 'x', lastEditedByName: 'Another Quite Long Editor Name', activeEditors: {} });
      // (scoutedBy is immutable once set, so the existing docs are replaced: delete, then create)
      for (const n of [101, 103]) await db.collection('teams').doc(tid).collection('pitScouting').doc('layout_' + n).delete();
      await db.collection('teams').doc(tid).collection('pitScouting').doc('layout_101').set({ ...meta(101, 'u1'), ...pitA, [key]: 'only the A entry has this deleted-field value ' + note, checkpoint: pitA });
      await db.collection('teams').doc(tid).collection('pitScouting').doc('layout_103').set({ ...meta(103, 'u2'), ...pitB, checkpoint: pitB });
      for (const m of [1, 2]) {
        const a = { autoScore: 10 * m, teleopScore: 50, endgameScore: 5, cycleTime: 9, notes: note };
        const b = { autoScore: 11 * m, teleopScore: 50, endgameScore: 7, cycleTime: 9, notes: note + ' (B)' };
        await db.collection('teams').doc(tid).collection('matchScouting').doc('layout_m_101_' + m).set({ ...meta(101, 'u1'), matchNumber: m, ...a, checkpoint: a });
        await db.collection('teams').doc(tid).collection('matchScouting').doc('layout_m_103_' + m).set({ ...meta(103, 'u2'), matchNumber: m, ...b, checkpoint: b });
      }
    }, [LONG_NOTE, LONG_KEY]);
    await page.waitForFunction(() => currentScrimmage.teams['103'] && currentScrimmage.teams['3650']);
    // Opens Edit #101, types the roster number 103 and Saves -> the merge choice shows.
    const openMergeChoice = async () => {
      await openScoutingSubtab(page, 'info');
      await (await teamRow(page, '#team-list-info', 101)).locator('.btn-scrimmage-team-edit').click();
      await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
      await page.waitForFunction(() => !document.getElementById('input-scrimmage-team-number').disabled);
      await page.fill('#input-scrimmage-team-number', '103');
      await page.click('#btn-scrimmage-team-save');
      await page.waitForSelector('#scrimmage-team-merge-choice:not(.hidden)');
    };
    // The Compare screen: card on screen, buttons reachable (at the top AND after scrolling the
    // list), nothing sticking out, A/B stacked on a narrow screen and side by side on a wide one.
    const checkCompare = async (L, label) => {
      await page.waitForSelector('#scrimmage-merge-modal:not(.hidden)');
      await insideViewport('#scrimmage-merge-modal .modal-card', L(label + ': card'));
      for (const sel of ['#btn-merge-compare-confirm', '#btn-merge-compare-cancel', '#btn-merge-compare-close']) {
        await insideViewport(sel, L(label + ': ' + sel));
        if (!(await page.isVisible(sel))) problems.push(L(label + ': ' + sel + ' is not visible'));
      }
      const box = await page.evaluate(() => {
        const list = document.getElementById('merge-compare-list');
        const card = document.querySelector('#scrimmage-merge-modal .modal-card');
        const confirm = document.getElementById('btn-merge-compare-confirm').getBoundingClientRect();
        const over = [...list.querySelectorAll('*')].filter(e => e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === 'visible')
          .slice(0, 3).map(e => e.className + ':' + (e.scrollWidth - e.clientWidth));
        const sides = [...list.querySelectorAll('.merge-sides')].map(s => [...s.children].map(c => Math.round(c.getBoundingClientRect().top)));
        return {
          scrolls: list.scrollHeight > list.clientHeight + 1, listH: list.clientHeight, ih: window.innerHeight,
          listX: list.scrollWidth - list.clientWidth, cardX: card.scrollWidth - card.clientWidth,
          cardTop: card.getBoundingClientRect().top, cardBottom: card.getBoundingClientRect().bottom, confirmBottom: confirm.bottom, confirmTop: confirm.top,
          z: getComputedStyle(document.getElementById('scrimmage-merge-modal')).zIndex, over, sides, iw: window.innerWidth,
          conflicts: list.querySelectorAll('.merge-conflict').length
        };
      });
      if (box.conflicts !== 3) problems.push(L(label + ': expected 3 conflicts (pit, match 1, match 2), got ' + box.conflicts));
      if (!box.scrolls) problems.push(L(label + ': a long compare list should scroll inside the card'));
      if (box.listH > box.ih * 0.55 + 2) problems.push(L(label + ': list is not capped (' + box.listH + 'px of ' + box.ih + ')'));
      if (box.listX > 1 || box.cardX > 1) problems.push(L(label + ': overflows horizontally ' + JSON.stringify(box)));
      if (box.over.length) problems.push(L(label + ': text sticks out of its box ' + JSON.stringify(box.over)));
      if (box.cardBottom > box.ih + 1 || box.cardTop < -1 || box.confirmBottom > box.ih || box.confirmTop < 0) problems.push(L(label + ': card/buttons off screen ' + JSON.stringify(box)));
      if (box.z !== '1002') problems.push(L(label + ': z-index ' + box.z));
      const stacked = box.sides.every(s => s[0] !== s[1]);
      const sideBySide = box.sides.every(s => s[0] === s[1]);
      if (box.iw <= 520 && !stacked) problems.push(L(label + ': A and B should stack on a narrow screen ' + JSON.stringify(box.sides)));
      if (box.iw >= 600 && !sideBySide) problems.push(L(label + ': A and B should sit side by side on a wide screen ' + JSON.stringify(box.sides)));
      for (const where of ['top', 'bottom']) {
        await page.evaluate((w) => { const l = document.getElementById('merge-compare-list'); l.scrollTop = w === 'bottom' ? l.scrollHeight : 0; }, where);
        await insideViewport('#merge-compare-list .merge-conflict:last-child .merge-opt', L(label + ': last option (' + where + ')'));
        await insideViewport('#btn-merge-compare-confirm', L(label + ': Merge button after scrolling to the ' + where));
      }
      await noPageOverflow(L(label + ' open'));
    };
    // The lookup popup's RESULTS list for "36": #36, #365, #3650 (on the roster: greyed), #36012 (a very
    // long name + location), #36533. Rows fit, nothing sticks out, the buttons stay on screen (only the
    // middle scrolls), and a picked row shows the confirm button.
    const checkResultsPopup = async (L, label) => {
      await page.fill('#input-ftc-lookup-number', '36');
      await page.click('#btn-ftc-lookup-go');
      await page.waitForFunction(() => document.querySelectorAll('#ftc-lookup-results .ftc-result-row').length === 5);
      await insideViewport('#ftc-lookup-modal .modal-card', L(label + ': card'));
      const m = await page.evaluate(() => {
        const card = document.querySelector('#ftc-lookup-modal .modal-card');
        const rows = [...document.querySelectorAll('#ftc-lookup-results .ftc-result-row')];
        const scroll = document.querySelector('.ftc-lookup-scroll');
        const actions = document.querySelector('#ftc-lookup-modal .pit-modal-actions').getBoundingClientRect();
        return {
          rowX: Math.max(...rows.map(r => r.scrollWidth - r.clientWidth)), scrollX: scroll.scrollWidth - scroll.clientWidth, cardX: card.scrollWidth - card.clientWidth,
          cardTop: card.getBoundingClientRect().top, cardBottom: card.getBoundingClientRect().bottom, ih: window.innerHeight, actionsTop: actions.top, actionsBottom: actions.bottom,
          roster: rows.filter(r => r.classList.contains('is-roster')).map(r => r.dataset.number)
        };
      });
      if (m.rowX > 1 || m.scrollX > 1 || m.cardX > 1) problems.push(L(label + ': overflows horizontally ' + JSON.stringify(m)));
      if (m.cardBottom > m.ih + 1 || m.cardTop < -1 || m.actionsBottom > m.ih || m.actionsTop < 0) problems.push(L(label + ': card/buttons off screen ' + JSON.stringify(m)));
      if (m.roster.join() !== '3650') problems.push(L(label + ': only #3650 should be greyed, got ' + m.roster));
      for (const where of ['top', 'bottom']) {
        await page.evaluate((w) => { const s = document.querySelector('.ftc-lookup-scroll'); s.scrollTop = w === 'bottom' ? s.scrollHeight : 0; }, where);
        for (const n of [36, 36012, 36533]) await insideViewport('#ftc-lookup-results .ftc-result-row[data-number="' + n + '"]', L(label + ': row #' + n + ' (' + where + ')'));
        await insideViewport('#btn-ftc-lookup-cancel', L(label + ': Cancel (' + where + ')'));
      }
      await page.click('#ftc-lookup-results .ftc-result-row[data-number="36012"]');
      if (!(await page.isVisible('#btn-ftc-lookup-confirm'))) problems.push(L(label + ': the confirm button should show once a row is picked'));
      await insideViewport('#btn-ftc-lookup-confirm', L(label + ': Use This Team'));
      await insideViewport('#btn-ftc-lookup-cancel', L(label + ': Cancel after picking'));
      await noPageOverflow(L(label + ' open'));
    };
    // The My Account DATA card: the refresh button in each state (idle / refreshing / cooldown).
    const checkDataCard = async (L) => {
      await page.evaluate(() => { document.querySelector('#dashboard-tabs .tab[data-dtab="myteam"]'); document.getElementById('btn-open-my-account-from-dashboard').click(); });
      await page.waitForSelector('#btn-refresh-cached-data', { state: 'visible' });
      for (const [state, text] of [['idle', 'Refresh cached data'], ['refreshing', 'Refreshing...'], ['cooldown', 'Available again in 15 min']]) {
        await page.evaluate(([st]) => {
          const btn = document.getElementById('btn-refresh-cached-data');
          if (st === 'idle') { dataRefreshBusy = false; localStorage.removeItem(DATA_REFRESH_STORAGE_KEY); }
          if (st === 'refreshing') { dataRefreshBusy = true; }
          if (st === 'cooldown') { dataRefreshBusy = false; localStorage.setItem(DATA_REFRESH_STORAGE_KEY, String(Date.now())); }
          renderDataRefreshControl();
        }, [state]);
        if ((await page.textContent('#btn-refresh-cached-data')).trim() !== text) problems.push(L('DATA card (' + state + '): button reads "' + (await page.textContent('#btn-refresh-cached-data')).trim() + '", expected "' + text + '"'));
        await insideViewport('#btn-refresh-cached-data', L('DATA card (' + state + '): button'));
        await insideViewport('#refresh-data-help', L('DATA card (' + state + '): help line'));
        const x = await page.evaluate(() => { const b = document.getElementById('btn-refresh-cached-data'); return b.scrollWidth - b.clientWidth; });
        if (x > 1) problems.push(L('DATA card (' + state + '): the button text overflows by ' + x));
      }
      await page.evaluate(() => { dataRefreshBusy = false; localStorage.removeItem(DATA_REFRESH_STORAGE_KEY); renderDataRefreshControl(); });
      await noPageOverflow(L('My Account page'));
      await page.click('#btn-my-account-standalone-back').catch(() => {});
      await page.click('#dashboard-tabs .tab[data-dtab="scouting"]');
    };

    // Cancel -> "Discard changes?" (must layer ABOVE the Compare screen) -> Discard -> close the Edit modal.
    const discardCompare = async (L) => {
      await page.click('#btn-merge-compare-cancel');
      await page.waitForSelector('#generic-confirm-modal:not(.hidden)');
      await insideViewport('#generic-confirm-modal .modal-card', L('discard confirm'));
      const zz = await page.evaluate(() => [document.getElementById('scrimmage-merge-modal'), document.getElementById('generic-confirm-modal')].map(e => Number(getComputedStyle(e).zIndex)));
      if (!(zz[1] > zz[0])) problems.push(L('the Discard confirm must layer above the Compare screen ' + zz));
      await page.click('#btn-generic-confirm-proceed');
      await page.waitForSelector('#scrimmage-merge-modal', { state: 'hidden' });
      await page.click('#btn-scrimmage-team-cancel');
      await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });
    };

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      // .tab has `transition: all 0.2s`, so right after a resize the tabs are
      // still mid-animation — let them settle before measuring any geometry.
      await page.waitForTimeout(400);
      await openScoutingSubtab(page, 'info');
      const L = (s) => `${width}px ${s}`;

      // --- the subtab bar ---
      const bar = await page.evaluate(() => {
        const el = document.getElementById('scouting-subtabs');
        const tabs = [...el.querySelectorAll('.tab')].map(t => { const b = t.getBoundingClientRect(); return { l: b.left, r: b.right }; });
        const b = el.getBoundingClientRect();
        return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, left: b.left, right: b.right, tabs, overflowX: getComputedStyle(el).overflowX };
      });
      // (overflow-x:visible computes to auto next to overflow-y:hidden, so the
      // computed style can't tell the modes apart — check the geometry instead.)
      const fits = bar.scrollWidth <= bar.clientWidth + 1;
      if (width >= WIDE_MODE_FROM) {
        // Wide layout (see the @media rule in css/style.css): all six tabs must
        // fit with no scrolling AND fill the bar edge to edge.
        const lastRight = Math.max(...bar.tabs.map(t => t.r));
        if (!fits) problems.push(L(`subtab bar should fit all tabs but scrolls (scrollWidth ${bar.scrollWidth} > clientWidth ${bar.clientWidth}) — breakpoint in style.css needs re-measuring`));
        if (fits && lastRight < bar.right - 2) problems.push(L(`subtab tabs don't fill the bar (last tab ends at ${Math.round(lastRight)}, bar at ${Math.round(bar.right)})`));
      }
      // Either mode: every tab must be reachable and become active when clicked.
      for (const tab of SUBTABS) {
        await page.click(`#scouting-subtabs .tab[data-subtab="${tab}"]`);
        const active = await page.evaluate((t) => document.querySelector(`#scouting-subtabs .tab[data-subtab="${t}"]`).classList.contains('active'), tab);
        if (!active) problems.push(L(`tab "${tab}" did not activate when clicked`));
      }
      await noPageOverflow(L('Scrimmages subtab'));

      // --- Scrimmages list row ---
      await openScoutingSubtab(page, 'scrimmages');
      await insideViewport('#scrimmage-list .scrimmage-item', L('row'));
      for (const sel of ['.btn-scrimmage-manage', '.btn-scrimmage-delete']) {
        await insideViewport(`#scrimmage-list .scrimmage-item ${sel}`, L('row button'));
      }
      await noPageOverflow(L('Scrimmages list'));

      // --- banner + strips on Info / Pit / Match ---
      for (const tab of ['info', 'pit', 'match', 'compare']) {
        await openScoutingSubtab(page, tab);
        await insideViewport(`#subtab-${tab} [data-scrimmage-banner]`, L(`${tab} banner`));
        await noPageOverflow(L(`${tab} tab`));
      }
      for (const [tab, btn] of [['pit', '#btn-scrimmage-add-scout-pit'], ['match', '#btn-scrimmage-add-scout-match'], ['info', '#btn-scrimmage-add-team']]) {
        await openScoutingSubtab(page, tab);
        await insideViewport(`#subtab-${tab} .scrimmage-add-block`, L(`${tab} add block`));
        await insideViewport(btn, L(`${tab} add button`));
        await insideViewport(`#subtab-${tab} .scrimmage-add-block .help-text`, L(`${tab} add help line`));
        if (!(await page.isVisible(btn))) problems.push(L(`${tab} add button is not visible`));
      }

      // --- phase 2: link badges in all four team lists + the bulk-link button ---
      for (const [tab, list] of [['info', '#team-list-info'], ['pit', '#team-list-pit'], ['match', '#team-list-match'], ['compare', '#team-list-compare']]) {
        await openScoutingSubtab(page, tab);
        await insideViewport(`${list} .team-item[data-team-number="101"]`, L(`${tab} long-named row`));
        await insideViewport(`${list} .team-item[data-team-number="101"] .team-link-badge`, L(`${tab} unlinked badge`));
        if (!(await page.isVisible(`${list} .team-item[data-team-number="101"] .team-link-badge`))) problems.push(L(`${tab} unlinked badge not visible`));
        const rowOverflow = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return el.scrollWidth - el.clientWidth;
        }, `${list} .team-item[data-team-number="101"]`);
        if (rowOverflow > 1) problems.push(L(`${tab} long-named row overflows by ${rowOverflow}px`));
        await noPageOverflow(L(`${tab} tab with badges`));
      }
      await openScoutingSubtab(page, 'info');
      await insideViewport('#team-list-info .team-item[data-team-number="102"] .team-link-badge', L('linked badge'));
      for (const sel of ['#btn-scrimmage-bulk-link', '#scrimmage-bulk-link-help']) {
        await insideViewport(sel, L(sel));
        if (!(await page.isVisible(sel))) problems.push(L(`${sel} not visible`));
      }
      if (!/^Bulk link teams \(1\)$/.test((await page.textContent('#btn-scrimmage-bulk-link')).trim())) problems.push(L('bulk button should read "Bulk link teams (1)"'));
      await noPageOverflow(L('Info tab with the bulk button'));

      // --- phase 2: the "N scrimmage entries not included" line on My Team ---
      await page.click('#dashboard-tabs .tab[data-dtab="myteam"]');
      await page.evaluate(() => { document.getElementById('myteam-export-scrimmage-note').textContent = '123 scrimmage entries not included'; });
      await insideViewport('#myteam-export-scrimmage-note', L('my team export note'));
      await insideViewport('#btn-myteam-export', L('my team export button'));
      await noPageOverflow(L('My Team tab'));
      await page.evaluate(() => { document.getElementById('myteam-export-scrimmage-note').textContent = ''; });
      await page.click('#dashboard-tabs .tab[data-dtab="scouting"]');
      await openScoutingSubtab(page, 'info');

      // --- phase 2: the whole-team export choice with "Include scrimmages" ---
      await page.evaluate(() => openExportChoiceModal({
        title: 'Export Whole Team Data', statusPrefix: 'layout-export', includeScrimmagesOption: { count: 123 }, excelHandler() {}, sheetsHandler() {}
      }));
      await page.waitForSelector('#export-choice-modal:not(.hidden)');
      await insideViewport('#export-choice-modal .modal-card', L('export choice card'));
      for (const sel of ['#chk-export-include-scrimmages', '#export-choice-scrimmage-note', '#btn-export-choice-excel', '#btn-export-choice-sheets']) {
        await insideViewport(sel, L(`export choice ${sel}`));
        if (!(await page.isVisible(sel))) problems.push(L(`export choice ${sel} not visible`));
      }
      await page.check('#chk-export-include-scrimmages');
      await insideViewport('#export-choice-scrimmage-note', L('export choice note (included)'));
      await page.click('#btn-export-choice-close');
      await page.waitForSelector('#export-choice-modal', { state: 'hidden' });

      // --- phase 2: the BULK LINK REVIEW popup with many teams (the list scrolls, the buttons stay) ---
      await page.evaluate(() => {
        const long = (i) => `An Even Longer Official FTCScout Team Name Number ${i}`;
        const matches = Array.from({ length: 40 }, (_, i) => ({
          number: 1000 + i,
          typed: i % 3 === 0 ? '' : `A Rather Long Typed Team Name Number ${i}`,
          ftc: { name: long(i), location: 'Somewhere', opr: 100 + i, season: String(currentScrimmage.season) }
        }));
        const notFound = Array.from({ length: 12 }, (_, i) => ({ number: 2000 + i, typed: i % 2 ? '' : `Typed Name That Is Fairly Long Number ${i}` }));
        openBulkLinkReview({ scrimmageId: currentScrimmage.id, season: String(currentScrimmage.season), matches, notFound });
      });
      await page.waitForSelector('#bulk-link-modal:not(.hidden)');
      await insideViewport('#bulk-link-modal .modal-card', L('bulk review card'));
      for (const sel of ['#btn-bulk-link-confirm', '#btn-bulk-link-cancel', '#btn-bulk-link-close', '#btn-bulk-link-all', '#btn-bulk-link-none']) {
        await insideViewport(sel, L(`bulk review ${sel}`));
        if (!(await page.isVisible(sel))) problems.push(L(`bulk review ${sel} is not visible`));
      }
      const bulkBox = await page.evaluate(() => {
        const scroll = document.querySelector('#bulk-link-modal .bulk-link-scroll');
        const card = document.querySelector('#bulk-link-modal .modal-card');
        const confirm = document.getElementById('btn-bulk-link-confirm').getBoundingClientRect();
        return {
          scrolls: scroll.scrollHeight > scroll.clientHeight + 1, listH: scroll.clientHeight, ih: window.innerHeight,
          scrollX: scroll.scrollWidth - scroll.clientWidth, cardX: card.scrollWidth - card.clientWidth,
          cardBottom: card.getBoundingClientRect().bottom, confirmBottom: confirm.bottom,
          z: getComputedStyle(document.getElementById('bulk-link-modal')).zIndex, label: document.getElementById('btn-bulk-link-confirm').textContent.trim()
        };
      });
      if (!bulkBox.scrolls) problems.push(L('bulk review: 52 rows should make the list scroll'));
      if (bulkBox.listH > bulkBox.ih * 0.5 + 2) problems.push(L(`bulk review list is not capped (${bulkBox.listH}px of ${bulkBox.ih})`));
      if (bulkBox.scrollX > 1 || bulkBox.cardX > 1) problems.push(L(`bulk review overflows horizontally ${JSON.stringify(bulkBox)}`));
      if (bulkBox.cardBottom > bulkBox.ih + 1 || bulkBox.confirmBottom > bulkBox.ih) problems.push(L(`bulk review runs off the bottom (${JSON.stringify(bulkBox)})`));
      if (bulkBox.z !== '1001') problems.push(L(`bulk review z-index ${bulkBox.z}`));
      if (bulkBox.label !== 'Link 40 teams') problems.push(L(`bulk review confirm label "${bulkBox.label}"`));
      // Scrolled to the very bottom: the last not-found row is reachable and the buttons never moved.
      await page.evaluate(() => { const s = document.querySelector('#bulk-link-modal .bulk-link-scroll'); s.scrollTop = s.scrollHeight; });
      await insideViewport('#bulk-link-notfound .bulk-link-row:last-child', L('bulk review last row'));
      await insideViewport('#btn-bulk-link-confirm', L('bulk review confirm after scrolling'));
      await noPageOverflow(L('bulk review open'));
      await page.click('#btn-bulk-link-cancel');
      await page.waitForSelector('#bulk-link-modal', { state: 'hidden' });

      // --- Pinned tab: dropdown + rows ---
      await openScoutingSubtab(page, 'pinned');
      await insideViewport('.pinned-season-row', L('pinned season row'));
      await insideViewport('#select-pinned-season', L('pinned season select'));
      await insideViewport('#pinned-events-list .event-item', L('pinned row'));
      await insideViewport('#pinned-events-list .btn-unpin', L('pinned unpin button'));
      await noPageOverflow(L('Pinned tab'));

      // --- Add Team modal ---
      await openScoutingSubtab(page, 'info');
      await page.click('#btn-scrimmage-add-team');
      await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
      await insideViewport('#scrimmage-team-modal .modal-card', L('add-team modal'));
      await insideViewport('#btn-scrimmage-team-save', L('add-team save button'));
      // phase 2: the FTCScout step inside it, and the lookup modal (every state)
      for (const sel of ['#btn-scrimmage-team-lookup', '#scrimmage-team-ftc-help']) {
        await insideViewport(sel, L(`add-team ${sel}`));
        if (!(await page.isVisible(sel))) problems.push(L(`add-team ${sel} not visible`));
      }
      await page.fill('#input-scrimmage-team-number', '202');
      await page.click('#btn-scrimmage-team-lookup');
      await page.waitForSelector('#ftc-lookup-modal:not(.hidden)');
      await insideViewport('#ftc-lookup-modal .modal-card', L('lookup modal'));
      const under = await page.evaluate(() => {
        const n = document.getElementById('input-ftc-lookup-number').getBoundingClientRect();
        const g = document.getElementById('btn-ftc-lookup-go').getBoundingClientRect();
        return { gap: g.top - n.bottom, nLeft: n.left, nRight: n.right, gLeft: g.left, gRight: g.right };
      });
      if (under.gap < 0 || under.gap > 24 || Math.abs(under.gLeft - under.nLeft) > 2 || Math.abs(under.gRight - under.nRight) > 2) {
        problems.push(L('lookup popup: Look up must sit UNDER the number box, full width ' + JSON.stringify(under)));
      }
      for (const sel of ['#input-ftc-lookup-number', '#btn-ftc-lookup-go', '#btn-ftc-lookup-cancel']) {
        await insideViewport(sel, L(`lookup modal ${sel}`));
        if (!(await page.isVisible(sel))) problems.push(L(`lookup modal ${sel} not visible`));
      }
      await page.click('#btn-ftc-lookup-go');
      await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
      await page.evaluate(() => {
        // Long official text, so a real long team name can't push the card out.
        document.getElementById('ftc-lookup-result-name').textContent = 'An Equally Long Official FTCScout Team Name For The Linked Row Layout Check';
        document.getElementById('ftc-lookup-result-location').textContent = 'A Very Long City Name, A Long State Or Province Name, A Long Country Name';
      });
      for (const sel of ['#ftc-lookup-result', '#btn-ftc-lookup-confirm', '#btn-ftc-lookup-cancel']) {
        await insideViewport(sel, L(`lookup modal (found) ${sel}`));
        if (!(await page.isVisible(sel))) problems.push(L(`lookup modal (found) ${sel} not visible`));
      }
      const lookupBox = await page.evaluate(() => {
        const card = document.querySelector('#ftc-lookup-modal .modal-card');
        const result = document.getElementById('ftc-lookup-result');
        return { cardX: card.scrollWidth - card.clientWidth, resultX: result.scrollWidth - result.clientWidth, cardBottom: card.getBoundingClientRect().bottom, ih: window.innerHeight };
      });
      if (lookupBox.cardX > 1 || lookupBox.resultX > 1) problems.push(L(`lookup modal overflows horizontally ${JSON.stringify(lookupBox)}`));
      if (lookupBox.cardBottom > lookupBox.ih + 1) problems.push(L(`lookup modal runs off the bottom (${Math.round(lookupBox.cardBottom)} > ${lookupBox.ih})`));
      await checkResultsPopup(L, 'lookup results');
      await page.click('#btn-ftc-lookup-cancel');
      await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
      await page.click('#btn-scrimmage-team-cancel');
      await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });

      // --- phase 2: the Edit modal in EVERY state (A unlinked, B pending link, C linked, D pending unlink) ---
      // #101 is unlinked with a long typed name and committed entries (renumberable since phase 3: the
      // "entries move with it" hint shows); #102 is linked with a long official name (lock note; after
      // Unlink, the longest editing hint).
      const checkEditModal = async (label, selectors) => {
        await insideViewport('#scrimmage-team-modal .modal-card', L(`${label}: card`));
        for (const sel of selectors) {
          await insideViewport(sel, L(`${label}: ${sel}`));
          if (!(await page.isVisible(sel))) problems.push(L(`${label}: ${sel} is not visible`));
        }
        const box = await page.evaluate(() => {
          const card = document.querySelector('#scrimmage-team-modal .modal-card');
          const fit = (id) => { const el = document.getElementById(id); return el.scrollWidth - el.clientWidth; };
          return { cardX: card.scrollWidth - card.clientWidth, cardBottom: card.getBoundingClientRect().bottom, ih: window.innerHeight, helpX: fit('scrimmage-team-ftc-help'), hintX: fit('scrimmage-team-number-hint'), lockX: fit('scrimmage-team-lock-note'), mergeX: fit('scrimmage-team-merge-text') };
        });
        if (box.cardX > 1 || box.helpX > 1 || box.hintX > 1 || box.lockX > 1 || box.mergeX > 1) problems.push(L(`${label}: overflows horizontally ${JSON.stringify(box)}`));
        if (box.cardBottom > box.ih + 1) problems.push(L(`${label}: runs off the bottom (${Math.round(box.cardBottom)} > ${box.ih})`));
      };
      // A: unlinked, number blocked -> Link button, the long hint, both boxes
      await (await teamRow(page, '#team-list-info', 101)).locator('.btn-scrimmage-team-edit').click();
      await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
      await page.waitForFunction(() => /move with it/.test(document.getElementById('scrimmage-team-number-hint').textContent));
      await checkEditModal('edit A', ['#input-scrimmage-team-name', '#input-scrimmage-team-number', '#btn-scrimmage-team-lookup', '#scrimmage-team-ftc-help', '#scrimmage-team-number-hint', '#btn-scrimmage-team-save', '#btn-scrimmage-team-cancel']);
      // the longest hint there is: three people editing
      await page.evaluate(() => { document.getElementById('scrimmage-team-number-hint').textContent = scrimmageEditingMessage(['Alexandria Montgomery-Livingston', 'Bartholomew Featherstonehaugh', 'Christopher']); });
      await checkEditModal('edit A (editing hint)', ['#scrimmage-team-number-hint', '#btn-scrimmage-team-save']);
      // B: pick a team -> official name, locked number, "Unlink" button
      await page.click('#btn-scrimmage-team-lookup');
      await page.waitForSelector('#ftc-lookup-modal:not(.hidden)');
      await insideViewport('#ftc-lookup-modal .modal-card', L('edit lookup popup'));
      await page.click('#btn-ftc-lookup-go');
      await page.waitForSelector('#ftc-lookup-result:not(.hidden)');
      await page.click('#btn-ftc-lookup-confirm');
      await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
      if (await page.inputValue('#input-scrimmage-team-name') !== 'Alpha Bots') problems.push(L('edit B: the official name should fill the name box'));
      if (!/^Unlink$/.test((await page.textContent('#btn-scrimmage-team-unlink')).trim())) problems.push(L('edit B: the button should read "Unlink"'));
      await checkEditModal('edit B', ['#input-scrimmage-team-name', '#input-scrimmage-team-number', '#btn-scrimmage-team-unlink', '#scrimmage-team-lock-note', '#scrimmage-team-ftc-help', '#btn-scrimmage-team-save']);
      if (!/Press Unlink to change them/.test(await page.textContent('#scrimmage-team-lock-note'))) problems.push(L('edit B: the lock note (with "Press Unlink") is missing'));
      await page.click('#btn-scrimmage-team-cancel');
      await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });
      // C: linked -> both boxes locked, the lock line, "Unlink from FTCScout"
      await (await teamRow(page, '#team-list-info', 102)).locator('.btn-scrimmage-team-edit').click();
      await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
      await checkEditModal('edit C', ['#input-scrimmage-team-name', '#input-scrimmage-team-number', '#btn-scrimmage-team-unlink', '#scrimmage-team-lock-note', '#btn-scrimmage-team-save']);
      if (!/can't be edited while linked/.test(await page.textContent('#scrimmage-team-lock-note'))) problems.push(L('edit C: the lock note is missing'));
      // D: Unlink -> name unlocked, "Link to FTCScout", the longest hint (three editors named)
      await page.click('#btn-scrimmage-team-unlink');
      await page.waitForFunction(() => !document.getElementById('input-scrimmage-team-number').disabled);
      await page.evaluate(() => {
        const hint = document.getElementById('scrimmage-team-number-hint');
        hint.textContent = scrimmageEditingMessage(['Alexandria Montgomery-Livingston', 'Bartholomew Featherstonehaugh', 'Christopher']);
        hint.classList.remove('hidden');
      });
      await checkEditModal('edit D', ['#input-scrimmage-team-name', '#input-scrimmage-team-number', '#btn-scrimmage-team-lookup', '#scrimmage-team-ftc-help', '#scrimmage-team-number-hint', '#btn-scrimmage-team-save']);
      if (await page.isVisible('#scrimmage-team-lock-note')) problems.push(L('edit D: the lock note should be hidden while the boxes are editable'));
      await page.click('#btn-scrimmage-team-cancel');
      await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });

      // --- phase 3: the merge choice in the Edit modal, then the Compare screen ---
      await openMergeChoice();
      await checkEditModal('edit A (merge choice)', ['#scrimmage-team-number-hint', '#scrimmage-team-merge-text', '#btn-scrimmage-team-merge', '#btn-scrimmage-team-merge-change', '#btn-scrimmage-team-cancel']);
      if (!(await page.isDisabled('#btn-scrimmage-team-save'))) problems.push(L('merge choice: Save should be off while the choice shows'));
      await page.click('#btn-scrimmage-team-merge');
      await checkCompare(L, 'compare screen');
      await discardCompare(L);
      // the new OPR wording fits its row: "OPR: unlinked" (#101) and the linked team's number
      for (const [tab, list] of [['info', '#team-list-info'], ['pit', '#team-list-pit'], ['match', '#team-list-match']]) {
        await openScoutingSubtab(page, tab);
        await insideViewport(`${list} .team-item[data-team-number="101"] .team-opr-inline`, L(`${tab} OPR text`));
        const txt = (await page.textContent(`${list} .team-item[data-team-number="101"] .team-opr-inline`)).trim();
        if (txt !== 'OPR: unlinked') problems.push(L(`${tab}: #101 should read "OPR: unlinked", not "${txt}"`));
        if (!(await page.isVisible(`${list} .team-item[data-team-number="101"] .team-opr-inline`))) problems.push(L(`${tab}: OPR text not visible`));
      }
      await openScoutingSubtab(page, 'info');
      await page.click('#btn-scrimmage-add-team');
      await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
      await page.click('#btn-scrimmage-team-cancel');
      await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });

      // --- Manage modal (row button) ---
      await openScrimmagesTab(page);
      await scrimmageRow(page, 'A Rather Long Scrimmage Name').locator('.btn-scrimmage-manage').click();
      await page.waitForSelector('#scrimmage-form-modal:not(.hidden)');
      await insideViewport('#scrimmage-form-modal .modal-card', L('manage modal'));
      for (const sel of ['#select-scrimmage-season', '#btn-scrimmage-manage-add-team', '#btn-scrimmage-manage-delete', '#btn-scrimmage-form-save']) {
        await insideViewport(sel, L(`manage modal ${sel}`));
      }
      // --- the season-change confirm (3 actions, per-team lines) layered over Manage ---
      await page.selectOption('#select-scrimmage-season', '2025');
      await page.click('#btn-scrimmage-form-save');
      await page.waitForFunction(() => !document.getElementById('generic-confirm-modal').classList.contains('hidden')
        && /Change Season/.test(document.getElementById('generic-confirm-title').textContent));
      await insideViewport('#generic-confirm-modal .modal-card', L('season confirm card'));
      for (const sel of ['#btn-generic-confirm-proceed', '#btn-generic-confirm-secondary', '#btn-generic-confirm-cancel', '#btn-generic-confirm-close']) {
        await insideViewport(sel, L(`season confirm ${sel}`));
        if (!(await page.isVisible(sel))) problems.push(L(`season confirm ${sel} is not visible`));
      }
      const confirmOverflow = await page.evaluate(() => {
        const card = document.querySelector('#generic-confirm-modal .modal-card');
        const msg = document.getElementById('generic-confirm-message');
        return { cardX: card.scrollWidth - card.clientWidth, msgX: msg.scrollWidth - msg.clientWidth };
      });
      if (confirmOverflow.cardX > 1 || confirmOverflow.msgX > 1) problems.push(L(`season confirm text overflows horizontally (${JSON.stringify(confirmOverflow)})`));
      if (!/and 2 more teams/.test(await page.textContent('#generic-confirm-message'))) problems.push(L('season confirm should list 5 teams then "and 2 more teams"'));
      await page.click('#btn-generic-confirm-cancel');
      await page.waitForSelector('#generic-confirm-modal', { state: 'hidden' });
      await page.click('#btn-scrimmage-form-cancel');
      await page.waitForSelector('#scrimmage-form-modal', { state: 'hidden' });

      // --- My Account > DATA card ---
      await checkDataCard(L);
      await openScoutingSubtab(page, 'info');

      // --- New Scrimmage modal ---
      await openScrimmagesTab(page);
      await page.click('#btn-new-scrimmage');
      await page.waitForSelector('#scrimmage-form-modal:not(.hidden)');
      await insideViewport('#scrimmage-form-modal .modal-card', L('new-scrimmage modal'));
      await page.click('#btn-scrimmage-form-cancel');
      await page.waitForSelector('#scrimmage-form-modal', { state: 'hidden' });
    }

    // A SHORT viewport (a phone on its side, 320x480 here): the review popup's
    // buttons must still be on screen — only its list scrolls.
    await page.setViewportSize({ width: 320, height: 480 });
    await page.waitForTimeout(400);
    await openScoutingSubtab(page, 'info');
    await page.evaluate(() => {
      const matches = Array.from({ length: 40 }, (_, i) => ({ number: 1000 + i, typed: `A Rather Long Typed Team Name Number ${i}`, ftc: { name: `An Even Longer Official FTCScout Team Name Number ${i}`, location: '', opr: 1, season: '2026' } }));
      openBulkLinkReview({ scrimmageId: currentScrimmage.id, season: '2026', matches, notFound: [{ number: 2000, typed: 'Nope' }] });
    });
    await page.waitForSelector('#bulk-link-modal:not(.hidden)');
    const shortBox = await page.evaluate(() => ({
      confirmBottom: document.getElementById('btn-bulk-link-confirm').getBoundingClientRect().bottom,
      confirmTop: document.getElementById('btn-bulk-link-confirm').getBoundingClientRect().top,
      cardTop: document.querySelector('#bulk-link-modal .modal-card').getBoundingClientRect().top,
      cardBottom: document.querySelector('#bulk-link-modal .modal-card').getBoundingClientRect().bottom,
      ih: window.innerHeight
    }));
    if (shortBox.confirmBottom > shortBox.ih || shortBox.confirmTop < 0) problems.push(`320x480: bulk review confirm button is off screen ${JSON.stringify(shortBox)}`);
    if (shortBox.cardBottom > shortBox.ih + 1 || shortBox.cardTop < -1) problems.push(`320x480: bulk review card does not fit ${JSON.stringify(shortBox)}`);
    await page.click('#btn-bulk-link-cancel');
    await page.waitForSelector('#bulk-link-modal', { state: 'hidden' });

    // The merge Compare screen on the same short screen: Cancel / Merge stay on screen, only the list scrolls.
    await openMergeChoice();
    await page.click('#btn-scrimmage-team-merge');
    await checkCompare((s) => `320x480 ${s}`, 'compare screen');
    await discardCompare((s) => `320x480 ${s}`);
    // the lookup popup with 5 results on the same short screen
    await openScoutingSubtab(page, 'info');
    await page.click('#btn-scrimmage-add-team');
    await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
    await page.click('#btn-scrimmage-team-lookup');
    await page.waitForSelector('#ftc-lookup-modal:not(.hidden)');
    await checkResultsPopup((s) => `320x480 ${s}`, 'lookup results');
    await page.click('#btn-ftc-lookup-cancel');
    await page.waitForSelector('#ftc-lookup-modal', { state: 'hidden' });
    await page.click('#btn-scrimmage-team-cancel');
    await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });
    await checkDataCard((s) => `320x480 ${s}`);

    assert.deepEqual(problems, [], `layout problems:\n  ${problems.join('\n  ')}`);
  }
};
