import { escapeHtml as esc } from '../escape.js';
import { renderLayout } from '../layout.js';
import { button } from '../button.js';

/**
 * The periodic posture digest — one email covering a window, instead of one
 * per finding.
 *
 * Escaping matters more here than in most templates. Every value below
 * originates on a monitored host: `message` carries process names and unix
 * usernames, `ownerLabel` carries container image names. A compromised host
 * must not be able to put markup, let alone a link, into an administrator's
 * mailbox — this is the same rule the immediate posture alert follows
 * (posture-spec.md §9.12, "escaping at render").
 */

const SEVERITY_COLOR = {
  CRITICAL: '#b91c1c',
  HIGH: '#c2410c',
  MEDIUM: '#a16207',
  LOW: '#3f6212',
  INFO: '#3f3f46',
};

function severityColor(sev) {
  return SEVERITY_COLOR[String(sev || '').toUpperCase()] || SEVERITY_COLOR.INFO;
}

function where(f) {
  if (!f.port) return '';
  return `${f.proto || 'tcp'}/${f.port}`;
}

function row(f) {
  const loc = where(f);
  return `
    <tr>
      <td style="padding:8px 12px 8px 0;vertical-align:top;white-space:nowrap">
        <span style="font:600 12px/1.4 -apple-system,sans-serif;color:${severityColor(f.severity)}">${esc(
          String(f.severity || '').toUpperCase()
        )}</span>
      </td>
      <td style="padding:8px 12px 8px 0;vertical-align:top">
        <span style="font:600 14px/1.4 -apple-system,sans-serif;color:#09090C">${esc(f.code)}</span>${
          loc ? `<span style="font:400 13px/1.4 -apple-system,sans-serif;color:#71717a"> ${esc(loc)}</span>` : ''
        }
        <br/>
        <span style="font:400 13px/1.5 -apple-system,sans-serif;color:#3f3f46">${esc(f.message || '')}</span>
      </td>
      <td style="padding:8px 0;vertical-align:top;white-space:nowrap">
        <span style="font:400 13px/1.4 -apple-system,sans-serif;color:#3f3f46">${esc(f.serverName || '')}</span><br/>
        <span style="font:400 12px/1.4 -apple-system,sans-serif;color:#71717a">${esc(f.environment || '')}</span>
      </td>
    </tr>`;
}

function textRow(f) {
  const loc = where(f);
  return `  [${String(f.severity || '').toUpperCase()}] ${f.code}${loc ? ` ${loc}` : ''} on ${f.serverName} (${
    f.environment
  })\n      ${f.message || ''}`;
}

/**
 * @param {object} vars
 * @param {string} vars.recipientName
 * @param {string} vars.ruleName
 * @param {string} vars.periodLabel      e.g. "the last 24 hours"
 * @param {Array}  vars.findings         opened/reopened in the window
 * @param {Array}  [vars.resolved]       resolved in the window (opt-in)
 * @param {number} [vars.truncated]      how many were left out of `findings`
 * @param {string} vars.postureUrl
 */
export function render({
  recipientName,
  ruleName,
  periodLabel: period,
  findings = [],
  resolved = [],
  truncated = 0,
  postureUrl,
}) {
  const n = findings.length;
  const subject = `[Shellius] Posture digest: ${n} new finding${n === 1 ? '' : 's'}`;
  const safeName = esc(recipientName || 'there');
  const safeRule = esc(ruleName || '');
  const safePeriod = esc(period || 'the last day');

  const findingsTable = n
    ? `<table style="border-collapse:collapse;width:100%;margin:0 0 8px">${findings.map(row).join('')}</table>`
    : `<p style="margin:0 0 16px;font:400 15px/1.5 -apple-system,sans-serif;color:#3f3f46">
         Nothing new opened in this period.
       </p>`;

  const truncatedHtml = truncated
    ? `<p style="margin:8px 0 0;font:400 13px/1.5 -apple-system,sans-serif;color:#71717a">
         and ${esc(String(truncated))} more — the full list is in Shellius.
       </p>`
    : '';

  const resolvedHtml = resolved.length
    ? `<h2 style="margin:28px 0 8px;font:600 15px/1.3 -apple-system,sans-serif;color:#09090C">
         Resolved in this period (${esc(String(resolved.length))})
       </h2>
       <table style="border-collapse:collapse;width:100%">${resolved.map(row).join('')}</table>`
    : '';

  const bodyHtml = `
    <h1 style="margin:0 0 4px;font:600 22px/1.3 -apple-system,sans-serif;color:#09090C">
      Posture digest
    </h1>
    <p style="margin:0 0 20px;font:400 13px/1.5 -apple-system,sans-serif;color:#71717a">
      ${safeRule} &middot; ${safePeriod}
    </p>
    <p style="margin:0 0 16px;font:400 15px/1.5 -apple-system,sans-serif;color:#3f3f46">
      Hi ${safeName}, here is what changed on the hosts you can see.
    </p>
    ${findingsTable}
    ${truncatedHtml}
    ${resolvedHtml}
    <div style="margin:32px 0;text-align:center">
      ${button({ href: esc(postureUrl), label: 'Open Posture' })}
    </div>
  `;

  const textLines = [
    `Posture digest — ${ruleName} — ${period}`,
    '',
    n ? `${n} new finding${n === 1 ? '' : 's'}:` : 'Nothing new opened in this period.',
    ...findings.map(textRow),
  ];
  if (truncated) textLines.push(`  and ${truncated} more — the full list is in Shellius.`);
  if (resolved.length) {
    textLines.push('', `Resolved in this period (${resolved.length}):`, ...resolved.map(textRow));
  }
  textLines.push('', `Open Posture: ${postureUrl}`);

  return {
    subject,
    html: renderLayout({
      title: subject,
      preheader: n ? `${n} new posture finding${n === 1 ? '' : 's'} in ${period}` : `No new findings in ${period}`,
      bodyHtml,
    }),
    text: textLines.join('\n'),
  };
}
