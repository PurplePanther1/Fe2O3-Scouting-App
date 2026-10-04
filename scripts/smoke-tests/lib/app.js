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

module.exports = {
  openScrimmagesTab, createScrimmageUI, scrimmageRow, openScrimmageUI, addAndScoutUI, submitScrimmageTeamModal,
  uniqueEmail, gotoApp, signInUI, signOutUI, createTeamUI, joinTeamUI, selectFixtureEvent,
  openScoutingSubtab, fillRequiredFields, teamRow, confirmTeamDisplayName,
  pitScoutTeam, matchScoutTeam
};
