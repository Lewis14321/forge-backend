const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.RESEND_FROM_EMAIL || 'Forge <noreply@forge.dev>';
const APP_NAME = 'Forge';

function base(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; margin: 0; padding: 32px 16px; }
    .card { background: #fff; border-radius: 12px; max-width: 520px; margin: 0 auto; padding: 40px; border: 1px solid #e5e7eb; }
    .logo { font-size: 22px; font-weight: 800; color: #4f46e5; margin-bottom: 28px; }
    h2 { margin: 0 0 8px; font-size: 20px; color: #111827; }
    p { margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #374151; }
    .btn { display: inline-block; background: #4f46e5; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; font-size: 15px; margin: 8px 0 20px; }
    .muted { font-size: 13px; color: #9ca3af; }
    hr { border: none; border-top: 1px solid #e5e7eb; margin: 24px 0; }
  </style></head><body>
  <div class="card">
    <div class="logo">${APP_NAME}</div>
    <h2>${title}</h2>
    ${body}
    <hr>
    <p class="muted">You're receiving this because you have an account on ${APP_NAME}. Do not reply to this email.</p>
  </div></body></html>`;
}

async function send(to, subject, html) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY not set — skipping email to', to);
    return;
  }
  try {
    await resend.emails.send({ from: FROM, to, subject, html });
  } catch (err) {
    console.error('[email] send failed:', err?.message);
  }
}

async function sendPasswordReset(to, name, resetUrl) {
  await send(to, `Reset your ${APP_NAME} password`,
    base('Reset your password',
      `<p>Hi ${name},</p>
       <p>We received a request to reset your password. Click the button below — this link expires in 15 minutes.</p>
       <a href="${resetUrl}" class="btn">Reset Password</a>
       <p class="muted">If you didn't request this, you can safely ignore this email. Your password won't change.</p>
       <p class="muted">Or copy this URL: ${resetUrl}</p>`
    )
  );
}

async function sendMilestoneSubmitted(to, creatorName, builderName, milestoneTitle, projectTitle, projectUrl) {
  await send(to, `Work submitted on "${milestoneTitle}"`,
    base('New submission to review',
      `<p>Hi ${creatorName},</p>
       <p><strong>${builderName}</strong> has submitted work for the milestone <strong>"${milestoneTitle}"</strong> on your project <strong>${projectTitle}</strong>.</p>
       <p>Head to your project to review and approve or request changes.</p>
       <a href="${projectUrl}" class="btn">Review Submission</a>`
    )
  );
}

async function sendMilestoneApproved(to, builderName, milestoneTitle, projectTitle, projectUrl) {
  await send(to, `Your work on "${milestoneTitle}" was approved`,
    base('Milestone approved!',
      `<p>Hi ${builderName},</p>
       <p>Your submission for <strong>"${milestoneTitle}"</strong> on the project <strong>${projectTitle}</strong> has been approved.</p>
       <p>The creator will release your payment shortly.</p>
       <a href="${projectUrl}" class="btn">View Project</a>`
    )
  );
}

async function sendPaymentReleased(to, builderName, amount, milestoneTitle, projectTitle) {
  const formatted = `£${Number(amount).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  await send(to, `Payment of ${formatted} released`,
    base('Payment released',
      `<p>Hi ${builderName},</p>
       <p>Your payment of <strong>${formatted}</strong> for the milestone <strong>"${milestoneTitle}"</strong> on <strong>${projectTitle}</strong> has been released via Stripe.</p>
       <p>It should arrive in your connected bank account within 2–7 business days depending on your Stripe payout schedule.</p>`
    )
  );
}

async function sendDisputeOpened(to, recipientName, disputeType, projectTitle, projectUrl) {
  const label = disputeType.replace(/_/g, ' ');
  await send(to, `A dispute has been opened on "${projectTitle}"`,
    base('Dispute opened',
      `<p>Hi ${recipientName},</p>
       <p>A dispute of type <strong>${label}</strong> has been raised on the project <strong>${projectTitle}</strong>.</p>
       <p>Our team will review it and may reach out. You can view the project and add context via the link below.</p>
       <a href="${projectUrl}" class="btn">View Project</a>`
    )
  );
}

module.exports = {
  sendPasswordReset,
  sendMilestoneSubmitted,
  sendMilestoneApproved,
  sendPaymentReleased,
  sendDisputeOpened,
};
