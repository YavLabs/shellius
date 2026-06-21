/**
 * castCommands.js
 *
 * Best-effort extraction of the commands a user ran during an SSH session,
 * parsed from the asciinema v2 (.cast) recording.
 *
 * Recordings only capture terminal OUTPUT ('o' events) - there is no separate
 * keystroke log. Because the remote PTY echoes what the user types, the typed
 * command lands in the output stream right after the shell prompt. We strip
 * ANSI control sequences, reconstruct each visual line, and pull the text that
 * follows a recognizable shell prompt.
 *
 * This is a heuristic: exotic PS1 prompts or full-screen TUI programs (vim,
 * top, etc.) can produce false positives/negatives. The UI labels the list
 * as "detected" for this reason.
 */

// Standard ansi-regex pattern (matches CSI + OSC escape sequences).
const ANSI_REGEX = new RegExp(
  [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
  ].join('|'),
  'g'
);

function clean(cmd) {
  return cmd.replace(/\s+$/, '').trim();
}

/**
 * Given a single reconstructed visual line, return the command typed after the
 * shell prompt, or null if the line is not a prompt line.
 */
function matchPromptCommand(line) {
  // user@host:~/path$ cmd   |   user@host:~/path# cmd
  let m = line.match(/\S+@\S+:.*?[$#]\s+(\S.*)$/);
  if (m) return clean(m[1]);
  // bash-5.1$ cmd | sh-5.1# cmd | zsh-5.9% cmd
  m = line.match(/(?:^|\s)(?:bash|sh|zsh)-[\d.]+[$#%]\s+(\S.*)$/);
  if (m) return clean(m[1]);
  // Bare prompt at start of line: "$ cmd" or "# cmd"
  m = line.match(/^[$#]\s+(\S.*)$/);
  if (m) return clean(m[1]);
  return null;
}

/**
 * Parse a .cast recording and return the list of detected commands.
 *
 * @param {string} castText  Raw asciinema v2 .cast file contents
 * @returns {Array<{ command: string, time: number }>}  time = seconds offset
 */
export function extractCommands(castText) {
  if (!castText || typeof castText !== 'string') return [];

  const lines = castText.split('\n');
  const commands = [];
  let pending = '';     // current visual line being reconstructed
  let lineTime = 0;     // timestamp of the most recent byte on `pending`

  // Skip line 0 (the asciicast header).
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) continue;

    let evt;
    try {
      evt = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(evt) || evt[1] !== 'o') continue;

    const time = typeof evt[0] === 'number' ? evt[0] : 0;
    const data = String(evt[2]).replace(/\r\n/g, '\n').replace(ANSI_REGEX, '');

    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (ch === '\n') {
        const cmd = matchPromptCommand(pending);
        if (cmd) commands.push({ command: cmd, time: lineTime });
        pending = '';
      } else if (ch === '\r') {
        // Carriage return: cursor back to column 0 (progress bars, etc.)
        pending = '';
      } else if (code === 8 || code === 127) {
        // Backspace / DEL
        pending = pending.slice(0, -1);
      } else if (ch === '\t' || code >= 32) {
        pending += ch;
      }
      lineTime = time;
    }
  }

  return commands;
}

/** Format a seconds offset as m:ss for display next to a command. */
export function formatOffset(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
