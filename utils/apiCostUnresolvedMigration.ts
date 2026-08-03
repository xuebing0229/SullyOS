import { DB } from './db';
export const API_COST_UNRESOLVED_MIGRATION_KEY =
  'sullyos.api-cost-unresolved.v1.migrated';
export async function migrateApiCostUnresolvedV1(): Promise<void> {
  if (localStorage.getItem(API_COST_UNRESOLVED_MIGRATION_KEY) === '1') return;
  await DB.migrateApiCostUnresolvedV1Data();
  localStorage.setItem(API_COST_UNRESOLVED_MIGRATION_KEY, '1');
}
