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

// This user's display-name override for whichever team is currently active
// (teams/{teamId}/memberDisplayNames/{uid}), or null if they haven't set one
// for this team — reset and re-fetched by loadTeamMembers() (members.js)
// every time the active team changes. getCurrentUserDisplayName() below
// checks this before falling back to the account-level name, so it's what
// every new scoutedByName write (pit-scout.js/match-scout.js) and the member
// list's self row reflect, without either needing to know about per-team
// names directly.
let currentTeamDisplayNameOverride = null;

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

  // Independent of the profile read/write below — user.email is already
  // known synchronously from the auth object, so this doesn't need to block
  // ensureUserProfile()'s return (or callers awaiting it) at all.
  contactRef.set({
    email: user.email || '',
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true }).catch(err => {
    console.warn('Failed to sync private contact doc:', err);
  });

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

/**
 * Point currentTeamData (and everything derived from it: member list,
 * permission UI, pin button, pinned events) at a fresh team doc — shared by
 * watchTeamDoc() (the active team's own listener) and watchMyTeams() (which
 * also needs to run this, not just update its myTeams entry, whenever the
 * team it just heard about happens to be the currently active one). Without
 * this shared, ANY listener that observes the active team's doc changing
 * refreshes the same state, instead of only whichever one happened to be
 * subscribed at the time.
 */
function refreshActiveTeamData(teamId, teamData) {
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
  if (typeof renderMyPermissionsModal === 'function') {
    renderMyPermissionsModal();
  }
  if (typeof updatePitBulkSelectUI === 'function') {
    updatePitBulkSelectUI();
  }
  if (typeof updateMatchTeamBulkSelectUI === 'function') {
    updateMatchTeamBulkSelectUI();
  }
  if (typeof updatePinButtonUI === 'function') {
    updatePinButtonUI();
  }
  if (typeof renderPinnedEventsList === 'function') {
    renderPinnedEventsList();
  }
}

