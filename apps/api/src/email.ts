import nodemailer from 'nodemailer';

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM ?? 'no-reply@sovernote.app';
const APP_URL = process.env.APP_URL ?? 'https://app.sovernote.app';

export const smtpConfigured = !!(SMTP_HOST && SMTP_USER && SMTP_PASS);

if (!smtpConfigured) {
  console.warn('[email] SMTP not configured — invitation emails will not be sent');
}

const transporter = smtpConfigured
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

export async function sendInvitationEmail(to: string, token: string): Promise<void> {
  if (!transporter) {
    throw new Error('SMTP not configured');
  }

  const registerUrl = `${APP_URL}/register?token=${encodeURIComponent(token)}`;

  await transporter.sendMail({
    from: SMTP_FROM,
    to,
    subject: 'You\'re invited to Sovernote',
    text: [
      'You\'ve been invited to join Sovernote!',
      '',
      `Sign up here: ${registerUrl}`,
      '',
      `Or enter this invitation token manually: ${token}`,
      '',
      'This invitation will expire in 7 days.',
    ].join('\n'),
    html: [
      '<h2>You\'re invited to Sovernote!</h2>',
      '<p>You\'ve been invited to create an account on Sovernote.</p>',
      `<p><a href="${registerUrl}" style="display:inline-block;padding:12px 24px;background:#1677ff;color:#fff;text-decoration:none;border-radius:6px;">Create your account</a></p>`,
      `<p>Or enter this invitation token manually: <code>${token}</code></p>`,
      '<p><small>This invitation will expire in 7 days.</small></p>',
    ].join('\n'),
  });
}
