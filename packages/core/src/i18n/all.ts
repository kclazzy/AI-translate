/** Registers every interface dictionary. Import it first in each page / worker entry point. */
import { registerDictionary } from './index';
import en from './locales/en.json';
import uk from './locales/uk.json';
import es from './locales/es.json';
import pt from './locales/pt.json';
import de from './locales/de.json';
import fr from './locales/fr.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import zh from './locales/zh.json';

registerDictionary('en', en);
registerDictionary('uk', uk);
registerDictionary('es', es);
registerDictionary('pt', pt);
registerDictionary('de', de);
registerDictionary('fr', fr);
registerDictionary('ja', ja);
registerDictionary('ko', ko);
registerDictionary('zh', zh);
