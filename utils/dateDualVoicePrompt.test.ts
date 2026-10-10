import { afterEach, describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../types';
import {
  buildDateInteractionPrinciples,
  buildVNModeBlock,
} from './datePrompts';
import { setElevenLabsModel, setTtsProvider, setVoicePromptOverrides } from './ttsProvider';

const makeChar = (coauthorUser = false): CharacterProfile => ({
  id: 'char-1',
  name: '温鸣竹',
  avatar: '',
  dateVoiceEnabled: true,
  dateStyleConfig: { coauthorUser },
} as CharacterProfile);

afterEach(() => {
  setTtsProvider('minimax');
  setElevenLabsModel('eleven_v4');
  setVoicePromptOverrides(undefined);
});

describe('见面模式双 OC / ElevenLabs prompt', () => {
  it('普通模式仍保留用户代理权，并要求 char speaker 标签', () => {
    const principles = buildDateInteractionPrinciples('温鸣竹', '祁连云', false, false);
    expect(principles).toContain('用户没有写出的台词、动作');
    expect(principles).not.toContain('强化演绎已开启');

    const block = buildVNModeBlock(makeChar(false), '祁连云');
    expect(block).toContain('[speaker:char]');
    expect(block).toContain('普通模式下你只写 温鸣竹 的台词');
  });

  it('强化演绎允许 AI 补写 user OC，并要求双方 speaker 标签', () => {
    const principles = buildDateInteractionPrinciples('温鸣竹', '祁连云', false, true);
    expect(principles).toContain('强化演绎已开启');
    expect(principles).toContain('自由补写 祁连云 的台词、动作');
    expect(principles).toContain('强化演绎执行提醒');
    expect(principles).toContain('不要等待用户逐句替 祁连云 输入台词');
    expect(principles).toContain('至少写一条 祁连云 的直接台词并标成 [speaker:user]');
    expect(principles).toContain('整轮只有 [speaker:char]');
    expect(principles).toContain('"……忙忘了。" [speaker:user]');
    expect(principles).toContain('用户已经通过“强化演绎”明确授权');
    expect(principles).toContain('### 写 温鸣竹 时，回到他自己');
    expect(principles).toContain('每一条属于 温鸣竹 的台词');
    expect(principles).not.toContain('### 最后，回到你自己\n你就是 温鸣竹。');
    expect(principles.lastIndexOf('### 强化演绎执行提醒')).toBeGreaterThan(principles.lastIndexOf('### 写 温鸣竹 时，回到他自己'));
    expect(principles).not.toContain('用户没有写出的台词、动作');

    const block = buildVNModeBlock(makeChar(true), '祁连云');
    expect(block).toContain('[speaker:char]');
    expect(block).toContain('[speaker:user]');
    expect(block).toContain('强化演绎已开启');
  });

  it('ElevenLabs 使用主聊天 v4 表演规则，同时强制 Audio Tags 留在引号内', () => {
    setTtsProvider('elevenlabs');
    setElevenLabsModel('eleven_v4');

    const block = buildVNModeBlock(makeChar(true), '祁连云');
    expect(block).toContain('ElevenLabs v4 语音表演规则');
    expect(block).toContain('Audio Tags');
    expect(block).toContain('双引号内的台词');
    expect(block).toContain('不要再输出');
    expect(block).toContain('[v:xxx]');
    expect(block).toContain('[speaker:user]');
  });
  it('旧 dateVoice 自定义提示不会覆盖 ElevenLabs v4 必需的 Audio Tags 规则', () => {
    setTtsProvider('elevenlabs');
    setElevenLabsModel('eleven_v4');
    setVoicePromptOverrides({ dateVoice: '旧规则：[v:calm] 每句都写。' });

    const block = buildVNModeBlock(makeChar(true), '祁连云');
    expect(block).toContain('旧规则：[v:calm] 每句都写。');
    expect(block).toContain('不要再输出');
    expect(block).toContain('[v:xxx]');
    expect(block).toContain('Audio Tags');
    expect(block).toContain('[speaker:user]');
  });

});
