// 「设置 → API 预设」这块的接线守卫。
//
// 仓库的 vitest 跑在纯 Node 环境（组件测试没装 testing-library），所以沿用
// amsg2CharToggle.wiring.test.ts 的做法做**源码级**断言。验证不了运行时时序，
// 只防下面这几种回归——它们的共同点是全都不报错、界面上也看不出来：
//
//   1. 草稿同步 effect 又拿整个 apiConfig 当依赖
//      → 在识图 / 语音那块点一下保存，主 API 这边没保存的输入被悄悄冲回旧值
//   2. 保存按钮漏掉当前明确选中的预设，或编辑弹窗只改 UI 不落库
//      → 用户以为预设已更新，刷新后却仍是旧配置
//   3. 点预设绕开 commitApiConfig 自己写配置
//      → 聊天换了 API，后台已排程的主动消息还拿旧 Key 打请求，到点一片 401
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const settings = readFileSync(fileURLToPath(new URL('../apps/Settings.tsx', import.meta.url)), 'utf8');

/** 截出某个顶层箭头函数的函数体（这些函数在文件里都是两空格缩进 + `};` 收尾）。 */
const bodyOf = (name: string): string => {
  const start = settings.indexOf(`const ${name} = `);
  expect(start, `${name} 没找到`).toBeGreaterThan(-1);
  const end = settings.indexOf('\n  };', start);
  expect(end, `${name} 的函数体没收尾`).toBeGreaterThan(start);
  return settings.slice(start, end);
};

describe('草稿同步不跨区块打架', () => {
  it('同步 effect 不以整个 apiConfig 对象为依赖', () => {
    // updateApiConfig 每次都返回新对象。整个对象当依赖 = 任何一处保存都会重置所有输入框。
    expect(settings).not.toMatch(/\}, \[apiConfig\]\);/);
  });

  it('主 API 那份只盯自己的五个字段', () => {
    expect(settings).toMatch(
      /\}, \[apiConfig\.baseUrl, apiConfig\.apiKey, apiConfig\.model, apiConfig\.stream, apiConfig\.temperature\]\);/,
    );
  });
});

describe('点预设 = 直接切过去', () => {
  it('预设名按钮走 applyPreset，不是「载入草稿」', () => {
    expect(settings).toMatch(/onClick=\{\(\) => applyPreset\(preset\)\}/);
    expect(settings).not.toMatch(/loadPreset/);
  });

  it('切换保留预设身份，并同步云端凭据', () => {
    const applyPreset = bodyOf('applyPreset');
    expect(applyPreset).toMatch(/setApiPresetDefaultModel\(preset, model\)/);
    expect(applyPreset).toMatch(/activateApiPreset\(runtimePreset\)/);
    expect(applyPreset).toMatch(/syncAmsgLlmCredentials/);
    expect(applyPreset).toMatch(/refreshApiCredentialsForPendingTasks/);
    expect(applyPreset).not.toMatch(/updateApiConfig\(/);
  });

  it('高亮的是「当前生效的那条」，按已保存配置反查', () => {
    expect(settings).toMatch(/activePresetId = useMemo\(\s*\(\) => findActivePresetId\(apiPresets, apiConfig\)/);
  });
});

describe('保存配置与已选预设保持一致', () => {
  it('未选预设时只改当前配置；已选预设时连名称和高级设置一起保存', () => {
    const handleSaveApi = bodyOf('handleSaveApi');
    expect(handleSaveApi).toMatch(/commitApiConfig\(nextConfig\)/);
    expect(handleSaveApi).toMatch(/if \(selectedApiPreset\)/);
    expect(handleSaveApi).toMatch(/setApiPresetDefaultModel/);
    expect(handleSaveApi).toMatch(/models: updatedPreset\.models/);
    expect(handleSaveApi).toMatch(/activateApiPreset\(updatedPreset\)/);
  });

  it('主表单、编辑弹窗与费用弹窗分别更新对应字段', () => {
    expect(settings.match(/updateApiPreset\(/g) ?? []).toHaveLength(3);
    expect(bodyOf('handleSaveApi')).toMatch(/updateApiPreset\(selectedApiPreset\.id/);
    expect(bodyOf('handleUpdatePreset')).toMatch(/models: updatedPreset\.models/);
    expect(settings).toMatch(/updateApiPreset\(preset\.id, \{ models: updated\.models \}\)/);
  });

  it('新建和保存预设都包含流式与温度', () => {
    expect(settings).toMatch(/buildApiPresetConfig\(\{[\s\S]*stream: localStream,[\s\S]*temperature: localTemperature/);
    expect(bodyOf('handleSavePreset')).toMatch(/buildCurrentApiPresetConfig\(\)/);
    expect(bodyOf('handleSaveApi')).toMatch(/buildCurrentApiPresetConfig\(\)/);
  });
});

describe('换 API 一定连着换云端凭据', () => {
  it('commitApiConfig 里三件事齐全', () => {
    const commitApiConfig = bodyOf('commitApiConfig');
    expect(commitApiConfig).toMatch(/updateApiConfig\(patch\)/);
    expect(commitApiConfig).toMatch(/syncAmsgLlmCredentials\(\{ \.\.\.apiConfig, \.\.\.patch \}\)/);
    expect(commitApiConfig).toMatch(/refreshApiCredentialsForPendingTasks\(\{ \.\.\.apiConfig, \.\.\.patch \}\)/);
  });
});
