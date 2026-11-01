import { describe, expect, it } from 'vitest';
import { checkPack, spillRegions, type PackPage } from '../src/diag/packCheck';

const page = (name: string, blocks: PackPage['blocks'], extra: Partial<PackPage> = {}): PackPage => ({ name, width: 900, height: 1280, blocks, ...extra });
const block = (id: string, bbox: [number, number, number, number], bubble?: [number, number, number, number], text = 'TEXT', translation = 'ТЕКСТ') => ({ id, text, translation, bbox, bubble });

describe('analysis pack check: seams', () => {
  it('reports a bubble cut by the seam between two pictures translated apart', () => {
    const a = page('007', [block('b2', [335, 1210, 524, 70], [271, 1074, 628, 206], 'MONSTERS POURED OUT OF')]);
    const b = page('008', [block('b1', [333, 0, 527, 69], [270, 0, 629, 228], 'STRANGE RIFTS ALL OVER THE WORLD')]);
    const issues = checkPack([a, b]).filter((i) => i.kind === 'seam-cut');
    expect(issues).toEqual([{ kind: 'seam-cut', upper: '007', lower: '008', glued: false, text: 'MONSTERS POURED OUT OF | STRANGE RIFTS ALL OVER THE WORLD' }]);
  });

  it('a cut bubble whose pictures went in one strip counts as glued', () => {
    const a = page('128', [block('b1', [100, 1200, 500, 80], [80, 1150, 600, 130])]);
    const b = page('129', [block('b1', [100, 0, 500, 60], [80, 0, 600, 100])], { joined: 'strip' });
    expect(checkPack([a, b]).find((i) => i.kind === 'seam-cut')).toMatchObject({ glued: true });
  });

  it('bubbles away from the edges are no seam problem', () => {
    const a = page('001', [block('b1', [100, 600, 300, 80], [80, 560, 340, 160])]);
    const b = page('002', [block('b1', [100, 300, 300, 80], [80, 260, 340, 160])]);
    expect(checkPack([a, b]).filter((i) => i.kind === 'seam-cut')).toEqual([]);
  });
});

describe('analysis pack check: text off its bubble', () => {
  it('reports a text box far bigger than the bubble it was put in, or with no bubble at all', () => {
    // 084: «A CHANTER?» snapped to the big status panel's box: the translation is drawn over the art.
    const p = page('084', [block('b1', [417, 381, 397, 585], undefined, 'A CHANTER?')]);
    expect(checkPack([p]).filter((i) => i.kind === 'loose-box')).toEqual([{ kind: 'loose-box', page: '084', block: 'b1', why: 'no bubble, box is 20% of the picture for 10 characters' }]);
  });

  it('a big sound effect left untranslated draws nothing: no problem', () => {
    const p = page('060', [block('b1', [0, 100, 400, 500], undefined, 'BOOM', '')]);
    expect(checkPack([p]).filter((i) => i.kind === 'loose-box')).toEqual([]);
  });

  it('a short line in its own bubble is fine', () => {
    const p = page('010', [block('b1', [326, 424, 549, 142], [270, 286, 629, 435], 'THOSE WHO CAME INTO CONTACT WITH A DUNGEON')]);
    expect(checkPack([p]).filter((i) => i.kind === 'loose-box')).toEqual([]);
  });

  it('finds what the render changed outside every bubble and text box', () => {
    const w = 100;
    const h = 100;
    const changed = new Uint8Array(w * h);
    // inside the allowed box: fine
    for (let y = 10; y < 30; y++) for (let x = 10; x < 40; x++) changed[y * w + x] = 1;
    // a 20×20 patch outside it: drawn over the art
    for (let y = 60; y < 80; y++) for (let x = 50; x < 70; x++) changed[y * w + x] = 1;
    // a few stray pixels (JPEG noise): ignored
    changed[5 * w + 90] = 1;
    expect(spillRegions(changed, w, h, [[8, 8, 40, 30]], 100)).toEqual([{ box: [50, 60, 20, 20], area: 400 }]);
  });
});
