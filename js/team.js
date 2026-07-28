// ====== Team Join / Create Logic ======

// Store the current team data (set after create or join)
let currentTeamData = null;

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    // Update tab buttons
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    // Update tab content
    const tabName = tab.dataset.tab;
    if (tabName) {
      document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
      const contentEl = document.getElementById('tab-' + tabName);
      if (contentEl) {
        contentEl.classList.add('active');
      }
    }

    // Clear errors
    clearErrors();
  });
});

// ====== Generate a random join code ======
function generateJoinCode() {
  const prefix = 'FE2O3';
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1 to avoid confusion
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `${prefix}-${suffix}`;
}

// ====== Show join code on dashboard ======
function showJoinCodeOnDashboard(joinCode) {
  const dashboardCode = document.getElementById('dashboard-join-code');
  const dashboardCodeValue = document.getElementById('dashboard-code-value');
  if (dashboardCode && dashboardCodeValue) {
    dashboardCodeValue.textContent = joinCode;
    dashboardCode.classList.remove('hidden');
  }
}

// ====== Copy to clipboard helper ======
function setupCopyButton(btnId, codeId) {
  const btn = document.getElementById(btnId);
  const codeEl = document.getElementById(codeId);
  if (!btn || !codeEl) return;

  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(codeEl.textContent);
      const originalText = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = originalText; }, 2000);
    } catch (err) {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = codeEl.textContent;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    }
  });
}

// Setup copy buttons
setupCopyButton('btn-copy-created-code', 'created-join-code');
setupCopyButton('btn-copy-dashboard-code', 'dashboard-code-value');

// ====== Create Team ======
$('btn-create-team').addEventListener('click', async () => {
  clearErrors();
  const teamName = $('input-team-name').value.trim();

  if (!teamName) {
    showError('create-error', 'Please enter a team name.');
    return;
  }

  if (!currentUser) {
    showError('create-error', 'You must be signed in to create a team.');
    return;
  }

  showLoading('Creating your team...');
  try {
    const joinCode = generateJoinCode();

    // Check if join code is unique via the public lookup collection (a plain
    // query against `teams` can't be used for this anymore now that team reads
    // are member-gated — a brand new team's creator isn't a member of anything yet)
    const codeDoc = await db.collection('joinCodes').doc(joinCode).get();
    if (codeDoc.exists) {
      // Extremely unlikely collision — just regenerate
      hideLoading();
      showError('create-error', 'Please try again (code collision).');
      return;
    }

    // Pre-generate the ID so we can create the team doc, then the joinCodes
    // lookup that validates against it, sequentially (avoids any ambiguity
    // around rules reading same-batch pending writes).
    const teamRef = db.collection('teams').doc();
    await teamRef.set({
      name: teamName,
      joinCode: joinCode,
      members: [currentUser.uid],
      roles: { [currentUser.uid]: 'captain' },
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: currentUser.uid
    });

    await db.collection('joinCodes').doc(joinCode).set({ teamId: teamRef.id });
    await db.collection('userTeams').doc(currentUser.uid).set({ teamId: teamRef.id, role: 'captain' });

    // Store team data for dashboard
    currentTeamData = {
      id: teamRef.id,
      name: teamName,
      joinCode: joinCode
    };

    // Show the join code on the create tab
    const joinCodeCreated = document.getElementById('join-code-created');
    const createdJoinCode = document.getElementById('created-join-code');
    createdJoinCode.textContent = joinCode;
    joinCodeCreated.classList.remove('hidden');

    hideLoading();
    // Navigate to main app
    $('main-team-name').textContent = teamName;
    showJoinCodeOnDashboard(joinCode);
    showScreen('screen-main');
  } catch (err) {
    hideLoading();
    console.error('Create team error:', err);
    showError('create-error', 'Failed to create team. Please try again.');
  }
});

// ====== Join Team ======
$('btn-join-team').addEventListener('click', async () => {
  clearErrors();
  const joinCode = $('input-join-code').value.trim().toUpperCase();

  if (!joinCode) {
    showError('join-error', 'Please enter a join code.');
    return;
  }

  if (!currentUser) {
    showError('join-error', 'You must be signed in to join a team.');
    return;
  }

  showLoading('Joining team...');
  try {
    // Resolve the join code to a team ID via the public lookup collection —
    // a direct query against `teams` won't work for a non-member anymore.
    const codeDoc = await db.collection('joinCodes').doc(joinCode).get();
    if (!codeDoc.exists) {
      hideLoading();
      showError('join-error', 'No team found with that join code. Check with your team lead.');
      return;
    }

    const teamId = codeDoc.data().teamId;
    const teamRef = db.collection('teams').doc(teamId);

    // If we're already a member, we can read the doc directly and just go to the dashboard.
    try {
      const existingSnap = await teamRef.get();
      const existingData = existingSnap.data();
      if (existingData.members && existingData.members.includes(currentUser.uid)) {
        hideLoading();
        currentTeamData = { id: teamId, name: existingData.name, joinCode: existingData.joinCode };
        $('main-team-name').textContent = existingData.name;
        showJoinCodeOnDashboard(existingData.joinCode);
        showScreen('screen-main');
        return;
      }
    } catch (notYetMemberErr) {
      // Expected: reading the full team doc is denied until we're actually a member — fall through to join.
    }

    // Scoped self-join: rules only allow this specific update (appending our own uid
    // and nothing else) for a non-member, which is exactly what's happening here.
    await teamRef.update({
      members: firebase.firestore.FieldValue.arrayUnion(currentUser.uid)
    });

    // Now that we're a member, we can read the full doc.
    const joinedSnap = await teamRef.get();
    const teamData = joinedSnap.data();

    await db.collection('userTeams').doc(currentUser.uid).set({ teamId, role: 'member' });

    currentTeamData = { id: teamId, name: teamData.name, joinCode: teamData.joinCode };

    hideLoading();
    $('main-team-name').textContent = teamData.name;
    showJoinCodeOnDashboard(teamData.joinCode);
    showScreen('screen-main');
  } catch (err) {
    hideLoading();
    console.error('Join team error:', err);
    showError('join-error', 'Failed to join team. Please try again.');
  }
});

// Allow pressing Enter to submit
$('input-join-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-join-team').click();
});
$('input-team-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-create-team').click();
});