import React from 'react';
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
    return <StoryTheater onClose={closeApp} />;
};

export default StoryTheaterApp;
