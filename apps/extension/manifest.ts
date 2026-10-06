/** Manifest generator: one source for Chrome/Edge/Brave/Opera and Firefox builds. */
export function buildManifest(target: 'chrome' | 'firefox', version: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    manifest_version: 3,
    name: 'AI Translate — переводчик манги и комиксов',
    short_name: 'AI Translate',
    version,
    description: 'Переводит мангу, манхву, вебтуны и комиксы прямо на странице: распознаёт текст, убирает оригинал и вписывает перевод в баблы. Работает с локальными моделями.',
    icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
    action: { default_popup: 'popup.html', default_title: 'AI Translate', default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' } },
    options_ui: { page: 'options.html', open_in_tab: true },
    content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_idle', all_frames: false }],
    permissions: ['storage', 'unlimitedStorage', 'activeTab', 'scripting', 'contextMenus', 'declarativeNetRequestWithHostAccess', 'downloads'],
    host_permissions: ['<all_urls>'],
    commands: {
      'translate-page': { suggested_key: { default: 'Alt+Shift+T' }, description: 'Перевести все картинки на странице' },
      'select-area': { suggested_key: { default: 'Alt+Shift+A' }, description: 'Перевести выделенную область экрана' },
      'toggle-original': { suggested_key: { default: 'Alt+Shift+O' }, description: 'Показать оригиналы / переводы' },
    },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  };
  if (target === 'chrome') {
    base.background = { service_worker: 'background.js', type: 'module' };
    (base.permissions as string[]).push('offscreen');
    base.minimum_chrome_version = '116';
  } else {
    base.background = { scripts: ['background.js'], type: 'module' };
    base.browser_specific_settings = { gecko: { id: 'ai-translate@kclazzy.github.io', strict_min_version: '128.0' }, gecko_android: { strict_min_version: '128.0' } };
  }
  return base;
}
