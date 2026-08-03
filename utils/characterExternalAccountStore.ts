import { openDB } from './db';
import type { CharacterExternalAccount } from './gameHallTypes';

export const CHARACTER_EXTERNAL_ACCOUNT_STORE = 'characterExternalAccounts' as const;

const txDone = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });

const reqResult = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export async function saveCharacterExternalAccount(
  account: CharacterExternalAccount,
): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(CHARACTER_EXTERNAL_ACCOUNT_STORE, 'readwrite');
  tx.objectStore(CHARACTER_EXTERNAL_ACCOUNT_STORE).put(account);
  await txDone(tx);
}

export async function getCharacterExternalAccount(
  accountRef: string,
): Promise<CharacterExternalAccount | undefined> {
  const db = await openDB();
  const tx = db.transaction(CHARACTER_EXTERNAL_ACCOUNT_STORE, 'readonly');
  return reqResult(
    tx.objectStore(CHARACTER_EXTERNAL_ACCOUNT_STORE).get(accountRef),
  );
}

export async function listCharacterExternalAccounts(
  charId: string,
): Promise<CharacterExternalAccount[]> {
  const db = await openDB();
  const tx = db.transaction(CHARACTER_EXTERNAL_ACCOUNT_STORE, 'readonly');
  const store = tx.objectStore(CHARACTER_EXTERNAL_ACCOUNT_STORE);
  const accounts = await reqResult<CharacterExternalAccount[]>(
    store.index('charId').getAll(charId),
  );
  return accounts.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function findCharacterExternalAccount(input: {
  charId: string;
  provider: string;
  serverId: string;
}): Promise<CharacterExternalAccount | undefined> {
  const db = await openDB();
  const tx = db.transaction(CHARACTER_EXTERNAL_ACCOUNT_STORE, 'readonly');
  const store = tx.objectStore(CHARACTER_EXTERNAL_ACCOUNT_STORE);
  if (store.indexNames.contains('charProviderServer')) {
    return reqResult(
      store.index('charProviderServer').get([
        input.charId,
        input.provider,
        input.serverId,
      ]),
    );
  }
  const accounts = await reqResult<CharacterExternalAccount[]>(
    store.index('charId').getAll(input.charId),
  );
  return accounts.find(
    account =>
      account.provider === input.provider && account.serverId === input.serverId,
  );
}

export async function deleteCharacterExternalAccount(
  accountRef: string,
): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(CHARACTER_EXTERNAL_ACCOUNT_STORE, 'readwrite');
  tx.objectStore(CHARACTER_EXTERNAL_ACCOUNT_STORE).delete(accountRef);
  await txDone(tx);
}

export async function touchCharacterExternalAccount(
  accountRef: string,
): Promise<void> {
  const account = await getCharacterExternalAccount(accountRef);
  if (!account) return;
  const now = Date.now();
  await saveCharacterExternalAccount({
    ...account,
    lastUsedAt: now,
    updatedAt: now,
  });
}
