import type { ApiPreset } from '../types';

/**
 * 校验备份中的当前 API 预设 ID。
 * 返回匹配到的精确 ID；空值、错误类型或不存在于本次备份预设列表中的 ID 均清空。
 */
export function resolveBackedUpActiveApiPresetId(
    candidate: unknown,
    presets: readonly Pick<ApiPreset, 'id'>[],
): string | null {
    if (typeof candidate !== 'string' || !candidate) return null;
    return presets.some(preset => preset.id === candidate) ? candidate : null;
}
