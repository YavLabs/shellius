/**
 * The Slack adapter, and the trap it exists to avoid.
 *
 * Slack answers `chat.postMessage` with **HTTP 200 and `{ok: false}`** when it
 * refuses a message. Classifying by status code — which is exactly right for
 * the audit sinks, whose destination is an arbitrary HTTP collector — would
 * read every Slack failure as a success: the failure counter would never rise,
 * the destination would never be switched off, the delivery log would say
 * "delivered", and an organisation would believe its approvals were arriving
 * in Slack while nothing had for a week.
 *
 * The other half of this file is escaping. Posture findings carry process
 * names and usernames read off a monitored host; Slack's mrkdwn renders
 * `<!channel>` as a broadcast and `<http://x|text>` as a disguised link, so a
 * compromised host could otherwise ping everyone in a channel or put a
 * convincing fake link in front of an administrator.
 */

import * as slack from '../notify/chat/slack.js';
import { buildBlocks, classify, validateConfig, describeConfig } from '../notify/chat/slack.js';
import { normalizeMessage, MAX_TEXT } from '../notify/chat/message.js';

describe('slack adapter — error classification', () => {
  test('a rate limit is retryable', () => {
    const err = classify({ ok: false, error: 'ratelimited' });
    expect(err.retryable).toBe(true);
  });

  test.each([
    'invalid_auth',
    'account_inactive',
    'token_revoked',
    'channel_not_found',
    'not_in_channel',
    'is_archived',
  ])('%s switches the destination off rather than retrying forever', (error) => {
    const err = classify({ ok: false, error });
    expect(err.retryable).toBe(false);
    expect(err.disable).toBe(true);
  });

  test('a message Slack will never accept is permanent but does not disable', () => {
    const err = classify({ ok: false, error: 'message_too_long' });
    expect(err.retryable).toBe(false);
    expect(err.disable).toBeFalsy();
  });

  test('an unrecognised error is retried rather than silently dropped', () => {
    expect(classify({ ok: false, error: 'something_new' }).retryable).toBe(true);
  });

  test('a 200 with ok:false is a failure — the whole point of this file', async () => {
    const realFetch = global.fetch;
    global.fetch = async () =>
      new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    try {
      await expect(
        slack.deliver(
          { mode: 'app', botToken: 'xoxb-test', channel: '#ops' },
          { title: 'hi', summary: 'there', severity: 'info' }
        )
      ).rejects.toMatchObject({ retryable: false, disable: true });
    } finally {
      global.fetch = realFetch;
    }
  });
});

describe('slack adapter — configuration', () => {
  test('a webhook URL must actually be a Slack webhook URL', () => {
    expect(() => validateConfig({ url: 'https://evil.test/hook' })).toThrow(/hooks\.slack\.com/);
    expect(() => validateConfig({ url: 'http://hooks.slack.com/services/x' })).toThrow(/hooks\.slack\.com/);
    expect(validateConfig({ url: 'https://hooks.slack.com/services/T1/B2/abc' }).mode).toBe('webhook');
  });

  test('a bot token is recognised by its prefix', () => {
    expect(() => validateConfig({ mode: 'app', botToken: 'nope', channel: '#ops' })).toThrow(/xoxb-/);
    expect(validateConfig({ mode: 'app', botToken: 'xoxb-1-2', channel: '#ops' }).mode).toBe('app');
  });

  test('both the URL and the bot token are secrets', () => {
    // Unlike the audit sink's `url`, which names a customer's own collector,
    // a Slack webhook URL IS the credential: anyone holding it can post as us.
    expect(slack.secretFields).toEqual(expect.arrayContaining(['url', 'botToken']));
  });

  test('a destination can be identified without revealing the credential', () => {
    const shown = describeConfig({ url: 'https://hooks.slack.com/services/T000/B111/SeCrEtPart' });
    expect(shown).not.toContain('SeCrEtPart');
    expect(shown).toContain('hooks.slack.com');
  });
});

