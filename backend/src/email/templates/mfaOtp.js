import { escapeHtml as esc } from '../escape.js';
import { renderLayout } from '../layout.js';

export function render({ recipientName, code, minutes }) {
  const subject = `[Shellius] Your verification code: ${code}`;
  const safeName = esc(recipientName || 'there');
  const safeCode = esc(code);
  const mins = Number(minutes) || 10;

  const bodyHtml = `
    <h1 style="margin:0 0 16px;font:600 22px/1.3 -apple-system,sans-serif;color:#0a0a0a">
      Your verification code
    </h1>
    <p style="margin:0 0 16px;font:400 15px/1.5 -apple-system,sans-serif;color:#3f3f46">
      Hi ${safeName}, use this code to finish signing in:
    </p>
    <div style="margin:24px 0;text-align:center">
      <span style="display:inline-block;padding:14px 28px;background:#f4f4f5;border:1px solid #e4e4e7;border-radius:8px;font:700 28px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:6px;color:#0a0a0a">${safeCode}</span>
    </div>
    <p style="margin:0;font:400 13px/1.5 -apple-system,sans-serif;color:#71717a">
      This code expires in ${mins} minutes. If you didn't try to sign in, you can ignore this email.
    </p>
  `;

  const text = `Your Shellius verification code is ${code}. It expires in ${mins} minutes.`;

  return {
    subject,
    html: renderLayout({ title: subject, preheader: `Code: ${code}`, bodyHtml }),
    text,
  };
}
