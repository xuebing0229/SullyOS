import { describe, expect, it } from 'vitest';
import { canCallWithoutGuessing, hashGameHallState, requiredSchemaKeys } from './gameHallAgent';

describe('GameHall action safety',()=>{
  const tool={name:'play',inputSchema:{type:'object',required:['gameId','move'],properties:{gameId:{type:'string'},move:{type:'string'}}}};
  it('requires every server-declared required argument',()=>{expect(requiredSchemaKeys(tool)).toEqual(['gameId','move']);expect(canCallWithoutGuessing(tool,{gameId:'g'})).toBe(false);expect(canCallWithoutGuessing(tool,{gameId:'g',move:'left'})).toBe(true);});
  it('hashes normalized data deterministically regardless of object key order',()=>{expect(hashGameHallState({b:2,a:1})).toBe(hashGameHallState({a:1,b:2}));});
});