describe('slack adapter — rendering', () => {
  test('a host-supplied string cannot become a channel-wide ping', () => {
    const blocks = buildBlocks({
      title: 'Posture finding',
      summary: 'Process <!channel> found listening',
      fields: [{ label: 'Process', value: '<!here> sshd' }],
      severity: 'warning',
    });
    const json = JSON.stringify(blocks);
    expect(json).not.toContain('<!channel>');
    expect(json).not.toContain('<!here>');
    expect(json).toContain('&lt;!channel&gt;');
  });

  test('a host-supplied string cannot become a disguised link', () => {
    const blocks = buildBlocks({
      title: 'Finding',
      summary: 'see <https://evil.test|your bank>',
      severity: 'info',
    });
    expect(JSON.stringify(blocks)).not.toContain('<https://evil.test|');
  });

  test('the header is plain_text, which does no markup at all', () => {
    const blocks = buildBlocks({ title: 'a <b> title', summary: '', severity: 'info' });
    expect(blocks[0].type).toBe('header');
    expect(blocks[0].text.type).toBe('plain_text');
  });

  test('an over-long body is truncated rather than rejected whole', () => {
    // Slack rejects a text object over 3000 characters, and rejects the entire
    // message rather than trimming — so one long finding would deliver nothing.
    const m = normalizeMessage({ title: 'x', summary: 'a'.repeat(10_000), severity: 'info' });
    expect(m.summary.length).toBeLessThanOrEqual(MAX_TEXT);
    expect(m.summary.endsWith('…')).toBe(true);
  });

  test('an action button carries its confirmation dialog', () => {
    const blocks = buildBlocks(
      { title: 'Access request', summary: 'prod', severity: 'warning', url: 'https://shellius.test/x' },
      {
        actions: [
          {
            id: 'approve',
            label: 'Approve',
            value: 'approve:req_1',
            style: 'primary',
            confirm: { title: 'Approve production access?', text: 'db-prod-01', ok: 'Approve', danger: true },
          },
        ],
      }
    );
    const actions = blocks.find((b) => b.type === 'actions');
    expect(actions.elements[0].confirm.title.text).toMatch(/production/i);
    // The link button is always present alongside.
    expect(actions.elements.some((e) => e.url)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('generic webhook adapter', () => {
  test('the signature is actually sent, not merely computed', async () => {
    // It was once computed into a headers object that was never passed to the
    // transport, so every payload arrived unsigned — something the unit tests
    // did not notice and a stand-in collector did, immediately.
    const { deliver, signBody } = await import('../notify/chat/webhook.js');
    const realFetch = global.fetch;
    let seen = null;
    global.fetch = async (url, init) => {
      seen = init;
      return new Response('ok', { status: 200 });
    };
    try {
      await deliver(
        { url: 'https://example.com/hook', signingSecret: 'shh' },
        { title: 'hello', summary: 'world', severity: 'info' },
        { event: 'test' }
      );
      expect(seen.headers['X-Shellius-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      // And it verifies against the exact body that was sent.
      const [, ts] = seen.headers['X-Shellius-Signature'].match(/^t=(\d+),/);
      expect(signBody('shh', seen.body, Number(ts))).toBe(seen.headers['X-Shellius-Signature']);
    } finally {
      global.fetch = realFetch;
    }
  });

  test('no secret means no signature header, not an empty one', async () => {
    const { deliver } = await import('../notify/chat/webhook.js');
    const realFetch = global.fetch;
    let seen = null;
    global.fetch = async (url, init) => {
      seen = init;
      return new Response('ok', { status: 200 });
    };
    try {
      await deliver({ url: 'https://example.com/hook' }, { title: 'hi', severity: 'info' }, {});
      expect(seen.headers['X-Shellius-Signature']).toBeUndefined();
    } finally {
      global.fetch = realFetch;
    }
  });
});
