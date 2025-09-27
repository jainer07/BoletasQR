
/// <reference types="astro/client" />
interface ImportMetaEnv {
  readonly PUBLIC_API_BASE: string;
  readonly PUBLIC_API_KEY?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv; }
