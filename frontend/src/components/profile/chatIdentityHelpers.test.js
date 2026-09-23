import { describe, expect, it } from 'vitest';
import { CHAT_VARIANTS } from '@/components/settings/chat/chatTypes';
import { platformLabel, platformIcon } from './chatIdentityHelpers';

describe('platformLabel', () => {
  it('gives Slack a clean, mode-free label', () => {
    expect(platformLabel('slack')).toBe('Slack');
  });

  it('labels the other known platforms', () => {
    expect(platformLabel('google_chat')).toBe('Google Chat');
    expect(platformLabel('teams')).toBe('Microsoft Teams');
    expect(platformLabel('webhook')).toBe('Webhook');
  });

  it('falls back to the raw platform for anything unknown', () => {
    expect(platformLabel('discord')).toBe('discord');
    expect(platformLabel(undefined)).toBe('Unknown');
    expect(platformLabel(null)).toBe('Unknown');
  });
});

describe('platformIcon', () => {
  it('returns an icon for every platform present in CHAT_VARIANTS', () => {
    for (const platform of new Set(CHAT_VARIANTS.map((v) => v.platform))) {
      expect(platformIcon(platform)).toBeTruthy();
    }
  });

  it('returns null for an unknown platform instead of throwing', () => {
    expect(platformIcon('discord')).toBeNull();
    expect(platformIcon(undefined)).toBeNull();
  });
});
