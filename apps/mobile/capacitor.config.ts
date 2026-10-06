import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.kclazzy.aitranslate',
  appName: 'AI Translate',
  webDir: 'dist',
  server: {
    // https://localhost on Android; plain-http calls to a PC on the LAN (engine, Ollama) are allowed below.
    androidScheme: 'https',
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
  ios: {
    contentInset: 'automatic',
  },
};

export default config;
