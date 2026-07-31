import type { APIConfig, CharacterProfile, UserProfile } from '../types';
import { safeResponseJson } from './safeApi';
import { buildCedarCapabilityMap, toCedarMcpServer } from './cedarToyMcpAdapter';
import { callMcpTool, type McpToolDef } from './mcpClient';
import type { CedarToyConnection, GameHallCompanionMode, GameHallPendingAction, NormalizedCedarGameState } from './gameHallTypes';
import { gameHallId } from './gameHallStore';

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as object).sort().map(k=>`${JSON.stringify(k)}:${stableJson((value as any)[k])}`).join(',')}}`;
  return JSON.stringify(value);
};
export const hashGameHallState = (value: unknown): string => { let h=2166136261; for(const ch of stableJson(value)){h^=ch.charCodeAt(0);h=Math.imul(h,16777619);} return (h>>>0).toString(16).padStart(8,'0'); };
export const requiredSchemaKeys = (tool: McpToolDef): string[] => Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required.filter((x:unknown)=>typeof x==='string') : [];
export const canCallWithoutGuessing = (tool: McpToolDef, args: Record<string,unknown>): boolean => requiredSchemaKeys(tool).every(k => args[k] !== undefined && args[k] !== '');
const extractSummary = (data: unknown): string => { try { const text=typeof data==='string'?data:JSON.stringify(data); return text.slice(0,1600); } catch { return String(data).slice(0,1600); } };
export async function readCedarGameState(connection:CedarToyConnection, preferredTool?:string, args:Record<string,unknown>={}):Promise<{state:NormalizedCedarGameState;toolName:string}> {
  const tools=connection.tools||[]; const map=buildCedarCapabilityMap(tools); const tool=(preferredTool&&map.state.find(t=>t.name===preferredTool))||map.state.find(t=>canCallWithoutGuessing(t,args));
  if(!tool) throw new Error('连接成功，但没有可在不猜参数的前提下调用的状态工具。');
  if(!canCallWithoutGuessing(tool,args)) throw new Error(`状态工具 ${tool.name} 缺少必填参数：${requiredSchemaKeys(tool).join('、')}`);
  const result=await callMcpTool(toCedarMcpServer(connection),tool.name,args); if(!result.success) throw new Error(result.error||'状态工具调用失败');
  const raw=result.data; const text=extractSummary(raw); const currentTurn=(raw as any)?.currentTurn||(raw as any)?.turn||(raw as any)?.current_player;
  const allows=Boolean((raw as any)?.allowsAiAction||(raw as any)?.canAct||(raw as any)?.can_ai_act);
  return {toolName:tool.name,state:{raw,summary:text,stateHash:hashGameHallState(raw),gameId:(raw as any)?.gameId||(raw as any)?.game_id,gameName:(raw as any)?.gameName||(raw as any)?.game_name,currentTurn:currentTurn?String(currentTurn):undefined,allowsAiAction:allows}};
}
const parseAgentJson=(text:string):any=>{const cleaned=text.replace(/^```(?:json)?/i,'').replace(/```$/,'').trim(); const start=cleaned.indexOf('{'),end=cleaned.lastIndexOf('}'); if(start<0||end<start)return null; try{return JSON.parse(cleaned.slice(start,end+1));}catch{return null;}};
export async function planGameHallTurn(input:{apiConfig:APIConfig;char:CharacterProfile;userProfile:UserProfile;mode:GameHallCompanionMode;userText:string;state?:NormalizedCedarGameState;actionTools:McpToolDef[];sessionId:string}):Promise<{reply:string;pending?:GameHallPendingAction}> {
  const {apiConfig,char,userProfile,mode,userText,state,actionTools,sessionId}=input; if(!apiConfig.baseUrl||!apiConfig.model) throw new Error('请先配置聊天 API。');
  const toolSchemas=actionTools.map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema}));
  const prompt=`你是 ${char.name}，正在 SullyOS 游戏厅陪 ${userProfile?.name||'用户'} 玩 Cedar Toy。保持角色人设：${char.systemPrompt||char.description||''}\n模式：${mode}。当前游戏状态摘要：${state?.summary||'尚未读取'}\n用户说：${userText}\n行动工具真实 schema：${JSON.stringify(toolSchemas)}\n只输出 JSON：{"reply":"给用户的自然回复","action":null 或 {"toolName":"必须来自工具清单","args":{},"reason":"原因"}}。observe 模式 action 必须 null。不得猜测 schema 中缺失的信息；不能填满全部 required 时 action 必须 null。`;
  const res=await fetch(`${apiConfig.baseUrl.replace(/\/+$/,'')}/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiConfig.apiKey}`},body:JSON.stringify({model:apiConfig.model,messages:[{role:'user',content:prompt}],temperature:0.7,response_format:{type:'json_object'}})});
  if(!res.ok) throw new Error(`游戏厅 Agent HTTP ${res.status}`); const data=await safeResponseJson(res); const parsed=parseAgentJson(data?.choices?.[0]?.message?.content||''); const reply=String(parsed?.reply||'我在看着这局，先别急着动。').slice(0,2000);
  if(mode==='observe'||!parsed?.action) return {reply}; const tool=actionTools.find(t=>t.name===parsed.action.toolName); const args=parsed.action.args; if(!tool||!args||typeof args!=='object'||Array.isArray(args)||!canCallWithoutGuessing(tool,args)) return {reply};
  return {reply,pending:{id:gameHallId('ghaction'),sessionId,charId:char.id,toolName:tool.name,args,reason:String(parsed.action.reason||'角色建议执行此行动').slice(0,500),stateHash:state?.stateHash,status:'pending',createdAt:Date.now(),updatedAt:Date.now()}};
}
export async function executePendingGameHallAction(connection:CedarToyConnection,action:GameHallPendingAction){ return callMcpTool(toCedarMcpServer(connection),action.toolName,action.args); }
