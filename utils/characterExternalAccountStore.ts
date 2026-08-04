import { openDB } from './db';
import type { CharacterExternalAccount } from './gameHallTypes';

export const CHARACTER_EXTERNAL_ACCOUNT_STORE = 'characterExternalAccounts' as const;

const txDone = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
});
const reqResult = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export async function saveCharacterExternalAccount(account: CharacterExternalAccount): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(CHARACTER_EXTERNAL_ACCOUNT_STORE, 'readwrite');
  tx.objectStore(CHARACTER_EXTERNAL_ACCOUNT_STORE).put(account);
  await txDone(tx);
}

export async function getCharacterExternalAccount(accountRef: string): Promise<CharacterExternalAccount | undefined> {
  const db = await openDB();
  const tx = db.transaction(CHARACTER_EXTERNAL_ACCOUNT_STORE, 'readonly');
  return reqResult(tx.objectStore(CHARACTER_EXTERNAL_ACCOUNT_STORE).get(accountRef));
}

export async function listCharacterExternalAccounts(charId: string): Promise<CharacterExternalAccount[]> {
  const db = await openDB();
  const tx = db.transaction(CHARACTER_EXTERNAL_ACCOUNT_STORE, 'readonly');
  const accounts = await reqResult<CharacterExternalAccount[]>(
    tx.objectStore(CHARACTER_EXTERNAL_ACCOUNT_STORE).index('charId').getAll(charId),
  );
  return accounts.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 多账号：按角色/服务商/服务器取全部，不再用 unique 索引强行只留一个。 */
export async function listCharacterExternalAccountsForServer(input: {
  charId: string;
  provider: string;
  serverId: string;
}): Promise<CharacterExternalAccount[]> {
  const accounts = await listCharacterExternalAccounts(input.charId);
  return accounts.filter(account => account.provider === input.provider && account.serverId === input.serverId);
}

export async function deleteCharacterExternalAccount(accountRef: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(CHARACTER_EXTERNAL_ACCOUNT_STORE, 'readwrite');
  tx.objectStore(CHARACTER_EXTERNAL_ACCOUNT_STORE).delete(accountRef);
  await txDone(tx);
}

export async function touchCharacterExternalAccount(accountRef: string): Promise<void> {
  const account = await getCharacterExternalAccount(accountRef);
  if (!account) return;
  const now = Date.now();
  await saveCharacterExternalAccount({ ...account, lastUsedAt: now, updatedAt: now });
}
