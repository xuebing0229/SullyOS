export type GameHallMemoryLevel = 0 | 1 | 2 | 3;
export type GameHallMemoryCategory = 'routine'|'current_context'|'promise'|'preference'|'boundary'|'relationship_shift'|'strong_emotion'|'shared_milestone'|'shared_naming'|'ongoing_goal'|'unresolved_conflict'|'role_self_change'|'manual';
export interface GameHallMemorySignal { category?: GameHallMemoryCategory; summary?: string; signals?: string[]; level?: GameHallMemoryLevel; }
export interface GameHallEvent {
  id:string; sessionId:string; charId:string; createdAt:number; kind:'user_message'|'assistant_message'|'state'|'action'|'session_summary';
  summary:string; level:GameHallMemoryLevel; category:GameHallMemoryCategory; signals:string[]; sourceMessageIds?:string[]; gameId?:string; gameName?:string; summarizedAt?:number;
}
export interface GameHallMemoryCandidate {
  id:string; sessionId:string; charId:string; eventIds:string[]; content:string; category:GameHallMemoryCategory; importance:number; createdAt:number; updatedAt:number;
  status:'pending'|'stored'|'deduplicated'|'rejected'; memoryNodeId?:string; error?:string; gameId?:string; gameName?:string;
}
export interface GameHallPreferenceEvidence { id:string; charId:string; sessionId:string; eventId:string; summary:string; createdAt:number; polarity:'prefer'|'avoid'|'boundary'; }
