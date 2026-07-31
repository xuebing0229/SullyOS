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

/**
 * Credential input that always remains a normal text control so Android uses the
 * ordinary IME and clipboard. Blurred masking is visual only; value never changes.
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
      ...rest
    },
    ref,
  ) {
    const [focused, setFocused] = useState(false);
    const securityStyle: WebkitSecurityStyle = {
      ...style,
      WebkitTextSecurity: getSensitiveTextSecurity(focused, reveal),
    };

    return (
      <input
        {...rest}
        ref={ref}
        type="text"
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