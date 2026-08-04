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

// Every team the current user belongs to (multi-team support) — populated on
// login from getUserTeams(). currentTeamData/currentTeamId (team.js/members.js)
// point at whichever one of these is currently "active" (see switchActiveTeam()).
let myTeams = [];

// Firestore-backed profile for the current user (displayName the user chose, email, photoURL)
let currentUserProfile = null;

/**
 * Load (or create) this user's Firestore profile, without ever clobbering a
 * display name the user has already chosen for themselves.
 *
 * Split across two documents so email can stay private while displayName/photo
 * stay broadly visible to teammates:
 *   users/{uid}                 — displayName, photoURL (not sensitive)
 *   users/{uid}/private/contact — email (self only; teammates who can see it
 *                                 read the per-team copy at
 *                                 teams/{teamId}/memberContacts/{uid} instead)
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

  currentUserProfile = {
    displayName: profile.displayName || '',
    photoURL: profile.photoURL || null,
    email: user.email || '',
    // True only once the user has explicitly gone through saveDisplayName() —
    // an auto-filled Google name doesn't count until they've actually confirmed it.
    displayNameConfirmed: !!profile.displayNameConfirmed
  };
  return currentUserProfile;
}

/**
 * Keep teams/{teamId}/memberContacts/{uid} (this user's email, denormalized
 * per team) in sync with their real email. This is what lets a team's
 * captain (or a teammate with canViewMemberEmails) see this member's email
 * scoped to THIS team specifically — replaces the old userTeams-based
 * cross-user pointer comparison, which could only express "shared team"
 * correctly when everyone had exactly one. Self-write only, and the write
 * rule cross-validates against the real team doc, so this can't be forged to
 * claim a membership that isn't real.
 */
async function ensureMemberContact(teamId, uid, email) {
  try {
    const ref = db.collection('teams').doc(teamId).collection('memberContacts').doc(uid);
    const doc = await ref.get();
    if (!doc.exists || doc.data().email !== email) {
      await ref.set({ email: email || '' });
    }
  } catch (err) {
    console.warn(`Failed to sync memberContacts for team ${teamId}:`, err);
  }
}

/**
 * Live-sync currentTeamData with the real teams/{teamId} document, the same way
 * pit/match scouting status already stay live via onSnapshot elsewhere. Without
 * this, changes another team member makes (a captaincy transfer, a permission
 * edit, a pinned event) only show up for everyone else after a manual refresh.
 */
let teamDocUnsubscribe = null;

