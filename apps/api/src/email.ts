import nodemailer from 'nodemailer';

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM;
const SMTP_BCC = process.env.SMTP_BCC || undefined;
const APP_URL = process.env.APP_URL;

export const smtpConfigured = !!(SMTP_HOST && SMTP_USER && SMTP_PASS && SMTP_FROM && APP_URL);

if (!smtpConfigured) {
  const missing = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'APP_URL']
    .filter(v => !process.env[v])
    .join(', ');
  console.warn(`[email] SMTP not fully configured (missing: ${missing}) — activation emails will not be sent`);
}

const transporter = smtpConfigured
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

export async function sendActivationEmail(to: string, token: string): Promise<void> {
  if (!transporter) {
    throw new Error('SMTP not configured');
  }

  const registerUrl = `${APP_URL}/register?token=${encodeURIComponent(token)}`;

  await transporter.sendMail({
    from: SMTP_FROM,
    to,
    bcc: SMTP_BCC,
    subject: 'Activate your Ubimate account',
    text: [
      'Your Ubimate account is ready to be activated.',
      '',
      `Activate your account here: ${registerUrl}`,
      '',
      `Or enter this activation token on the Create account form: ${token}`,
      '',
      'This activation token will expire in 7 days.',
    ].join('\n'),
    html: [
      '<h2>Activate your Ubimate account</h2>',
      '<p>Your Ubimate account is ready to be activated.</p>',
      `<p><a href="${registerUrl}" style="display:inline-block;padding:12px 24px;background:#1677ff;color:#fff;text-decoration:none;border-radius:6px;">Activate your account</a></p>`,
      `<p>Or enter this activation token on the Create account form: <code>${token}</code></p>`,
      '<p><small>This activation token will expire in 7 days.</small></p>',
    ].join('\n'),
  });
}

export async function sendCredentialResetEmail(to: string, token: string): Promise<void> {
  if (!transporter) {
    throw new Error('SMTP not configured');
  }

  const resetUrl = `${APP_URL}/reset-credentials?token=${encodeURIComponent(token)}`;

  await transporter.sendMail({
    from: SMTP_FROM,
    to,
    bcc: SMTP_BCC,
    subject: 'Reset your Ubimate sync credentials',
    text: [
      'You requested a Ubimate credential reset.',
      '',
      'This action is destructive for cloud sync state and should be used only when needed.',
      '',
      `Confirm reset: ${resetUrl}`,
      '',
      'If you did not request this, you can ignore this email.',
    ].join('\n'),
    html: [
      '<h2>Reset your Ubimate sync credentials</h2>',
      '<p>You requested a credential reset.</p>',
      '<p>This action is destructive for cloud sync state and should be used only when needed.</p>',
      `<p><a href="${resetUrl}" style="display:inline-block;padding:12px 24px;background:#1677ff;color:#fff;text-decoration:none;border-radius:6px;">Confirm reset</a></p>`,
      '<p><small>If you did not request this, you can ignore this email.</small></p>',
    ].join('\n'),
  });
}
