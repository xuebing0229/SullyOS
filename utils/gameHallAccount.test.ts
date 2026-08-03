import { describe, expect, it } from 'vitest';
import {
  extractCharacterAccountFields,
  formatGameHallToolResult,
  getGameHallToolResultPayload,
  isCredentialFieldName,
} from './gameHallAccount';

const LONG_TOKEN = `cedar_${'A1b2C3'.repeat(1200)}`;

describe('gameHallAccount exact result handling', () => {
  it('keeps token/password/cookie/authorization exactly as returned', () => {
    const rawResult = {
      content: [{
        type: 'text',
        text: JSON.stringify({
          token: LONG_TOKEN,
          password: 'p@ss\nword',
          cookie: 'sid=abc; path=/',
          authorization: 'Bearer exact-value',
        }),
      }],
      structuredContent: {
        token: LONG_TOKEN,
        password: 'p@ss\nword',
        cookie: 'sid=abc; path=/',
        authorization: 'Bearer exact-value',
      },
    };
    const payload = getGameHallToolResultPayload({
      success: true,
      data: rawResult.structuredContent,
      rawResult,
    });
    const text = formatGameHallToolResult(payload);
    expect(text).toContain(LONG_TOKEN);
    expect(JSON.parse(text).structuredContent.password).toBe('p@ss\nword');
    expect(text).toContain('sid=abc; path=/');
    expect(text).toContain('Bearer exact-value');
    expect(text).not.toContain('[已隐藏]');
    expect(text).not.toContain('已省略');
    expect(text.length).toBeGreaterThan(LONG_TOKEN.length);
  });

  it('extracts exact credentials even when the MCP only returns JSON inside content.text', () => {
    const result = {
      success: true,
      rawResult: {
        content: [{
          type: 'text',
          text: JSON.stringify({
            account_id: 'role-17',
            username: '祁连云',
            agent_token: LONG_TOKEN,
            character_session_id: 'session-exact',
          }),
        }],
      },
    };
    const extracted = extractCharacterAccountFields(result);
    expect(extracted.accountId).toBe('role-17');
    expect(extracted.username).toBe('祁连云');
    expect(extracted.credentials.agent_token).toBe(LONG_TOKEN);
    expect(extracted.credentials.character_session_id).toBe('session-exact');
  });

  it('selects rawResult before summaries', () => {
    const rawResult = { exact: { token: 'RAW' } };
    expect(getGameHallToolResultPayload({
      success: true,
      data: { token: 'DATA' },
      structuredContent: { token: 'STRUCTURED' },
      rawResult,
    })).toBe(rawResult);
  });

  it('recognizes credential schema fields for accountRef injection', () => {
    expect(isCredentialFieldName('token')).toBe(true);
    expect(isCredentialFieldName('access_token')).toBe(true);
    expect(isCredentialFieldName('Authorization')).toBe(true);
    expect(isCredentialFieldName('password')).toBe(true);
    expect(isCredentialFieldName('agent_token')).toBe(true);
    expect(isCredentialFieldName('characterSessionId')).toBe(true);
    expect(isCredentialFieldName('game_id')).toBe(false);
  });
});
