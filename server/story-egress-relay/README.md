# SullyOS Story Egress Relay

给文游云端后台任务提供一个固定的非 Cloudflare 出口。

数据流：

```text
App -> Cloudflare Story Worker -> this relay on the Japan VPS -> model upstream
```

Worker 仍然负责 D1、后台任务、停止生成、故障转移和流式落盘；relay 只负责最后一跳出网，不保存 API Key 和请求正文。

## 1. 安装 relay

要求 Node.js 22+。

```bash
sudo mkdir -p /opt/sullyos-story-egress
sudo cp relay.mjs /opt/sullyos-story-egress/relay.mjs
sudo chown -R root:root /opt/sullyos-story-egress
sudo chmod 755 /opt/sullyos-story-egress/relay.mjs

TOKEN="$(openssl rand -hex 32)"
printf 'SULLY_EGRESS_TOKEN=%s\n' "$TOKEN" | sudo tee /etc/sullyos-story-egress.env >/dev/null
sudo chmod 600 /etc/sullyos-story-egress.env
```

默认只监听 `127.0.0.1:4873`，不会直接暴露端口。

安装 systemd unit：

```bash
sudo cp sullyos-story-egress.service.example /etc/systemd/system/sullyos-story-egress.service
sudo systemctl daemon-reload
sudo systemctl enable --now sullyos-story-egress
curl http://127.0.0.1:4873/health
```

## 2. 挂到现有 ag.apixb.top Nginx

把 `nginx-location.conf.example` 里的两个 `location` 加进现有 HTTPS `server` 块，然后：

```bash
sudo nginx -t && sudo systemctl reload nginx
curl https://ag.apixb.top/sullyos-story-egress/health
```

这里只 reload Nginx，不需要重启服务器，也不需要开放新端口。

## 3. 配 Cloudflare Worker

在现有 `sullyos-amsg` Worker 环境变量/Secrets 中设置：

```text
STORY_EGRESS_RELAY_URL=https://ag.apixb.top/sullyos-story-egress
STORY_EGRESS_RELAY_TOKEN=<与 /etc/sullyos-story-egress.env 相同的 token>
```

两项必须同时存在。只要配置成功，所有 Story Worker 的模型线路都会统一走这个 relay；不会只特判 749，也不会在 relay 出错时偷偷回退到 Cloudflare 直连。

若两项都不存在，则保留旧的 Worker 直连行为，便于部署 relay 之前安全上线代码。

## 安全边界

- relay 只接受 `POST /relay`；`GET /health` 只返回存活状态。
- relay 必须校验 `X-Sully-Egress-Token`。
- 目标只允许 HTTPS。
- localhost、`.local`、RFC1918、loopback、link-local、文档网段等私有/保留地址会被拒绝，避免把它变成内网 SSRF/Open Proxy。
- relay 不转发自己的鉴权头；发给模型上游的只有模型请求真正需要的 `Content-Type` 和 `Authorization`。
- SSE 响应不缓存，直接流回 Worker。