function watchTeamDoc(teamId) {
  if (teamDocUnsubscribe) {
    teamDocUnsubscribe();
    teamDocUnsubscribe = null;
  }
  if (!teamId) return;

  teamDocUnsubscribe = db.collection('teams').doc(teamId).onSnapshot((doc) => {
    if (!doc.exists) return;
    const teamData = { id: doc.id, ...doc.data() };

    if (typeof currentTeamData !== 'undefined') {
      currentTeamData = teamData;
    }

    const nameEl = document.getElementById('main-team-name');
    if (nameEl) nameEl.textContent = teamData.name || 'Your Team';

    if (typeof loadTeamMembers === 'function') {
      loadTeamMembers(teamId, teamData);
    }
    if (typeof updatePermissionUI === 'function') {
      updatePermissionUI();
    }
    if (typeof updatePinButtonUI === 'function') {
      updatePinButtonUI();
    }
    if (typeof renderPinnedEventsList === 'function') {
      renderPinnedEventsList();
    }
  }, (err) => {
    console.warn('Team doc listener error:', err);
  });
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
 * Save the user's chosen display name to Firestore and update currentUserProfile.
 * The single write path behind every display-name entry point in the app: the
 * My Team tab's "Your Display Name" field, the create/join team screen's inline
 * prompt, and the post-login "set a display name" gate for existing users.
 * Always marks the name as explicitly confirmed — calling this at all means the
 * user saw the field (pre-filled or not) and pressed a button to proceed with it.
 */
async function saveDisplayName(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('Please enter a name.');
  if (!currentUser) throw new Error('You must be signed in.');

  await db.collection('users').doc(currentUser.uid).set({
    displayName: trimmed,
    photoURL: currentUser.photoURL || null,
    displayNameConfirmed: true,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  currentUserProfile = { ...(currentUserProfile || {}), displayName: trimmed, displayNameConfirmed: true };
  return trimmed;
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

  // screen-team's join-code/team-name fields and "team created" card belong
  // to whatever create/join attempt was last in progress — stale if a
  // different account reaches this screen in the same tab (e.g. delete
  // account → create a new one, without a refresh). Reset them every time
  // this screen is shown rather than at each individual call site, so a
  // future path that lands here doesn't need to remember to do it too. The
  // display name field is deliberately left alone — it's meant to stay
  // pre-filled with the signed-in user's known name.
  if (screenId === 'screen-team') {
    // Always land on the Join Team tab, regardless of whichever was last
    // active — same idea as resetAuthTabs() always resetting Sign In/Sign Up
    // back to Sign In, applied generally here rather than at each individual
    // call site that shows this screen.
    if (typeof resetTeamTabs === 'function') resetTeamTabs();

    const joinCodeInput = document.getElementById('input-join-code');
    if (joinCodeInput) joinCodeInput.value = '';
    const teamNameInput = document.getElementById('input-team-name');
    if (teamNameInput) teamNameInput.value = '';
    const joinCodeCreated = document.getElementById('join-code-created');
    if (joinCodeCreated) joinCodeCreated.classList.add('hidden');

    // This screen means "no current team" by definition — clear these too,
    // not just the form fields above. Previously only leaveTeam() did this,
    // so any other path reaching screen-team (e.g. a brand-new account that
    // never joined a team) left currentTeamData/currentTeamId pointing at
    // whatever team a PRIOR account in this same tab had, which later made
    // delete-account try team-scoped writes (self-leave, anonymization)
    // against a team the current account was never a member of.
    if (typeof currentTeamData !== 'undefined') currentTeamData = null;
    if (typeof currentTeamId !== 'undefined') currentTeamId = null;
    if (typeof myTeams !== 'undefined') myTeams = [];
  }
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

/**
 * Clear every credential field across the Sign In / Sign Up / Forgot Password
 * forms. Called on sign-out and whenever the user switches between these
 * forms, so a previously entered email/password never lingers into a
 * different form or a later session.
 */
function clearAuthFormFields() {
  ['input-signin-email', 'input-signin-password',
   'input-signup-email', 'input-signup-password', 'input-signup-confirm',
   'input-reset-email'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
}

// ====== Show/Hide Password Toggles (every password field in the app) ======
document.querySelectorAll('.btn-toggle-password').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? '👁' : '🙈';
    btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  });
});

// ====== Auth Tab Switching (Sign In / Sign Up) ======
// Exposed as a function so sign-out can reset it back to Sign In — a page
// refresh gets this for free from the HTML defaults, but nothing previously
// reset it after sign-out/account-deletion within the same tab, so it could
// stay stuck on Sign Up.
function resetAuthTabs() {
  document.querySelectorAll('#auth-tabs .tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === 'signin');
  });
  document.querySelectorAll('.auth-form').forEach(f => {
    f.classList.toggle('active', f.id === 'tab-signin');
  });
}

document.querySelectorAll('#auth-tabs .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#auth-tabs .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const tabName = tab.dataset.tab;
    document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
    document.getElementById('tab-' + tabName).classList.add('active');
    clearErrors();
    clearAuthFormFields();
  });
});

