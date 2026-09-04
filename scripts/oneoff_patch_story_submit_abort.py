from pathlib import Path
path = Path("context/OSContext.tsx")
text = path.read_text(encoding="utf-8")
old = """              // Story Jobs 的状态 GET 在 Android WebView 锁屏/切后台后可能被本地
              // AbortController 正常取消；远端 job 仍继续运行。这里只跳过这一个已知的诊断误报，
              // 不吞异常、不改轮询/重试，也不放过 POST 或其它网络失败。
              const isExpectedStoryJobPollAbort = (() => {
                  if (method !== 'GET' || err?.name !== 'AbortError') return false;
                  try {
                      const pathname = new URL(urlStr, window.location.href).pathname;
                      return /^\\/story-jobs\\/(?:by-client\\/)?[^/]+\\/?$/.test(pathname);
                  } catch {
                      return false;
                  }
              })();
              if (!isAnalyticsRequestUrl(urlStr) && !isExpectedStoryJobPollAbort) {
"""
new = """              // Story Jobs 的状态 GET，以及“带稳定幂等 ID 的任务提交 POST”，在 Android WebView
              // 锁屏/切后台后都可能被本地 AbortController 取消等待；远端 job 仍可能已经创建并继续运行。
              // 这里只跳过这两类可安全接回的底层诊断误报：异常本身仍继续 throw 给调用方，POST 会按同一
              // clientRequestId 查找已创建任务；若最终找不回，上层仍会报“提交结果不确定”。
              const isExpectedStoryJobAbort = (() => {
                  if (err?.name !== 'AbortError') return false;
                  let pathname = '';
                  try {
                      pathname = new URL(urlStr, window.location.href).pathname;
                  } catch {
                      return false;
                  }

                  if (method === 'GET') {
                      return /^\\/story-jobs\\/(?:by-client\\/)?[^/]+\\/?$/.test(pathname);
                  }
                  if (method !== 'POST' || pathname !== '/story-jobs') return false;

                  const rawBody = (sendArgs[1] as RequestInit | undefined)?.body;
                  if (typeof rawBody !== 'string') return false;
                  try {
                      const spec = JSON.parse(rawBody);
                      return typeof spec?.jobId === 'string'
                          && spec.jobId.startsWith('storycloud_')
                          && typeof spec?.clientRequestId === 'string'
                          && spec.clientRequestId.startsWith('storyreq_')
                          && Array.isArray(spec?.routes)
                          && spec.routes.length > 0
                          && spec?.baseBody
                          && typeof spec.baseBody === 'object';
                  } catch {
                      return false;
                  }
              })();
              if (!isAnalyticsRequestUrl(urlStr) && !isExpectedStoryJobAbort) {
"""
count = text.count(old)
if count != 1:
    raise SystemExit(f"expected exactly one story abort diagnostic gate, found {count}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
