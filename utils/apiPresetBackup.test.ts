import { describe, expect, it } from 'vitest';
import { resolveBackedUpActiveApiPresetId } from './apiPresetBackup';

const presets = [
    { id: 'same-endpoint-cheap' },
    { id: 'same-endpoint-expensive' },
];

describe('API 当前预设备份恢复', () => {
    it('按精确 ID 恢复，不用同地址同模型猜测', () => {
        expect(resolveBackedUpActiveApiPresetId('same-endpoint-expensive', presets)).toBe('same-endpoint-expensive');
    });

    it('ID 不存在、为空或类型错误时清空，避免绑定错误价格预设', () => {
        expect(resolveBackedUpActiveApiPresetId('missing', presets)).toBeNull();
        expect(resolveBackedUpActiveApiPresetId(null, presets)).toBeNull();
        expect(resolveBackedUpActiveApiPresetId('', presets)).toBeNull();
        expect(resolveBackedUpActiveApiPresetId(123, presets)).toBeNull();
    });
});
