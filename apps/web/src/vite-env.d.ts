/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute API origin (e.g. https://api.example.com). Empty: same origin (dev proxy / nginx). */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
