// ====== Auth: Google + Email/Password Sign-In & State Management ======

const $ = (id) => document.getElementById(id);
const screenLogin = $('screen-login');
const screenTeam = $('screen-team');
const screenMain = $('screen-main');
const screenVerifyEmail = $('screen-verify-email');
const screenForgotPassword = $('screen-forgot-password');
const loadingOverlay = $('loading-overlay');
const loadingText = $('loading-text');

// Currently authenticated user
let currentUser = null;

// Firestore-backed profile for the current user (displayName the user chose, email, photoURL)
let currentUserProfile = null;

/**
 * Load (or create) this user's Firestore profile, without ever clobbering a
 * display name the user has already chosen for themselves.
 *
 * Split across two documents so email can stay private while displayName/photo
 * stay broadly visible to teammates:
 *   users/{uid}                 — displayName, photoURL (not sensitive)
 *   users/{uid}/private/contact — email (captain + self only, see firestore.rules)
 */
async function ensureUserProfile(user) {
  const ref = db.collection('users').doc(user.uid);
  const contactRef = ref.collection('private').doc('contact');
  let profile;

  try {
    const doc = await ref.get();
    if (doc.exists) {
      profile = doc.data();
      const updates = {};
      if (user.photoURL && profile.photoURL !== user.photoURL) updates.photoURL = user.photoURL;
      if (!profile.displayName && user.displayName) updates.displayName = user.displayName;
      // Self-heal: this doc predates the public/private split and still has a raw email on it — move it off.
      if (profile.email) updates.email = firebase.firestore.FieldValue.delete();
      if (Object.keys(updates).length > 0) {
        await ref.set(updates, { merge: true });
        profile = { ...profile, ...updates, email: undefined };
      }
    } else {
      profile = { displayName: user.displayName || '', photoURL: user.photoURL || null };
      await ref.set({ ...profile, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    }
  } catch (err) {
    console.warn('Failed to load/create user profile:', err);
    profile = { displayName: user.displayName || '', photoURL: user.photoURL || null };
  }

  try {
    await contactRef.set({
      email: user.email || '',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (err) {
    console.warn('Failed to sync private contact doc:', err);
  }

  currentUserProfile = { displayName: profile.displayName || '', photoURL: profile.photoURL || null, email: user.email || '' };
  return currentUserProfile;
}

/**
 * Keep userTeams/{uid} (a denormalized {teamId, role} pointer) in sync with the
 * real teams/{teamId} document. This is what lets a captain's rules-check "is this
 * requester the captain of the SAME team as the profile they're reading" happen
 * without ever needing read access to the (member-gated) team document itself.
 * Self-write only, and the write rule cross-validates against the real team doc,
 * so this can't be forged to claim a membership/captaincy that isn't real.
 */
async function ensureUserTeamPointer(uid, teamId, role) {
  try {
    const ref = db.collection('userTeams').doc(uid);
    const doc = await ref.get();
    if (!doc.exists || doc.data().teamId !== teamId || doc.data().role !== role) {
      await ref.set({ teamId, role });
    }
  } catch (err) {
    console.warn('Failed to sync userTeams pointer:', err);
  }
}

/**
 * Backfill joinCodes/{code} for a team created before that lookup collection
 * existed, so new members can still join it by code. Only the captain can do
 * this (matches the joinCodes create rule), and it's a no-op once it exists.
 */
async function ensureJoinCodeDoc(teamId, joinCode) {
  if (!joinCode) return;
  try {
    const ref = db.collection('joinCodes').doc(joinCode);
    const doc = await ref.get();
    if (!doc.exists) {
      await ref.set({ teamId });
    }
  } catch (err) {
    console.warn('Failed to sync joinCodes entry:', err);
  }
}

/**
 * The name to show for the current user: their chosen display name first,
 * falling back to whatever Firebase Auth knows (Google name, then email).
 */
function getCurrentUserDisplayName() {
  if (currentUserProfile && currentUserProfile.displayName) return currentUserProfile.displayName;
  if (currentUser && currentUser.displayName) return currentUser.displayName;
  if (currentUser && currentUser.email) return currentUser.email;
  return 'Unknown';
}

/**
 * Show a loading spinner with a message.
 */
function showLoading(message) {
  loadingText.textContent = message;
  loadingOverlay.classList.remove('hidden');
}

/**
 * Hide the loading spinner.
 */
function hideLoading() {
  loadingOverlay.classList.add('hidden');
}

/**
 * Switch to a screen by id.
 */
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
}

/**
 * Show an error on a specific element.
 */
function showError(elementId, message) {
  const el = document.getElementById(elementId);
  el.textContent = message;
}

function clearErrors() {
  document.querySelectorAll('.error-message').forEach(el => el.textContent = '');
  document.querySelectorAll('.success-message').forEach(el => el.textContent = '');
}

// ====== Auth Tab Switching (Sign In / Sign Up) ======
document.querySelectorAll('#auth-tabs .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#auth-tabs .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const tabName = tab.dataset.tab;
    document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
    document.getElementById('tab-' + tabName).classList.add('active');
    clearErrors();
  });
});

// ====== Helper: Firebase error code → user-friendly message ======
function friendlyAuthError(code) {
  const map = {
    'auth/user-not-found': 'No account found with this email address.',
    'auth/wrong-password': 'Incorrect password. Please try again.',
    'auth/invalid-credential': 'Invalid email or password. Please try again.',
    'auth/invalid-email': 'Please enter a valid email address.',
    'auth/email-already-in-use': 'An account with this email already exists. Try signing in instead.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
    'auth/user-disabled': 'This account has been disabled.',
    'auth/operation-not-allowed': 'Email/password sign-in is not enabled. Please contact support.',
    'auth/network-request-failed': 'Network error. Check your internet connection and try again.',
  };
  return map[code] || 'Something went wrong. Please try again.';
}

// ====== SIGN UP ======
$('btn-signup').addEventListener('click', async () => {
  clearErrors();
  const email = $('input-signup-email').value.trim();
  const password = $('input-signup-password').value;
  const confirm = $('input-signup-confirm').value;

  // Client-side validation
  if (!email) {
    showError('signup-error', 'Please enter an email address.');
    return;
  }
  if (!password) {
    showError('signup-error', 'Please enter a password.');
    return;
  }
  if (password.length < 6) {
    showError('signup-error', 'Password must be at least 6 characters.');
    return;
  }
  if (password !== confirm) {
    showError('signup-error', 'Passwords do not match.');
    return;
  }

  showLoading('Creating account...');
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, password);

    // Send verification email
    await cred.user.sendEmailVerification();

    hideLoading();
    // Show verify-email screen
    $('verify-email-display').textContent = cred.user.email;
    showScreen('screen-verify-email');
  } catch (err) {
    hideLoading();
    console.error('Sign up error:', err);
    showError('signup-error', friendlyAuthError(err.code));
  }
});

