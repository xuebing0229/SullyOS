import type {
    CharacterProfile,
    VRAutonomousRoomId,
    VRAutonomousRoomMode,
    VRRoomId,
} from '../../types';

/**
 * 唯一允许出现在“自主活动范围”设置中的房间。
 *
 * 新房间即使加入 VR_ROOMS，也不会自动进入这里。
 * 必须显式决定是否允许自主活动，避免特殊活动误入。
 */
export const VR_AUTONOMOUS_ROOM_IDS:
readonly VRAutonomousRoomId[] = [
    'library',
    'music',
    'guestbook',
    'gym',
    'postoffice',
    'theater',
] as const;

const AUTONOMOUS_ROOM_ID_SET =
    new Set<VRRoomId>(
        VR_AUTONOMOUS_ROOM_IDS,
    );

export interface VRAutonomousRoomPolicy {
    mode:
        VRAutonomousRoomMode;

    roomIds:
        VRAutonomousRoomId[];
}

export interface VRRoomAvailability {
    hasNovels: boolean;

    /**
     * 角色有可点歌曲，或听歌房已有正在播放的歌曲。
     * 只影响 free 模式。
     */
    hasMusicContent: boolean;
}

export interface ChooseVRRoomInput
extends VRRoomAvailability {
    char:
        CharacterProfile;

    /**
     * 用户手动指定的临时房间。
     * 存在时优先于自主活动范围。
     */
    forcedRoom?:
        VRRoomId;

    /**
     * 测试可注入固定随机数。
     */
    random?:
        () => number;
}

export function isAutonomousRoomId(
    value:
        unknown,
): value is VRAutonomousRoomId {
    return (
        typeof value
        === 'string'
        && AUTONOMOUS_ROOM_ID_SET.has(
            value as VRRoomId,
        )
    );
}

/**
 * 过滤非法值并去重，同时按 UI 固定顺序输出。
 *
 * 不沿用输入顺序，保证：
 * - UI 稳定；
 * - 备份往返稳定；
 * - 测试稳定；
 * - 不因用户点击顺序产生无意义 diff。
 */
export function sanitizeAutonomousRoomIds(
    values:
        unknown,
): VRAutonomousRoomId[] {
    if (!Array.isArray(values)) {
        return [];
    }

    const selected =
        new Set<VRAutonomousRoomId>();

    for (const value of values) {
        if (
            isAutonomousRoomId(
                value,
            )
        ) {
            selected.add(value);
        }
    }

    return (
        VR_AUTONOMOUS_ROOM_IDS
            .filter(
                roomId =>
                    selected.has(
                        roomId,
                    ),
            )
    );
}

/**
 * 旧角色默认自由漫游。
 *
 * 注意：
 * selected + 空数组不能偷偷退回 free。
 * 这代表数据异常或用户限制后所有房间失效，
 * 正确行为是跳过本轮，而不是越权漫游。
 */
export function getAutonomousRoomPolicy(
    char:
        CharacterProfile,
): VRAutonomousRoomPolicy {
    const mode =
        char.vrState
            ?.autonomousRoomMode
        === 'selected'
            ? 'selected'
            : 'free';

    return {
        mode,
        roomIds:
            mode === 'selected'
                ? sanitizeAutonomousRoomIds(
                    char.vrState
                        ?.autonomousRoomIds,
                )
                : [],
    };
}

/**
 * 当前实际可用于“自主随机”的房间池。
 */
export function resolveAutonomousRoomPool(
    char:
        CharacterProfile,
    availability:
        VRRoomAvailability,
): VRAutonomousRoomId[] {
    const policy =
        getAutonomousRoomPolicy(
            char,
        );

    if (
        policy.mode
        === 'selected'
    ) {
        return (
            policy.roomIds
                .filter(
                    roomId => {
                        switch (roomId) {
                            case 'library':
                                return (
                                    availability
                                        .hasNovels
                                );

                            case 'music':
                                /*
                                 * 用户已经明确选择听歌房。
                                 * 即使暂无歌曲也允许进入。
                                 */
                                return true;

                            case 'guestbook':
                            case 'gym':
                            case 'postoffice':
                            case 'theater':
                                return true;

                            default:
                                return false;
                        }
                    },
                )
        );
    }

    /*
     * free 模式必须严格保持升级前的随机池行为。
     */
    const pool:
    VRAutonomousRoomId[] = [
        'guestbook',
        'gym',
        'postoffice',
        'theater',
    ];

    if (
        availability.hasNovels
    ) {
        pool.push('library');
    }

    if (
        availability
            .hasMusicContent
    ) {
        pool.push('music');
    }

    return pool;
}

