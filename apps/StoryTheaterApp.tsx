import React, { useEffect } from 'react';
import { useOS } from '../context/OSContext';
import StoryTheater from '../components/date/story/StoryTheater';

/**
 * 文游：从「见面」里拆出的独立剧情文字游戏入口。
 *
 * 剧情、预设、面具、事件盒 / 向量归档仍沿用原 StoryTheater 数据层，
 * 所以拆 App 不迁移也不复制任何存档。
 */
const StoryTheaterApp: React.FC = () => {
    const { closeApp } = useOS();

    useEffect(() => {
        // 兼容部分 OpenAI 中转：RikkaHub 默认不发送最大输出字段。
        // 先让文游保持同样的请求形状，避免超大的 max_tokens 被上游按资源申请量限流。
        // 这里只在文游挂载期间生效，不影响主聊天；预设里保存的 maxTokens 数值也不改，
        // 后续如果需要恢复或做成兼容开关，不会丢用户原配置。
        const originalFetch = globalThis.fetch;
        const wrappedFetch: typeof fetch = async (input, init) => {
            if (init?.body && typeof init.body === 'string') {
                try {
                    const body = JSON.parse(init.body);
                    let changed = false;

                    if (body && typeof body === 'object') {
                        if (Object.prototype.hasOwnProperty.call(body, 'max_tokens')) {
                            delete body.max_tokens;
                            changed = true;
                        }
                        if (Object.prototype.hasOwnProperty.call(body, 'max_completion_tokens')) {
                            delete body.max_completion_tokens;
                            changed = true;
                        }

                        if (body.baseBody && typeof body.baseBody === 'object') {
                            if (Object.prototype.hasOwnProperty.call(body.baseBody, 'max_tokens')) {
                                delete body.baseBody.max_tokens;
                                changed = true;
                            }
                            if (Object.prototype.hasOwnProperty.call(body.baseBody, 'max_completion_tokens')) {
                                delete body.baseBody.max_completion_tokens;
                                changed = true;
                            }
                        }
                    }

                    if (changed) {
                        init = { ...init, body: JSON.stringify(body) };
                    }
                } catch {
                    // 非 JSON 请求原样放行。
                }
            }
            return originalFetch(input, init);
        };

        globalThis.fetch = wrappedFetch;
        return () => {
            if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
        };
    }, []);

    return <StoryTheater onClose={closeApp} />;
};

export default StoryTheaterApp;
