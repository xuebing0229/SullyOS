import { beforeEach, describe, expect, it } from 'vitest';
import { DB } from './db';
import type { ApiCallLogEntry } from './apiCallLog';
import type { ApiCostDailySummary } from '../types';
import { API_COST_UNRESOLVED_MIGRATION_KEY, migrateApiCostUnresolvedV1 } from './apiCostUnresolvedMigration';
const dateKey = (timestamp: number) => { const d = new Date(timestamp); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const summary = (key: string, count: number): ApiCostDailySummary => ({ dateKey:key,totalCostMicros:'0',pricedCallCount:0,freeCallCount:0,unpricedCallCount:count,ignoredCallCount:0,byPreset:[],byApp:[],byPurpose:[],updatedAt:1 });
const legacy = (id:string, ok:boolean, timestamp:number): ApiCallLogEntry => ({ id,timestamp,ok,presetName:'API',baseUrl:'https://api.test/v1',model:'m',costStatus:'unpriced',unpricedReason:ok?'usage_missing':'failure_cost_unknown' });
describe.sequential('api unresolved migration',()=>{
 beforeEach(async()=>{await DB.deleteDB();localStorage.clear();});
 it('converts failed unpriced and creates exact plus aggregate entries',async()=>{
   const now=Date.now(), key=dateKey(now);
   await DB.replaceApiCallLog([legacy('failed',false,now),legacy('success',true,now)]);
   await DB.importFullData({timestamp:now,version:3,apiCostDailySummaries:[summary(key,6)],apiCostUnresolvedEntries:[]} as any);
   localStorage.removeItem(API_COST_UNRESOLVED_MIGRATION_KEY);
   await migrateApiCostUnresolvedV1();
   expect((await DB.getApiCallLog()).find(x=>x.id==='failed')).toMatchObject({costStatus:'free_failed',costMicros:'0'});
   const pending=await DB.getApiCostUnresolvedEntries();
   expect(pending.find(x=>x.id==='call:success')).toBeTruthy();
   expect(pending.find(x=>x.id===`legacy:${key}`)?.callCount).toBe(4);
   expect((await DB.getApiCostDailySummaries())[0]).toMatchObject({unpricedCallCount:5,freeCallCount:1});
 });
 it('repairs a missing unresolved index even after the migration marker is written',async()=>{
   const now=Date.now(), key=dateKey(now);
   await DB.replaceApiCallLog([legacy('success',true,now)]);
   await DB.importFullData({timestamp:now,version:3,apiCostDailySummaries:[summary(key,1)],apiCostUnresolvedEntries:[]} as any);
   localStorage.removeItem(API_COST_UNRESOLVED_MIGRATION_KEY);
   await migrateApiCostUnresolvedV1();
   await DB.replaceApiCostUnresolvedEntries([]);
   expect(await DB.getApiCostUnresolvedEntries()).toEqual([]);
   await migrateApiCostUnresolvedV1();
   expect(await DB.getApiCostUnresolvedEntries()).toMatchObject([{id:'call:success',callCount:1}]);
 });
 it('does not revive an entry that was already resolved',async()=>{
   const now=Date.now(), key=dateKey(now);
   await DB.replaceApiCallLog([legacy('success',true,now)]);
   await DB.importFullData({timestamp:now,version:3,apiCostDailySummaries:[summary(key,1)],apiCostUnresolvedEntries:[]} as any);
   await migrateApiCostUnresolvedV1();
   await DB.resolveApiCostUnpriced('call:success',{kind:'ignore_zero'});
   await migrateApiCostUnresolvedV1();
   expect(await DB.getApiCostUnresolvedEntries()).toEqual([]);
 });
});
