/// <reference types="vite/client" />
/// <reference types="chrome"/>

declare global {
  interface Window {
    chrome: typeof chrome;
  }
}

export {}

