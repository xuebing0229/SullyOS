import { DB } from './db';
export const API_COST_UNRESOLVED_MIGRATION_KEY =
  'sullyos.api-cost-unresolved.v1.migrated';
export async function migrateApiCostUnresolvedV1(): Promise<void> {
  // 每日汇总是待计价数量的权威来源，unresolved store 是可操作的明细索引。
  // 旧版导入/清理曾可能漏掉索引，但保留 migration marker，造成“有 N 次待处理”
  // 点开却一片空白。重建使用固定 id，是幂等操作，所以进入花费页时顺手补齐。
  await DB.migrateApiCostUnresolvedV1Data();
  localStorage.setItem(API_COST_UNRESOLVED_MIGRATION_KEY, '1');
}
