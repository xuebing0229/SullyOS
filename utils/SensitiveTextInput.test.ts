import { describe, expect, it } from 'vitest';
import { getSensitiveTextSecurity } from '../components/SensitiveTextInput';

describe('SensitiveTextInput masking state', () => {
  it('masks while blurred and reveals while focused', () => {
    expect(getSensitiveTextSecurity(false, false)).toBe('disc');
    expect(getSensitiveTextSecurity(true, false)).toBe('none');
  });

  it('supports a manual reveal without changing the credential value', () => {
    const credential = 'sk-real-key';
    expect(getSensitiveTextSecurity(false, true)).toBe('none');
    expect(credential).toBe('sk-real-key');
  });
});