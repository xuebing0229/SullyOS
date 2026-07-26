import { describe, expect, it } from 'vitest';
import { extractMcpImageCandidates } from './mcpToolBridge';
import type { McpToolResult } from './mcpClient';

describe('MCP image extraction', () => {
    it('keeps standard MCP image content', () => {
        const result: McpToolResult = {
            success: true,
            data: {},
            images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
        };
        expect(extractMcpImageCandidates(result)).toEqual([{
            kind: 'base64',
            data: 'aGVsbG8=',
            mimeType: 'image/png',
            trusted: true,
        }]);
    });

    it('accepts extensionless structuredContent.imageUrl', () => {
        const result: McpToolResult = {
            success: true,
            data: {},
            structuredContent: { imageUrl: 'https://example.test/files/abc123' },
        };
        expect(extractMcpImageCandidates(result)).toContainEqual({
            kind: 'url',
            url: 'https://example.test/files/abc123',
            mimeType: undefined,
            trusted: true,
        });
    });

    it('does not treat arbitrary extensionless url as image', () => {
        const result: McpToolResult = {
            success: true,
            data: { url: 'https://example.test/article/123' },
        };
        expect(extractMcpImageCandidates(result)).toEqual([]);
    });

    it('keeps traditional image urls in text', () => {
        const result: McpToolResult = {
            success: true,
            data: 'done',
            rawText: 'https://example.test/a.webp?x=1',
        };
        expect(extractMcpImageCandidates(result)).toHaveLength(1);
    });
});
