import { describe,expect,it } from 'vitest';
import { classifyGameHallMemory, sanitizeGameHallMemoryText, stripGameHallMemorySignals } from './gameHallMemoryPolicy';
describe('GameHall memory policy',()=>{
 it('honors explicit remember and forget overrides',()=>{expect(classifyGameHallMemory('请记住我喜欢潜行').level).toBe(3);expect(classifyGameHallMemory('不要记住这句话').level).toBe(0);});
 it('does not treat a bare future word as a promise',()=>{expect(classifyGameHallMemory('以后再玩吧').category).not.toBe('promise');});
 it('strips valid and malformed hidden signals from visible output',()=>{const r=stripGameHallMemorySignals('好呀[[GAMEHALL_MEMORY_SIGNAL {"category":"preference","level":2}]]');expect(r.visibleText).toBe('好呀');expect(r.signals).toHaveLength(1);expect(stripGameHallMemorySignals('嗯[[GAMEHALL_MEMORY_SIGNAL nope]]').visibleText).toBe('嗯');});
 it('redacts credentials before memory persistence',()=>expect(sanitizeGameHallMemoryText('token=abc123 Bearer xyz987')).not.toContain('abc123'));
 it('rejects secret-bearing metadata',()=>expect(stripGameHallMemorySignals('好[[GAMEHALL_MEMORY_SIGNAL {"secret":"x"}]]').signals).toHaveLength(0));
});
