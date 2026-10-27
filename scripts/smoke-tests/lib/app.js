// UI-driving helpers shared by the smoke tests. Everything goes through the
// real UI (no direct Firestore writes) so the tests exercise the same paths a
// scout does. Selectors are the app's own element IDs / data attributes.

const assert = require('node:assert/strict');
const { FIXTURE_EVENT } = require('./harness');

let uniqueCounter = 0;
function uniqueEmail(prefix = 'scout') {
  uniqueCounter += 1;
  return `${prefix}-${Date.now()}-${uniqueCounter}@smoke.test`;
}

async function gotoApp(page) {
  await page.goto('/scouting/');
  await page.waitForSelector('#screen-login.active, #screen-team.active, #screen-main.active');
}

async function signInUI(page, user) {
  await gotoApp(page);
  await page.waitForSelector('#screen-login.active');
  await page.fill('#input-signin-email', user.email);
  await page.fill('#input-signin-password', user.password);
  await page.click('#btn-signin');
  // A first-ever sign-in (profile has no saved display name yet) is gated by
  // the Set Display Name screen — pre-filled from the account, so just
  // continue. Afterwards: the team screen (no team yet) or the dashboard.
  await page.waitForSelector('#screen-set-display-name.active, #screen-team.active, #screen-main.active');
  if (await page.isVisible('#screen-set-display-name.active')) {
    await page.click('#btn-set-display-name-continue');
    await page.waitForSelector('#screen-team.active, #screen-main.active');
  }
}

async function signOutUI(page) {
  await page.click('#btn-sign-out:visible, #btn-main-sign-out:visible');
  await page.click('#btn-generic-confirm-proceed');
  await page.waitForSelector('#screen-login.active');
}

async function confirmTeamDisplayName(page) {
  await page.waitForSelector('#team-display-name-modal:not(.hidden)');
  await page.click('#btn-team-display-name-save');
}

async function createTeamUI(page, teamName) {
  await page.waitForSelector('#screen-team.active');
  await page.click('#screen-team .tab[data-tab="create"]');
  await page.fill('#input-team-name', teamName);
  await page.click('#btn-create-team');
  await confirmTeamDisplayName(page);
  await page.waitForSelector('#screen-main.active');
  const joinCode = (await page.textContent('#created-join-code')).trim();
  assert.match(joinCode, /^[A-Z0-9]+-[A-Z0-9]+$/, `unexpected join code format: "${joinCode}"`);
  return joinCode;
}

async function joinTeamUI(page, joinCode) {
  await page.waitForSelector('#screen-team.active');
  await page.fill('#input-join-code', joinCode);
  await page.click('#btn-join-team');
  await confirmTeamDisplayName(page);
  await page.waitForSelector('#screen-main.active');
}

// Opens the Scouting dashboard tab and selects the mocked fixture event.
async function selectFixtureEvent(page) {
  await page.click('#dashboard-tabs .tab[data-dtab="scouting"]');
  await page.fill('#input-event-search', 'Smoke');
  await page.click('#btn-search-events');
  await page.click(`.event-item[data-code="${FIXTURE_EVENT.code}"]`);
  await page.waitForFunction(() => /team\(s\) registered/.test(document.getElementById('selected-event-teams-count')?.textContent || ''));
}

async function openScoutingSubtab(page, subtab) {
  await page.click(`#scouting-subtabs .tab[data-subtab="${subtab}"]`);
  await page.waitForSelector(`#subtab-${subtab}.active`);
}

// Fills every REQUIRED field of the currently open dynamic form (field set
// differs by season, so this doesn't hard-code any field IDs), then `notes`.
async function fillRequiredFields(page, modalSelector, notes) {
  const required = await page.$$eval(`${modalSelector} .pit-field`, divs =>
    divs.filter(d => /\*\s*$/.test(d.querySelector('label')?.textContent || '')).map(d => d.dataset.fieldId));
  for (const id of required) {
    const el = page.locator(`${modalSelector} #dyn-${id}`);
    const tag = await el.evaluate(n => n.tagName);
    if (tag === 'SELECT') {
      const value = await el.evaluate(n => [...n.options].find(o => o.value)?.value);
      await el.selectOption(value);
    } else if (id !== 'matchNumber') {
      await el.fill('1');
    }
  }
  if (notes) await page.fill(`${modalSelector} #dyn-notes`, notes);
}

async function teamRow(page, listSelector, teamNumber) {
  return page.locator(`${listSelector} .team-item[data-team-number="${teamNumber}"]`);
}

