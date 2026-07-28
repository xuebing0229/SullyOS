/**
 * 没有可靠响应，或响应可能由网关在上游已开始工作后丢失时，
 * 不能断言这次调用一定没有费用。
 */
export function failureMayHaveUpstreamCost(
    status: number | undefined,
): boolean {
    if (status == null) return true;
    if (status === 408 || status === 425) return true;
    if (status >= 500 && status <= 599) return true;
    return false;
}

export function apiUnpricedReasonLabel(
    reason: string | undefined,
): string {
    switch (reason) {
        case 'failure_cost_unknown':
            return '费用未知';
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
