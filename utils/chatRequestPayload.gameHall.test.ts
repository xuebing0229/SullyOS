import { describe, expect, it, vi } from 'vitest';
vi.mock('./devDebug',()=>({isPromptBuildSkipped:()=>false,isSystemMessageMergeEnabled:()=>false}));
vi.mock('./memoryPalace/pipeline',()=>({injectMemoryPalace:vi.fn()}));
vi.mock('./chatPrompts',()=>({ChatPrompts:{buildSystemPromptParts:vi.fn(async()=>({stablePrompt:'stable',volatileState:'volatile',recencyTail:'RECENCY'})),buildMessageHistory:vi.fn(()=>({apiMessages:[]})),filterVisibleEmojis:vi.fn((emojis,categories)=>({emojis,categories}))}}));
vi.mock('./worldbook',()=>({resolveWorldbookEntries:vi.fn(()=>[]),injectWorldbookDepthEntries:vi.fn((x:any)=>x)}));
vi.mock('./mcpClient',()=>({isMcpChatAvailable:()=>false}));
import { buildChatRequestPayload } from './chatRequestPayload';
it('injects GameHall bridge before the final recency tail',async()=>{const r=await buildChatRequestPayload({char:{id:'c'} as any,userProfile:{} as any,groups:[],emojis:[],categories:[],historyMsgs:[],contextLimit:1,gameHallBridgeBlock:'GAMEHALL'});const tail=String(r.fullMessages.at(-1)?.content);expect(tail.indexOf('GAMEHALL')).toBeLessThan(tail.indexOf('RECENCY'));});
