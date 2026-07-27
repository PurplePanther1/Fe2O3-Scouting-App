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

    // Check if join code is unique
    const existing = await db.collection('teams')
      .where('joinCode', '==', joinCode)
      .get();

    if (!existing.empty) {
      // Extremely unlikely collision — just regenerate
      hideLoading();
      showError('create-error', 'Please try again (code collision).');
      return;
    }

    // Create the team document with roles
    const teamRef = await db.collection('teams').add({
      name: teamName,
      joinCode: joinCode,
      members: [currentUser.uid],
      roles: { [currentUser.uid]: 'captain' },
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: currentUser.uid
    });

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
    // Find team by join code
    const snapshot = await db.collection('teams')
      .where('joinCode', '==', joinCode)
      .limit(1)
      .get();

    if (snapshot.empty) {
      hideLoading();
      showError('join-error', 'No team found with that join code. Check with your team lead.');
      return;
    }

    const teamDoc = snapshot.docs[0];
    const teamData = teamDoc.data();

    // Store team data for dashboard
    currentTeamData = {
      id: teamDoc.id,
      name: teamData.name,
      joinCode: teamData.joinCode
    };

    // Check if user is already a member
    if (teamData.members && teamData.members.includes(currentUser.uid)) {
      hideLoading();
      // Already a member — just go to main
      $('main-team-name').textContent = teamData.name;
      showJoinCodeOnDashboard(teamData.joinCode);
      showScreen('screen-main');
      return;
    }

    // Add user to team members
    await teamDoc.ref.update({
      members: firebase.firestore.FieldValue.arrayUnion(currentUser.uid)
    });

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