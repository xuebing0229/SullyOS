import type { GameHallMemoryCategory, GameHallMemoryLevel, GameHallMemorySignal } from './gameHallMemoryTypes';
const clamp=(n:number):GameHallMemoryLevel=>Math.max(0,Math.min(3,Math.round(n))) as GameHallMemoryLevel;
export const sanitizeGameHallMemoryText=(text:string)=>text.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi,'Bearer [REDACTED]').replace(/(?:api[_-]?key|token|cookie|authorization)\s*[:=]\s*[^\s,;]+/gi,m=>m.split(/[:=]/)[0]+': [REDACTED]').replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,'[REDACTED_JWT]').slice(0,1200);
export function stripGameHallMemorySignals(text:string):{visibleText:string;signals:GameHallMemorySignal[]}{
  const signals:GameHallMemorySignal[]=[];
  const visibleText=text.replace(/\[\[GAMEHALL_MEMORY_SIGNAL\s+([\s\S]*?)\]\]/g,(_,raw)=>{try{const v=JSON.parse(raw);if(v&&typeof v==='object'&&!('secret'in v))signals.push(v);}catch{/* malformed hidden metadata never affects visible reply */}return '';}).trim();
  return {visibleText,signals};
}
export function classifyGameHallMemory(text:string, signal?:GameHallMemorySignal):{level:GameHallMemoryLevel;category:GameHallMemoryCategory;summary:string;signals:string[]}{
  const clean=sanitizeGameHallMemoryText(text.trim()); const marks=Array.isArray(signal?.signals)?signal!.signals!.filter(x=>typeof x==='string').slice(0,8):[];
  if(/(不要|别|无需).{0,5}(记住|记下来|保存|记录)/i.test(clean)) return {level:0,category:'manual',summary:clean,signals:['user_forget_override']};
  if(/(请|要|一定要)?.{0,4}(记住|记下来|别忘了)/i.test(clean)) return {level:3,category:'manual',summary:signal?.summary||clean,signals:['user_remember_override',...marks]};
  let category:GameHallMemoryCategory=signal?.category||'routine'; let level:GameHallMemoryLevel=signal?.level===undefined?0:clamp(signal.level);
  if(/(不可以|不要再|底线|禁忌|我不接受|别这样)/i.test(clean)){category='boundary';level=3;}
  else if(/(我答应|我保证|约定|说好了)/i.test(clean)){category='promise';level=3;}
  else if(/(以后叫|命名为|我们叫它|取名)/i.test(clean)){category='shared_naming';level=3;}
  else if(/(第一次|终于|通关|达成|纪念|里程碑)/i.test(clean)){category='shared_milestone';level=Math.max(level,2) as GameHallMemoryLevel;}
  else if(/(我喜欢|我更喜欢|我讨厌|我不喜欢|偏好)/i.test(clean)){category='preference';level=Math.max(level,2) as GameHallMemoryLevel;}
  else if(/(难过|激动|开心死|气死|害怕|感动)/i.test(clean)){category='strong_emotion';level=Math.max(level,2) as GameHallMemoryLevel;}
  else if(/(下次|继续|目标|还没解决|未完成)/i.test(clean)){category='ongoing_goal';level=Math.max(level,1) as GameHallMemoryLevel;}
  return {level,category,summary:(signal?.summary||clean).slice(0,1200),signals:marks};
}
export const gameHallImportance=(category:GameHallMemoryCategory,signals:string[]=[])=>signals.includes('user_remember_override')||category==='boundary'?9:category==='promise'||category==='relationship_shift'?8:category==='shared_naming'||category==='shared_milestone'?7:6;
