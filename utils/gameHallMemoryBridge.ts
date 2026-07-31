import { gameHallId, getLatestGameHallBridgeSnapshot, saveGameHallBridgeSnapshot } from './gameHallStore';
export async function writeGameHallBridgeSnapshot(input: { sessionId:string; charId:string; summary:string; eventIds?:string[] }): Promise<void> {
  const summary=input.summary.trim().slice(0,1200); if(!summary) return;
  await saveGameHallBridgeSnapshot({ id:gameHallId('ghsnap'), sessionId:input.sessionId, charId:input.charId, summary, eventIds:input.eventIds||[], createdAt:Date.now(), expiresAt:Date.now()+14*24*60*60*1000 });
}
export async function getGameHallBridgeBlock(charId:string): Promise<string> {
  const snap=await getLatestGameHallBridgeSnapshot(charId); if(!snap) return '';
  return `\n\n## 刚刚共同游戏的连续状态\n${snap.summary}\n只在当前话题相关时自然想起这些共同经历，不要提及“快照”“系统记录”或内部机制。`;
}
