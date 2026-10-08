import React, { useEffect } from 'react';
import { useOS } from '../context/OSContext';
import { AppID } from '../types';

import { markQixiLaunchPopupSeen } from '../utils/qixiLaunchPopup';
import './QixiLaunchPopup.css';

interface QixiLaunchPopupProps {
    onClose: () => void;
}

export const QixiLaunchPopup: React.FC<QixiLaunchPopupProps> = ({ onClose }) => {
    const { openApp } = useOS();

    useEffect(() => {
        
    }, []);

    const dismiss = () => {
        markQixiLaunchPopupSeen();
        onClose();
        
    };

    const openQixi = () => {
        markQixiLaunchPopupSeen();
        onClose();
        openApp(AppID.SpecialMoments);
        
    };

    return (
        <div className="qixi-launch-overlay" onMouseDown={event => {
            if (event.target === event.currentTarget) dismiss();
        }}>
            <section
                className="qixi-launch-letter"
                role="dialog"
                aria-modal="true"
                aria-labelledby="qixi-launch-title"
                aria-describedby="qixi-launch-description"
            >
                <button type="button" className="qixi-launch-close" aria-label="关闭七夕活动提醒" onClick={dismiss}>×</button>

                <div className="qixi-launch-date"><span>BEIJING</span><b>2026 · 08 · 19</b></div>

                <div className="qixi-launch-sky" aria-hidden="true">
                    <i className="qixi-launch-star is-user" />
                    <i className="qixi-launch-star is-char" />
                    <span className="qixi-launch-thread is-user" />
                    <span className="qixi-launch-thread is-char" />
                    <b className="qixi-launch-knot" />
                </div>

                <div className="qixi-launch-copy">
                    <p>七 月 初 七 · 一 次 性 推 送</p>
                    <h2 id="qixi-launch-title"><small>有一条消息</small>掉进了星夜。</h2>
                    <div id="qixi-launch-description">
                        <strong>ta 也正在另一边找你。</strong>
                        <span>今夜，去「特别时光」选择一个想见的人。</span>
                    </div>
                </div>

                <footer>
                    <button type="button" className="qixi-launch-primary" onClick={openQixi}>
                        <span>去赴约</span><i aria-hidden="true">✦</i>
                    </button>
                    <button type="button" className="qixi-launch-later" onClick={dismiss}>先把这封信收好</button>
                </footer>

                <p className="qixi-launch-note">活动之后仍可从桌面「特别时光」进入</p>
            </section>
        </div>
    );
};

export default QixiLaunchPopup;
