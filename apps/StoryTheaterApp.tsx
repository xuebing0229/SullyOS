import React from 'react';
import { useOS } from '../context/OSContext';
import StoryTheater from '../components/date/story/StoryTheater';
import { DB } from '../utils/db';

/**
 * 文游的归档目前仍会拿一整份 StoryTheaterEntry 回写。
 * 如果用户在归档进行中修改了世界书 / 预设 / 语音 / 配图等设置，旧 entry 晚到时会把新设置覆盖。
 *
 * 在数据层调用入口做一层串行合并保护：
 * - 新增归档时，以数据库里最新剧情设置为底，只合并新增归档；
 * - 设置保存若拿着稍旧的 archives，则保留数据库里已经完成的归档；
 * - 将最终合并对象原地写回 incoming，保证调用方随后 setState 的也是同一份最新数据。
 *
 * 这样不仅 IndexedDB 不会被旧归档覆盖，当前 React 状态也不会被旧 entry 顶回去。
 */
const installStoryTheaterSaveMergeGuard = () => {
    const guardedDB = DB as typeof DB & { __storyTheaterSaveMergeGuardInstalled?: boolean };
    if (guardedDB.__storyTheaterSaveMergeGuardInstalled) return;
    guardedDB.__storyTheaterSaveMergeGuardInstalled = true;

    const rawSaveStoryTheater = DB.saveStoryTheater.bind(DB);
    let saveQueue: Promise<void> = Promise.resolve();

    DB.saveStoryTheater = (incoming) => {
        const run = saveQueue.then(async () => {
            try {
                const stored = (await DB.getStoryTheaters()).find(item => item.id === incoming.id);
                if (stored) {
                    const storedArchives = Array.isArray(stored.archives) ? stored.archives : [];
                    const incomingArchives = Array.isArray(incoming.archives) ? incoming.archives : [];
                    const storedArchiveIds = new Set(storedArchives.map(archive => archive.id));
                    const incomingArchiveIds = new Set(incomingArchives.map(archive => archive.id));
                    const hasNewArchive = incomingArchives.some(archive => !storedArchiveIds.has(archive.id));
                    const missesStoredArchive = storedArchives.some(archive => !incomingArchiveIds.has(archive.id));

                    if (hasNewArchive || missesStoredArchive) {
                        const mergedArchives = [...storedArchives];
                        const mergedArchiveIds = new Set(storedArchiveIds);
                        for (const archive of incomingArchives) {
                            if (mergedArchiveIds.has(archive.id)) continue;
                            mergedArchiveIds.add(archive.id);
                            mergedArchives.push(archive);
                        }

                        const merged = hasNewArchive
                            ? {
                                ...stored,
                                archives: mergedArchives,
                                updatedAt: Math.max(Number(stored.updatedAt) || 0, Number(incoming.updatedAt) || 0, Date.now()),
                            }
                            : {
                                ...incoming,
                                archives: mergedArchives,
                                updatedAt: Math.max(Number(stored.updatedAt) || 0, Number(incoming.updatedAt) || 0),
                            };

                        Object.assign(incoming, merged);
                    }
                }
            } catch (error) {
                // 读取最新条目失败时仍允许原保存继续，避免保护逻辑本身阻断文游。
                console.warn('[StoryTheater] save merge guard lookup failed', error);
            }

            await rawSaveStoryTheater(incoming);
        });

        saveQueue = run.catch(() => undefined);
        return run;
    };
};

installStoryTheaterSaveMergeGuard();

/**
 * 文游：从「见面」里拆出的独立剧情文字游戏入口。
 *
 * 剧情、预设、面具、事件盒 / 向量归档仍沿用原 StoryTheater 数据层，
 * 所以拆 App 不迁移也不复制任何存档。
 */
const StoryTheaterApp: React.FC = () => {
    const { closeApp } = useOS();
    return <StoryTheater onClose={closeApp} />;
};

export default StoryTheaterApp;
