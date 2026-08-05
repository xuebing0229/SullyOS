import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  acknowledgeGameHallAutoplayCommand,
  enqueueGameHallAutoplayCommands,
  peekGameHallAutoplayCommands,
  stripAndParseGameHallAutoplayCommands,
} from './gameHallAutoplayIntent';

describe('gameHallAutoplayIntent', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('strips START marker and keeps natural reply', () => {
    const parsed =
      stripAndParseGameHallAutoplayCommands(
        '行啊，我去转一圈。\n[[GAME_HALL_AUTOPLAY_START {"gameHint":"钓鱼","returnToMainChat":true}]]',
        'char-1',
      );

    expect(parsed.displayText)
      .toBe('行啊，我去转一圈。');
    expect(parsed.commands).toHaveLength(1);
    expect(parsed.commands[0]).toMatchObject({
      charId: 'char-1',
      type: 'start',
      payload: {
        gameHint: '钓鱼',
        returnToMainChat: true,
      },
    });
  });

  it('strips pause resume and stop markers', () => {
    const parsed =
      stripAndParseGameHallAutoplayCommands(
        '先停一下。[[GAME_HALL_AUTOPLAY_PAUSE]][[GAME_HALL_AUTOPLAY_RESUME]][[GAME_HALL_AUTOPLAY_STOP]]',
        'char-1',
      );

    expect(parsed.displayText).toBe('先停一下。');
    expect(parsed.commands.map(item => item.type))
      .toEqual(['pause', 'resume', 'stop']);
  });

  it('persists and acknowledges command queue', () => {
    const parsed =
      stripAndParseGameHallAutoplayCommands(
        '去吧。[[GAME_HALL_AUTOPLAY_START {}]]',
        'char-1',
      );
    enqueueGameHallAutoplayCommands(parsed.commands);

    const queued = peekGameHallAutoplayCommands();
    expect(queued).toHaveLength(1);

    acknowledgeGameHallAutoplayCommand(queued[0].id);
    expect(peekGameHallAutoplayCommands()).toEqual([]);
  });

  it('never exposes malformed payload marker', () => {
    const parsed =
      stripAndParseGameHallAutoplayCommands(
        '好。[[GAME_HALL_AUTOPLAY_START 去玩点喜欢的]]',
        'char-1',
      );

    expect(parsed.displayText).toBe('好。');
    expect(parsed.commands[0].payload?.instruction)
      .toBe('去玩点喜欢的');
  });
});
