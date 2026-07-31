import type { CharacterProfile, Message, UserProfile } from '../types';
import { blobToDataUrl, getBlobForRef, isBlobRef } from './blobRef';

export interface GeneratedImageInspectInput {
    char: CharacterProfile;
    userProfile: UserProfile;
    imageMessages: Message[];
    model: string;
    executeChat: (body: Record<string, any>, purpose: string) => Promise<any>;
}

export interface GeneratedImageInspectOutput {
    text: string;
    rawResponse: any;
}

export const messageImageToApiUrl = async (message: Message): Promise<string> => {
    const content = typeof message.content === 'string' ? message.content.trim() : '';
    if (!content) throw new Error('图片消息没有可用内容');
    if (isBlobRef(content)) {
        const blob = await getBlobForRef(content);
        if (!blob) throw new Error('无法读取已保存的图片');
        return blobToDataUrl(blob);
    }
    if (content.startsWith('data:image/') || content.startsWith('http://') || content.startsWith('https://')) return content;
    throw new Error('图片地址格式无法用于视觉请求');
};

const buildInspectSystemPrompt = (char: CharacterProfile, userProfile: UserProfile): string => {
    const baseline = [
        `你是${char.name}，正在和${userProfile.name}对话。`,
        typeof char.description === 'string' ? `角色设定：${char.description.slice(0, 1600)}` : '',
    ].filter(Boolean).join('\n');
    return `${baseline}
保持角色语气，只对眼前图片自然回应一小句。不要描述系统流程，不要输出 JSON，不要调用或声称调用任何工具。`;
};

export async function inspectGeneratedImages(
    input: GeneratedImageInspectInput,
): Promise<GeneratedImageInspectOutput> {
    const imageUrls = await Promise.all(input.imageMessages.map(messageImageToApiUrl));
    if (!imageUrls.length) throw new Error('没有可供查看的最终图片');
    const body: Record<string, any> = {
        model: input.model,
        messages: [
            { role: 'system', content: buildInspectSystemPrompt(input.char, input.userProfile) },
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: '这是你刚刚生成并发送给用户的最终图片。请真正看图后，保持当前角色语气，自然地回应一小句。不要描述系统流程，不要声称再次调用工具，不要输出 JSON。',
                    },
                    ...imageUrls.map(url => ({ type: 'image_url', image_url: { url } })),
                ],
            },
        ],
        max_tokens: 160,
        stream: false,
    };
    delete body.tools;
    delete body.tool_choice;
    const rawResponse = await input.executeChat(body, '生图后看图回应');
    const text = String(rawResponse?.choices?.[0]?.message?.content || '').trim();
    if (!text) throw new Error('看图回应没有返回文字');
    return { text, rawResponse };
}
