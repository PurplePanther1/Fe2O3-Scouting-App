// ====== Floating Feedback Button ======
// Writes straight to feedback/{autoId} (no in-app viewer — reviewed via the
// Firestore console). Screenshot attachment follows the SAME pattern as the
// profile picture (js/auth.js's resizeImageFileToDataURL()): client-side
// canvas resize/compress into a base64 JPEG data URI stored directly on the
// doc, rather than Firebase Storage (not provisioned for this project — see
// that function's own comment). Unlike the profile picture, this is NOT
// cover-cropped to a square — a screenshot's whole content matters, so it's
// scaled down (preserving aspect ratio) only if it exceeds the max dimension.

const FEEDBACK_MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB — raw picked-file gate, before any processing
const FEEDBACK_SCREENSHOT_MAX_DIMENSION = 1600; // longest side, aspect-ratio preserved
const FEEDBACK_SCREENSHOT_MAX_DATA_URL_LENGTH = 700000; // ~700KB — leaves headroom under firestore.rules' hard cap and Firestore's 1MiB doc limit alongside category/message/etc
const FEEDBACK_MESSAGE_MAX_LENGTH = 5000;

// Same deployed-Worker convention as first-api.js's FTC_PROXY_BASE — a
// separate, dedicated Worker (workers/feedback-notify/), not a new endpoint
// bolted onto fe2o3-ftc-proxy, so its Resend secret stays isolated from that
// Worker's own FIRST API credentials.
const FEEDBACK_NOTIFY_WORKER_URL = 'https://fe2o3-feedback-notify.fe2o3-scouting.workers.dev';

// The currently-processed screenshot's data URL, or null — cleared on open,
// on Remove Screenshot, and after a successful submit.
let pendingFeedbackScreenshot = null;

// Resize/compress a picked screenshot file into a JPEG data URI, shrinking
// quality until it clears FEEDBACK_SCREENSHOT_MAX_DATA_URL_LENGTH — mirrors
// resizeImageFileToDataURL() (auth.js) but scales to fit within a max
// dimension instead of cover-cropping to a fixed square.
function resizeFeedbackScreenshotToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read the selected file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That file doesn't look like a valid image."));
      img.onload = () => {
        try {
          const maxDim = FEEDBACK_SCREENSHOT_MAX_DIMENSION;
          const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
          const width = Math.max(1, Math.round(img.naturalWidth * scale));
          const height = Math.max(1, Math.round(img.naturalHeight * scale));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          let quality = 0.85;
          let dataUrl = canvas.toDataURL('image/jpeg', quality);
          while (dataUrl.length > FEEDBACK_SCREENSHOT_MAX_DATA_URL_LENGTH && quality > 0.3) {
            quality -= 0.15;
            dataUrl = canvas.toDataURL('image/jpeg', quality);
          }
          if (dataUrl.length > FEEDBACK_SCREENSHOT_MAX_DATA_URL_LENGTH) {
            reject(new Error('Screenshot is too complex to compress small enough. Try a smaller image.'));
            return;
          }
          resolve(dataUrl);
        } catch (err) {
          reject(err);
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function clearFeedbackAttachment() {
  pendingFeedbackScreenshot = null;
  const preview = document.getElementById('feedback-attachment-preview');
  if (preview) {
    preview.src = '';
    preview.classList.add('hidden');
  }
  const removeBtn = document.getElementById('btn-feedback-remove-attachment');
  if (removeBtn) removeBtn.classList.add('hidden');
}

async function handleFeedbackAttachmentChosen(file) {
  if (typeof clearStatusMessage === 'function') clearStatusMessage('feedback');
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    if (typeof setStatusMessage === 'function') setStatusMessage('feedback', 'error', 'Please choose an image file (JPEG, PNG, GIF, or WEBP).');
    return;
  }
  if (file.size > FEEDBACK_MAX_FILE_BYTES) {
    if (typeof setStatusMessage === 'function') setStatusMessage('feedback', 'error', 'Screenshot is too large (max 5MB).');
    return;
  }

  showLoading('Processing screenshot...');
  try {
    const dataUrl = await resizeFeedbackScreenshotToDataURL(file);
    pendingFeedbackScreenshot = dataUrl;
    const preview = document.getElementById('feedback-attachment-preview');
    if (preview) {
      preview.src = dataUrl;
      preview.classList.remove('hidden');
    }
    const removeBtn = document.getElementById('btn-feedback-remove-attachment');
    if (removeBtn) removeBtn.classList.remove('hidden');
    hideLoading();
  } catch (err) {
    hideLoading();
    console.error('Feedback screenshot processing error:', err);
    if (typeof setStatusMessage === 'function') setStatusMessage('feedback', 'error', (err && err.message) || 'Failed to process screenshot.');
  }
}

function openFeedbackModal() {
  document.getElementById('feedback-category').value = '';
  document.getElementById('feedback-message').value = '';
  document.getElementById('feedback-email').value = '';
  clearFeedbackAttachment();
  if (typeof clearStatusMessage === 'function') clearStatusMessage('feedback');
  document.getElementById('feedback-modal').classList.remove('hidden');
}

// Very permissive on purpose — this only gates whether the string gets
// stored at all, not full RFC validity; catches obvious typos ("no @") while
// never blocking a real address it doesn't recognize.
function isPlausibleEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function closeFeedbackModal() {
  document.getElementById('feedback-modal').classList.add('hidden');
}

// Fire-and-forget email notification to the maintainers (via the dedicated
// fe2o3-feedback-notify Worker → Resend) — deliberately NOT awaited by its
// caller. The Firestore write is what already gates the user's success/
// failure state; this is purely a best-effort notification on top of that,
// so a slow or failed request here must never delay the "Thanks for the
// feedback!" modal or surface as an error to the person submitting feedback
// (see the single call site in submitFeedback() below, which only
// console.warns on rejection).
async function notifyFeedbackEmail(payload) {
  const response = await fetch(FEEDBACK_NOTIFY_WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`Feedback notify worker returned ${response.status}`);
  }
}