function watchTeamDoc(teamId) {
  if (teamDocUnsubscribe) {
    teamDocUnsubscribe();
    teamDocUnsubscribe = null;
  }
  if (!teamId) return;

  teamDocUnsubscribe = db.collection('teams').doc(teamId).onSnapshot((doc) => {
    if (!doc.exists) return;
    const teamData = { id: doc.id, ...doc.data() };
    refreshActiveTeamData(teamId, teamData);
  }, (err) => {
    // Removal detection (permission-denied -> this uid is no longer in
    // `members`) lives in watchMyTeams()'s per-team error callback now —
    // it already has a listener on every team including this active one
    // (a documented, intentional overlap), so that's the single place this
    // is handled, rather than duplicating it here too.
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
  if (currentTeamDisplayNameOverride) return currentTeamDisplayNameOverride;
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

// ====== reset-success auto-clears after a few seconds — nothing else on
// this persistent screen ever touches it otherwise (no auto-navigation, and
// the user may just sit on it rather than immediately going to check their
// inbox). ======
let resetSuccessTimer = null;
function showResetSuccess() {
  $('reset-success').textContent = 'Password reset link sent! Check your inbox. (Check your spam/junk folder if you don\'t see it.)';
  if (resetSuccessTimer) clearTimeout(resetSuccessTimer);
  resetSuccessTimer = setTimeout(() => {
    const el = document.getElementById('reset-success');
    if (el) el.textContent = '';
    resetSuccessTimer = null;
  }, 5000);
}

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
    showResetSuccess();
    $('input-reset-email').value = '';
  } catch (err) {
    hideLoading();
    console.error('Password reset error:', err);
    if (err.code === 'auth/user-not-found') {
      // Deliberately shown as if it succeeded — confirming "no account exists"
      // here is an enumeration leak, exactly as revealing "an account exists"
      // would be. Nothing was actually sent, but the response looks identical.
      showResetSuccess();
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
    // Auto-clears after a few seconds — nothing else on this persistent
    // screen (no auto-navigation) would otherwise touch it.
    $('set-password-success').textContent = 'Password reset successfully! You can now sign in with your new password.';
    setTimeout(() => {
      const el = document.getElementById('set-password-success');
      if (el) el.textContent = '';
    }, 5000);
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

// ====== verify-error auto-clears after a few seconds — this screen runs a
// live 4s background poll (startVerifyEmailPolling() above) the whole time
// it's shown, so a message here (whether "resent!" or an error) would
// otherwise sit indefinitely while the user just waits for the poll to
// succeed, with nothing else around to naturally clear it. Scoped to this
// one element rather than changing showError() itself, which is also used
// for blocking form-validation errors elsewhere (Sign In, Create Team, ...)
// where persisting until the next attempt is correct. ======
let verifyErrorTimer = null;
function showVerifyError(message) {
  showError('verify-error', message);
  if (verifyErrorTimer) clearTimeout(verifyErrorTimer);
  verifyErrorTimer = setTimeout(() => {
    const el = document.getElementById('verify-error');
    if (el) el.textContent = '';
    verifyErrorTimer = null;
  }, 5000);
}

$('btn-resend-verification').addEventListener('click', async () => {
  clearErrors();
  if (!currentUser) {
    showVerifyError('You are not signed in. Please go back and sign in again.');
    return;
  }

  showLoading('Sending verification email...');
  try {
    await currentUser.sendEmailVerification();
    hideLoading();
    showVerifyError('Verification email resent! Check your inbox. (Check your spam/junk folder if you don\'t see it.)');
  } catch (err) {
    hideLoading();
    console.error('Resend verification error:', err);
    showVerifyError('Failed to resend. Please try again.');
  }
});

$('btn-check-verified').addEventListener('click', async () => {
  clearErrors();
  if (!currentUser) {
    showVerifyError('You are not signed in. Please go back and sign in again.');
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
      showVerifyError('Email not verified yet. Please check your inbox and click the verification link, then try again.');
    }
  } catch (err) {
    hideLoading();
    console.error('Check verified error:', err);
    showVerifyError('Failed to check verification status. Please try again.');
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

// ====== My Account tab: consolidated info card (name/email/login method) ======
// Replaces the old separate Change Email / Change Password modals
// (openChangeEmailModal/saveNewEmail, openChangePasswordModal/
// saveNewPassword) with one Edit -> reauth -> Save flow covering all three
// fields at once. The underlying Firebase calls are unchanged from those —
// reauthenticateWithCredential/reauthenticateWithPopup, verifyBeforeUpdateEmail,
// updatePassword — just no longer split across two separate modals/buttons.
function userHasPasswordProvider() {
  return !!(currentUser && currentUser.providerData &&
    currentUser.providerData.some(p => p.providerId === 'password'));
}

function userHasGoogleProvider() {
  return !!(currentUser && currentUser.providerData &&
    currentUser.providerData.some(p => p.providerId === 'google.com'));
}

function renderAccountInfo() {
  if (!currentUser) return;

  const nameEl = document.getElementById('account-card-name-display');
  if (nameEl) nameEl.textContent = (typeof getCurrentUserDisplayName === 'function') ? getCurrentUserDisplayName() : (currentUser.email || '');

  const hasPassword = userHasPasswordProvider();

  // A password-provider account gets its own Email row, same as always; a
  // Google-provider account's email is shown inline with Login Method
  // instead (it isn't a separately editable field for that account type —
  // see enterAccountCardEditMode()).
  const emailRow = document.getElementById('account-card-email-row');
  if (emailRow) emailRow.classList.toggle('hidden', !hasPassword);
  const emailEl = document.getElementById('account-card-email-display');
  if (emailEl) emailEl.textContent = currentUser.email || '(no email on this account)';

  const methodEl = document.getElementById('account-card-login-method-display');
  if (methodEl) {
    methodEl.textContent = hasPassword ? 'Email & Password' : `Google (${currentUser.email || 'no email on this account'})`;
  }

  const convertSection = document.getElementById('account-google-convert-section');
  if (convertSection) convertSection.classList.toggle('hidden', hasPassword);
  const convertCurrentEmailEl = document.getElementById('account-google-convert-current-email');
  if (convertCurrentEmailEl) convertCurrentEmailEl.textContent = currentUser.email || '(no email on this account)';

  const hasGoogle = userHasGoogleProvider();
  const emailToGoogleSection = document.getElementById('account-email-to-google-section');
  if (emailToGoogleSection) emailToGoogleSection.classList.toggle('hidden', !hasPassword || hasGoogle);

  // Always land back in view mode when this re-renders (tab switched to,
  // login, a live team-list update, ...) — an edit in progress showing now-
  // stale field values would be confusing, and Cancel already does the same.
  exitAccountCardEditMode();
}

function enterAccountCardEditMode() {
  if (!currentUser) return;
  const hasPassword = userHasPasswordProvider();

  document.getElementById('input-account-card-name').value = (typeof getCurrentUserDisplayName === 'function') ? getCurrentUserDisplayName() : '';
  document.getElementById('input-account-card-email').value = hasPassword ? (currentUser.email || '') : '';
  document.getElementById('input-account-card-new-password').value = '';
  document.getElementById('input-account-card-confirm-password').value = '';
  document.getElementById('account-card-error').textContent = '';
  document.getElementById('account-card-success').textContent = '';

  // A Google-only account has no editable email or password here — its
  // email comes from whichever Google account is linked (shown read-only in
  // the "Switch to Email + Password Login" section instead), and its
  // password is what that same section exists to add.
  document.getElementById('account-card-email-field-group').classList.toggle('hidden', !hasPassword);
  document.getElementById('account-card-new-password-group').classList.toggle('hidden', !hasPassword);
  document.getElementById('account-card-confirm-password-group').classList.toggle('hidden', !hasPassword);

  document.getElementById('account-card-view').classList.add('hidden');
  document.getElementById('account-card-edit').classList.remove('hidden');
}

function exitAccountCardEditMode() {
  const editEl = document.getElementById('account-card-edit');
  const viewEl = document.getElementById('account-card-view');
  if (editEl) editEl.classList.add('hidden');
  if (viewEl) viewEl.classList.remove('hidden');
}

// ====== Edit-button reauth gate ======
// Reauthenticates BEFORE the card ever enters edit mode — a Google-only
// account gets an immediate popup; a password-provider account gets a small
// modal asking for the current password. Edit mode only opens once that
// succeeds; a failed or canceled reauth leaves the card in view mode.
async function handleAccountCardEditClick() {
  if (!currentUser) return;

  if (userHasPasswordProvider()) {
    openAccountReauthModal(enterAccountCardEditMode);
    return;
  }

  showLoading('Verifying your identity...');
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    await currentUser.reauthenticateWithPopup(provider);
    hideLoading();
    enterAccountCardEditMode();
  } catch (err) {
    hideLoading();
    console.error('Account edit reauth error:', err);
    if (typeof showNoticeModal === 'function') {
      showNoticeModal({ title: 'Verification Failed', message: friendlyAuthError(err.code) });
    }
  }
}

// ====== Password-reauth gate modal ======
// Generic: whoever opens it passes the callback to run once the current
// password checks out — the Account tab Edit button (password-provider
// accounts) and the Switch to Google Login flow (below) both use this same
// "confirm your password first" step rather than each having their own copy.
let pendingAccountReauthCallback = null;

function openAccountReauthModal(onSuccess) {
  pendingAccountReauthCallback = typeof onSuccess === 'function' ? onSuccess : null;
  $('input-account-reauth-password').value = '';
  $('account-reauth-error').textContent = '';
  $('account-reauth-modal').classList.remove('hidden');
}

function closeAccountReauthModal() {
  pendingAccountReauthCallback = null;
  $('account-reauth-modal').classList.add('hidden');
}

async function confirmAccountReauth() {
  const errorEl = $('account-reauth-error');
  errorEl.textContent = '';

  const password = $('input-account-reauth-password').value;
  if (!password) {
    errorEl.textContent = 'Please enter your current password.';
    return;
  }
  if (!currentUser || !currentUser.email) return;

  showLoading('Verifying your identity...');
  try {
    const cred = firebase.auth.EmailAuthProvider.credential(currentUser.email, password);
    await currentUser.reauthenticateWithCredential(cred);
    hideLoading();
    const callback = pendingAccountReauthCallback;
    closeAccountReauthModal();
    if (callback) await callback();
  } catch (err) {
    hideLoading();
    console.error('Account reauth error:', err);
    errorEl.textContent = 'Incorrect password. Please try again.';
  }
}

$('btn-account-card-edit').addEventListener('click', handleAccountCardEditClick);
$('btn-account-card-cancel').addEventListener('click', exitAccountCardEditMode);
$('btn-account-reauth-close').addEventListener('click', closeAccountReauthModal);
$('btn-account-reauth-cancel').addEventListener('click', closeAccountReauthModal);
$('account-reauth-modal-overlay').addEventListener('click', closeAccountReauthModal);
$('btn-account-reauth-confirm').addEventListener('click', confirmAccountReauth);
$('input-account-reauth-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-account-reauth-confirm').click();
});

// ====== Save the consolidated card ======
// Reauth already happened up front, when Edit was clicked (see
// handleAccountCardEditClick()) — Save just applies whatever changed, in
// order name -> email -> password: cheapest and least externally-dependent
// first, so if a later step fails the earlier ones are still saved rather
// than losing everything to one error (the error message says so
// explicitly). If Firebase decides the earlier reauth is no longer "recent"
// enough by the time this runs (auth/requires-recent-login — the user left
// the form open a while), friendlyAuthError() already has a message for
// that; they'd need to click Edit again to re-gate.
$('btn-account-card-save').addEventListener('click', async () => {
  const errorEl = document.getElementById('account-card-error');
  const successEl = document.getElementById('account-card-success');
  errorEl.textContent = '';
  successEl.textContent = '';

  if (!currentUser) return;

  const newName = document.getElementById('input-account-card-name').value.trim();
  const hasPassword = userHasPasswordProvider();
  // A Google-provider account's email isn't an editable field here — it's
  // tied to whichever Google account is linked (see the read-only line in
  // the "Switch to Email + Password Login" section instead) — so there's
  // nothing to read/validate/save for it on this account type.
  const newEmail = hasPassword ? document.getElementById('input-account-card-email').value.trim() : null;
  const newPassword = hasPassword ? document.getElementById('input-account-card-new-password').value : '';
  const confirmPassword = hasPassword ? document.getElementById('input-account-card-confirm-password').value : '';

  if (!newName) {
    errorEl.textContent = 'Please enter a name.';
    return;
  }
  if (hasPassword) {
    if (!newEmail) {
      errorEl.textContent = 'Please enter an email address.';
      return;
    }
    if (!EMAIL_FORMAT_REGEX.test(newEmail)) {
      errorEl.textContent = 'Please enter a valid email address.';
      return;
    }
  }
  if (newPassword || confirmPassword) {
    if (newPassword.length < 6) {
      errorEl.textContent = 'New password must be at least 6 characters.';
      return;
    }
    if (newPassword !== confirmPassword) {
      errorEl.textContent = 'New passwords do not match.';
      return;
    }
  }

  const previousName = typeof getCurrentUserDisplayName === 'function' ? getCurrentUserDisplayName() : '';
  let emailChangePending = false;
  try {
    if (newName !== previousName) {
      showLoading('Saving name...');
      await saveDisplayName(newName);
    }

    if (hasPassword && currentUser.email && newEmail.toLowerCase() !== currentUser.email.toLowerCase()) {
      showLoading('Sending confirmation email...');
      await currentUser.verifyBeforeUpdateEmail(newEmail);
      emailChangePending = true;
    }

    if (hasPassword && newPassword) {
      showLoading('Updating password...');
      await currentUser.updatePassword(newPassword);
    }

    hideLoading();
    successEl.textContent = emailChangePending
      ? `Saved! Check ${newEmail} to confirm your new email — it won't take effect until you click the link. (Check your spam/junk folder if you don't see it.)`
      : 'Saved!';
    // Stay in edit mode (showing the message above) briefly before
    // renderAccountInfo() refreshes the view-mode fields and exits — longer
    // when an email change is pending so there's time to actually read it,
    // same distinction the old saveNewPassword (1200ms) / saveNewEmail
    // (4000ms) split made.
    setTimeout(() => { renderAccountInfo(); }, emailChangePending ? 4000 : 1200);
  } catch (err) {
    hideLoading();
    console.error('Account card save error:', err);
    errorEl.textContent = friendlyAuthError(err.code);
  }
});

// ====== Switch to Email + Password Login (Google-linked accounts only) ======
// Keeps the account's existing (already-verified) email rather than
// accepting a new one — Firebase's linkWithCredential() behavior when the
// credential's email differs from the account's current one isn't clearly
// documented, whereas linking a credential whose email already matches
// currentUser.email is unambiguous. A user who wants a different email can
// still get one afterward through the consolidated card above, once they
// have a password provider.
// Sequence: confirm (showConfirmModal) -> collect a new password
// (google-convert-modal) -> fresh Google reauth -> link the password
// credential (same email) -> unlink Google -> delete the stored profile
// picture ONLY if it's still exactly what Google supplied (never a
// custom-uploaded one, once that feature exists — see the photoURL
// comparison below).
function openGoogleConvertConfirm() {
  if (!currentUser || userHasPasswordProvider() || typeof showConfirmModal !== 'function') return;

  showConfirmModal({
    title: 'Switch to Email + Password Login?',
    message: `You'll set a password for ${currentUser.email}. After this, you'll sign in with that email and password instead of "Sign in with Google" — this can't be undone from here.`,
    confirmLabel: 'Continue',
    danger: true,
    onConfirm: openGoogleConvertModal
  });
}

function openGoogleConvertModal() {
  $('google-convert-email-display').textContent = currentUser.email || '';
  $('input-google-convert-password').value = '';
  $('input-google-convert-confirm').value = '';
  $('google-convert-error').textContent = '';
  $('google-convert-success').textContent = '';
  $('google-convert-modal').classList.remove('hidden');
}

function closeGoogleConvertModal() {
  $('google-convert-modal').classList.add('hidden');
}

async function saveGoogleConvert() {
  const errorEl = $('google-convert-error');
  const successEl = $('google-convert-success');
  errorEl.textContent = '';
  successEl.textContent = '';

  const newPassword = $('input-google-convert-password').value;
  const confirmPassword = $('input-google-convert-confirm').value;

  if (!newPassword || newPassword.length < 6) {
    errorEl.textContent = 'Password must be at least 6 characters.';
    return;
  }
  if (newPassword !== confirmPassword) {
    errorEl.textContent = 'Passwords do not match.';
    return;
  }
  if (!currentUser || !currentUser.email) {
    errorEl.textContent = 'You must be signed in to do this.';
    return;
  }

  showLoading('Verifying your identity...');
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    await currentUser.reauthenticateWithPopup(provider);
  } catch (err) {
    hideLoading();
    console.error('Google convert reauth error:', err);
    errorEl.textContent = friendlyAuthError(err.code);
    return;
  }

  // Capture Google's own profile-picture URL BEFORE unlinking — providerData
  // only has a 'google.com' entry while it's still linked.
  const googleEntry = currentUser.providerData.find(p => p.providerId === 'google.com');
  const googlePhotoURL = googleEntry ? googleEntry.photoURL : null;

  try {
    showLoading('Setting your password...');
    const cred = firebase.auth.EmailAuthProvider.credential(currentUser.email, newPassword);
    await currentUser.linkWithCredential(cred);
  } catch (err) {
    hideLoading();
    console.error('Google convert link error:', err);
    errorEl.textContent = friendlyAuthError(err.code);
    return;
  }

  // The password is already set and working at this point — a failure below
  // (unlink or the Firestore cleanup) is reported but nothing is rolled
  // back; both are safe to leave half-done (Google stays linked as a second
  // sign-in option; a leftover Firestore photoURL is cosmetic only).
  try {
    showLoading('Removing Google sign-in...');
    await currentUser.unlink('google.com');

    if (googlePhotoURL && currentUserProfile && currentUserProfile.photoURL === googlePhotoURL) {
      await db.collection('users').doc(currentUser.uid).update({
        photoURL: firebase.firestore.FieldValue.delete()
      });
      currentUserProfile.photoURL = null;
    }

    hideLoading();
    renderAccountInfo();
    successEl.textContent = 'Your account now signs in with email and password!';
    setTimeout(() => { closeGoogleConvertModal(); }, 2000);
  } catch (err) {
    hideLoading();
    console.error('Google convert unlink/cleanup error:', err);
    renderAccountInfo(); // password provider is already active either way
    errorEl.textContent = 'Password set, but removing Google sign-in failed. You can sign in with your new password now; try again to finish removing Google, or contact support.';
  }
}

// btn-open-google-convert's containing section is currently rolled back out
// of the Account tab's HTML (see index.html) — guarded rather than assumed
// present, unlike this file's other $(...) wiring, so the rest of this
// script still runs when that button doesn't exist.
const btnOpenGoogleConvert = document.getElementById('btn-open-google-convert');
if (btnOpenGoogleConvert) btnOpenGoogleConvert.addEventListener('click', openGoogleConvertConfirm);
$('btn-google-convert-close').addEventListener('click', closeGoogleConvertModal);
$('btn-google-convert-cancel').addEventListener('click', closeGoogleConvertModal);
$('google-convert-modal-overlay').addEventListener('click', closeGoogleConvertModal);
$('btn-google-convert-save').addEventListener('click', saveGoogleConvert);

// ====== Switch to Google Login (email/password accounts only) ======
// The reverse direction of the section above. Sequence: confirm
// (showConfirmModal) -> straight to a Google popup on a SEPARATE, temporary
// Firebase app instance (so it never touches currentUser or this tab's real
// session) purely to find out which Google account the user picked and its
// email -> if that email doesn't exactly match this account's email, abort
// with a clear message (same match-required restriction chosen for the
// other direction, applied here in reverse) -> only then link that
// credential to the real currentUser and unlink the password provider. No
// separate password-reauth step first — picking a Google account via the
// popup already re-proves identity for this operation, the same way it does
// for the equivalent Google-account-side flows elsewhere in this file.
// Using a scratch app to inspect the credential first, rather than linking
// immediately and unlinking again on a mismatch, avoids ever leaving the
// real account in a transient "both providers linked" state for a
// rejected attempt.
function openEmailToGoogleConvertConfirm() {
  if (!currentUser || !userHasPasswordProvider() || userHasGoogleProvider() || typeof showConfirmModal !== 'function') return;

  showConfirmModal({
    title: 'Switch to Google Login?',
    message: `You'll sign in with Google to link it — that Google account's email must exactly match ${currentUser.email}. After this, you'll sign in with "Sign in with Google" instead of your password — this can't be undone from here.`,
    confirmLabel: 'Continue',
    danger: true,
    onConfirm: startEmailToGoogleLinkPopup
  });
}

async function startEmailToGoogleLinkPopup() {
  if (!currentUser || !currentUser.email) return;

  showLoading('Opening Google sign-in...');
  let tempApp = null;
  try {
    tempApp = firebase.initializeApp(firebaseConfig, `email-to-google-check-${Date.now()}`);
    const tempAuth = firebase.auth(tempApp);
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const tempResult = await tempAuth.signInWithPopup(provider);
    const googleEmail = tempResult.user.email;
    const googlePhotoURL = tempResult.user.photoURL;
    const googleCredential = firebase.auth.GoogleAuthProvider.credentialFromResult(tempResult);

    // Done with the scratch sign-in either way — clear it before touching
    // the real account, so a mismatch leaves nothing lingering.
    await tempAuth.signOut();

    if (!googleEmail || googleEmail.toLowerCase() !== currentUser.email.toLowerCase()) {
      hideLoading();
      if (typeof showNoticeModal === 'function') {
        showNoticeModal({
          title: 'Email Mismatch',
          message: `That Google account's email (${googleEmail || 'unknown'}) doesn't match your account's email (${currentUser.email}). Sign in with the matching Google account, or change your account's email first (Edit, above), then try again.`
        });
      }
      return;
    }

    showLoading('Linking your Google account...');
    await currentUser.linkWithCredential(googleCredential);

    // Import whatever Google-supplied profile data a normal Google sign-in
    // captures (see ensureUserProfile()'s photoURL handling) — same field,
    // same storage location, so this account looks identical to one that
    // originally signed up via Google. Display name is deliberately left
    // alone: unlike a brand-new Google signup, this account already has a
    // display name the user chose, and Google's isn't more authoritative.
    if (googlePhotoURL) {
      try {
        await db.collection('users').doc(currentUser.uid).set({ photoURL: googlePhotoURL }, { merge: true });
        if (currentUserProfile) currentUserProfile.photoURL = googlePhotoURL;
      } catch (err) {
        console.warn('Failed to import Google profile photo:', err);
      }
    }

    showLoading('Removing password sign-in...');
    await currentUser.unlink('password');

    hideLoading();
    renderAccountInfo();
    if (typeof showNoticeModal === 'function') {
      showNoticeModal({ title: 'Account Converted', message: 'Your account now signs in with Google!' });
    }
  } catch (err) {
    hideLoading();
    console.error('Email-to-Google conversion error:', err);
    if (typeof showNoticeModal === 'function') {
      showNoticeModal({ title: 'Conversion Failed', message: friendlyAuthError(err.code) });
    }
  } finally {
    if (tempApp) {
      try { await tempApp.delete(); } catch (err) { console.warn('Failed to clean up temporary auth app:', err); }
    }
  }
}

// Same rollback guard as btn-open-google-convert above — this button's
// section is currently removed from index.html.
const btnOpenEmailToGoogleConvert = document.getElementById('btn-open-email-to-google-convert');
if (btnOpenEmailToGoogleConvert) btnOpenEmailToGoogleConvert.addEventListener('click', openEmailToGoogleConvertConfirm);

// ====== SIGN OUT ======
async function signOut() {
  try {
    watchTeamDoc(null); // stop the live team doc listener
    // Stop every per-team myTeams listener and drop the (now stale, belongs
    // to the departing account) list itself — otherwise these listeners would
    // keep running against the OLD account's teams for whoever signs in next
    // in this same tab, and watchMyTeams() would have nothing to tear down
    // them with once myTeams no longer reflects which teams they came from.
    myTeams = [];
    if (typeof watchMyTeams === 'function') watchMyTeams();
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
    // clearSelectedEvent() deliberately leaves the search box's typed text
    // alone (callers like doSearch() need it to survive their own call to
    // clearSelectedEvent() while showing that same query's results), so
    // sign-out has to clear it explicitly here — otherwise the next login in
    // this same tab would see whatever the previous account had typed.
    const eventSearchInput = $('input-event-search');
    if (eventSearchInput) eventSearchInput.value = '';
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

// ====== My Account tab: list of every team this user currently belongs to.
// Read-only summary (name + role) — distinct from the My Team tab's switcher
// dropdown (select-active-team, members.js), which actually changes the
// active team. Reads myTeams directly, same as renderTeamSwitcher(), so it
// always reflects whatever's current whenever called. ======
function renderAccountTeamsList() {
  const container = document.getElementById('account-teams-list');
  const status = document.getElementById('account-teams-status');
  if (!container || !status) return;

  const teams = (typeof myTeams !== 'undefined' && Array.isArray(myTeams)) ? myTeams : [];
  container.innerHTML = '';

  if (teams.length === 0) {
    status.textContent = "You're not currently on any team.";
    return;
  }

  status.textContent = `${teams.length} team(s)`;

  teams.forEach(t => {
    const isCaptain = !!(currentUser && t.roles && t.roles[currentUser.uid] === 'captain');

    const item = document.createElement('div');
    item.className = 'team-item';

    const nameEl = document.createElement('div');
    nameEl.style.cssText = 'font-weight:600; font-size:0.9rem';
    nameEl.textContent = t.name || 'Unnamed team';
    item.appendChild(nameEl);

    const badge = document.createElement('span');
    badge.className = isCaptain ? 'member-role-badge' : 'member-role-badge member';
    badge.textContent = isCaptain ? 'Captain' : 'Member';
    item.appendChild(badge);

    container.appendChild(item);
  });
}

// ====== My Account tab: per-team display names ======
// Independent of the account-level display name in the consolidated card
// above — lets the user set a DIFFERENT name shown to just one team's
// members (member list, scouting entry attribution), stored at
// teams/{teamId}/memberDisplayNames/{uid}. Reads every team's current value
// fresh each time this renders (no cross-team cache needed — this list is
// small, and it's not read anywhere near as often as fetchMemberInfo()).
async function renderPerTeamDisplayNames() {
  const container = document.getElementById('account-per-team-names-list');
  const status = document.getElementById('account-per-team-names-status');
  if (!container || !status || !currentUser) return;

  const teams = (typeof myTeams !== 'undefined' && Array.isArray(myTeams)) ? myTeams : [];
  container.innerHTML = '';

  if (teams.length === 0) {
    status.textContent = "You're not currently on any team.";
    return;
  }

  status.textContent = '';
  const uid = currentUser.uid;

  const rows = teams.map(t => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:8px; align-items:flex-start; margin-bottom:12px';

    const labelWrap = document.createElement('div');
    labelWrap.style.cssText = 'flex:1; min-width:0';

    const label = document.createElement('div');
    label.style.cssText = 'font-size:0.8rem; color:var(--text-muted); margin-bottom:4px';
    label.textContent = t.name || 'Unnamed team';
    labelWrap.appendChild(label);

    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 40;
    input.placeholder = 'Same as account name';
    input.style.marginBottom = '0';
    labelWrap.appendChild(input);

    const rowStatus = document.createElement('p');
    rowStatus.className = 'help-text';
    rowStatus.style.cssText = 'font-size:0.75rem; margin-top:4px; margin-bottom:0';
    labelWrap.appendChild(rowStatus);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-small btn-primary';
    saveBtn.textContent = 'Save';
    saveBtn.style.cssText = 'width:auto; white-space:nowrap; flex-shrink:0';
    saveBtn.addEventListener('click', () => savePerTeamDisplayName(t.id, input, rowStatus));

    row.appendChild(labelWrap);
    row.appendChild(saveBtn);
    container.appendChild(row);

    return { teamId: t.id, input };
  });

  // Populate each row's current value independently, same "resolve then
  // patch" pattern as fetchMemberInfo()'s callers — a slow team doesn't hold
  // up the rest of the list.
  rows.forEach(({ teamId, input }) => {
    db.collection('teams').doc(teamId).collection('memberDisplayNames').doc(uid).get()
      .then(doc => {
        if (doc.exists && doc.data().displayName) input.value = doc.data().displayName;
      })
      .catch(err => {
        // Same "expected removal signal" reasoning as loadTeamMembers()'s
        // own-override read (members.js) and watchMyTeams()'s listener
        // (both this file) — a permission-denied for a team no longer in
        // myTeams almost always means this read raced a leave/kick that's
        // already been handled elsewhere, not a genuine problem.
        const stillMember = typeof myTeams !== 'undefined' && Array.isArray(myTeams) && myTeams.some(t => t.id === teamId);
        if (err.code === 'permission-denied' && !stillMember) return;
        console.warn(`Failed to load per-team display name for team ${teamId}:`, err);
      });
  });
}

async function savePerTeamDisplayName(teamId, input, statusEl) {
  if (!currentUser) return;
  const name = input.value.trim();

  statusEl.textContent = 'Saving...';
  statusEl.className = 'help-text';
  try {
    if (name) {
      await db.collection('teams').doc(teamId).collection('memberDisplayNames').doc(currentUser.uid)
        .set({ displayName: name });
    } else {
      // Blank means "use my account name" — delete the override rather than
      // storing an empty string, so fetchMemberInfo()'s `if (overrideName)`
      // check (and the same logic for the self row here) falls through to
      // the account-level name exactly as if it were never set.
      await db.collection('teams').doc(teamId).collection('memberDisplayNames').doc(currentUser.uid).delete();
    }

    statusEl.textContent = 'Saved!';
    statusEl.className = 'success-message';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);

    // If this is the currently active team, refresh the live override (and
    // this user's own member-list row/future scoutedByName writes) right
    // away rather than waiting for the next team switch.
    if (teamId === currentTeamId) {
      currentTeamDisplayNameOverride = name || null;
      if (typeof loadTeamMembers === 'function' && currentTeamData) {
        loadTeamMembers(currentTeamId, currentTeamData);
      }
    }
  } catch (err) {
    console.error(`Failed to save per-team display name for team ${teamId}:`, err);
    statusEl.textContent = 'Failed to save. Please try again.';
    statusEl.className = 'error-message';
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
  renderAccountTeamsList();
  if (typeof renderPerTeamDisplayNames === 'function') renderPerTeamDisplayNames();
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

  // Shown immediately, before any network calls — previously this didn't
  // appear until after ensureUserProfile() had already resolved, leaving a
  // real network round trip where the screen looked signed-out instead of
  // loading.
  showLoading('Signing you in...');

  try {
    // ensureUserProfile()'s profile read and getUserTeams() don't depend on
    // each other's result, so run them concurrently instead of back to back.
    const [, teams] = await Promise.all([
      ensureUserProfile(user),
      getUserTeams(user.uid)
    ]);
    const displayName = getCurrentUserDisplayName();
    renderAccountInfo();

    // Update user info in team screen
    $('user-avatar').src = user.photoURL || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(displayName);
    $('user-avatar').alt = displayName;
    $('user-name').textContent = displayName;

    // Reconcile against the last-known team set for this uid (localStorage,
    // persisted below and by persistKnownTeamIds() elsewhere) BEFORE
    // overwriting it — any team present in that old set but missing from
    // this fresh fetch means this uid lost access to it since this device
    // was last used (a kick, or a self-leave from elsewhere), and there was
    // no live listener running here to show a notice for it at the time.
    // getStoredKnownTeams() returns null (not []) when nothing's stored yet
    // (this device's first-ever login for this uid), which correctly skips
    // the diff below rather than treating "no baseline" as "every team was
    // removed."
    const previouslyKnownTeams = getStoredKnownTeams(user.uid);
    const removedTeamNames = previouslyKnownTeams
      ? previouslyKnownTeams
          .filter(pt => !teams.some(t => t.id === pt.id))
          .map(pt => pt.name || 'a team')
      : [];
    setStoredKnownTeams(user.uid, teams.map(t => ({ id: t.id, name: t.name || '' })));

    // Shown after the dashboard/screen-team has fully settled (both call
    // sites below are right after their own hideLoading()), never blocking
    // the login flow itself. Worded neutrally — this signal can't tell a
    // kick apart from a self-initiated leave on another device, so it never
    // says "kicked."
    const showRemovedTeamsNoticeIfAny = () => {
      if (removedTeamNames.length === 0 || typeof showNoticeModal !== 'function') return;
      const message = removedTeamNames.length === 1
        ? `You're no longer a member of "${removedTeamNames[0]}".`
        : `You're no longer a member of these teams: ${removedTeamNames.map(n => `"${n}"`).join(', ')}.`;
      showNoticeModal({ title: 'Removed from Team', message });
    };

    if (teams.length > 0) {
      // Existing users who haven't explicitly confirmed a display name yet must
      // do so before reaching the dashboard — same blocking pattern as the
      // email-verification gate above. This also catches an auto-filled Google
      // name the user never actually chose, not just a genuinely blank one.
      // Brand-new users without a team yet are prompted inline on the create/join
      // screen instead (see the branch below), not here.
      if (!currentUserProfile || !currentUserProfile.displayNameConfirmed) {
        hideLoading();
        const nameInput = document.getElementById('input-set-display-name');
        if (nameInput) nameInput.value = (currentUserProfile && currentUserProfile.displayName) || '';
        showScreen('screen-set-display-name');
        return;
      }

      // Keep this user's per-team email copy fresh for EVERY team they
      // belong to, not just whichever one is shown below — a captain on a
      // different team than the one displayed here still needs to see an
      // up-to-date email if/when they view it. Fire-and-forget: pure
      // denormalization bookkeeping that nothing in this render path reads
      // back, and ensureMemberContact() already swallows its own errors —
      // so it shouldn't hold up the dashboard appearing.
      const myEmail = (currentUserProfile && currentUserProfile.email) || user.email || '';
      Promise.all(teams.map(t => ensureMemberContact(t.id, user.uid, myEmail)));

      // Full list of every team this user belongs to (multi-team support) —
      // the Stage 3 switcher UI will read this directly; for now the
      // dashboard still only ever displays one team at a time.
      myTeams = teams;
      if (typeof watchMyTeams === 'function') watchMyTeams();
      if (typeof renderAccountTeamsList === 'function') renderAccountTeamsList();
      if (typeof renderPerTeamDisplayNames === 'function') renderPerTeamDisplayNames();

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
        // Legacy backfill for teams created before joinCodes existed —
        // nothing in this render path depends on it, and it already
        // swallows its own errors — fire-and-forget.
        ensureJoinCodeDoc(team.id, team.joinCode);
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
      // event). Runs after showScreen so the dashboard is already in the DOM,
      // but the loading overlay (hidden below, once this settles) stays up
      // for it too, so the dashboard's un-restored default state never
      // flashes on screen before it settles into the real one.
      if (typeof restoreOrDefaultSessionState === 'function') {
        try {
          await restoreOrDefaultSessionState();
        } catch (err) {
          console.error('Failed to restore session state:', err);
        }
      } else {
        if (typeof window.activateDashboardTab === 'function') {
          window.activateDashboardTab('scouting');
        }
        if (typeof window.activateScoutingSubTab === 'function') {
          window.activateScoutingSubTab('info');
        }
      }
      hideLoading();
      showRemovedTeamsNoticeIfAny();
    } else {
      hideLoading();
      clearErrors();
      // Always shown — pre-filled with whatever name is already known (Google or
      // a prior save), if any, but the user must still press Create/Join to
      // proceed, so an unconfirmed auto-filled name is never used silently.
      const nameInput = document.getElementById('input-screen-team-display-name');
      if (nameInput) nameInput.value = (currentUserProfile && currentUserProfile.displayName) || '';
      showScreen('screen-team');
      showRemovedTeamsNoticeIfAny();
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

// UI-only gate for the "Kick" button — the underlying removal is enforced
// server-side by the teams/{teamId} update rule's kick branch, which checks
// this same captain-or-canKickMembers condition independently.
function canUserKickMembers() {
  if (!currentUser || !currentTeamData) return false;
  if (getCurrentUserRole() === 'captain') return true;
  if (currentTeamData.permissions &&
      currentTeamData.permissions[currentUser.uid] &&
      currentTeamData.permissions[currentUser.uid].canKickMembers === true) {
    return true;
  }
  return false;
}

function updatePermissionUI() {
  const canEditTmpl = canUserEditTemplates();
  const formSection = document.getElementById('form-config-section');
  if (formSection) formSection.style.display = canEditTmpl ? 'block' : 'none';
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

// ====== Known-team-set persistence (offline removal reconciliation) ======
// Same localStorage layer/per-uid scoping as active-team persistence above,
// for the same reason (has to survive closing the browser, not just the
// tab) — but here to answer a different question: "which teams did this
// user belong to as of their last visit?" so a fresh login can detect a
// team that disappeared while they weren't around to see a live removal
// notice (handleRemovedFromTeam(), members.js) — see the reconciliation
// diff in handleAuthenticatedUser() below. Stores {id, name} pairs, not
// bare IDs — the name has to be captured NOW, while still a member,
// because a team that's disappeared by the next login can no longer be
// read to look its name up after the fact.
function knownTeamIdsStorageKey(uid) {
  return `fe2o3_known_teams_${uid}`;
}

// Returns null (not []) when nothing's been stored yet, so callers can tell
// "no baseline to diff against" (e.g. this device's very first login) apart
// from "the last known set was genuinely empty."
function getStoredKnownTeams(uid) {
  try {
    const raw = localStorage.getItem(knownTeamIdsStorageKey(uid));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn('Failed to read stored known teams:', err);
    return null;
  }
}

function setStoredKnownTeams(uid, teams) {
  try {
    localStorage.setItem(knownTeamIdsStorageKey(uid), JSON.stringify(teams));
  } catch (err) {
    console.warn('Failed to persist known teams:', err);
  }
}

// ====== Persist the CURRENT myTeams as the known-team-set for this uid —
// called immediately after every local myTeams change (login, join, create,
// leave, kick-detected) so the baseline never lags behind a deliberate
// action taken on THIS device. That's what keeps a self-initiated Leave
// Team (or joining a new team) from misfiring as a "mystery removal" (or a
// missed one) the next time this device opens the app — without updating
// the baseline at the moment of the action, the next login's diff would
// compare against a stale set and draw the wrong conclusion. ======
function persistKnownTeamIds() {
  if (!currentUser || typeof myTeams === 'undefined' || !Array.isArray(myTeams)) return;
  setStoredKnownTeams(currentUser.uid, myTeams.map(t => ({ id: t.id, name: t.name || '' })));
}

/**
 * Switch which of the user's teams (myTeams) is "active" — everything the
 * dashboard shows (Scouting tabs, Pinned Events, My Team, permission checks)
 * reads currentTeamData/currentTeamId, so re-pointing those and refreshing
 * whatever depends on them is the whole job. Not called from anywhere yet —
 * Stage 3 wires this to the team-switcher UI.
 */
async function switchActiveTeam(teamId) {
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

  // Event/search state is scoped per team (session-state.js) — restore
  // whatever THIS team last had (or clear to empty if it's never had one),
  // now that currentTeamId already points at it. Must be awaited: the
  // activateDashboardTab('myteam') call below fires its own
  // saveSessionState() synchronously, which reads whatever's currently in
  // selectedEvent/the search box — if that ran before this finished
  // restoring (e.g. mid-selectEvent() network round trip), it would write
  // the PREVIOUS team's still-in-memory selectedEvent into the newly
  // active team's own perTeam entry instead of what's actually being
  // restored for it.
  if (typeof restorePerTeamEventState === 'function') {
    await restorePerTeamEventState();
  }

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

  // Land on the My Team tab, not Scouting — unlike a fresh login/create/join
  // (which lands on Scouting since there's nothing to manage on a team
  // you're just now seeing for the first time), switching to a team you
  // already belong to is a "manage my membership" action, so My Team is the
  // more useful landing spot. This covers every caller of switchActiveTeam()
  // — the switcher dropdown, Join Another Team, and Leave Team's
  // switch-to-a-remaining-team branch — from one place.
  if (typeof activateDashboardTab === 'function') {
    activateDashboardTab('myteam');
  }
}

// ====== Live-sync myTeams with each team's real document (multi-team
// support). currentTeamData is already kept live for whichever ONE team is
// active, via watchTeamDoc()'s listener — but that only ever updates the
// separate currentTeamData global, never the matching entry inside the
// myTeams array, so every entry in myTeams (including the active team's own
// entry) was otherwise a one-time snapshot from login that never refreshed.
// That's what let a captaincy transfer or another member joining go
// unnoticed by anything reading myTeams (e.g. the Delete Account
// captain-block check) until a full page refresh re-ran getUserTeams().
//
// This sets up one listener per team currently in myTeams — not just the
// active one, since a background team's staleness needs its own listener
// too (watchTeamDoc only ever watches one team at a time). A small amount of
// overlap with watchTeamDoc on the active team's own doc is expected and
// harmless (Firestore has no trouble maintaining two independent listeners
// on the same document); keeping the two systems fully separate is simpler
// to reason about than trying to coordinate them.
//
// Call again whenever the SET of teams changes (not just their contents) —
// login, joining another team, leaving one — since that's what determines
// which docs need a listener at all; a fresh call always tears down every
// previous listener first, so it's safe (and required) to call repeatedly
// rather than trying to diff the old set against the new one. ======
let myTeamsUnsubscribes = {};

function watchMyTeams() {
  Object.values(myTeamsUnsubscribes).forEach(unsub => unsub());
  myTeamsUnsubscribes = {};

  (myTeams || []).forEach(t => {
    if (!t || !t.id) return;
    const teamId = t.id;
    myTeamsUnsubscribes[teamId] = db.collection('teams').doc(teamId).onSnapshot((doc) => {
      if (!Array.isArray(myTeams)) return;

      if (!doc.exists) {
        // The team's gone (e.g. deleted by its last member elsewhere) —
        // drop it rather than leaving a stale ghost entry, and stop
        // listening to a document that will never exist again.
        myTeams = myTeams.filter(team => team.id !== teamId);
        if (myTeamsUnsubscribes[teamId]) {
          delete myTeamsUnsubscribes[teamId];
        }
      } else {
        const fresh = { id: doc.id, ...doc.data() };
        const idx = myTeams.findIndex(team => team.id === teamId);
        if (idx !== -1) {
          myTeams[idx] = fresh;
        }

        // If this happens to be the ACTIVE team, also refresh currentTeamData
        // (and the member list/permission/pin UI derived from it) from here —
        // not just the myTeams entry. watchTeamDoc() already does this too via
        // its own listener on the same doc (a harmless, expected overlap), but
        // that redundancy is exactly what makes this a reliable second path
        // rather than the only one: relying solely on watchTeamDoc meant a
        // captaincy transfer (or any other change) landing while its listener
        // was momentarily not the one covering this doc — e.g. mid-switch —
        // would otherwise wait for a manual switch-away-and-back or a refresh
        // to show up, instead of updating live like it does here.
        if (teamId === currentTeamId) {
          refreshActiveTeamData(teamId, fresh);
        }
      }

      if (typeof renderTeamSwitcher === 'function') {
        renderTeamSwitcher();
      }
      if (typeof renderAccountTeamsList === 'function') {
        renderAccountTeamsList();
      }
      if (typeof renderPerTeamDisplayNames === 'function') {
        renderPerTeamDisplayNames();
      }
    }, (err) => {
      console.warn(`myTeams listener error for team ${teamId}:`, err);
      // A permission-denied error here means this uid is no longer in this
      // team's `members` — the only way that happens to a previously-
      // working listener (kicked, or removed from a different tab/device).
      // This one callback already covers every team the user belongs to,
      // active or not, so it's the single place removal needs handling —
      // handleRemovedFromTeam() (members.js) branches internally on whether
      // this was the active team (navigate away, then notify) or a
      // background one (just drop it and notify, nothing to navigate away
      // from).
      if (err.code === 'permission-denied' && typeof handleRemovedFromTeam === 'function') {
        handleRemovedFromTeam(teamId);
      }
    });
  });
}
