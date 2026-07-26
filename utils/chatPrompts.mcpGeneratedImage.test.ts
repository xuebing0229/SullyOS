import { describe, expect, it } from 'vitest';
import { ChatPrompts } from './chatPrompts';

describe('MCP generated image history', () => {
    it('sends assistant generated blob image as text placeholder only', () => {
        const history = [{
            id: 1, charId: 'c1', role: 'assistant', type: 'image', content: 'blobref:img_test',
            timestamp: Date.now(), metadata: { mcpGeneratedImage: true, imageEngine: 'GPT Image', imagePrompt: 'cat' },
        }] as any[];
        const { apiMessages } = ChatPrompts.buildMessageHistory(
            history, 10, { id: 'c1', name: '角色', timeAwarenessEnabled: false } as any, { name: '用户' } as any, [],
        );
        expect(typeof apiMessages[0].content).toBe('string');
        expect(apiMessages[0].content).toContain('此前生成并发送了一张图片');
        expect(apiMessages[0].content).toContain('GPT Image');
        expect(JSON.stringify(apiMessages[0])).not.toContain('blobref:img_test');
        expect(JSON.stringify(apiMessages[0])).not.toContain('image_url');
    });
});
