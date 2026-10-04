// Login: real sign-up (email verification + display-name gate), sign-out,
// a rejected wrong password, and a successful sign-in.

const assert = require('node:assert/strict');
const { verifyEmailViaEmulator } = require('../lib/harness');
const { uniqueEmail, gotoApp, signInUI, signOutUI } = require('../lib/app');

module.exports = {
  name: 'login: sign up, verify email, set name, sign out, bad password, sign in',
  async run(ctx) {
    const page = await ctx.newPage('login');
    const email = uniqueEmail('login');
    const password = 'smoke-pass-123';

    await gotoApp(page);
    await page.click('#auth-tabs .tab[data-tab="signup"]');
    await page.fill('#input-signup-email', email);
    await page.fill('#input-signup-password', password);
    await page.fill('#input-signup-confirm', password);
    await page.click('#btn-signup');

    await page.waitForSelector('#screen-verify-email.active');
    assert.equal((await page.textContent('#verify-email-display')).trim(), email);
    await verifyEmailViaEmulator(email);
    await page.click('#btn-check-verified');

    await page.waitForSelector('#screen-set-display-name.active');
    await page.fill('#input-set-display-name', 'Login Tester');
    await page.click('#btn-set-display-name-continue');
    await page.waitForSelector('#screen-team.active');

    await signOutUI(page);

    // Wrong password is rejected with a visible error and stays on login.
    await page.fill('#input-signin-email', email);
    await page.fill('#input-signin-password', 'definitely-wrong');
    await page.click('#btn-signin');
    await page.waitForFunction(() => (document.getElementById('signin-error')?.textContent || '').trim().length > 0);
    assert.ok(await page.isVisible('#screen-login.active'));

    // Correct password gets back in (display name already set, so no gate).
    await signInUI(page, { email, password });
    await page.waitForSelector('#screen-team.active');
    assert.ok(!(await page.isVisible('#screen-set-display-name.active')));
  }
};
