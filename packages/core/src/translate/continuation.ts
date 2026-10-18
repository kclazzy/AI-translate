/**
 * A line that stops mid-sentence and goes on in the next bubble — often on the next picture of a
 * webtoon («I CAN'T» | «FIGURE IT OUT.»). Translated one by one, each half gets its own meaning
 * («Я не могу.» | «Придумай что-нибудь.»); translated together, the sentence is split back.
 */
const CONNECTORS = new Set(
  'and or but so the a an to of with for from by at in on about as than that which who whose when while if because like my your his her their our its is are was were be been am will would can could should i you we they he she it me us them this these those not just even really also'.split(' '),
);

export function continuesNext(text: string): boolean {
  const t = text.replace(/[\s"'«»“”’)\]]+$/u, '');
  if (!t) return false;
  if (/[,\-–—:;]$/.test(t)) return true;
  if (/[.!?…~♪。！？」』]$/.test(t)) return false;
  const words = t.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  if (!words.length) return false;
  const last = words[words.length - 1].toLowerCase().replace(/[^a-z']/g, '');
  // No end mark at all: a sentence goes on unless it is a single word (HEY, SARANG).
  return CONNECTORS.has(last) || words.length >= 2;
}