// ====== SIGN IN ======
$('btn-signin').addEventListener('click', async () => {
  clearErrors();
  const email = $('input-signin-email').value.trim();
  const password = $('input-signin-password').value;

  if (!email) {
    showError('signin-error', 'Please enter your email address.');
    return;
  }
  if (!password) {
    showError('signin-error', 'Please enter your password.');
    return;
  }

  showLoading('Signing in...');
  try {
    const cred = await auth.signInWithEmailAndPassword(email, password);

    // Check email verification
    if (!cred.user.emailVerified) {
      hideLoading();
      $('verify-email-display').textContent = cred.user.email;
      showScreen('screen-verify-email');
      return;
    }

    // Email is verified — auth state observer will handle navigation
    hideLoading();
  } catch (err) {
    hideLoading();
    console.error('Sign in error:', err);
    showError('signin-error', friendlyAuthError(err.code));
  }
});

// ====== GOOGLE SIGN-IN ======
$('btn-google-login').addEventListener('click', async () => {
  clearErrors();
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    await auth.signInWithPopup(provider);
    // Google accounts are pre-verified — auth state observer handles navigation
  } catch (err) {
    console.error('Google login error:', err);
    let msg = 'Failed to sign in. Please try again.';
    if (err.code === 'auth/popup-closed-by-user') {
      msg = 'Sign-in was cancelled.';
    } else if (err.code === 'auth/popup-blocked') {
      msg = 'Pop-up was blocked. Please allow pop-ups for this site.';
    }
    showError('login-error', msg);
  }
});

// ====== FORGOT PASSWORD ======
$('btn-forgot-password').addEventListener('click', () => {
  clearErrors();
  showScreen('screen-forgot-password');
});

$('btn-back-to-login').addEventListener('click', () => {
  clearErrors();
  showScreen('screen-login');
});

$('btn-back-to-login-from-reset').addEventListener('click', () => {
  clearErrors();
  showScreen('screen-login');
});

