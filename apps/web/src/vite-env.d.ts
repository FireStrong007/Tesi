/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** the app this build is (vite.config.ts: --mode heartbridge), see brand.ts */
  readonly VITE_APP: "vitabridge" | "heartbridge";
}
