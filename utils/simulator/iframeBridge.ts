export const SIM_ACTION = 'SULLY_SIM_ACTION';
export const SIM_STATE = 'SULLY_SIM_STATE';
export const SIM_READY = 'SULLY_SIM_READY';

export interface SimulatorIframeAction {
  type: typeof SIM_ACTION;
  action: string;
  payload?: unknown;
}

export const isSimulatorIframeAction = (
  value: unknown,
): value is SimulatorIframeAction => {
  const data = value as any;
  return (
    !!data &&
    data.type === SIM_ACTION &&
    typeof data.action === 'string' &&
    data.action.length > 0
  );
};

export const postSimulatorState = (
  frame: HTMLIFrameElement | null,
  state: unknown,
): void => {
  frame?.contentWindow?.postMessage(
    {
      type: SIM_STATE,
      state,
    },
    '*',
  );
};

/**
 * 可放进用户 HTML 的最小桥接示例：
 *
 * parent.postMessage({
 *   type: 'SULLY_SIM_ACTION',
 *   action: 'choose',
 *   payload: { option: 'A' }
 * }, '*');
 *
 * window.addEventListener('message', (event) => {
 *   if (event.data?.type === 'SULLY_SIM_STATE') {
 *     render(event.data.state);
 *   }
 * });
 */
export const SIMULATOR_BRIDGE_HELP = `
向 AI 发动作：
parent.postMessage({
  type: 'SULLY_SIM_ACTION',
  action: '动作名',
  payload: { 任意: '数据' }
}, '*');

接收 AI 状态：
window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SULLY_SIM_STATE') {
    console.log(event.data.state);
  }
});
`;
