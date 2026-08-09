/**
 * 构建版本相关常量的单一来源。
 *
 * `__BUILD_BRANCH__` / `__BUILD_COMMIT__` 是 vite.config.ts 注入的全局常量（prod 也有真值），
 * 但「branch@commit」这个 user-facing 标签字符串原本在 BuildBadge / VersionInfo / DevDebugPanel
 * 三处分别现拼，想加 dirty 标、截短 commit 之类要改三处——抽到这里集中维护。
 */

/** "branch@shortCommit" 形式的构建标签；BuildBadge 角标、设置页 VersionInfo、调试面板都用这一份。 */
export const BUILD_LABEL = `${__BUILD_BRANCH__}@${__BUILD_COMMIT__}`;

/** Android 安装包的可比较版本号；正式发版工作流通过 VITE_APP_VERSION 注入。 */
export const APP_RELEASE_VERSION = import.meta.env.VITE_APP_VERSION || '0.0.0-dev';

/** 设置页底部的产品版本名；APK 发版时优先显示工作流注入的正式版本号。 */
export const APP_VERSION = APP_RELEASE_VERSION === '0.0.0-dev'
    ? 'v2.2 (Realtime Awareness)'
    : `v${APP_RELEASE_VERSION}`;
