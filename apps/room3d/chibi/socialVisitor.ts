import * as T from 'three';
import type { bindBlankBody } from './blankRig';

/**
 * Minimal structural contract for two-person room interactions.
 * Kept separate from visitor.ts so visitor -> social prop code does not form a recursive ReturnType cycle.
 */
export interface SocialVisitor {
  root: T.Group;
  rig?: ReturnType<typeof bindBlankBody>;
  classicPoint?: (name: string) => T.Vector3;
}
