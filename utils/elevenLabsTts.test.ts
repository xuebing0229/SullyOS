import { describe, expect, it } from 'vitest';
import type { APIConfig, CharacterProfile } from '../types';
import {
  buildElevenLabsRequestBody,
  cleanTextForTtsElevenLabs,
  getElevenLabsVoiceActingGuide,
  normalizeElevenLabsModel,
  normalizeElevenLabsVoiceId,
  stripElevenLabsMarkupForDisplay,
} from './elevenLabsTts';
import { normalizeTtsProvider } from './ttsProvider';

const character = {
  id: 'char-1',
  name: '测试角色',
  avatar: '',
  description: '',
  systemPrompt: '',
  memories: [],
  voiceProfile: {
    elevenLabsVoiceId: '21m00Tcm4TlvDq8ikWAM',
    speed: 1.1,
    elevenLabsSpeed: 0.85,
  },
} as CharacterProfile;

describe('ElevenLabs voice id', () => {
  it('accepts a raw id and extracts ids from common links', () => {
    expect(normalizeElevenLabsVoiceId('21m00Tcm4TlvDq8ikWAM')).toBe('21m00Tcm4TlvDq8ikWAM');
    expect(normalizeElevenLabsVoiceId('https://elevenlabs.io/app/voice-library?voiceId=21m00Tcm4TlvDq8ikWAM'))
      .toBe('21m00Tcm4TlvDq8ikWAM');
    expect(normalizeElevenLabsVoiceId('https://elevenlabs.io/app/voice-library/21m00Tcm4TlvDq8ikWAM'))
      .toBe('21m00Tcm4TlvDq8ikWAM');
    expect(normalizeElevenLabsVoiceId('https://elevenlabs.io/app/settings')).toBe('');
  });
});

describe('ElevenLabs v4 migration and text cleanup', () => {
  it('keeps v4 tags and converts known parenthesized cues', () => {
    expect(cleanTextForTtsElevenLabs('<语音>[laughs] 你好 (sigh)</语音>', 'eleven_v4'))
      .toBe('[laughs] 你好 [sighs]');
  });

  it('passes every single-bracket v4 Audio Tag through verbatim', () => {
    expect(cleanTextForTtsElevenLabs(
      '<语音>[wet squeeze] 阿竹……[spank — sharp, loud crack]再来。[急促喘息]等等。[!!! / ???]好。</语音>',
      'eleven_v4',
    )).toBe('[wet squeeze] 阿竹……[spank — sharp, loud crack]再来。[急促喘息]等等。[!!! / ???]好。');
    expect(cleanTextForTtsElevenLabs('[short pause] 好。[long pause] 再说。', 'eleven_v4'))
      .toBe('[short pause] 好。[long pause] 再说。');
  });

  it('still strips SullyOS double-bracket control blocks before TTS', () => {
    expect(cleanTextForTtsElevenLabs('<语音>[[internal-control]][急促喘息]你好</语音>', 'eleven_v4'))
      .toBe('[急促喘息]你好');
  });

  it('migrates old saved model ids to v4 while preserving v4 Turbo', () => {
    expect(normalizeElevenLabsModel('eleven_v3')).toBe('eleven_v4');
    expect(normalizeElevenLabsModel('eleven_flash_v2_5')).toBe('eleven_v4');
    expect(normalizeElevenLabsModel('eleven_multilingual_v2')).toBe('eleven_v4');
    expect(normalizeElevenLabsModel('eleven_v4_turbo')).toBe('eleven_v4_turbo');
  });

  it('hides every single-bracket Audio Tag from ElevenLabs voice display', () => {
    expect(stripElevenLabsMarkupForDisplay('[whispers] 小声说 [第2章]')).toBe('小声说');
    expect(stripElevenLabsMarkupForDisplay('[spank — sharp, loud crack]阿竹……[急促喘息]等等。'))
      .toBe('阿竹……等等。');
  });
});

describe('ElevenLabs v4 request body', () => {
  it('only sends Stability + Similarity and keeps language selection', () => {
    const config: APIConfig = {
      baseUrl: '',
      apiKey: '',
      model: '',
      elevenLabsModel: 'eleven_v4',
      elevenLabsStability: 0.35,
      elevenLabsSimilarityBoost: 1.5,
      elevenLabsStyle: 0.9,
      elevenLabsUseSpeakerBoost: true,
    };
    const body = buildElevenLabsRequestBody('你好', character, config, { languageBoost: 'JA' });
    expect(body).toEqual({
      text: '你好',
      model_id: 'eleven_v4',
      language_code: 'ja',
      voice_settings: {
        stability: 0.35,
        similarity_boost: 1,
      },
    });
    expect(body.voice_settings).not.toHaveProperty('style');
    expect(body.voice_settings).not.toHaveProperty('speed');
    expect(body.voice_settings).not.toHaveProperty('use_speaker_boost');
  });

  it('supports v4 Cantonese codes and adds an emotion cue once', () => {
    const config = {
      baseUrl: '', apiKey: '', model: '',
      elevenLabsModel: 'eleven_v4_turbo',
      elevenLabsStability: 0.76,
    } as APIConfig;
    const body = buildElevenLabsRequestBody('真的？', character, config, { languageBoost: 'yue', emotion: 'surprised' });
    expect(body.model_id).toBe('eleven_v4_turbo');
    expect(body.language_code).toBe('yue');
    expect(body.voice_settings.stability).toBe(0.76);
    expect(body.text).toBe('[curious] 真的？');
  });
});

describe('ElevenLabs prompt and provider routing', () => {
  it('uses v4 Audio Tags guidance and recognizes the provider', () => {
    expect(getElevenLabsVoiceActingGuide('eleven_v4')).toContain('Audio Tags');
    expect(getElevenLabsVoiceActingGuide('eleven_v4_turbo')).toContain('ElevenLabs v4');
    expect(normalizeTtsProvider('elevenlabs')).toBe('elevenlabs');
  });
});
