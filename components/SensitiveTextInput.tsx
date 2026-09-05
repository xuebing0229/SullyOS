import React, {
  forwardRef,
  useState,
  type CSSProperties,
  type InputHTMLAttributes,
} from 'react';

type SensitiveTextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  /** Keep the value visible even while blurred. Focus always reveals it. */
  reveal?: boolean;
};

type WebkitSecurityStyle = CSSProperties & {
  WebkitTextSecurity?: 'none' | 'disc' | 'circle' | 'square';
};

export const getSensitiveTextSecurity = (
  focused: boolean,
  reveal: boolean,
): 'none' | 'disc' => (!focused && !reveal ? 'disc' : 'none');

const configuredSecretFromPlaceholder = (placeholder: unknown): string => {
  if (typeof placeholder !== 'string') return '';
  const match = placeholder.match(/^已配置：(.*)（留空不更换）$/);
  return match?.[1]?.trim() || '';
};

/**
 * Credential input that always remains a normal text control so Android uses the
 * ordinary IME and clipboard. Blurred masking is visual only; value never changes.
 *
 * For the private image-generation settings screen, the server may return the
 * configured key in the existing "已配置：...（留空不更换）" placeholder. When the
 * controlled value is otherwise empty, surface that returned key as the actual,
 * selectable text value so it can be copied or replaced directly. Inputs using
 * this configured-key placeholder are intentionally kept visible in plaintext.
 */
export const SensitiveTextInput = forwardRef<HTMLInputElement, SensitiveTextInputProps>(
  function SensitiveTextInput(
    {
      reveal = false,
      onFocus,
      onBlur,
      style,
      autoComplete = 'off',
      autoCapitalize = 'none',
      autoCorrect = 'off',
      spellCheck = false,
      inputMode = 'text',
      placeholder,
      value,
      ...rest
    },
    ref,
  ) {
    const [focused, setFocused] = useState(false);
    const configuredSecret = configuredSecretFromPlaceholder(placeholder);
    const useConfiguredSecret = (value === '' || value === undefined || value === null) && Boolean(configuredSecret);
    const displayValue = useConfiguredSecret ? configuredSecret : value;
    const securityStyle: WebkitSecurityStyle = {
      ...style,
      WebkitTextSecurity: getSensitiveTextSecurity(focused, reveal || Boolean(configuredSecret)),
    };

    return (
      <input
        {...rest}
        ref={ref}
        type="text"
        value={displayValue}
        placeholder={useConfiguredSecret ? undefined : placeholder}
        inputMode={inputMode}
        autoComplete={autoComplete}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        spellCheck={spellCheck}
        style={securityStyle}
        onFocus={event => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={event => {
          setFocused(false);
          onBlur?.(event);
        }}
      />
    );
  },
);

export default SensitiveTextInput;