$('btn-send-reset').addEventListener('click', async () => {
  clearErrors();
  const email = $('input-reset-email').value.trim();

  if (!email) {
    showError('reset-error', 'Please enter your email address.');
    return;
  }

  showLoading('Sending reset link...');
  try {
    await auth.sendPasswordResetEmail(email);
    hideLoading();
    $('reset-success').textContent = 'Password reset link sent! Check your inbox.';
    $('input-reset-email').value = '';
  } catch (err) {
    hideLoading();
    console.error('Password reset error:', err);
    if (err.code === 'auth/user-not-found') {
      showError('reset-error', 'No account found with this email address.');
    } else if (err.code === 'auth/invalid-email') {
      showError('reset-error', 'Please enter a valid email address.');
    } else {
      showError('reset-error', friendlyAuthError(err.code));
    }
  }
});

// ====== SET NEW PASSWORD (from oobCode in reset link) ======
// Check if we have a password reset oobCode in the URL
function checkForPasswordResetCode() {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode');
  const oobCode = params.get('oobCode');

  if (mode === 'resetPassword' && oobCode) {
    // Store the code and show the set-password screen
    window.__resetOobCode = oobCode;
    showScreen('screen-set-password');
    // Clean URL without refreshing
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

// Run on page load
checkForPasswordResetCode();

$('btn-set-password').addEventListener('click', async () => {
  clearErrors();
  const newPassword = $('input-new-password').value;
  const confirmPassword = $('input-new-password-confirm').value;

  if (!newPassword) {
    showError('set-password-error', 'Please enter a new password.');
    return;
  }
  if (newPassword.length < 6) {
    showError('set-password-error', 'Password must be at least 6 characters.');
    return;
  }
  if (newPassword !== confirmPassword) {
    showError('set-password-error', 'Passwords do not match.');
    return;
  }
  if (!window.__resetOobCode) {
    showError('set-password-error', 'Invalid or expired reset link. Please request a new one.');
    return;
  }

  showLoading('Resetting password...');
  try {
    await auth.confirmPasswordReset(window.__resetOobCode, newPassword);
    hideLoading();
    $('set-password-success').textContent = 'Password reset successfully! You can now sign in with your new password.';
    $('input-new-password').value = '';
    $('input-new-password-confirm').value = '';
    window.__resetOobCode = null;
  } catch (err) {
    hideLoading();
    console.error('Set password error:', err);
    if (err.code === 'auth/expired-action-code') {
      showError('set-password-error', 'This reset link has expired. Please request a new one.');
    } else if (err.code === 'auth/invalid-action-code') {
      showError('set-password-error', 'Invalid reset link. Please request a new one.');
    } else if (err.code === 'auth/weak-password') {
      showError('set-password-error', 'Password must be at least 6 characters.');
    } else {
      showError('set-password-error', friendlyAuthError(err.code));
    }
  }
});

// ====== VERIFY EMAIL SCREEN ======
$('btn-resend-verification').addEventListener('click', async () => {
  clearErrors();
  if (!currentUser) {
    showError('verify-error', 'You are not signed in. Please go back and sign in again.');
    return;
  }

  showLoading('Sending verification email...');
  try {
    await currentUser.sendEmailVerification();
    hideLoading();
    showError('verify-error', 'Verification email resent! Check your inbox.');
  } catch (err) {
    hideLoading();
    console.error('Resend verification error:', err);
    showError('verify-error', 'Failed to resend. Please try again.');
  }
});

$('btn-check-verified').addEventListener('click', async () => {
  clearErrors();
  if (!currentUser) {
    showError('verify-error', 'You are not signed in. Please go back and sign in again.');
    return;
  }

  showLoading('Checking verification status...');
  try {
    // Reload user to get fresh emailVerified status
    await currentUser.reload();
    const freshUser = auth.currentUser;

    if (freshUser && freshUser.emailVerified) {
      hideLoading();
      // Proceed to team lookup (auth state observer will handle it)
      // But we need to trigger the flow manually since the observer already ran
      await handleAuthenticatedUser(freshUser);
    } else {
      hideLoading();
      showError('verify-error', 'Email not verified yet. Please check your inbox and click the verification link, then try again.');
    }
  } catch (err) {
    hideLoading();
    console.error('Check verified error:', err);
    showError('verify-error', 'Failed to check verification status. Please try again.');
  }
});

$('btn-verify-sign-out').addEventListener('click', async () => {
  await signOut();
});

// ====== SIGN OUT ======
async function signOut() {
  try {
    await auth.signOut();
    showScreen('screen-login');
  } catch (err) {
    console.error('Sign out error:', err);
  }
}

$('btn-sign-out').addEventListener('click', signOut);
$('btn-main-sign-out').addEventListener('click', signOut);

// ====== Handle authenticated user (team lookup + navigation) ======
async function handleAuthenticatedUser(user) {
  currentUser = user;
  await ensureUserProfile(user);
  const displayName = getCurrentUserDisplayName();

  // Update user info in team screen
  $('user-avatar').src = user.photoURL || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(displayName);
  $('user-avatar').alt = displayName;
  $('user-name').textContent = displayName;

  // Check if user belongs to a team
  showLoading('Looking up your team...');
  try {
    const team = await getUserTeam(user.uid);
    hideLoading();
    if (team) {
      const myRole = (team.roles && team.roles[user.uid]) || 'member';
      await ensureUserTeamPointer(user.uid, team.id, myRole);
      if (myRole === 'captain') {
        await ensureJoinCodeDoc(team.id, team.joinCode);
      }

      $('main-team-name').textContent = team.name || 'Your Team';
      // Show join code on dashboard if available
      if (team.joinCode) {
        if (typeof showJoinCodeOnDashboard === 'function') {
          showJoinCodeOnDashboard(team.joinCode);
        }
      }
      // Load My Team tab data
      if (typeof loadTeamMembers === 'function') {
        loadTeamMembers(team.id, team);
      }
      // Set currentTeamData for other modules (dynamic-form, form-builder) that need it
      if (typeof currentTeamData !== 'undefined') {
        currentTeamData = team; // Store full team doc (id, name, joinCode, roles, permissions, members)
      }
      if (typeof updatePermissionUI === 'function') {
        updatePermissionUI();
      }
      showScreen('screen-main');
    } else {
      clearErrors();
      showScreen('screen-team');
    }
  } catch (err) {
    hideLoading();
    console.error('Team lookup error:', err);
    showError('join-error', 'Failed to look up team. Please try again.');
    showScreen('screen-team');
  }
}

// ====== Auth State Observer ======
auth.onAuthStateChanged(async (user) => {
  if (user) {
    currentUser = user;

    // Check if this is an email/password user who hasn't verified their email
    // Google users always have emailVerified = true, so this only catches email/password users
    if (!user.emailVerified) {
      // Check if the provider is Google (which means email is already verified by Google)
      const isGoogleUser = user.providerData &&
        user.providerData.some(p => p.providerId === 'google.com');

      if (!isGoogleUser) {
        // Email/password user with unverified email → show verify screen
        $('verify-email-display').textContent = user.email;
        showScreen('screen-verify-email');
        return;
      }
      // Google user — emailVerified should be true, but just in case, fall through
    }

    // User is fully authenticated (Google or verified email) → proceed
    await handleAuthenticatedUser(user);
  } else {
    currentUser = null;
    showScreen('screen-login');
  }
});

// ====== Enter key support ======
$('input-signin-email').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-signin').click();
});
$('input-signin-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-signin').click();
});
$('input-signup-email').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-signup').click();
});
$('input-signup-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-signup').click();
});
$('input-signup-confirm').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-signup').click();
});
$('input-reset-email').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-send-reset').click();
});

