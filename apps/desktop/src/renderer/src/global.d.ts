import type { DekiDesktopApi } from "@deki-ai/shared";

declare global {
  interface Window {
    deki: DekiDesktopApi;
  }
}

export {};
