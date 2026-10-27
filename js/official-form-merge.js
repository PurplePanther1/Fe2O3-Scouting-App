// ====== Merge an official form into the team's own form ======
// Fields are matched by FIELD ID (official-forms.js classifyMerge()):
//   only on the official form  -> added
//   only on the team's form    -> kept (a merge never removes a field)
//   on both, different         -> a per-field choice, default = the team's version
//   on both, equal             -> collapsed into one line
// The screen reuses the scrimmage Compare screen's layout and classes
// (scrimmage-merge.js). It is STAGED: nothing is written until the final
// "Merge" button; Cancel / X / click-out change nothing. The official version
// shown when the screen OPENS is the one recorded as handled on save, so a
// publish while it is open leaves the notice to show again for the newer
// version afterwards.

let officialMergeState = null; // { season, formType, official, officialFields, current, basisJson, choices, busy }

function officialMergeEl(id) {
  return document.getElementById(id);
}

function officialMergeText(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

async function openOfficialFormMerge(season, formType, captured) {
  const teamId = currentTeamData && currentTeamData.id;
  const official = captured || officialForms.get(officialFormId(season, formType));
  if (!teamId || !official || officialFormActionBusy || officialMergeState) return;
  officialFormActionBusy = true;

  let current;
  showLoading('Loading your form...');
  try {
    current = await loadTeamFormConfigFresh(teamId, season, formType);
  } catch (err) {
    console.error('Could not load the form for merge:', err);
    setOfficialFormsStatus('error', describeOfficialFormErrorForUser(err));
    return;
  } finally {
    hideLoading();
    officialFormActionBusy = false;
  }

  const officialFields = renumberFields(sortFormFields(official.fields));
  officialMergeState = {
    season: String(season),
    formType,
    official: { ...official, fields: officialFields },
    officialFields,
    current,
    basisJson: JSON.stringify(current.fields.map(normalizedFieldForCompare)),
    choices: {},
    busy: false
  };
  renderOfficialMerge();
  officialMergeEl('official-merge-modal').classList.remove('hidden');
  officialMergeEl('official-merge-list').scrollTop = 0;
  officialMergeEl('btn-official-merge-confirm').focus();
}

function renderOfficialMerge() {
  const state = officialMergeState;
  if (!state) return;
  const { season, formType, official, officialFields, current } = state;
  const word = officialFormTypeWord(formType);
  const plan = classifyMerge(current.fields, officialFields);
  state.plan = plan;
  plan.different.forEach((d) => { state.choices[d.id] = 'mine'; });

  officialMergeEl('official-merge-title').textContent = `Merge the official ${word} form`;
  officialMergeEl('official-merge-intro').textContent =
    `${officialFormSeasonLabel(season)} · official version ${official.version} into your form, matched by field ID. `
    + 'Nothing is removed, and nothing is saved until you press Merge.';
  officialMergeEl('official-merge-summary').textContent =
    `${plan.added.length} to add · ${plan.kept.length} only on your form (kept) · ${plan.different.length} different · ${plan.same.length} the same`;
  officialMergeEl('official-merge-error').textContent = '';
  const banner = officialMergeEl('official-merge-notice');
  banner.classList.add('hidden');
  banner.textContent = '';
  const confirmBtn = officialMergeEl('btn-official-merge-confirm');
  confirmBtn.textContent = 'Merge';
  confirmBtn.disabled = false;
  officialMergeEl('btn-official-merge-cancel').disabled = false;

  const list = officialMergeEl('official-merge-list');
  list.textContent = '';

  if (plan.added.length === 0 && plan.different.length === 0) {
    list.appendChild(officialMergeText('p', 'help-text', 'Your form already has every field on the official form, exactly as it is there. Merging only records that you have dealt with this version.'));
  }

  if (plan.added.length > 0) {
    const section = document.createElement('section');
    section.className = 'merge-conflict';
    section.dataset.section = 'added';
    section.appendChild(officialMergeText('h4', 'merge-conflict-title', `Added from the official form (${plan.added.length})`));
    plan.added.forEach((field) => {
      const row = document.createElement('div');
      row.className = 'merge-field';
      row.dataset.field = field.id;
      row.appendChild(officialMergeText('div', 'merge-field-label', field.label));
      row.appendChild(officialMergeText('div', 'merge-opt-value', describeFieldDefinition(field)));
      section.appendChild(row);
    });
    list.appendChild(section);
  }

  if (plan.different.length > 0) {
    const section = document.createElement('section');
    section.className = 'merge-conflict';
    section.dataset.section = 'different';
    section.appendChild(officialMergeText('h4', 'merge-conflict-title', `Different on both (${plan.different.length}): choose which to keep`));

    const shortcuts = document.createElement('div');
    shortcuts.className = 'merge-shortcuts';
    [['mine', 'Use all of mine'], ['official', 'Use all of the official']].forEach(([who, label]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-small btn-outline';
      btn.dataset.useAll = who;
      btn.textContent = label;
      btn.addEventListener('click', () => {
        plan.different.forEach((d) => { state.choices[d.id] = who; });
        section.querySelectorAll('input[type="radio"]').forEach((r) => { r.checked = r.value === who; });
      });
      shortcuts.appendChild(btn);
    });
    section.appendChild(shortcuts);

    plan.different.forEach((d) => {
      const row = document.createElement('div');
      row.className = 'merge-field';
      row.dataset.field = d.id;
      row.appendChild(officialMergeText('div', 'merge-field-label', d.mine.label === d.official.label ? d.mine.label : `${d.mine.label} / ${d.official.label}`));
      row.appendChild(officialMergeText('div', 'help-text merge-field-diff', `Differs in: ${d.differences.join(', ')}`));
      const opts = document.createElement('div');
      opts.className = 'merge-field-opts';
      [['mine', 'Mine', d.mine], ['official', 'Official', d.official]].forEach(([who, who_label, field]) => {
        const opt = document.createElement('label');
        opt.className = 'merge-opt';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = `official_merge_${d.id}`;
        radio.value = who;
        radio.checked = who === 'mine';
        radio.addEventListener('change', () => { if (radio.checked) state.choices[d.id] = who; });
        opt.appendChild(radio);
        const text = document.createElement('span');
        text.className = 'merge-opt-text';
        text.appendChild(officialMergeText('span', 'merge-opt-who', who_label));
        text.appendChild(officialMergeText('span', 'merge-opt-value', describeFieldDefinition(field)));
        opt.appendChild(text);
        opts.appendChild(opt);
      });
      row.appendChild(opts);
      section.appendChild(row);
    });
    list.appendChild(section);
  }

  if (plan.kept.length > 0) {
    const box = document.createElement('div');
    box.className = 'merge-same';
    box.dataset.section = 'kept';
    box.appendChild(officialMergeText('div', 'merge-same-title', `Only on your form: kept (${plan.kept.length})`));
    plan.kept.forEach((field) => box.appendChild(officialMergeText('div', 'merge-same-line', field.label)));
    list.appendChild(box);
  }
  if (plan.same.length > 0) {
    const box = document.createElement('div');
    box.className = 'merge-same';
    box.dataset.section = 'same';
    box.appendChild(officialMergeText('div', 'merge-same-title', `Same on both (${plan.same.length})`));
    plan.same.forEach((field) => box.appendChild(officialMergeText('div', 'merge-same-line', field.label)));
    list.appendChild(box);
  }

  const previewWarning = officialMergePreviewWarning(state);
  if (previewWarning) list.appendChild(officialMergeText('p', 'help-text', previewWarning));
}

// Added fields that would push the preview past its cap are added with
// "Show in preview" off — say so up front.
function officialMergePreviewWarning(state) {
  const cap = typeof PREVIEW_FIELD_CAP === 'number' ? PREVIEW_FIELD_CAP : 6;
  const merged = computeMergedFields(state.current.fields, state.officialFields, {});
  const before = state.current.fields.filter((f) => f.showInPreview !== false).length;
  const turnedOff = merged.filter((f) => state.plan.added.some((a) => a.id === f.id) && f.showInPreview === false
    && state.officialFields.find((o) => o.id === f.id)?.showInPreview !== false);
  if (turnedOff.length === 0) return '';
  return `The preview shows at most ${cap} fields (your form already has ${before}), so ${turnedOff.map((f) => f.label).join(', ')} will be added with "Show in preview" off.`;
}

// The officialForms listener fired while the screen is open: the screen keeps
// the version it opened with, and says that a newer one exists.
function onOfficialFormsChangedForMerge() {
  const state = officialMergeState;
  if (!state) return;
  const latest = officialForms.get(officialFormId(state.season, state.formType));
  const banner = officialMergeEl('official-merge-notice');
  if (!banner) return;
  if (latest && latest.version > state.official.version) {
    banner.textContent = `A newer official version (${latest.version}) was published while this is open. This merge uses version ${state.official.version}. When you finish or cancel, the notice shows again for version ${latest.version}.`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
    banner.textContent = '';
  }
}

function closeOfficialMerge() {
  officialMergeState = null;
  const modal = officialMergeEl('official-merge-modal');
  if (modal) modal.classList.add('hidden');
  const list = officialMergeEl('official-merge-list');
  if (list) list.textContent = '';
}

// Cancel / X / click-out: asks first only when the user has changed a choice.
function requestCloseOfficialMerge() {
  const state = officialMergeState;
  if (!state || state.busy) return;
  const dirty = Object.values(state.choices).some((c) => c !== 'mine');
  if (!dirty) { closeOfficialMerge(); return; }
  showConfirmModal({
    title: 'Discard changes?',
    message: 'The merge will not happen and your choices on this screen will be discarded.',
    confirmLabel: 'Discard',
    danger: true,
    onConfirm: () => { if (officialMergeState === state && !state.busy) closeOfficialMerge(); }
  });
}

async function confirmOfficialMerge() {
  const state = officialMergeState;
  if (!state || state.busy) return;
  const teamId = currentTeamData && currentTeamData.id;
  const errEl = officialMergeEl('official-merge-error');
  const confirmBtn = officialMergeEl('btn-official-merge-confirm');
  const cancelBtn = officialMergeEl('btn-official-merge-cancel');
  errEl.textContent = '';
  state.busy = true;
  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  confirmBtn.textContent = 'Merging...';
  const choices = { ...state.choices };
  try {
    await replaceTeamForm({
      teamId, season: state.season, formType: state.formType, action: 'merge',
      appliedVersion: state.official.version, basisJson: state.basisJson,
      computeNext: (cur) => {
        const fields = computeMergedFields(cur.fields, state.officialFields, choices);
        const ids = new Set(fields.map((f) => f.id));
        return {
          fields,
          // A retired field that this merge brought back is a normal field again.
          retiredFields: (cur.retiredFields || []).filter((r) => r && !ids.has(r.id)),
          baseVersion: state.official.version,
          handledVersion: state.official.version
        };
      }
    });
  } catch (err) {
    console.error('Merge failed:', err);
    if (officialMergeState !== state) return;
    state.busy = false;
    confirmBtn.disabled = false;
    cancelBtn.disabled = false;
    confirmBtn.textContent = 'Merge';
    errEl.textContent = describeOfficialFormErrorForUser(err);
    return;
  }
  const version = state.official.version;
  const word = officialFormTypeWord(state.formType);
  closeOfficialMerge();
  setOfficialFormsStatus('success', `Merged official version ${version} into your ${word} scouting form. The previous form was saved (Restore previous form).`);
}

document.addEventListener('DOMContentLoaded', () => {
  const on = (id, evt, fn) => { const el = officialMergeEl(id); if (el) el.addEventListener(evt, fn); };
  on('btn-official-merge-cancel', 'click', requestCloseOfficialMerge);
  on('btn-official-merge-close', 'click', requestCloseOfficialMerge);
  on('official-merge-modal-overlay', 'click', requestCloseOfficialMerge);
  on('btn-official-merge-confirm', 'click', confirmOfficialMerge);
});
