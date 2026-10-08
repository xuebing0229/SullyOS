/// <reference types="vite/client" />

declare const __BUILD_BRANCH__: string;
declare const __BUILD_COMMIT__: string;
declare const __BUILD_TIME__: string;
declare const __BUILD_BADGE_VISIBLE__: boolean;

interface ImportMetaEnv {
  readonly VITE_AMSG_NATIVE_PUSH?: string;
}
declare const __APP_BUILD_ID__: string;
