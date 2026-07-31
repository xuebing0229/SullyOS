import { describe, expect, it, vi } from 'vitest';
vi.mock('./gameHallStore',()=>({getLatestGameHallBridgeSnapshot:vi.fn(async()=>({summary:'我们刚一起完成了关键回合。'})),saveGameHallBridgeSnapshot:vi.fn(),gameHallId:()=> 'id'}));
import { getGameHallBridgeBlock } from './gameHallMemoryBridge';
describe('GameHall bridge block',()=>{it('uses the required natural continuity heading and anti-meta reminder',async()=>{const block=await getGameHallBridgeBlock('c');expect(block).toContain('## 刚刚共同游戏的连续状态');expect(block).toContain('我们刚一起完成了关键回合');expect(block).toContain('不要提及“快照”');});});