// Pit-scouts `teamNumber` from the Pit Scouting tab and waits for the save
// to land (modal closes, row flips to its scouted state).
async function pitScoutTeam(page, teamNumber, notes) {
  await openScoutingSubtab(page, 'pit');
  const row = await teamRow(page, '#team-list-pit', teamNumber);
  await row.locator('.btn-pit-quick-scout').click();
  await page.waitForSelector('#pit-modal:not(.hidden) #pit-dynamic-fields .pit-field');
  // The form renders before its live-collaboration session has joined (the
  // entry doc is created by join()); a human can't click Done that fast, but a
  // script can — wait for the session so Done never races the doc creation.
  await page.waitForFunction(() => typeof currentPitLiveSession !== 'undefined' && currentPitLiveSession && currentPitLiveSession.isJoined());
  await fillRequiredFields(page, '#pit-modal', notes);
  await page.click('#btn-pit-save');
  await page.waitForSelector('#pit-modal', { state: 'hidden' });
  await row.locator('.pit-row-meta').waitFor();
}

// Match-scouts `teamNumber` via Team View (batch mode: match number is a
// form field) and waits for the save to land (modal closes, count badge up).
async function matchScoutTeam(page, teamNumber, matchNumber, notes) {
  await openScoutingSubtab(page, 'match');
  const row = await teamRow(page, '#team-list-match', teamNumber);
  await row.getByRole('button', { name: '+ Match Scout' }).click();
  await page.waitForSelector('#match-modal:not(.hidden) #match-dynamic-fields .pit-field');
  await page.fill('#match-modal #dyn-matchNumber', String(matchNumber));
  await fillRequiredFields(page, '#match-modal', notes);
  await page.click('#btn-match-save');
  await page.waitForSelector('#match-modal', { state: 'hidden' });
  await row.locator('.match-count-badge:not(.hidden)').waitFor();
}

// ====== Scrimmage helpers ======
async function openScrimmagesTab(page) {
  await page.click('#dashboard-tabs .tab[data-dtab="scouting"]');
  await openScoutingSubtab(page, 'scrimmages');
}

async function createScrimmageUI(page, { name, season, date }) {
  await openScrimmagesTab(page);
  await page.click('#btn-new-scrimmage');
  await page.waitForSelector('#scrimmage-form-modal:not(.hidden)');
  await page.fill('#input-scrimmage-name', name);
  if (season) await page.selectOption('#select-scrimmage-season', String(season));
  if (date) await page.fill('#input-scrimmage-date', date);
  await page.click('#btn-scrimmage-form-save');
  await page.waitForSelector('#scrimmage-form-modal', { state: 'hidden' });
  await scrimmageRow(page, name).waitFor();
}

function scrimmageRow(page, name) {
  return page.locator('#scrimmage-list .scrimmage-item', { hasText: name });
}

// Opens a scrimmage by clicking its ROW (whole row is the click target) and
// waits for it to be open. The Scrimmages tab stays showing (like Pinned
// Events); pass { goTo: 'info' } (default) to then move to another subtab.
async function openScrimmageUI(page, name, { goTo = 'info' } = {}) {
  await openScrimmagesTab(page);
  await scrimmageRow(page, name).locator('.event-name').click();
  await page.waitForFunction((n) => selectedEvent && selectedEvent.isScrimmage && selectedEvent.name === n && currentScrimmage, name);
  if (goTo) await openScoutingSubtab(page, goTo);
}

// Pit / Match tabs: "+ Add & scout a team" -> modal -> submit. Waits for the
// modal to be fully closed. (The form then opens on its own.)
async function addAndScoutUI(page, kind, { number, name }) {
  await openScoutingSubtab(page, kind);
  await page.click(`#btn-scrimmage-add-scout-${kind}`);
  await submitScrimmageTeamModal(page, { number, name });
}

// Fills the Add/Edit Team modal that's already open and submits it.
async function submitScrimmageTeamModal(page, { number, name }) {
  await page.waitForSelector('#scrimmage-team-modal:not(.hidden)');
  if (number != null) await page.fill('#input-scrimmage-team-number', String(number));
  if (name != null) await page.fill('#input-scrimmage-team-name', name);
  await page.click('#btn-scrimmage-team-save');
  await page.waitForSelector('#scrimmage-team-modal', { state: 'hidden' });
}


// ====== Official forms helpers (js/official-forms.js, official-form-admin.js) ======
// The admin account is the emulator user with the REAL admin address (ctx.adminUser()): the
// rules hard-code that address, so publishing end-to-end needs it. Tests that publish use a
// throwaway SEASON (2021-2024) so no template ever reaches the current season's teams.
const ADMIN_EMAIL = 'leviticus.sietman@gmail.com';

// A field definition in the shape the form builder saves.
function formField(id, label, type, extra = {}) {
  return { id, label, type, required: false, sortOrder: 0, showInPreview: true, ...extra };
}

// Publishes through the page's OWN admin code (adminDoPublish(), the Publish button's
// transaction) on the real rules; the draft basis is read fresh so repeated publishes work.
async function publishOfficialForm(adminPage, { season, formType, fields }) {
  return adminPage.evaluate(async ({ season, formType, fields }) => {
    const id = officialFormId(season, formType);
    const current = await fetchOfficialForm(season, formType);
    adminDrafts.set(id, { fields: adminCleanFields(fields), basisVersion: current ? current.version : 0, basisJson: '', fromDefault: false });
    await adminDoPublish(season, formType, adminDrafts.get(id));
    return (await fetchOfficialForm(season, formType)).version;
  }, { season: String(season), formType, fields });
}

