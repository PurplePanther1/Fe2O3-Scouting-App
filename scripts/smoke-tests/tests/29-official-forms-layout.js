// Layout of everything the official-forms work adds, from 320px to 1280px and on a 320x480 screen:
//   - the Admin button beside My Account (team screen AND dashboard header, with the My Account badges)
//   - the "new official version" notice on My Team and on My Account (two items, long text, 4 buttons each)
//   - the form builder's "Official form" bar, the official-form VIEWER and the MERGE screen (long labels, an
//     unbroken token, many fields: only the list scrolls, Cancel / Merge / Accept stay on screen)
//   - the ADMIN screen (panel, history list, the "Draft saved" / "Not saved" line, the "See what changed" button and
//     its popup) and the export choice's "Include deleted fields" row
//   - the builder rows with the Copy button and the six-dot drag handle, the drop line while dragging, and the
//     "other seasons also have an update" line under the My Team banner
// One account does it all: the admin account is captain of its own team here (and deletes it at the end).
// The throwaway season is 2021, so nothing real is touched.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {
  signInUI, createTeamUI, formField, publishOfficialForm, openBuilderFor, closeBuilder, openMyTeamTab,
  noticeButton, deleteTeamAsLastMember, selectAppSeason
} = require('../lib/app');

const WIDTHS = [320, 375, 414, 600, 768, 1024, 1280];
const SEASON = '2021';
const TOKEN = 'Unbroken'.repeat(8);
const LONG = 'An Extremely Long Field Label That Goes On And On To Test Wrapping In Every Official Form Screen';

