# Android 应用内更新

SullyOS 的 Android 安装包采用固定签名，并通过 GitHub Release 提供应用内更新。

## 发布一个新版本

1. 将应用代码合并到 `master`。
2. 工作流会读取最新正式 Release，并自动递增补丁版本（例如 `2.3.1` → `2.3.2`）。
3. 工作流构建签名 APK、创建新 Release，并上传 APK 与 SHA-256 校验文件。

只修改 `README.md`、`docs/**` 或 `.github/**` 不会构建 APK。需要指定版本号和更新说明时，仍可在 **Actions → Build Android APK → Run workflow** 手动发布。Pull Request 继续只运行网页构建检查。

## 用户侧更新流程

- Android App 启动后最多每 6 小时检查一次最新 GitHub Release。
- 发现更高版本时显示更新弹窗；也可在设置页底部手动检查。
- 首次更新时，Android 会要求允许 SullyOS 安装未知来源应用。
- 下载完成后系统安装页会弹出，确认后直接覆盖安装，应用数据不会清除。

从旧的随机 debug 签名迁移到固定 release 签名时，需要卸载旧版并安装一次新的正式版。此后只要签名密钥不变，就能持续覆盖更新。

## 仓库 Secrets

工作流依赖以下 GitHub Actions Secrets：

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

签名文件和密码不得提交到 Git。签名备份一旦丢失，Android 将不允许新 APK 覆盖现有安装。
