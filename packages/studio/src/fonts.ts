import pangolinCyr from '@fontsource/pangolin/files/pangolin-cyrillic-400-normal.woff2?url';
import pangolinLat from '@fontsource/pangolin/files/pangolin-latin-400-normal.woff2?url';
import ptCyr from '@fontsource/pt-sans-narrow/files/pt-sans-narrow-cyrillic-400-normal.woff2?url';
import ptLat from '@fontsource/pt-sans-narrow/files/pt-sans-narrow-latin-400-normal.woff2?url';
import ptCyrB from '@fontsource/pt-sans-narrow/files/pt-sans-narrow-cyrillic-700-normal.woff2?url';
import ptLatB from '@fontsource/pt-sans-narrow/files/pt-sans-narrow-latin-700-normal.woff2?url';
import balCyr from '@fontsource/balsamiq-sans/files/balsamiq-sans-cyrillic-400-normal.woff2?url';
import balLat from '@fontsource/balsamiq-sans/files/balsamiq-sans-latin-400-normal.woff2?url';
import balCyrB from '@fontsource/balsamiq-sans/files/balsamiq-sans-cyrillic-700-normal.woff2?url';
import balLatB from '@fontsource/balsamiq-sans/files/balsamiq-sans-latin-700-normal.woff2?url';
import balCyrI from '@fontsource/balsamiq-sans/files/balsamiq-sans-cyrillic-400-italic.woff2?url';
import balLatI from '@fontsource/balsamiq-sans/files/balsamiq-sans-latin-400-italic.woff2?url';
import russoCyr from '@fontsource/russo-one/files/russo-one-cyrillic-400-normal.woff2?url';
import russoLat from '@fontsource/russo-one/files/russo-one-latin-400-normal.woff2?url';

const CYRILLIC = 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116';
const LATIN = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';

// [family, url, unicode range, weight, style]
const FACES: [string, string, string, string, string?][] = [
  // Comic lettering (Balsamiq Sans, OFL): close to the lettering of webtoons and scanlations.
  ['AIT Lettering', balCyr, CYRILLIC, '400'],
  ['AIT Lettering', balLat, LATIN, '400'],
  ['AIT Lettering', balCyrB, CYRILLIC, '700'],
  ['AIT Lettering', balLatB, LATIN, '700'],
  ['AIT Lettering', balCyrI, CYRILLIC, '400', 'italic'],
  ['AIT Lettering', balLatI, LATIN, '400', 'italic'],
  ['AIT Comic', pangolinCyr, CYRILLIC, '400'],
  ['AIT Comic', pangolinLat, LATIN, '400'],
  ['AIT Comic', pangolinCyr, CYRILLIC, '700'],
  ['AIT Comic', pangolinLat, LATIN, '700'],
  ['AIT Narration', ptCyr, CYRILLIC, '400'],
  ['AIT Narration', ptLat, LATIN, '400'],
  ['AIT Narration', ptCyrB, CYRILLIC, '700'],
  ['AIT Narration', ptLatB, LATIN, '700'],
  ['AIT SFX', russoCyr, CYRILLIC, '400'],
  ['AIT SFX', russoLat, LATIN, '400'],
  ['AIT SFX', russoCyr, CYRILLIC, '700'],
  ['AIT SFX', russoLat, LATIN, '700'],
];

let loading: Promise<void> | null = null;

/**
 * Register the bundled typesetting fonts (OFL licensed) so canvas text uses them.
 * Works in documents and in workers that expose `self.fonts`.
 */
export function loadBundledFonts(): Promise<void> {
  if (loading) return loading;
  const set: FontFaceSet | undefined = (globalThis as unknown as { fonts?: FontFaceSet }).fonts ?? (typeof document !== 'undefined' ? document.fonts : undefined);
  if (!set || typeof FontFace === 'undefined') return Promise.resolve();
  loading = Promise.all(
    FACES.map(async ([family, url, range, weight, style]) => {
      const face = new FontFace(family, `url(${url})`, { unicodeRange: range, weight, style: style ?? 'normal' });
      try {
        await face.load();
        set.add(face);
      } catch {
        /* a missing font falls back to the stack in render/style.ts */
      }
    }),
  ).then(() => undefined);
  return loading;
}

/** User-supplied font file (editor "Add font"). */
export async function registerUserFont(name: string, bytes: ArrayBuffer): Promise<void> {
  const face = new FontFace(name, bytes);
  await face.load();
  ((globalThis as unknown as { fonts?: FontFaceSet }).fonts ?? document.fonts).add(face);
}
