import { describe, expect, it } from 'vitest';
import { ChatPrompts } from './chatPrompts';

const char = { id: 'c1', name: '测试角色', timeAwarenessEnabled: false } as any;
const userProfile = { name: '用户' } as any;
const timestamp = Date.now();

describe('buildMessageHistory chat GIF vision payload', () => {
    it('保留消息中的 GIF，但把 JPEG 首帧发送给视觉模型', () => {
        const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==';
        const jpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
        const history = [{
            id: 1,
            charId: 'c1',
            role: 'user',
            type: 'image',
            content: gif,
            timestamp,
            metadata: { visionImageDataUrl: jpeg, isAnimatedGif: true },
        }] as any[];

        const { apiMessages } = ChatPrompts.buildMessageHistory(history, 10, char, userProfile, []);
        expect(history[0].content).toBe(gif);
        expect(apiMessages[0].content[0].text).toContain('animated GIF');
        expect(apiMessages[0].content[1].image_url.url).toBe(jpeg);
        expect(apiMessages[0].content[1].image_url.url).not.toBe(gif);
    });

    it('普通静态图片继续使用原 content', () => {
        const jpeg = 'data:image/jpeg;base64,/9j/static';
        const history = [{
            id: 2,
            charId: 'c1',
            role: 'user',
            type: 'image',
            content: jpeg,
            timestamp,
        }] as any[];

        const { apiMessages } = ChatPrompts.buildMessageHistory(history, 10, char, userProfile, []);
        expect(apiMessages[0].content[1].image_url.url).toBe(jpeg);
        expect(apiMessages[0].content[0].text).not.toContain('animated GIF');
    });
});
