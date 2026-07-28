import {
    describe,
    expect,
    it,
} from 'vitest';

import type {
    CharacterProfile,
} from '../../types';

import {
    chooseVRRoom,
    getAutonomousRoomPolicy,
    resolveAutonomousRoomPool,
    sanitizeAutonomousRoomIds,
} from './roomSelection';

function makeChar(
    vrState:
        Record<string, unknown>
        = {},
): CharacterProfile {
    return {
        id: 'char-1',
        name: '测试角色',
        avatar: '',
        systemPrompt: '',
        vrState: {
            enabled: true,
            intervalMinutes: 120,
            ...vrState,
        },
    } as CharacterProfile;
}

describe(
    'VR autonomous room selection',
    () => {
        it(
            'keeps legacy characters in free mode',
            () => {
                const char =
                    makeChar();

                expect(
                    getAutonomousRoomPolicy(
                        char,
                    ),
                ).toEqual({
                    mode: 'free',
                    roomIds: [],
                });
            },
        );

        it(
            'keeps the old free-mode base pool',
            () => {
                const pool =
                    resolveAutonomousRoomPool(
                        makeChar(),
                        {
                            hasNovels:
                                false,
                            hasMusicContent:
                                false,
                        },
                    );

                expect(pool)
                    .toEqual([
                        'guestbook',
                        'gym',
                        'postoffice',
                        'theater',
                    ]);
            },
        );

        it(
            'adds library and music to free mode only when available',
            () => {
                const pool =
                    resolveAutonomousRoomPool(
                        makeChar(),
                        {
                            hasNovels:
                                true,
                            hasMusicContent:
                                true,
                        },
                    );

                expect(pool)
                    .toEqual([
                        'guestbook',
                        'gym',
                        'postoffice',
                        'theater',
                        'library',
                        'music',
                    ]);
            },
        );

        it(
            'uses one selected room as a fixed room',
            () => {
                const char =
                    makeChar({
                        autonomousRoomMode:
                            'selected',
                        autonomousRoomIds: [
                            'theater',
                        ],
                    });

                const room =
                    chooseVRRoom({
                        char,
                        hasNovels:
                            true,
                        hasMusicContent:
                            true,
                        random:
                            () => 0.75,
                    });

                expect(room)
                    .toBe(
                        'theater',
                    );
            },
        );

        it(
            'randomizes only inside selected rooms',
            () => {
                const char =
                    makeChar({
                        autonomousRoomMode:
                            'selected',
                        autonomousRoomIds: [
                            'music',
                            'gym',
                        ],
                    });

                expect(
                    chooseVRRoom({
                        char,
                        hasNovels:
                            true,
                        hasMusicContent:
                            true,
                        random:
                            () => 0,
                    }),
                ).toBe(
                    'music',
                );

                expect(
                    chooseVRRoom({
                        char,
                        hasNovels:
                            true,
                        hasMusicContent:
                            true,
                        random:
                            () => 0.99,
                    }),
                ).toBe(
                    'gym',
                );
            },
        );

        it(
            'removes library when the selected scope has no novels',
            () => {
                const char =
                    makeChar({
                        autonomousRoomMode:
                            'selected',
                        autonomousRoomIds: [
                            'library',
                            'theater',
                        ],
                    });

                expect(
                    resolveAutonomousRoomPool(
                        char,
                        {
                            hasNovels:
                                false,
                            hasMusicContent:
                                false,
                        },
                    ),
                ).toEqual([
                    'theater',
                ]);
            },
        );

        it(
            'returns no room when selected scope only contains an unavailable library',
            () => {
                const char =
                    makeChar({
                        autonomousRoomMode:
                            'selected',
                        autonomousRoomIds: [
                            'library',
                        ],
                    });

                expect(
                    chooseVRRoom({
                        char,
                        hasNovels:
                            false,
                        hasMusicContent:
                            false,
                    }),
                ).toBeNull();
            },
        );

        it(
            'allows explicitly selected music even without music content',
            () => {
                const char =
                    makeChar({
                        autonomousRoomMode:
                            'selected',
                        autonomousRoomIds: [
                            'music',
                        ],
                    });

                expect(
                    chooseVRRoom({
                        char,
                        hasNovels:
                            false,
                        hasMusicContent:
                            false,
                    }),
                ).toBe(
                    'music',
                );
            },
        );

        it(
            'manual room assignment bypasses autonomous scope',
            () => {
                const char =
                    makeChar({
                        autonomousRoomMode:
                            'selected',
                        autonomousRoomIds: [
                            'library',
                        ],
                    });

                expect(
                    chooseVRRoom({
                        char,
                        hasNovels:
                            true,
                        hasMusicContent:
                            false,
                        forcedRoom:
                            'postoffice',
                    }),
                ).toBe(
                    'postoffice',
                );
            },
        );

        it(
            'allows signal only as a forced room',
            () => {
                const char =
                    makeChar({
                        autonomousRoomMode:
                            'selected',
                        autonomousRoomIds: [
                            'signal',
                        ],
                    });

                expect(
                    chooseVRRoom({
                        char,
                        hasNovels:
                            true,
                        hasMusicContent:
                            true,
                    }),
                ).toBeNull();

                expect(
                    chooseVRRoom({
                        char,
                        hasNovels:
                            true,
                        hasMusicContent:
                            true,
                        forcedRoom:
                            'signal',
                    }),
                ).toBe(
                    'signal',
                );
            },
        );

        it(
            'never allows cafe through autonomous or forced selection',
            () => {
                const char =
                    makeChar({
                        autonomousRoomMode:
                            'selected',
                        autonomousRoomIds: [
                            'cafe',
                        ],
                    });

                expect(
                    chooseVRRoom({
                        char,
                        hasNovels:
                            true,
                        hasMusicContent:
                            true,
                    }),
                ).toBeNull();

                expect(
                    chooseVRRoom({
                        char,
                        hasNovels:
                            true,
                        hasMusicContent:
                            true,
                        forcedRoom:
                            'cafe',
                    }),
                ).toBeNull();
            },
        );

        it(
            'sanitizes duplicates and invalid room ids in stable order',
            () => {
                expect(
                    sanitizeAutonomousRoomIds([
                        'theater',
                        'signal',
                        'library',
                        'theater',
                        'bad-room',
                        'music',
                    ]),
                ).toEqual([
                    'library',
                    'music',
                    'theater',
                ]);
            },
        );

        it(
            'does not silently turn selected empty scope into free mode',
            () => {
                const char =
                    makeChar({
                        autonomousRoomMode:
                            'selected',
                        autonomousRoomIds:
                            [],
                    });

                expect(
                    resolveAutonomousRoomPool(
                        char,
                        {
                            hasNovels:
                                true,
                            hasMusicContent:
                                true,
                        },
                    ),
                ).toEqual([]);
            },
        );

        it(
            'falls back to autonomous scope when forced library becomes unavailable',
            () => {
                const char =
                    makeChar({
                        autonomousRoomMode:
                            'selected',
                        autonomousRoomIds: [
                            'theater',
                        ],
                    });

                expect(
                    chooseVRRoom({
                        char,
                        hasNovels:
                            false,
                        hasMusicContent:
                            false,
                        forcedRoom:
                            'library',
                    }),
                ).toBe(
                    'theater',
                );
            },
        );
    },
);
