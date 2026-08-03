export function apiUnpricedReasonLabel(
    reason: string | undefined,
): string {
    switch (reason) {
        case 'legacy_unknown':
            return '历史遗留，明细已过期';
        case 'failure_cost_unknown':
            return '旧版失败记录';
        case 'preset_not_found':
            return '未匹配到预设';
        case 'preset_ambiguous':
            return '预设匹配不明确';
        case 'pricing_not_configured':
            return '未配置价格';
        case 'usage_missing':
            return '服务商未返回 Token';
        default:
            return '未计价';
    }
}