export function pickRandomVRRoom(
    pool:
        readonly VRAutonomousRoomId[],
    random:
        () => number
        = Math.random,
): VRAutonomousRoomId | null {
    if (pool.length === 0) {
        return null;
    }

    const raw =
        Number(random());

    /*
     * 防御异常 random mock：
     * NaN / Infinity / 负数均归零；
     * 1 归到最后一项，而不是越界。
     */
    const normalized =
        Number.isFinite(raw)
            ? Math.min(
                Math.max(raw, 0),
                0.9999999999999999,
            )
            : 0;

    const index =
        Math.floor(
            normalized
            * pool.length,
        );

    return (
        pool[index]
        ?? pool[0]
        ?? null
    );
}

/**
 * 临时手动指定房间。
 *
 * 返回 undefined：
 * 指定房间当前不可用，允许调用方回退到自主池。
 *
 * 返回 null：
 * 指定的是明确禁止进入的房间。
 */
export function resolveForcedVRRoom(
    forcedRoom:
        VRRoomId,
    availability:
        VRRoomAvailability,
): VRRoomId | undefined | null {
    switch (forcedRoom) {
        case 'signal':
            /*
             * 特殊活动由专门入口触发，
             * 允许 forcedRoom 直达。
             */
            return 'signal';

        case 'music':
            /*
             * 手动指定听歌房永远尊重。
             */
            return 'music';

        case 'library':
            /*
             * 没有书时无法完成图书馆玩法，
             * 回退到角色自主池。
             */
            return (
                availability.hasNovels
                    ? 'library'
                    : undefined
            );

        case 'guestbook':
        case 'gym':
        case 'postoffice':
        case 'theater':
            return forcedRoom;

        case 'cafe':
        default:
            /*
             * 未实装/未知房间绝不运行。
             */
            return null;
    }
}

/**
 * 完整房间选择。
 *
 * 优先级：
 * 1. 用户临时指定的具体房间；
 * 2. 角色的自主活动范围；
 * 3. 无可用房间则 null。
 */
export function chooseVRRoom(
    input:
        ChooseVRRoomInput,
): VRRoomId | null {
    const availability:
    VRRoomAvailability = {
        hasNovels:
            input.hasNovels,
        hasMusicContent:
            input.hasMusicContent,
    };

    if (input.forcedRoom) {
        const forced =
            resolveForcedVRRoom(
                input.forcedRoom,
                availability,
            );

        if (forced) {
            return forced;
        }

        if (forced === null) {
            return null;
        }

        /*
         * undefined：
         * 例如手动指定图书馆但书库刚好被清空。
         * 保持旧逻辑，回退到该角色当前自主池。
         */
    }

    const pool =
        resolveAutonomousRoomPool(
            input.char,
            availability,
        );

    return pickRandomVRRoom(
        pool,
        input.random,
    );
}

/**
 * UI 摘要。
 */
export function describeAutonomousRoomPolicy(
    char:
        CharacterProfile,
    roomNameOf:
        (
            roomId:
                VRAutonomousRoomId,
        ) => string,
): string {
    const policy =
        getAutonomousRoomPolicy(
            char,
        );

    if (
        policy.mode
        === 'free'
    ) {
        return '自由漫游';
    }

    if (
        policy.roomIds.length
        === 0
    ) {
        return '未选择板块';
    }

    if (
        policy.roomIds.length
        === 1
    ) {
        return (
            `固定：${
                roomNameOf(
                    policy.roomIds[0],
                )
            }`
        );
    }

    return (
        `限定：${
            policy.roomIds
                .map(roomNameOf)
                .join('、')
        }`
    );
}
