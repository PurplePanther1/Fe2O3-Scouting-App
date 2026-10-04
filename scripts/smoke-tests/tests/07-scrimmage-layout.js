// Layout at phone/tablet/desktop widths for everything the scrimmage work adds:
// the six-tab Scouting subtab bar (it has had overflow bugs before — see the
// long comment in css/style.css), the Scrimmages list rows (Manage/Delete), the
// banner, the Add & scout / Add Team to Roster buttons and their help lines, the
// Add Team and Manage modals, and the Pinned tab's season dropdown and rows.

const assert = require('node:assert/strict');
const {
  signInUI, createTeamUI, openScoutingSubtab, createScrimmageUI, openScrimmageUI, openScrimmagesTab, selectFixtureEvent, scrimmageRow
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

      // --- New Scrimmage modal ---
      await openScrimmagesTab(page);
      await page.click('#btn-new-scrimmage');
      await page.waitForSelector('#scrimmage-form-modal:not(.hidden)');
      await insideViewport('#scrimmage-form-modal .modal-card', L('new-scrimmage modal'));
      await page.click('#btn-scrimmage-form-cancel');
      await page.waitForSelector('#scrimmage-form-modal', { state: 'hidden' });
    }

    assert.deepEqual(problems, [], `layout problems:\n  ${problems.join('\n  ')}`);
  }
};