async function submitFeedback() {
  if (typeof clearStatusMessage === 'function') clearStatusMessage('feedback');

  const category = document.getElementById('feedback-category').value;
  const message = document.getElementById('feedback-message').value.trim();

  if (!category) {
    if (typeof setStatusMessage === 'function') setStatusMessage('feedback', 'error', 'Please select a category.');
    return;
  }
  if (!message) {
    if (typeof setStatusMessage === 'function') setStatusMessage('feedback', 'error', 'Please enter a message.');
    return;
  }
  if (message.length > FEEDBACK_MESSAGE_MAX_LENGTH) {
    if (typeof setStatusMessage === 'function') setStatusMessage('feedback', 'error', `Message is too long (max ${FEEDBACK_MESSAGE_MAX_LENGTH} characters).`);
    return;
  }
  const email = document.getElementById('feedback-email').value.trim();
  if (email && !isPlausibleEmail(email)) {
    if (typeof setStatusMessage === 'function') setStatusMessage('feedback', 'error', "That email address doesn't look valid.");
    return;
  }
  if (!currentUser) {
    if (typeof setStatusMessage === 'function') setStatusMessage('feedback', 'error', 'You must be signed in to send feedback.');
    return;
  }

  showLoading('Sending feedback...');
  try {
    const payload = {
      category,
      message,
      uid: currentUser.uid,
      displayName: typeof getCurrentUserDisplayName === 'function' ? getCurrentUserDisplayName() : (currentUser.email || 'Unknown'),
      teamId: (currentTeamData && currentTeamData.id) || null,
      teamName: (currentTeamData && currentTeamData.name) || null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (email) payload.email = email;
    if (pendingFeedbackScreenshot) payload.screenshot = pendingFeedbackScreenshot;

    await db.collection('feedback').add(payload);

    // Not awaited — see notifyFeedbackEmail()'s own docblock for why this
    // must never delay or fail the success UI below.
    notifyFeedbackEmail({
      category,
      message,
      displayName: payload.displayName,
      teamName: payload.teamName,
      email: email || null,
      hasScreenshot: !!pendingFeedbackScreenshot
    }).catch((err) => {
      console.warn('Feedback email notification failed (feedback was still saved to Firestore):', err);
    });

    hideLoading();
    closeFeedbackModal();
    if (typeof showNoticeModal === 'function') {
      showNoticeModal({ title: 'Feedback Sent', message: 'Thanks for the feedback!' });
    }
  } catch (err) {
    hideLoading();
    console.error('Failed to submit feedback:', err);
    if (typeof setStatusMessage === 'function') setStatusMessage('feedback', 'error', 'Failed to send feedback. Please check your connection and try again.');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const openBtn = document.getElementById('btn-open-feedback');
  if (openBtn) openBtn.addEventListener('click', openFeedbackModal);

  const closeBtn = document.getElementById('btn-feedback-close');
  if (closeBtn) closeBtn.addEventListener('click', closeFeedbackModal);

  const cancelBtn = document.getElementById('btn-feedback-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', closeFeedbackModal);

  const overlay = document.getElementById('feedback-modal-overlay');
  if (overlay) overlay.addEventListener('click', closeFeedbackModal);

  const submitBtn = document.getElementById('btn-feedback-submit');
  if (submitBtn) submitBtn.addEventListener('click', submitFeedback);

  const attachBtn = document.getElementById('btn-feedback-attach');
  const attachInput = document.getElementById('input-feedback-attachment');
  if (attachBtn && attachInput) {
    attachBtn.addEventListener('click', () => attachInput.click());
    attachInput.addEventListener('change', () => {
      const file = attachInput.files && attachInput.files[0];
      attachInput.value = ''; // allow re-picking the same file later
      if (file) handleFeedbackAttachmentChosen(file);
    });
  }

  const removeAttachBtn = document.getElementById('btn-feedback-remove-attachment');
  if (removeAttachBtn) removeAttachBtn.addEventListener('click', clearFeedbackAttachment);

  // Drag-and-drop — same resize/compress pipeline as the file-picker button,
  // just a second way to hand it a file.
  const dropzone = document.getElementById('feedback-attachment-dropzone');
  if (dropzone) {
    ['dragenter', 'dragover'].forEach((evtName) => {
      dropzone.addEventListener(evtName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add('drag-over');
      });
    });
    // dragleave fires when the cursor crosses onto a CHILD element too (the
    // buttons/text/preview inside the dropzone), not just when it truly
    // leaves the zone — check relatedTarget so hovering over those children
    // doesn't flicker the highlight off and back on.
    dropzone.addEventListener('dragleave', (e) => {
      if (!dropzone.contains(e.relatedTarget)) {
        dropzone.classList.remove('drag-over');
      }
    });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('drag-over');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) handleFeedbackAttachmentChosen(file);
    });
  }

  // Clipboard paste — listens on the whole modal so it works regardless of
  // which field currently has focus. Only intercepts when the clipboard
  // actually contains an image; a plain text paste (e.g. into Message) is
  // left completely alone.
  const modalEl = document.getElementById('feedback-modal');
  if (modalEl) {
    modalEl.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) handleFeedbackAttachmentChosen(file);
          break;
        }
      }
    });
  }
});
