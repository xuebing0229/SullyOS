import { describe, expect, it } from 'vitest';
import { buildCedarCapabilityMap, describeCedarCapabilities } from './cedarToyMcpAdapter';

describe('Cedar Toy MCP runtime capability discovery', () => {
  it('classifies tools from names, descriptions and schemas without inventing arguments', () => {
    const tools = [
      { name: 'who_am_i', description: 'Return current account profile', inputSchema: { type: 'object', properties: {} } },
      { name: 'read_board', description: 'Read current game state and turn', inputSchema: { type: 'object', properties: { saveId: { type: 'string' } } } },
      { name: 'submit_choice', description: 'Perform an action in a running game', inputSchema: { type: 'object', required: ['choice'], properties: { choice: { type: 'string' } } } },
      { name: 'mystery', description: 'opaque capability', inputSchema: {} },
    ];
    const map = buildCedarCapabilityMap(tools);
    expect(map.account.map(t => t.name)).toContain('who_am_i');
    expect(map.state.map(t => t.name)).toContain('read_board');
    expect(map.action.map(t => t.name)).toContain('submit_choice');
    expect(map.unknown.map(t => t.name)).toEqual(['mystery']);
    expect(tools[2].inputSchema.required).toEqual(['choice']);
  });
  it('reports missing state/action abilities explicitly', () => {
    const lines = describeCedarCapabilities(buildCedarCapabilityMap([]));
    expect(lines).toContain('状态工具：未识别');
    expect(lines).toContain('行动工具：未识别');
  });
});