// ====== Helper: Firebase error code → user-friendly message ======
function friendlyAuthError(code) {
  const map = {
    'auth/user-not-found': 'No account found with this email address.',
    'auth/wrong-password': 'Incorrect password. Please try again.',
    'auth/invalid-credential': 'Invalid email or password. Please try again.',
    'auth/invalid-email': 'Please enter a valid email address.',
    // Deliberately vague — confirming "an account already exists" for this
    // email is an enumeration leak, whether hit during sign-up or Change Email.
    'auth/email-already-in-use': 'This email address can\'t be used right now. Please try a different one or contact support.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
    'auth/user-disabled': 'This account has been disabled.',
    'auth/operation-not-allowed': 'Email/password sign-in is not enabled. Please contact support.',
    'auth/network-request-failed': 'Network error. Check your internet connection and try again.',
    'auth/requires-recent-login': 'For security, please re-enter your current password to continue.',
    'auth/popup-closed-by-user': 'Sign-in was cancelled.',
    'auth/popup-blocked': 'Pop-up was blocked. Please allow pop-ups for this site.',
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
    showVerifyEmailScreen(cred.user.email);
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
      showVerifyEmailScreen(cred.user.email);
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
// Basic format check only (not full RFC 5322) — an @ with something on both
// sides and a plausible-looking TLD. This catches genuinely malformed input
// before we bother calling Firebase; it can't verify the domain is real or
// actually receives mail, since that would require a network lookup.
const EMAIL_FORMAT_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

$('btn-forgot-password').addEventListener('click', () => {
  clearErrors();
  clearAuthFormFields();
  showScreen('screen-forgot-password');
});

$('btn-back-to-login').addEventListener('click', () => {
  clearErrors();
  clearAuthFormFields();
  showScreen('screen-login');
});

$('btn-back-to-login-from-reset').addEventListener('click', () => {
  clearErrors();
  clearAuthFormFields();
  showScreen('screen-login');
});

$('btn-send-reset').addEventListener('click', async () => {
  clearErrors();
  const email = $('input-reset-email').value.trim();

  if (!email) {
    showError('reset-error', 'Please enter your email address.');
    return;
  }
  if (!EMAIL_FORMAT_REGEX.test(email)) {
    showError('reset-error', 'Please enter a valid email address.');
    return;
  }

  showLoading('Sending reset link...');
  try {
    await auth.sendPasswordResetEmail(email);
    hideLoading();
    $('reset-success').textContent = 'Password reset link sent! Check your inbox. (Check your spam/junk folder if you don\'t see it.)';
    $('input-reset-email').value = '';
  } catch (err) {
    hideLoading();
    console.error('Password reset error:', err);
    if (err.code === 'auth/user-not-found') {
      // Deliberately shown as if it succeeded — confirming "no account exists"
      // here is an enumeration leak, exactly as revealing "an account exists"
      // would be. Nothing was actually sent, but the response looks identical.
      $('reset-success').textContent = 'Password reset link sent! Check your inbox. (Check your spam/junk folder if you don\'t see it.)';
      $('input-reset-email').value = '';
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
// Polls for verification automatically instead of requiring the manual
// button — reloads the Firebase user every few seconds and checks
// emailVerified. The button stays as a fallback for whenever polling is slow
// or the tab was backgrounded (most browsers throttle timers in background
// tabs, so this alone isn't guaranteed to fire promptly).
let verifyEmailPollInterval = null;

function showVerifyEmailScreen(email) {
  $('verify-email-display').textContent = email;
  showScreen('screen-verify-email');
  startVerifyEmailPolling();
}

function startVerifyEmailPolling() {
  stopVerifyEmailPolling(); // avoid stacking multiple intervals
  verifyEmailPollInterval = setInterval(async () => {
    if (!currentUser) {
      stopVerifyEmailPolling();
      return;
    }
    try {
      await currentUser.reload();
      const freshUser = auth.currentUser;
      if (freshUser && freshUser.emailVerified) {
        stopVerifyEmailPolling();
        await handleAuthenticatedUser(freshUser);
      }
    } catch (err) {
      // Non-fatal — the manual button is still there, and the next tick tries again.
      console.warn('Email verification poll failed:', err);
    }
  }, 4000);
}

function stopVerifyEmailPolling() {
  if (verifyEmailPollInterval) {
    clearInterval(verifyEmailPollInterval);
    verifyEmailPollInterval = null;
  }
}

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
    showError('verify-error', 'Verification email resent! Check your inbox. (Check your spam/junk folder if you don\'t see it.)');
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

// ====== Set Display Name gate (existing users with a blank display name) ======
$('btn-set-display-name-continue').addEventListener('click', async () => {
  clearErrors();
  const input = $('input-set-display-name');
  const name = input.value.trim();

  if (!name) {
    showError('set-display-name-error', 'Please enter a name.');
    return;
  }
  if (!currentUser) return;

  showLoading('Saving...');
  try {
    await saveDisplayName(name);
    hideLoading();
    // Re-run the post-login flow now that the name is set — mirrors the
    // "I've verified — continue" pattern above.
    await handleAuthenticatedUser(currentUser);
  } catch (err) {
    hideLoading();
    console.error('Failed to save display name:', err);
    showError('set-display-name-error', 'Failed to save. Please try again.');
  }
});

$('input-set-display-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-set-display-name-continue').click();
});

// ====== Change Password (My Account tab, email/password accounts only) ======
function openChangePasswordModal() {
  $('input-change-password-current').value = '';
  $('input-change-password-new').value = '';
  $('input-change-password-confirm').value = '';
  $('change-password-error').textContent = '';
  $('change-password-success').textContent = '';
  $('change-password-modal').classList.remove('hidden');
}

function closeChangePasswordModal() {
  $('change-password-modal').classList.add('hidden');
}

async function saveNewPassword() {
  const errorEl = $('change-password-error');
  const successEl = $('change-password-success');
  errorEl.textContent = '';
  successEl.textContent = '';

  const currentPassword = $('input-change-password-current').value;
  const newPassword = $('input-change-password-new').value;
  const confirmPassword = $('input-change-password-confirm').value;

  if (!currentPassword) {
    errorEl.textContent = 'Please enter your current password.';
    return;
  }
  if (!newPassword || newPassword.length < 6) {
    errorEl.textContent = 'New password must be at least 6 characters.';
    return;
  }
  if (newPassword !== confirmPassword) {
    errorEl.textContent = 'New passwords do not match.';
    return;
  }
  if (!currentUser || !currentUser.email) {
    errorEl.textContent = 'You must be signed in to change your password.';
    return;
  }

  showLoading('Verifying your identity...');
  try {
    // Firebase requires a recent sign-in before allowing a password change —
    // re-entering the current password is how we satisfy that here.
    const cred = firebase.auth.EmailAuthProvider.credential(currentUser.email, currentPassword);
    await currentUser.reauthenticateWithCredential(cred);

    showLoading('Updating password...');
    await currentUser.updatePassword(newPassword);

    hideLoading();
    successEl.textContent = 'Password updated!';
    setTimeout(() => {
      closeChangePasswordModal();
    }, 1200);
  } catch (err) {
    hideLoading();
    console.error('Change password error:', err);
    errorEl.textContent = friendlyAuthError(err.code);
  }
}

$('btn-open-change-password').addEventListener('click', openChangePasswordModal);
$('btn-change-password-close').addEventListener('click', closeChangePasswordModal);
$('btn-change-password-cancel').addEventListener('click', closeChangePasswordModal);
$('change-password-modal-overlay').addEventListener('click', closeChangePasswordModal);
$('btn-change-password-save').addEventListener('click', saveNewPassword);

// ====== Change Email (My Account tab) ======
// Uses verifyBeforeUpdateEmail() rather than updateEmail() — this sends a
// confirmation link to the NEW address and Firebase only actually changes the
// account's email once that link is clicked, so no Firestore write happens here.
// ensureUserProfile() already re-syncs private/contact.email from
// currentUser.email on every login, so the next sign-in after confirming
// picks up the change automatically — no extra sync code needed.
function openChangeEmailModal() {
  if (!currentUser) return;
  const hasPasswordProvider = !!(currentUser.providerData &&
    currentUser.providerData.some(p => p.providerId === 'password'));

  $('input-change-email-password').value = '';
  $('input-change-email-new').value = '';
  $('change-email-error').textContent = '';
  $('change-email-success').textContent = '';
  $('change-email-password-field').classList.toggle('hidden', !hasPasswordProvider);
  $('change-email-google-note').classList.toggle('hidden', hasPasswordProvider);

  $('change-email-modal').classList.remove('hidden');
}

function closeChangeEmailModal() {
  $('change-email-modal').classList.add('hidden');
}

async function saveNewEmail() {
  const errorEl = $('change-email-error');
  const successEl = $('change-email-success');
  errorEl.textContent = '';
  successEl.textContent = '';

  const newEmail = $('input-change-email-new').value.trim();
  if (!newEmail) {
    errorEl.textContent = 'Please enter a new email address.';
    return;
  }
  if (!currentUser) {
    errorEl.textContent = 'You must be signed in to change your email.';
    return;
  }
  if (currentUser.email && newEmail.toLowerCase() === currentUser.email.toLowerCase()) {
    errorEl.textContent = "That's already your current email address.";
    return;
  }

  const hasPasswordProvider = !!(currentUser.providerData &&
    currentUser.providerData.some(p => p.providerId === 'password'));

  // Reauth and the actual email update are handled as two separate try/catch
  // stages — a wrong current password and a new-email-already-in-use error both
  // used to fall through to the same generic "Invalid email or password"
  // message, which is wrong for both: a reauth failure here is always a
  // password problem (the email side of that credential is our own, already-
  // correct one), and conflating it with the unrelated new-email conflict below
  // was actively confusing.
  showLoading('Verifying your identity...');
  try {
    if (hasPasswordProvider) {
      const currentPassword = $('input-change-email-password').value;
      if (!currentPassword) {
        hideLoading();
        errorEl.textContent = 'Please enter your current password.';
        return;
      }
      const cred = firebase.auth.EmailAuthProvider.credential(currentUser.email, currentPassword);
      await currentUser.reauthenticateWithCredential(cred);
    } else {
      // Google-only accounts have no password — reauthenticate with the same
      // provider/popup flow used for Google sign-in.
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await currentUser.reauthenticateWithPopup(provider);
    }
  } catch (err) {
    hideLoading();
    console.error('Change email reauth error:', err);
    if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/popup-blocked') {
      errorEl.textContent = friendlyAuthError(err.code);
    } else if (hasPasswordProvider) {
      errorEl.textContent = 'Incorrect password. Please try again.';
    } else {
      errorEl.textContent = 'Could not verify your identity. Please try again.';
    }
    return;
  }

  showLoading('Sending confirmation email...');
  try {
    await currentUser.verifyBeforeUpdateEmail(newEmail);

    hideLoading();
    successEl.textContent = `Check ${newEmail} to confirm the change. Your email here won't update until you click the link. (Check your spam/junk folder if you don't see it.)`;
    setTimeout(() => {
      closeChangeEmailModal();
    }, 4000);
  } catch (err) {
    hideLoading();
    console.error('Change email update error:', err);
    // friendlyAuthError() already keeps auth/email-already-in-use generic —
    // it never confirms whether the new address has an existing account.
    errorEl.textContent = friendlyAuthError(err.code);
  }
}

$('btn-open-change-email').addEventListener('click', openChangeEmailModal);
$('btn-change-email-close').addEventListener('click', closeChangeEmailModal);
$('btn-change-email-cancel').addEventListener('click', closeChangeEmailModal);
$('change-email-modal-overlay').addEventListener('click', closeChangeEmailModal);
$('btn-change-email-save').addEventListener('click', saveNewEmail);

// ====== SIGN OUT ======
async function signOut() {
  try {
    watchTeamDoc(null); // stop the live team doc listener
    stopVerifyEmailPolling(); // in case sign-out happened from the verify-email screen
    await auth.signOut();
    clearAuthFormFields();
    // Resets the in-memory selectedEvent/currentEventTeams/currentSelectedTeamNumber
    // and their DOM (event-search area, team lists, detail modal). Without this,
    // selectedEvent stays stale in memory, and the very next
    // activateDashboardTab()/activateScoutingSubTab() call during the next
    // login (each of which calls saveSessionState() internally) would read
    // that stale event and write it straight back into sessionStorage —
    // silently undoing clearSessionState() below.
    if (typeof clearSelectedEvent === 'function') {
      clearSelectedEvent();
    }
    if (typeof clearSessionState === 'function') {
      clearSessionState();
    }
    // In case sign-out happened from the standalone My Account view (reached
    // from the Join/Create Team screen) — don't leave screen-main stuck
    // hiding its dashboard header/tabs for whoever logs in next.
    const mainScreen = document.getElementById('screen-main');
    if (mainScreen) mainScreen.classList.remove('standalone-account-mode');
    const standaloneBackBtn = document.getElementById('btn-my-account-standalone-back');
    if (standaloneBackBtn) standaloneBackBtn.classList.add('hidden');
    // A refresh gets this reset for free from the HTML defaults — sign-out
    // needs to do it explicitly so Sign Up doesn't stay active into the next
    // session in this same tab.
    resetAuthTabs();
    showScreen('screen-login');
  } catch (err) {
    console.error('Sign out error:', err);
  }
}

$('btn-sign-out').addEventListener('click', signOut);
$('btn-main-sign-out').addEventListener('click', signOut);

// ====== My Account tab: email + Change Password gating ======
// currentUser.email (Firebase Auth) is already the source of truth for the
// signed-in user's own email — no need to read users/{uid}/private/contact,
// which exists only so *other* people (the captain) can see a teammate's email.
function renderAccountInfo() {
  if (!currentUser) return;

  const emailEl = document.getElementById('account-email-display');
  if (emailEl) emailEl.textContent = currentUser.email || '(no email on this account)';

  const hasPasswordProvider = !!(currentUser.providerData &&
    currentUser.providerData.some(p => p.providerId === 'password'));

  const changePwBtn = document.getElementById('btn-open-change-password');
  const note = document.getElementById('account-password-note');
  if (changePwBtn) changePwBtn.classList.toggle('hidden', !hasPasswordProvider);
  if (note) {
    note.textContent = hasPasswordProvider ? '' : 'Signed in with Google — no password to change.';
  }
}

// ====== Standalone My Account view (from the Join/Create Team screen, for a
// user who doesn't have a team yet — e.g. right after deleting their old
// account and signing up fresh). Reuses the same #dtab-account markup/logic
// as the normal My Account tab; just hides the dashboard header/tab bar
// (there's no team name or other tabs to show yet) and adds a Back button. ======
function openStandaloneMyAccount() {
  const mainScreen = document.getElementById('screen-main');
  if (mainScreen) mainScreen.classList.add('standalone-account-mode');
  showScreen('screen-main');
  if (typeof activateDashboardTab === 'function') activateDashboardTab('account');
  renderAccountInfo();
  const backBtn = document.getElementById('btn-my-account-standalone-back');
  if (backBtn) backBtn.classList.remove('hidden');
}

function closeStandaloneMyAccount() {
  const mainScreen = document.getElementById('screen-main');
  if (mainScreen) mainScreen.classList.remove('standalone-account-mode');
  const backBtn = document.getElementById('btn-my-account-standalone-back');
  if (backBtn) backBtn.classList.add('hidden');
  showScreen('screen-team');
}

$('btn-open-my-account-standalone').addEventListener('click', openStandaloneMyAccount);
$('btn-my-account-standalone-back').addEventListener('click', closeStandaloneMyAccount);

// ====== Handle authenticated user (team lookup + navigation) ======
async function handleAuthenticatedUser(user) {
  currentUser = user;
  // Reaching this function always means we're past the verify-email gate
  // (manually, via auto-poll, or because the account was already verified).
  stopVerifyEmailPolling();
  await ensureUserProfile(user);
  const displayName = getCurrentUserDisplayName();
  renderAccountInfo();

  // Update user info in team screen
  $('user-avatar').src = user.photoURL || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(displayName);
  $('user-avatar').alt = displayName;
  $('user-name').textContent = displayName;

  // Check if user belongs to a team
  showLoading('Looking up your team...');
  try {
    const teams = await getUserTeams(user.uid);
    hideLoading();
    if (teams.length > 0) {
      // Existing users who haven't explicitly confirmed a display name yet must
      // do so before reaching the dashboard — same blocking pattern as the
      // email-verification gate above. This also catches an auto-filled Google
      // name the user never actually chose, not just a genuinely blank one.
      // Brand-new users without a team yet are prompted inline on the create/join
      // screen instead (see the branch below), not here.
      if (!currentUserProfile || !currentUserProfile.displayNameConfirmed) {
        const nameInput = document.getElementById('input-set-display-name');
        if (nameInput) nameInput.value = (currentUserProfile && currentUserProfile.displayName) || '';
        showScreen('screen-set-display-name');
        return;
      }

      // Keep this user's per-team email copy fresh for EVERY team they
      // belong to, not just whichever one is shown below — a captain on a
      // different team than the one displayed here still needs to see an
      // up-to-date email if/when they view it.
      const myEmail = (currentUserProfile && currentUserProfile.email) || user.email || '';
      await Promise.all(teams.map(t => ensureMemberContact(t.id, user.uid, myEmail)));

      // Full list of every team this user belongs to (multi-team support) —
      // the Stage 3 switcher UI will read this directly; for now the
      // dashboard still only ever displays one team at a time.
      myTeams = teams;

      // Resolve which team is "active": whatever was last stored for this
      // uid, if it's still a team they belong to, else just the first one
      // (which is also the ONLY one for anybody still single-team — same
      // behavior as before this existed). Re-persist the resolved choice so
      // a first-ever login (nothing stored yet) primes it for next time, and
      // a stored team that's no longer valid (e.g. they left it elsewhere)
      // gets corrected rather than silently retried forever.
      const storedActiveTeamId = getStoredActiveTeamId(user.uid);
      const team = teams.find(t => t.id === storedActiveTeamId) || teams[0];
      setStoredActiveTeamId(user.uid, team.id);

      const myRole = (team.roles && team.roles[user.uid]) || 'member';
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
      // Keep currentTeamData (and everything derived from it) live from here on,
      // so role/permission/pinned-event changes made by anyone on the team show
      // up immediately without a manual refresh.
      watchTeamDoc(team.id);

      showScreen('screen-main');

      // Restore whatever tab/subtab/event this browser tab had before a
      // refresh (sessionStorage — cleared when the tab/browser closes, so a
      // brand-new session still starts clean), or fall back to the same
      // default a fresh page load starts on (Scouting → Team Information, no
      // event). Runs after showScreen so the dashboard appears immediately;
      // any event reload uses the same loading overlay a manual event
      // selection already does.
      if (typeof restoreOrDefaultSessionState === 'function') {
        restoreOrDefaultSessionState().catch(err => {
          console.error('Failed to restore session state:', err);
        });
      } else {
        if (typeof window.activateDashboardTab === 'function') {
          window.activateDashboardTab('scouting');
        }
        if (typeof window.activateScoutingSubTab === 'function') {
          window.activateScoutingSubTab('info');
        }
      }
    } else {
      clearErrors();
      // Always shown — pre-filled with whatever name is already known (Google or
      // a prior save), if any, but the user must still press Create/Join to
      // proceed, so an unconfirmed auto-filled name is never used silently.
      const nameInput = document.getElementById('input-screen-team-display-name');
      if (nameInput) nameInput.value = (currentUserProfile && currentUserProfile.displayName) || '';
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
        showVerifyEmailScreen(user.email);
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

// UI-only gate for the bulk-select/delete toolbar — the underlying deletes still go
// through canEditOrDeleteEntry() in firestore.rules, which only cares about
// canEditOtherEntries, so this has no rules-side counterpart.
function canUserBulkDelete() {
  if (!currentUser || !currentTeamData) return false;
  if (getCurrentUserRole() === 'captain') return true;
  if (currentTeamData.permissions &&
      currentTeamData.permissions[currentUser.uid] &&
      currentTeamData.permissions[currentUser.uid].canBulkDelete === true) {
    return true;
  }
  return false;
}

function canUserPinEvents() {
  if (!currentUser || !currentTeamData) return false;
  if (getCurrentUserRole() === 'captain') return true;
  if (currentTeamData.permissions &&
      currentTeamData.permissions[currentUser.uid] &&
      currentTeamData.permissions[currentUser.uid].canPinEvents === true) {
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
 * Query Firestore for every team a user belongs to (multi-team support).
 * Scans all teams where members array contains the uid — no limit, since a
 * user may belong to more than one.
 */
async function getUserTeams(uid) {
  const snapshot = await db.collection('teams')
    .where('members', 'array-contains', uid)
    .get();

  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

/**
 * The first/only team a user belongs to. Stage 1 of multi-team support keeps
 * the dashboard showing a single team — this is the one spot that still
 * legitimately needs "first team" rather than the full list; a later stage
 * (the team switcher) will replace this call site with getUserTeams() directly.
 */
async function getUserTeam(uid) {
  const teams = await getUserTeams(uid);
  return teams[0] || null;
}

// ====== Active-team persistence (multi-team support) ======
// localStorage, not sessionStorage — unlike dashboard tab/subtab/selected
// event (session-state.js, deliberately tab-scoped and cleared on sign-out),
// which team is "active" is meant to survive closing the browser entirely.
// Scoped per uid so a shared device signing into a different account doesn't
// inherit — or clobber — another account's choice.
function activeTeamStorageKey(uid) {
  return `fe2o3_active_team_${uid}`;
}

function getStoredActiveTeamId(uid) {
  try {
    return localStorage.getItem(activeTeamStorageKey(uid));
  } catch (err) {
    console.warn('Failed to read stored active team:', err);
    return null;
  }
}

function setStoredActiveTeamId(uid, teamId) {
  try {
    localStorage.setItem(activeTeamStorageKey(uid), teamId);
  } catch (err) {
    console.warn('Failed to persist active team:', err);
  }
}

/**
 * Switch which of the user's teams (myTeams) is "active" — everything the
 * dashboard shows (Scouting tabs, Pinned Events, My Team, permission checks)
 * reads currentTeamData/currentTeamId, so re-pointing those and refreshing
 * whatever depends on them is the whole job. Not called from anywhere yet —
 * Stage 3 wires this to the team-switcher UI.
 */
function switchActiveTeam(teamId) {
  if (!currentUser) return;
  const team = (myTeams || []).find(t => t.id === teamId);
  if (!team) {
    console.warn(`switchActiveTeam: ${teamId} is not one of this user's teams`);
    return;
  }
  if (currentTeamId === teamId) return; // already active — nothing to do

  setStoredActiveTeamId(currentUser.uid, teamId);

  // Set synchronously (from the already-fetched myTeams entry) rather than
  // waiting on watchTeamDoc()'s snapshot below — watchPitScoutStatus()/
  // watchMatchScoutStatus() further down read currentTeamData.id the moment
  // they're called to build their query, so it has to be correct immediately,
  // not once a network round-trip later. watchTeamDoc()'s own snapshot will
  // very shortly re-confirm/refresh this with the live doc anyway.
  currentTeamData = team;
  currentTeamId = teamId;
  $('main-team-name').textContent = team.name || 'Your Team';
  if (team.joinCode && typeof showJoinCodeOnDashboard === 'function') {
    showJoinCodeOnDashboard(team.joinCode);
  }

  // A team detail modal open at the moment of switching would otherwise keep
  // showing pit/match data scoped to the team being switched away from.
  if (typeof closeTeamDetailModal === 'function') {
    closeTeamDetailModal();
  }

  // Re-subscribes the live team-doc listener to the new team (it already
  // unsubscribes whichever team it was previously watching) — its snapshot
  // callback handles loadTeamMembers()/updatePermissionUI()/pin button/
  // pinned events for us, same as it does for any other team-doc change.
  watchTeamDoc(teamId);

  // Same reset a fresh create/join gets — land on Scouting → Team
  // Information regardless of whatever tab was active on the team being left.
  if (typeof resetDashboardOnEnterTeam === 'function') {
    resetDashboardOnEnterTeam();
  }

  // The one genuinely new case multi-team support introduces: "the active
  // team changed but the selected event didn't." watchPitScoutStatus()/
  // watchMatchScoutStatus() (pit-scout.js/match-scout.js) close over
  // currentTeamData.id at subscription time and never re-read it — until
  // now, that was fine, because a team never changed out from under a
  // selected event. Re-subscribing them here (now that currentTeamData
  // already points at the new team, set above) refreshes everything they
  // drive: scouted-state checkmarks on the team list, and the match count
  // on a currently open team detail modal.
  if (selectedEvent?.code) {
    if (typeof watchPitScoutStatus === 'function') {
      watchPitScoutStatus(selectedEvent.code);
    }
    if (typeof watchMatchScoutStatus === 'function') {
      watchMatchScoutStatus(selectedEvent.code);
    }
  }
}
