from pathlib import Path

p = Path('worker/amsg/src/storyJobs.ts')
s = p.read_text()
old = """      if (spec.imageHandoff && provisionalImageHandoff?.state === 'submitted') {
        let finalImageHandoff: Awaited<ReturnType<typeof runStoryImageHandoff>>;
        try {
          finalImageHandoff = await runStoryImageHandoff(
            spec.imageHandoff,
            spec.clientRequestId,
            streamed.content,
          );
        } catch (imageHandoffError) {
          finalImageHandoff = {
            state: 'failed',
            error: String((imageHandoffError as Error)?.message || imageHandoffError).slice(0, 500),
          };
        }
        const finalStoredResponse = {
          ...streamed.response,
          _sullyStoryImageHandoff: finalImageHandoff,
        };
        const finalResponseCipher = await sealJson(env, userId, jobId, 'response', finalStoredResponse);
        await env.DB.prepare(
          `UPDATE story_jobs SET response_cipher = ?, updated_at = ?
           WHERE user_id = ? AND job_id = ? AND status = 'succeeded'`,
        ).bind(finalResponseCipher, now(), userId, jobId).run();
      }
"""
new = """      if (spec.imageHandoff && provisionalImageHandoff?.state === 'submitted') {
        // 从这一行开始正文已经是 succeeded。任何生图尾活错误都只能记日志，绝不能再落进
        // 外层剧情失败 catch，把已经可读的正文反改成 failed。
        try {
          let finalImageHandoff: Awaited<ReturnType<typeof runStoryImageHandoff>>;
          try {
            finalImageHandoff = await runStoryImageHandoff(
              spec.imageHandoff,
              spec.clientRequestId,
              streamed.content,
            );
          } catch (imageHandoffError) {
            finalImageHandoff = {
              state: 'failed',
              error: String((imageHandoffError as Error)?.message || imageHandoffError).slice(0, 500),
            };
          }
          const finalStoredResponse = {
            ...streamed.response,
            _sullyStoryImageHandoff: finalImageHandoff,
          };
          const finalResponseCipher = await sealJson(env, userId, jobId, 'response', finalStoredResponse);
          await env.DB.prepare(
            `UPDATE story_jobs SET response_cipher = ?, updated_at = ?
             WHERE user_id = ? AND job_id = ? AND status = 'succeeded'`,
          ).bind(finalResponseCipher, now(), userId, jobId).run();
        } catch (imageTailError) {
          console.warn('[amsg:story-job] image handoff tail failed after text succeeded', {
            jobId,
            error: String((imageTailError as Error)?.message || imageTailError).slice(0, 500),
          });
        }
      }
"""
assert old in s, 'post-success image tail anchor not found'
s = s.replace(old, new, 1)
p.write_text(s)
