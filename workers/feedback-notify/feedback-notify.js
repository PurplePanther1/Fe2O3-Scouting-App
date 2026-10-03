/**
 * Cloudflare Worker — Feedback Email Notifier
 *
 * Called fire-and-forget from js/feedback.js right after a new feedback doc
 * is written to Firestore (feedback/{autoId}) — the Firestore write is what
 * gates the user-facing success/failure state; this Worker only forwards a
 * copy of that same feedback to Resend's API, which emails it to the two
 * maintainer addresses below. A failure here is never surfaced to the
 * submitting user (see js/feedback.js's own call site) — the feedback is
 * already safely saved in Firestore regardless of whether this email goes
 * out, and the Firestore console remains the authoritative place to review
 * every submission (including its screenshot, which this Worker never
 * receives — see NOTIFY_MESSAGE_MAX_LENGTH below).
 *
 * Endpoint:
 *   POST /   body: { category, message, displayName?, teamName?, email?, hasScreenshot? }
 *
 * Deploy (run from this directory, workers/feedback-notify/):
 *   npm install -g wrangler
 *   wrangler secret put RESEND_API_KEY
 *   wrangler deploy
 */

const RESEND_API_URL = 'https://api.resend.com/emails';

// INTERIM STATE: the original design sent to both maintainer addresses, but
// a live test against the real Resend account (2026-10-02) found that its
// unverified sender (onboarding@resend.dev, used below in `from` — see
// sendFeedbackEmail()) can only deliver to the Resend ACCOUNT'S OWN signup
// address — it 403s on any other recipient. ftcfe2o3@gmail.com isn't that
// address, so only leviticus.sietman@gmail.com is listed here for now by
// deliberate choice, confirmed working end-to-end (real 200 from this
// Worker + a real success response from Resend). Add ftcfe2o3@gmail.com
// back once a domain is verified at resend.com/domains and `from` below is
// updated to use it — Resend lifts the single-recipient restriction entirely
// once sending from a verified domain.
const NOTIFY_RECIPIENTS = ['leviticus.sietman@gmail.com'];

// This endpoint takes unauthenticated POSTs from any client that can reach
// it (same trust model as fe2o3-ftc-proxy's GET endpoints) and forwards
// their content into a real outbound email — these caps are a backstop
// against a bad-actor payload bypassing js/feedback.js's own (smaller)
// client-side limits directly, not a limit anyone submitting real feedback
// through the app would ever hit.
const NOTIFY_CATEGORY_MAX_LENGTH = 200;
const NOTIFY_MESSAGE_MAX_LENGTH = 10000;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders());
    }

    let body;
    try {
      body = await request.json();
    } catch (err) {
      return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders());
    }

    const category = typeof body.category === 'string' ? body.category.trim().slice(0, NOTIFY_CATEGORY_MAX_LENGTH) : '';
    const message = typeof body.message === 'string' ? body.message.trim().slice(0, NOTIFY_MESSAGE_MAX_LENGTH) : '';
    if (!category || !message) {
      return jsonResponse({ error: 'category and message are required' }, 400, corsHeaders());
    }

    const displayName = typeof body.displayName === 'string' && body.displayName.trim() ? body.displayName.trim() : 'Unknown';
    const teamName = typeof body.teamName === 'string' && body.teamName.trim() ? body.teamName.trim() : null;
    const email = typeof body.email === 'string' && body.email.trim() ? body.email.trim() : null;
    const hasScreenshot = body.hasScreenshot === true;

    try {
      await sendFeedbackEmail({ category, message, displayName, teamName, email, hasScreenshot }, env);
      return jsonResponse({ ok: true }, 200, corsHeaders());
    } catch (err) {
      console.error('Failed to send feedback notification email:', err.message);
      return jsonResponse({ error: err.message }, 500, corsHeaders());
    }
  },
};

async function sendFeedbackEmail({ category, message, displayName, teamName, email, hasScreenshot }, env) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('Resend API key not configured. Set the RESEND_API_KEY secret.');
  }

  const bodyLines = [
    `Category: ${category}`,
    `From: ${displayName}${teamName ? ` (${teamName})` : ''}`,
    email ? `Reply-to email provided: ${email}` : 'No reply-to email provided.',
    '',
    message,
    '',
    hasScreenshot
      ? 'A screenshot was attached to this submission — view it in the Firestore console (feedback collection); it is not included in this email.'
      : null,
  ].filter((line) => line !== null);

  const emailPayload = {
    from: 'Fe2O3 Scouting Feedback <onboarding@resend.dev>',
    to: NOTIFY_RECIPIENTS,
    subject: `[Fe2O3 Scouting Feedback] ${category}`,
    text: bodyLines.join('\n'),
  };
  // Resend rejects an empty/invalid reply_to rather than ignoring it, so
  // it's only included at all when a real address was actually provided.
  if (email) emailPayload.reply_to = email;

  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(emailPayload),
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`Resend API error ${response.status}: ${responseText}`);
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}
