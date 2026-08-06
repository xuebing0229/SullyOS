import { describe, expect, it } from 'vitest';
import {
  cleanJsonFence,
  parseFirstJsonObject,
  sliceLocalMessages,
} from '../utils/appContext';

describe('appContext helpers', () => {
  it('keeps only explicit local context count', () => {
    expect(sliceLocalMessages([1, 2, 3, 4], 2)).toEqual([3, 4]);
    expect(sliceLocalMessages([1, 2], 0)).toEqual([]);
  });

  it('parses fenced json', () => {
    expect(parseFirstJsonObject('```json\n{"cards":[]}\n```')).toEqual({
      cards: [],
    });
  });

  it('finds json inside prose', () => {
    expect(
      parseFirstJsonObject('前言\n{"message":"ok","state":{"x":1}}\n尾巴'),
    ).toEqual({ message: 'ok', state: { x: 1 } });
  });

  it('cleans fence', () => {
    expect(cleanJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
});