module.exports = {
  name: 'official forms layout: Admin button, notice, builder bar, viewer, Merge screen, admin screen and export option fit from 320px to 1280px and on 320x480',
  async run(ctx) {
    const admin = await ctx.adminUser();
    const page = await ctx.newPage('layout');
    await signInUI(page, admin);

    const problems = [];
    // SMOKE_SHOTS=1 saves a picture of each screen at 375px (and 320x480) into artifacts/ for eyeballing.
    const shot = async (name) => {
      if (process.env.SMOKE_SHOTS !== '1') return;
      fs.mkdirSync(path.join(__dirname, '..', 'artifacts'), { recursive: true });
      await page.screenshot({ path: path.join(__dirname, '..', 'artifacts', `official-${name}.png`) });
    };
    const noPageOverflow = async (label) => {
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      if (m.sw > m.iw + 1) problems.push(`${label}: page scrolls horizontally (${m.sw} > ${m.iw})`);
    };
    // Visible and entirely inside the viewport (left/right always; top/bottom when `vertical`).
    const inView = async (selector, label, vertical = false) => {
      const r = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: b.width, h: b.height, iw: window.innerWidth, ih: window.innerHeight };
      }, selector);
      if (!r) { problems.push(`${label}: ${selector} is missing`); return; }
      if (r.w === 0 || r.h === 0) { problems.push(`${label}: ${selector} is not visible`); return; }
      if (r.left < -1 || r.right > r.iw + 1) problems.push(`${label}: ${selector} sticks out sideways (${Math.round(r.left)}..${Math.round(r.right)} of ${r.iw})`);
      if (vertical && (r.top < -1 || r.bottom > r.ih + 1)) problems.push(`${label}: ${selector} is off screen vertically (${Math.round(r.top)}..${Math.round(r.bottom)} of ${r.ih})`);
    };
    // Every button / control inside `container` is inside the viewport sideways.
    const childrenInside = async (container, label) => {
      const bad = await page.evaluate((sel) => {
        const root = document.querySelector(sel);
        if (!root) return ['(container missing)'];
        const iw = window.innerWidth;
        return [...root.querySelectorAll('button, input, select')].filter(el => el.offsetWidth > 0)
          .filter(el => { const b = el.getBoundingClientRect(); return b.left < -1 || b.right > iw + 1; })
          .map(el => (el.id || el.textContent || el.tagName).trim().slice(0, 30));
      }, container);
      if (bad.length) problems.push(`${label}: ${bad.join(', ')} stick(s) out sideways`);
    };

    // ---------- the admin on the Join/Create Team screen ----------
    for (const width of [320, 375, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(150);
      await inView('#btn-open-admin-from-team', `${width}px team screen`);
      await inView('#btn-open-my-account-standalone', `${width}px team screen`);
      await inView('#btn-sign-out', `${width}px team screen`);
      await noPageOverflow(`${width}px team screen`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await createTeamUI(page, 'Official Layout Team');
    const teamId = await page.evaluate(() => currentTeamData.id);
    await selectAppSeason(page, SEASON); // the My Team banner follows the app's season

    // ---------- seed: a team form and an official form that differ in every way, with long text ----------
    const dd = (id, label, options, extra = {}) => formField(id, label, 'dropdown', { options, ...extra });
    const teamFields = [
      dd('alpha', LONG, ['Short', 'A very long option name that has to wrap somewhere sensible inside the radio card', TOKEN], { required: true }),
      formField('same1', 'Same One', 'text'), formField('same2', `Same Two ${TOKEN}`, 'text'),
      formField('mineOnly', `Only Mine ${TOKEN}`, 'number'),
      formField('typeChange', 'Type Changes', 'text', { required: true }),
      ...Array.from({ length: 6 }, (_, i) => formField(`filler${i}`, `Filler Field ${i} With A Label`, 'text', { showInPreview: false }))
    ];
    const officialFields = [
      dd('alpha', LONG, ['Short', 'A different very long option name that also has to wrap somewhere sensible', TOKEN, 'More']),
      formField('same1', 'Same One', 'text'), formField('same2', `Same Two ${TOKEN}`, 'text'),
      formField('typeChange', 'Type Changes', 'number'),
      formField('newA', `New Field A ${LONG}`, 'textarea'), formField('newB', `New B ${TOKEN}`, 'counter', { min: 0, max: 9, step: 1 }),
      ...Array.from({ length: 6 }, (_, i) => formField(`filler${i}`, `Filler Field ${i} With A Label`, 'text', { showInPreview: false }))
    ];
    await page.evaluate(async ([tid, season, fields]) => {
      for (const type of ['pitScouting', 'matchScouting']) {
        await db.collection('teams').doc(tid).collection('formConfig').doc(`${season}_${type}`)
          .set({ fields, baseVersion: null, handledVersion: 0, retiredFields: [] });
      }
    }, [teamId, SEASON, teamFields.map((f, i) => ({ ...f, sortOrder: i }))]);
    await publishOfficialForm(page, { season: SEASON, formType: 'pitScouting', fields: officialFields });
    await publishOfficialForm(page, { season: SEASON, formType: 'matchScouting', fields: officialFields });
    // A second season with an update too, so the "other seasons" line shows under the banner.
    await page.evaluate(async ([tid, fields]) => {
      await db.collection('teams').doc(tid).collection('formConfig').doc('2022_pitScouting')
        .set({ fields, baseVersion: null, handledVersion: 0, retiredFields: [] });
    }, [teamId, teamFields.map((f, i) => ({ ...f, sortOrder: i }))]);
    await publishOfficialForm(page, { season: '2022', formType: 'pitScouting', fields: officialFields });
    await openMyTeamTab(page);
    await page.waitForFunction(() => document.querySelectorAll('#official-forms-notice-myteam .official-notice-item').length === 2);
    await page.waitForFunction(() => !document.getElementById('official-forms-other-seasons').classList.contains('hidden'));

    // ---------- every width ----------
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(150);
      const tag = `${width}px`;

      // dashboard header: My Account (+ badge), Admin, Sign Out
      await page.click('#dashboard-tabs .tab[data-dtab="myteam"]');
      for (const sel of ['#btn-open-my-account-from-dashboard', '#btn-open-admin-from-dashboard', '#btn-main-sign-out', '#official-forms-nav-badge-header']) await inView(sel, `${tag} header`);
      await noPageOverflow(`${tag} header`);

      // My Team notice
      if (width === 375) { await page.locator('#official-forms-notice-myteam').scrollIntoViewIfNeeded(); await shot('notice-375'); }
      await inView('#official-forms-notice-myteam', `${tag} My Team notice`);
      await inView('#official-forms-other-seasons', `${tag} other-seasons line`);
      await childrenInside('#official-forms-notice-myteam', `${tag} My Team notice`);
      await noPageOverflow(`${tag} My Team notice`);

      // My Account card
      await page.click('#btn-open-my-account-from-dashboard');
      await page.waitForSelector('#official-forms-account-card:not(.hidden)');
      await inView('#official-forms-account-card', `${tag} My Account card`);
      await childrenInside('#official-forms-notice-account', `${tag} My Account card`);
      await noPageOverflow(`${tag} My Account`);
      // the Admin button beside the back button on My Account and on Account Activity
      for (const sel of ['#btn-my-account-standalone-back', '#btn-open-admin-from-account', '#btn-open-account-activity', '#btn-account-page-sign-out']) await inView(sel, `${tag} My Account header`);
      await childrenInside('#dtab-account > div:first-child', `${tag} My Account header`);
      if (width === 375) await shot('account-admin-375');
      await page.click('#btn-open-account-activity');
      await page.waitForSelector('#btn-account-activity-back');
      for (const sel of ['#btn-account-activity-back', '#btn-open-admin-from-activity', '#btn-activity-page-sign-out']) await inView(sel, `${tag} Account Activity header`);
      await childrenInside('#dtab-activity > div:first-child', `${tag} Account Activity header`);
      await noPageOverflow(`${tag} Account Activity`);
      if (width === 375) await shot('activity-admin-375');
      await page.click('#btn-account-activity-back');
      await page.click('#btn-my-account-standalone-back');
      await page.click('#dashboard-tabs .tab[data-dtab="myteam"]');

      // the form builder's "Official form" bar
      await openBuilderFor(page, SEASON, 'pitScouting');
      await page.waitForFunction(() => /Official version \d+ is available/.test(document.getElementById('builder-official-text').textContent));
      if (width === 375) await shot('builder-bar-375');
      await inView('#builder-official-bar', `${tag} builder bar`);
      await inView('#btn-builder-official-view', `${tag} builder bar`);
      await childrenInside('#builder-official-bar', `${tag} builder bar`);
      // the rows: drag handle, arrows, label, Edit / Copy / X all inside the screen, the buttons under the label when narrow
      await childrenInside('#builder-field-list', `${tag} builder rows`);
      const rowProblems = await page.evaluate(() => [...document.querySelectorAll('#builder-field-list .builder-field-item')].flatMap((row) => {
        const iw = window.innerWidth;
        const rb = row.getBoundingClientRect();
        const out = [];
        if (rb.left < -1 || rb.right > iw + 1) out.push('row sticks out');
        if (row.scrollWidth > row.clientWidth + 1) out.push('row content wider than the row');
        for (const sel of ['.builder-drag-handle', '[data-builder-action="copy"]', '.builder-field-actions']) {
          const el = row.querySelector(sel);
          const b = el && el.getBoundingClientRect();
          if (!b || b.width === 0) out.push(sel + ' missing');
          else if (b.left < rb.left - 1 || b.right > rb.right + 1) out.push(sel + ' outside its row');
        }
        return out;
      }));
      if (rowProblems.length) problems.push(`${tag} builder rows: ${[...new Set(rowProblems)].join(', ')}`);
      if (width === 375) await shot('builder-rows-375');
      await noPageOverflow(`${tag} builder`);
      await closeBuilder(page);

      // the viewer
      await noticeButton(page, 'pitScouting', 'view').click();
      await page.waitForSelector('#official-form-view-modal:not(.hidden)');
      if (width === 375) await shot('viewer-375');
      await inView('#official-form-view-modal .modal-card', `${tag} viewer`);
      for (const sel of ['#btn-official-view-close-inline', '#btn-official-view-merge', '#btn-official-view-accept', '#btn-official-view-close']) await inView(sel, `${tag} viewer`, true);
      await noPageOverflow(`${tag} viewer`);
      await page.click('#btn-official-view-close-inline');
      await page.waitForSelector('#official-form-view-modal', { state: 'hidden' });

      // the Merge screen
      await noticeButton(page, 'pitScouting', 'merge').click();
      await page.waitForSelector('#official-merge-modal:not(.hidden)');
      if (width === 375) await shot('merge-375');
      await inView('#official-merge-modal .modal-card', `${tag} merge`);
      for (const sel of ['#btn-official-merge-cancel', '#btn-official-merge-confirm', '#btn-official-merge-close']) await inView(sel, `${tag} merge`, true);
      await childrenInside('#official-merge-list', `${tag} merge list`);
      const listOverflow = await page.evaluate(() => { const l = document.getElementById('official-merge-list'); return l.scrollWidth - l.clientWidth; });
      if (listOverflow > 1) problems.push(`${tag} merge list: content is wider than the list by ${listOverflow}px`);
      await noPageOverflow(`${tag} merge`);
      await page.click('#btn-official-merge-cancel');
      await page.waitForSelector('#official-merge-modal', { state: 'hidden' });

      // the admin screen with its history
      await page.click('#btn-open-admin-from-dashboard');
      await page.waitForSelector('#builder-modal:not(.hidden)');
      await page.selectOption('#builder-season-select', SEASON);
      await page.waitForFunction(() => /Published now: version/.test(document.getElementById('admin-status').textContent) && !/Loading/.test(document.getElementById('admin-draft-state').textContent));
      await page.click('#btn-admin-history');
      await page.waitForSelector('#admin-history-list .official-admin-history-row');
      if (width === 375) await shot('admin-375');
      await inView('#builder-admin-panel', `${tag} admin`);
      for (const sel of ['#btn-admin-publish', '#btn-admin-history']) await inView(sel, `${tag} admin`);
      await childrenInside('#builder-admin-panel', `${tag} admin`);
      // an edit: "Saving..." / "Draft saved", "See what changed" and its popup
      await page.evaluate(async () => {
        const fields = getAdminDraftFields('2021', 'pitScouting');
        setAdminDraftFields('2021', 'pitScouting', [...fields.slice(1), { ...fields[0], label: fields[0].label + ' (edited)' }]);
        await renderBuilderFields('admin');
      });
      await page.waitForFunction(() => document.getElementById('admin-save-state').textContent.trim() === 'Draft saved');
      if (width === 375) await shot('admin-draft-375');
      for (const sel of ['#admin-save-state', '#btn-admin-changes', '#btn-admin-reset']) await inView(sel, `${tag} admin draft`);
      await childrenInside('#builder-admin-panel', `${tag} admin draft`);
      await noPageOverflow(`${tag} admin draft`);
      await page.click('#btn-admin-changes');
      await page.waitForSelector('#admin-changes-modal:not(.hidden)');
      if (width === 375) await shot('admin-changes-375');
      await inView('#admin-changes-modal .modal-card', `${tag} changes popup`);
      for (const sel of ['#btn-admin-changes-close-inline', '#btn-admin-changes-close']) await inView(sel, `${tag} changes popup`, true);
      await childrenInside('#admin-changes-list', `${tag} changes list`);
      const changesOverflow = await page.evaluate(() => { const l = document.getElementById('admin-changes-list'); return l.scrollWidth - l.clientWidth; });
      if (changesOverflow > 1) problems.push(`${tag} changes list: content is wider than the list by ${changesOverflow}px`);
      await noPageOverflow(`${tag} changes popup`);
      await page.click('#btn-admin-changes-close-inline');
      await page.waitForSelector('#admin-changes-modal', { state: 'hidden' });
      // the six-dot handle while dragging: the drop line is inside the list
      await page.locator('#builder-field-list .builder-drag-handle').first().scrollIntoViewIfNeeded();
      const handleBox = await page.locator('#builder-field-list .builder-drag-handle').first().boundingBox();
      if (handleBox) {
        await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2 + 70, { steps: 5 });
        if (width === 375) await shot('drag-375');
        const line = await page.evaluate(() => {
          const ind = document.querySelector('#builder-field-list .builder-drop-indicator');
          const list = document.getElementById('builder-field-list').getBoundingClientRect();
          if (!ind) return null;
          const b = ind.getBoundingClientRect();
          return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, listLeft: list.left, listRight: list.right, listTop: list.top, listBottom: list.bottom };
        });
        if (!line) problems.push(`${tag} drag: no drop line`);
        else if (line.left < line.listLeft - 1 || line.right > line.listRight + 1 || line.top < line.listTop - 6 || line.bottom > line.listBottom + 6) problems.push(`${tag} drag: the drop line is outside the list`);
        await page.keyboard.press('Escape');
        await page.mouse.up();
      }
      await page.click('#btn-admin-reset');
      await page.waitForFunction(() => /No changes since the published version/.test(document.getElementById('admin-draft-state').textContent));
      const historyOverflow = await page.evaluate(() => { const l = document.getElementById('admin-history-list'); return l.scrollWidth - l.clientWidth; });
      if (historyOverflow > 1) problems.push(`${tag} admin history: wider than its box by ${historyOverflow}px`);
      await noPageOverflow(`${tag} admin`);
      await page.click('#btn-builder-close');
      await page.waitForSelector('#builder-modal', { state: 'hidden' });
    }

    // ---------- the 320x480 screen: the buttons that matter stay reachable ----------
    await page.setViewportSize({ width: 320, height: 480 });
    await page.waitForTimeout(200);
    await openMyTeamTab(page);
    await noticeButton(page, 'pitScouting', 'view').click();
    await page.waitForSelector('#official-form-view-modal:not(.hidden)');
    for (const sel of ['#btn-official-view-close-inline', '#btn-official-view-merge', '#btn-official-view-accept']) await inView(sel, '320x480 viewer', true);
    const viewerScrolls = await page.evaluate(() => { const l = document.getElementById('official-view-fields'); return l.scrollHeight > l.clientHeight; });
    assert.ok(viewerScrolls, '320x480: only the viewer\'s field list scrolls (it has more rows than fit)');
    await page.click('#btn-official-view-close-inline');
    await noticeButton(page, 'pitScouting', 'merge').click();
    await page.waitForSelector('#official-merge-modal:not(.hidden)');
    await shot('merge-320x480');
    for (const sel of ['#btn-official-merge-cancel', '#btn-official-merge-confirm', '#btn-official-merge-close']) await inView(sel, '320x480 merge', true);
    const mergeScrolls = await page.evaluate(() => { const l = document.getElementById('official-merge-list'); return l.scrollHeight > l.clientHeight; });
    assert.ok(mergeScrolls, '320x480: only the Merge list scrolls');
    // ...and Cancel / Merge are still reachable after scrolling the list to the bottom.
    await page.evaluate(() => { const l = document.getElementById('official-merge-list'); l.scrollTop = l.scrollHeight; });
    for (const sel of ['#btn-official-merge-cancel', '#btn-official-merge-confirm']) await inView(sel, '320x480 merge (scrolled)', true);
    await page.click('#btn-official-merge-cancel');
    await page.waitForSelector('#official-merge-modal', { state: 'hidden' });
    await page.click('#btn-open-admin-from-dashboard');
    await page.waitForSelector('#builder-modal:not(.hidden)');
    await page.selectOption('#builder-season-select', SEASON);
    await page.waitForFunction(() => /Published now: version/.test(document.getElementById('admin-status').textContent) && !/Loading/.test(document.getElementById('admin-draft-state').textContent));
    // The builder card scrolls as a whole on a short screen (as the team builder always has): the Publish button is
    // reachable by scrolling and the card header (with the X) stays.
    await page.locator('#btn-admin-publish').scrollIntoViewIfNeeded();
    await inView('#btn-admin-publish', '320x480 admin');
    // "See what changed" on the short screen: only the list scrolls, Close and the X stay on screen.
    await page.evaluate(async () => {
      const fields = getAdminDraftFields('2021', 'pitScouting');
      setAdminDraftFields('2021', 'pitScouting', [...fields.slice(1), { ...fields[0], label: fields[0].label + ' (edited)' }]);
      await renderBuilderFields('admin');
    });
    await page.waitForFunction(() => document.getElementById('admin-save-state').textContent.trim() === 'Draft saved');
    await page.locator('#btn-admin-changes').scrollIntoViewIfNeeded();
    await page.click('#btn-admin-changes');
    await page.waitForSelector('#admin-changes-modal:not(.hidden)');
    await shot('admin-changes-320x480');
    for (const sel of ['#btn-admin-changes-close-inline', '#btn-admin-changes-close']) await inView(sel, '320x480 changes popup', true);
    assert.ok(await page.evaluate(() => { const l = document.getElementById('admin-changes-list'); return l.scrollHeight > l.clientHeight; }), '320x480: only the changes list scrolls');
    await page.evaluate(() => { const l = document.getElementById('admin-changes-list'); l.scrollTop = l.scrollHeight; });
    for (const sel of ['#btn-admin-changes-close-inline', '#btn-admin-changes-close']) await inView(sel, '320x480 changes popup (scrolled)', true);
    await page.click('#btn-admin-changes-close-inline');
    await page.waitForSelector('#admin-changes-modal', { state: 'hidden' });
    // The "Not saved" line (a draft the real rules refuse: 101 fields) wraps inside the panel.
    await page.evaluate(() => setAdminDraftFields('2021', 'pitScouting', Array.from({ length: 101 }, (_, i) => ({ id: `big${i}`, label: `Big ${i}`, type: 'text', required: false, sortOrder: i, showInPreview: false }))));
    await page.waitForFunction(() => /^Not saved/.test(document.getElementById('admin-save-state').textContent.trim()));
    await page.locator('#admin-save-state').scrollIntoViewIfNeeded();
    await shot('admin-not-saved-320x480');
    await inView('#admin-save-state', '320x480 not saved');
    await childrenInside('#builder-admin-panel', '320x480 not saved');
    await noPageOverflow('320x480 not saved');
    await page.click('#btn-admin-reset');
    await page.waitForFunction(() => /No changes since the published version/.test(document.getElementById('admin-draft-state').textContent));
    await page.click('#btn-builder-close');
    await page.waitForSelector('#builder-modal', { state: 'hidden' });

    // ---------- the export choice's "Include deleted fields" row ----------
    for (const width of [320, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() => openExportChoiceModal({ title: 'Export Whole Team Data', statusPrefix: 'myteam-export', deletedFieldsOption: true, includeScrimmagesOption: { count: 3 }, excelHandler() {}, sheetsHandler() {} }));
      await page.waitForSelector('#export-choice-modal:not(.hidden)');
      await inView('#export-choice-deleted-option', `${width}px export option`);
      await inView('#chk-export-include-deleted', `${width}px export option`);
      await childrenInside('#export-choice-modal .modal-card', `${width}px export choice`);
      await page.click('#btn-export-choice-close');
    }

    // ---------- the builder bar's "Your form matches official version N." wording ----------
    await page.evaluate(async ([tid, season, fields]) => {
      await db.collection('teams').doc(tid).collection('formConfig').doc(`${season}_pitScouting`).set({ fields }, { merge: true });
    }, [teamId, SEASON, officialFields.map((f, i) => ({ ...f, sortOrder: i }))]);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(150);
      await openBuilderFor(page, SEASON, 'pitScouting');
      await page.waitForFunction(() => /^Your form matches official version \d+\./.test(document.getElementById('builder-official-text').textContent.trim()));
      if (width === 375) await shot('builder-bar-matches-375');
      await inView('#builder-official-bar', `${width}px builder bar (matches)`);
      await inView('#btn-builder-official-view', `${width}px builder bar (matches)`);
      await childrenInside('#builder-official-bar', `${width}px builder bar (matches)`);
      await noPageOverflow(`${width}px builder (matches)`);
      await closeBuilder(page);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await deleteTeamAsLastMember(page);
    assert.deepEqual(problems, [], `layout problems:\n  ${problems.join('\n  ')}`);
  }
};
