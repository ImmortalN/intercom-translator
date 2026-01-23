import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import http from 'http';
import dotenv from 'dotenv';
import { franc } from 'franc';
import NodeCache from 'node-cache';

dotenv.config();

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));

// ────────────────────────────── Config ──────────────────────────────
const INTERCOM_TOKEN        = `Bearer ${process.env.INTERCOM_TOKEN}`;
const ADMIN_ID              = process.env.ADMIN_ID;
const DEEPL_KEY             = process.env.DEEPL_KEY;               // твій ключ DeepL
const MYMEMORY_EMAIL        = process.env.MYMEMORY_EMAIL || 'immortal@jetmonsters.me'; // ← зміни на свою реальну пошту!
const TARGET_LANG           = 'en';
const SKIP_LANGS            = new Set(['en', 'ru', 'uk']);
const INTERCOM_API_VERSION  = '2.14';
const REQUEST_TIMEOUT       = 7000;
const DEBUG                 = process.env.DEBUG === 'true';

const LIBRE_APIS = [
  'https://translate.terraprint.co/translate',     // один з найстабільніших на 2026
  'https://translate.argosopentech.com/translate', // другий за стабільністю
  'https://libretranslate.de/translate',
  // 'https://translate.fedilab.app/translate'     // часто не працює
];

const CACHE             = new NodeCache({ stdTTL: 24*3600, checkperiod: 600 });
const PROCESSED         = new NodeCache({ stdTTL: 3600 }); // анти-дублі

const axiosInstance = axios.create({
  timeout: REQUEST_TIMEOUT,
  httpAgent: new http.Agent({ keepAlive: true })
});

// ────────────────────────────── Utils ──────────────────────────────
function cleanText(text = '') {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMessageText(conv) {
  const parts = conv.conversation_parts?.conversation_parts || [];
  const userParts = parts
    .filter(p => ['user', 'lead', 'contact'].includes(p.author?.type) && p.body)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

  return cleanText(userParts[0]?.body || conv.source?.body || '');
}

// ────────────────────────────── Переклад ──────────────────────────────
async function translateMessage(originalText) {
  if (!originalText || originalText.length < 4) return null;

  const text = originalText.trim();
  const cacheKey = `tr:${text.slice(0,120)}:${TARGET_LANG}`;

  if (CACHE.has(cacheKey)) {
    if (DEBUG) console.log('[CACHE HIT]', text.slice(0,40));
    return CACHE.get(cacheKey);
  }

  // ─── 1. Дуже раннє виявлення мови (економимо квоти) ───
  const francCode = franc(text, { minLength: 4, whitelist: ['eng','rus','ukr','deu','fra','spa','ita','por','pol'] });
  const detectedLang = francCode === 'und' ? 'auto' : (francCode === 'eng' ? 'en' : francCode.slice(0,2));

  if (SKIP_LANGS.has(detectedLang) || detectedLang === TARGET_LANG) {
    if (DEBUG) console.log(`[SKIP ${detectedLang}]`, text.slice(0,60));
    return null;
  }

  if (DEBUG) console.log(`[TRY] ${text.length} chars | Lang: ${detectedLang} | "${text.slice(0,60)}..."`);

  let translation = null;

  // ─── 2. Спроба DeepL (найкраща якість) ───
  if (DEEPL_KEY) {
    try {
      const res = await axiosInstance.post('https://api.deepl.com/v2/translate', {
        text: [text],
        target_lang: 'EN',
        source_lang: detectedLang === 'auto' ? undefined : detectedLang.toUpperCase()
      }, {
        headers: {
          'Authorization': `DeepL-Auth-Key ${DEEPL_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      const translated = res.data.translations?.[0]?.text;
      if (translated && translated.trim() !== text.trim()) {
        translation = {
          text: translated.trim(),
          sourceLang: res.data.translations[0].detected_source_language.toLowerCase() || detectedLang,
          targetLang: 'en'
        };
        CACHE.set(cacheKey, translation);
        if (DEBUG) console.log('[DeepL OK]', detectedLang, '→ en');
        return translation;
      }
    } catch (err) {
      if (DEBUG) console.log('[DeepL ERR]', err.response?.status || err.message);
    }
  }

  // ─── 3. LibreTranslate fallback ───
  for (const url of LIBRE_APIS) {
    try {
      const res = await axiosInstance.post(url, {
        q: text,
        source: detectedLang === 'auto' ? 'auto' : detectedLang,
        target: 'en',
        format: 'text'
      });

      const translated = res.data.translatedText || res.data.translation;
      if (translated && translated.trim() !== text.trim()) {
        translation = {
          text: translated.trim(),
          sourceLang: (res.data.detectedLanguage?.language || detectedLang).toLowerCase(),
          targetLang: 'en'
        };
        CACHE.set(cacheKey, translation);
        if (DEBUG) console.log('[Libre OK]', url.split('//')[1].split('/')[0]);
        return translation;
      }
    } catch (err) {
      if (DEBUG) console.log('[Libre fail]', url, err.message);
    }
  }

  // ─── 4. MyMemory — останній резерв + з email для 50k ліміту ───
  try {
    const params = {
      q: text,
      langpair: detectedLang === 'auto' ? 'auto|en' : `${detectedLang}|en`,
      de: MYMEMORY_EMAIL   // ← це і є ключовий параметр!
    };

    const res = await axiosInstance.get('https://api.mymemory.translated.net/get', { params });

    const translated = res.data?.responseData?.translatedText;
    if (translated && translated.trim() !== text.trim()) {
      translation = {
        text: translated.trim(),
        sourceLang: detectedLang,
        targetLang: 'en'
      };
      CACHE.set(cacheKey, translation);
      if (DEBUG) console.log('[MyMemory OK]');
      return translation;
    }
  } catch (err) {
    if (DEBUG) console.log('[MyMemory ERR]', err.response?.status || err.message);
  }

  return null;
}

// ────────────────────────────── Webhook ──────────────────────────────
app.post('/intercom-webhook', async (req, res) => {
  res.sendStatus(200);
  if (process.env.ENABLED !== 'true') return;

  try {
    const { topic, data } = req.body;
    if (!['conversation.user.replied', 'conversation.user.created'].includes(topic)) return;

    const conv = data.item;
    const convId = conv?.id;
    if (!convId) return;

    const text = extractMessageText(conv);
    if (!text) return;

    // Антидубль
    const hash = `${convId}:${text.slice(0,80)}`;
    if (PROCESSED.has(hash)) return;
    PROCESSED.set(hash, true);

    const translation = await translateMessage(text);
    if (!translation) return;

    const note = `📝 Auto-translation (${translation.sourceLang} → en): ${translation.text}`;

    await axiosInstance.post(
      `https://api.intercom.io/conversations/${convId}/reply`,
      { message_type: 'note', admin_id: ADMIN_ID, body: note },
      { headers: { Authorization: INTERCOM_TOKEN, 'Intercom-Version': INTERCOM_API_VERSION } }
    );

    console.log(`Переклад виконано → ${convId}`);
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

app.get('/intercom-webhook', (_, res) => res.send('OK'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Сервер на ${PORT}`));