/**
 * Helper functions for permission checks
 */
function getCurrentUserRole() {
  if (!currentUser || !currentTeamData) return 'member';
  if (currentTeamData.roles && currentTeamData.roles[currentUser.uid] === 'captain') {
    return 'captain';
  }
  return 'member';
}

function canUserEditTemplates() {
  if (!currentUser || !currentTeamData) return false;
  if (getCurrentUserRole() === 'captain') return true;
  if (currentTeamData.permissions && 
      currentTeamData.permissions[currentUser.uid] && 
      currentTeamData.permissions[currentUser.uid].canEditTemplates === true) {
    return true;
  }
  return false;
}

function canUserEditOtherEntries(entry) {
  if (!currentUser || !currentTeamData) return false;
  if (entry && entry.scoutedBy === currentUser.uid) return true;
  if (getCurrentUserRole() === 'captain') return true;
  if (currentTeamData.permissions && 
      currentTeamData.permissions[currentUser.uid] && 
      currentTeamData.permissions[currentUser.uid].canEditOtherEntries === true) {
    return true;
  }
  return false;
}

function updatePermissionUI() {
  const canEditTmpl = canUserEditTemplates();
  const pitSection = document.getElementById('pit-form-config-section');
  const matchSection = document.getElementById('match-form-config-section');
  if (pitSection) pitSection.style.display = canEditTmpl ? 'block' : 'none';
  if (matchSection) matchSection.style.display = canEditTmpl ? 'block' : 'none';
}

/**
 * Query Firestore to find which team a user belongs to.
 * Scans all teams where members array contains the uid.
 */
async function getUserTeam(uid) {
  const snapshot = await db.collection('teams')
    .where('members', 'array-contains', uid)
    .limit(1)
    .get();

  if (snapshot.empty) return null;

  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
}