// The team's own saved config for a season + form type (null if none), straight from Firestore.
function readFormConfig(page, teamId, season, formType) {
  return page.evaluate(async ([tid, id]) => {
    const snap = await db.collection('teams').doc(tid).collection('formConfig').doc(id).get();
    return snap.exists ? snap.data() : null;
  }, [teamId, season + '_' + formType]);
}

// Snapshots saved before an Accept / Merge / Restore, oldest first.
function readSnapshots(page, teamId, season, formType) {
  return page.evaluate(async ([tid, key]) => {
    const snap = await db.collection('teams').doc(tid).collection('formSnapshots').where('formKey', '==', key).get();
    return snap.docs.map(d => d.data()).sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
  }, [teamId, season + '_' + formType]);
}

// The app's season selector (what the My Team notice follows). The <select> lives on the Scouting tab,
// so this sets it the way a pick does - value + 'change' - without needing it on screen.
const selectAppSeason = (page, season) => page.evaluate((s) => {
  const sel = document.getElementById('select-season');
  sel.value = s;
  sel.dispatchEvent(new Event('change'));
}, String(season));

const openMyTeamTab = (page) => page.click('#dashboard-tabs .tab[data-dtab="myteam"]');

// Opens the team's form builder on a season + form type (creating that config if the team has none).
async function openBuilderFor(page, season, formType) {
  if (await page.isHidden('#builder-modal:not(.hidden)')) {
    await openMyTeamTab(page);
    await page.click('#btn-open-form-builder');
  }
  await page.waitForSelector('#builder-modal:not(.hidden)');
  await page.selectOption('#builder-season-select', String(season));
  await page.click(`.builder-type-tab[data-builder-type="${formType}"]`);
  await page.waitForFunction(([s, t]) => currentBuilderSeason === s && currentFormBuilderType === t && !document.getElementById('builder-field-list').textContent.includes('Loading'), [String(season), formType]);
}

const closeBuilder = async (page) => {
  await page.click('#btn-builder-close');
  await page.waitForSelector('#builder-modal', { state: 'hidden' });
};

const builderLabels = (page) => page.$$eval('#builder-field-list .builder-field-label', els => els.map(e => e.textContent.trim()));

// Edit Permissions -> tick "Edit templates" for a member (the forms-editing permission, canEditTemplates).
async function setFormsPermission(capPage, memberName, on) {
  await openMyTeamTab(capPage);
  const row = capPage.locator('#member-list .member-item', { hasText: memberName });
  await row.getByRole('button', { name: 'Edit Permissions' }).click();
  await capPage.waitForSelector('#member-permissions-modal:not(.hidden)');
  await capPage.setChecked('#perm-canEditTemplates', on);
  await capPage.click('#btn-member-perms-save');
  await capPage.waitForSelector('#member-permissions-modal', { state: 'hidden' });
}

// The notice items currently shown in a container ('myteam' | 'account'): [{ formType, title, detail }].
function noticeItems(page, where = 'myteam') {
  return page.$$eval(`#official-forms-notice-${where} .official-notice-item`, els => els.map(e => ({
    formType: e.dataset.formType,
    title: e.querySelector('.official-notice-title').textContent.trim(),
    detail: e.querySelector('.official-notice-detail').textContent.trim(),
    actions: [...e.querySelectorAll('button')].map(b => b.textContent.trim())
  })));
}

const noticeButton = (page, formType, action, where = 'myteam') =>
  page.locator(`#official-forms-notice-${where} .official-notice-item[data-form-type="${formType}"] [data-official-action="${action}"]`);

const confirmGeneric = async (page) => {
  await page.waitForSelector('#generic-confirm-modal:not(.hidden)');
  await page.click('#btn-generic-confirm-proceed');
  await page.waitForSelector('#generic-confirm-modal', { state: 'hidden' });
};

// Ends a team the test created (the shared admin account must not keep a team between tests).
async function deleteTeamAsLastMember(page) {
  await page.evaluate(async () => { await deleteEntireTeam(currentTeamData.id, currentUser.uid, currentTeamData); });
}

module.exports = {
  ADMIN_EMAIL, formField, publishOfficialForm, readFormConfig, readSnapshots, openMyTeamTab, selectAppSeason, openBuilderFor, closeBuilder, builderLabels, setFormsPermission, noticeItems, noticeButton, confirmGeneric, deleteTeamAsLastMember,
  openScrimmagesTab, createScrimmageUI, scrimmageRow, openScrimmageUI, addAndScoutUI, submitScrimmageTeamModal,
  uniqueEmail, gotoApp, signInUI, signOutUI, createTeamUI, joinTeamUI, selectFixtureEvent,
  openScoutingSubtab, fillRequiredFields, teamRow, confirmTeamDisplayName,
  pitScoutTeam, matchScoutTeam
};
