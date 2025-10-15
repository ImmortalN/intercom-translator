import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import http from 'http';
import dotenv from 'dotenv';
import NodeCache from 'node-cache';
import { franc } from 'franc';  // Для локального детекта языка (npm install franc)

dotenv.config();
const app = express();
app.use(bodyParser.json());

// Config (добавьте в .env: INTERCOM_TOKEN, ADMIN_ID, ENABLED=true, TARGET_LANG=ru, SKIP_L suceder_LANGS=en,ru,uk,zh, DEBUG=true, LIBRE_API_KEY=yourkeyifany)
const INTERCOM_TOKEN = `Bearer ${process.env.INTERCOM_TOKEN}`;
const ADMIN_ID = process.env.ADMIN_ID;
const ENABLED = process.env.ENABLED === 'true';
const TARGET_LANG = process.env.TARGET_LANG || 'ru';  // Целевой язык, напр. ru
const SKIP_LANGS = (process.env.SKIP_LANGS || 'en,ru,uk,zh').split(',');  // Языки, которые пропускаем для перевода
const LIBRE_API_KEY = process.env.LIBRE_API_KEY || null;  // Опциональный ключ для libretranslate.com
const LANG_MAP = {
  'en': 'en', 'ru': 'ru', 'uk': 'uk', 'es': 'es', 'de': 'de', 'fr': 'fr',
  'it': 'it', 'pt': 'pt', 'pl': 'pl', 'cs': 'cs', 'nl': 'nl', 'tr': 'tr',
  'ar': 'ar', 'zh': 'zh', 'zh-Hant': 'zh', 'zh-Hans': 'zh',
  'English': 'en', 'Russian': 'ru', 'Ukrainian': 'uk', 'Spanish': 'es',
  'German': 'de', 'French': 'fr', 'Italian': 'it', 'Portuguese': 'pt',
  'Polish': 'pl', 'Czech': 'cs', 'Dutch': 'nl', 'Turkish': 'tr',
  'Arabic': 'ar', 'Chinese': 'zh',
  'Chinese (Taiwan)': 'zh-Hant', 'Chinese (Simplified)': 'zh-Hans', 'Chinese (Traditional)': 'zh-Hant', 'Traditional Chinese': 'zh-Hant',
  'ko': 'ko', 'ja': 'ja',
  // Коды из franc (ISO 639-3 to 2-letter)
  'cmn': 'zh', // Mandarin Chinese
  'spa': 'es', 'deu': 'de', 'fra': 'fr', 'ita': 'it', 'por': 'pt', 'pol': 'pl', 'ces': 'cs', 'nld': 'nl', 'tur': 'tr',
  'ara': 'ar', 'kor': 'ko', 'jpn': 'ja', 'rus': 'ru', 'ukr': 'uk', 'eng': 'en',
  'zho': 'zh', // Traditional Chinese
  'und': 'auto' // undefined
};
const INTERCOM_API_VERSION = '2.11';

// Полностью бесплатные API
const LIBRE_INSTANCES = [
  'https://libretranslate.de/translate',  // Приоритет: рабочий
  'https://translate.fedilab.app/translate',
  'https://libretranslate.com/translate',
  'https://translate.argosopentech.com/translate',
  'https://libretranslate.cf/translate'
];
const LINGVA_INSTANCE = `https://lingva.ml/api/v1/auto/${TARGET_LANG}/`;  // Авто-детект + на TARGET_LANG
const MYMEMORY_TRANSLATE_API_URL = 'https://api.mymemory.translated.net/get';
const TRANSLATION_CACHE = new NodeCache({ stdTTL: 3600, checkperiod: 120, useClones: false });
const REQUEST_TIMEOUT = 8000;
const DEBUG = process.env.DEBUG === 'true';

const axiosInstance = axios.create({
  timeout: REQUEST_TIMEOUT,
  httpAgent: new http.Agent({ keepAlive: true })
});

// Env check
if (!INTERCOM_TOKEN || INTERCOM_TOKEN === 'Bearer ') {
  console.error('Missing INTERCOM_TOKEN');
  process.exit(1);
}
if (!ADMIN_ID) {
  console.error('Missing ADMIN_ID');
  process.exit(1);
}
console.log('Server starting with ENABLED:', ENABLED);
console.log(`Using ${LIBRE_INSTANCES.length} Libre instances + Lingva fallback. Target lang: ${TARGET_LANG}`);

app.get('/intercom-webhook', (req, res) => res.status(200).send('Webhook verified'));

app.post('/intercom-webhook', async (req, res) => {
  const start = Date.now();
  try {
    res.sendStatus(200);
    if (!ENABLED) return;
    const { topic, data } = req.body;
    if (!['conversation.user.replied', 'conversation.user.created'].includes(topic)) return;

    const conversation = data?.item;
    const conversationId = conversation?.id;
    if (!conversationId) return;

    const messageText = extractMessageText(conversation);
    if (DEBUG) console.log(`Extracted: "${messageText}"`);
    if (!messageText || messageText.length < 3) return;

    if (DEBUG) console.log('Conversation object:', JSON.stringify(conversation, null, 2));

    let intercomLang = conversation?.language_override || 
                       conversation?.language || 
                       conversation?.custom_attributes?.Language || 
                       conversation?.source?.language || 
                       'auto';
    if (DEBUG) console.log('Detected language from Intercom:', intercomLang);

    let detectedLang = LANG_MAP[intercomLang] || 'auto';

    // Улучшенный детект: всегда проверяем franc и переопределяем если нужно
    const francLang = detectLangByContent(messageText);
    if (francLang !== 'auto' && francLang !== detectedLang) {
      if (DEBUG) console.log(`Overriding Intercom lang ${detectedLang} with franc ${francLang}`);
      detectedLang = francLang;
    }

    // Дополнительная проверка: если zh, но текст не на китайском (нет иероглифов)
    if (detectedLang.startsWith('zh') && !/[\u4e00-\u9fff]/.test(messageText)) {
      detectedLang = francLang || 'auto';
      if (DEBUG) console.log('Overridden zh as text is not Chinese script');
    }

    // Если auto или skip - используем franc
    if (detectedLang === 'auto' || detectedLang === 'und' || SKIP_LANGS.includes(detectedLang)) {
      detectedLang = francLang;
      if (DEBUG) console.log('Fallback content detection with franc:', detectedLang);
    }

    const translation = await translateMessage(messageText, detectedLang);
    if (!translation) return;
    await createInternalNote(conversationId, translation);
    console.log(`Processed ${conversationId} in ${Date.now() - start}ms`);
  } catch (error) {
    console.error('Webhook error:', error.message);
  }
});

function detectLangByContent(text, fallback = 'auto') {
  if (!text || text.length < 10) return fallback;
  const langCode = franc(text, { minLength: 3 });
  if (langCode === 'und') return fallback;
  return LANG_MAP[langCode] || fallback;
}

function extractMessageText(conversation) {
  let parts = conversation?.conversation_parts?.conversation_parts || [];
  let rawBody = '';
  if (parts.length > 0) {
    if (DEBUG) console.log('Parts count:', parts.length);
    parts = parts
      .filter(p => p?.author?.type === 'user' && p?.body)
      .sort((a, b) => (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0));
    if (parts[0]) {
      rawBody = parts[0].body;
    }
  }
  if (!rawBody && conversation?.source?.author?.type === 'user' && conversation.source.body) {
    rawBody = conversation.source.body;
  }
  if (DEBUG && rawBody) console.log('Raw body before clean:', rawBody);
  return cleanText(rawBody);
}

function cleanText(text) {
  if (!text) return '';
  text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
              .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
              .replace(/<br\s*\/?>/gi, '\n')
              .replace(/<[^>]+>/g, ' ')
              .replace(/id="[^"]*"/gi, '') 
              .replace(/class="[^"]*"/gi, '')
              .replace(/menu-item-\d+/gi, '')
              .replace(/license849 key[:\s]*[a-f0-9]{32}/gi, '')
              .replace(/https?:\S+/g, '')
              .replace(/&nbsp;|\u00A0|\u200B/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();

  if (/[a-zA-Z]="[^"]*"/.test(text) || /menu|select|option|dropdown/.test(text.toLowerCase())) {
    if (DEBUG) console.log('Discarded as garbage:', text);
    return '';
  }
  return text;
}

async function translateMessage(text, detectedLang) {
  // Chunking для очень длинных текстов (лимит Libre ~5000, но безопасно)
  if (text.length > 1500) {
    const sentences = text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 0);
    const translatedSentences = [];
    for (const sentence of sentences) {
      const trans = await translateChunk(sentence, detectedLang);
      if (trans && trans.text) translatedSentences.push(trans.text);
    }
    if (translatedSentences.length > 0) {
      return { text: translatedSentences.join(' '), sourceLang: detectedLang, targetLang: TARGET_LANG };
    }
    return null;
  } else {
    return await translateChunk(text, detectedLang);
  }
}

async function translateChunk(q, sourceLang) {
  if (q.length > 5000) q = q.substring(0, 5000); // Hard limit

  let apiSource = sourceLang && LANG_MAP[sourceLang] ? LANG_MAP[sourceLang] : 'auto';
  if (apiSource.startsWith('zh')) apiSource = 'zh';
  if (DEBUG) console.log('Final source lang for API:', apiSource);

  if (apiSource === 'und' || SKIP_LANGS.includes(apiSource)) {
    if (DEBUG) console.log('Skipping translation: lang in SKIP_LANGS or und');
    return null;
  }

  if (apiSource === TARGET_LANG) {
    if (DEBUG) console.log('Skipping translation: Source matches target');
    return null;
  }

  const cacheKey = `${q}:${apiSource}:${TARGET_LANG}`;
  if (TRANSLATION_CACHE.has(cacheKey)) {
    if (DEBUG) console.log('Returning cached translation');
    return TRANSLATION_CACHE.get(cacheKey);
  }

  let result;

  // Параллельные запросы к Libre
  result = await translateWithLibreAny(q, apiSource);

  // Fallback: Lingva
  if (!result) {
    result = await translateWithLingva(q);
  }

  // Final MyMemory
  if (!result) {
    result = await translateWithMyMemory(q, apiSource);
  }

  if (!result) return null;

  const translation = { text: result.text, sourceLang: result.source || apiSource, targetLang: TARGET_LANG };
  TRANSLATION_CACHE.set(cacheKey, translation);
  return translation;
}

async function translateWithLibre(q, source, url) {
  if (DEBUG) console.log(`Trying Libre ${url}: text="${q.substring(0, 50)}...", source=${source}`);
  try {
    const payload = {
      q, source, target: TARGET_LANG, format: 'text'
    };
    if (LIBRE_API_KEY) payload.api_key = LIBRE_API_KEY;

    const response = await axiosInstance.post(url, payload);
    const respData = response.data;

    if (DEBUG) console.log('Libre response:', JSON.stringify(respData, null, 2));

    // Проверка на HTML или мусор
    if (typeof respData === 'string' && respData.includes('<!DOCTYPE')) return null;
    let transText = respData.translatedText?.trim();
    if (!transText || transText.length < 1 || transText.startsWith('<') || /menu-item|select|id=/.test(transText)) return null;

    // Проверка completeness: не менее 30% длины оригинала
    if (q.length > 20 && transText.length < q.length * 0.3) {
      if (DEBUG) console.log('Incomplete from Libre, skip');
      return null;
    }

    const apiDetected = respData.detectedLanguage?.language || source;
    const confidence = respData.detectedLanguage?.confidence || 100;

    if (confidence < 70) return null;
    if (apiDetected === TARGET_LANG || SKIP_LANGS.includes(apiDetected)) return null;

    return { text: transText, source: apiDetected };
  } catch (e) {
    if (e.response && e.response.status === 400) console.warn(`Libre ${url} bad request - likely HTML redirect or down`);
    else console.warn(`Libre ${url} error: ${e.message}`);
    return null;
  }
}

async function translateWithLibreAny(q, source) {
  const promises = LIBRE_INSTANCES.map(url => translateWithLibre(q, source, url));
  const results = await Promise.allSettled(promises);
  for (const res of results) {
    if (res.status === 'fulfilled' && res.value) {
      if (DEBUG) console.log('Successful Libre instance used');
      return res.value;
    }
  }
  if (DEBUG) console.log('All Libre instances failed');
  return null;
}

async function translateWithLingva(q) {
  const encodedQ = encodeURIComponent(q);
  const url = `${LINGVA_INSTANCE}${encodedQ}`;
  if (DEBUG) console.log(`Trying Lingva: ${url}`);
  try {
    const response = await axiosInstance.get(url);
    const respData = response.data;
    if (DEBUG) console.log('Lingva response:', JSON.stringify(respData, null, 2));

    let transText = respData.translation?.trim();
    if (!transText || transText.length < 1 || /menu-item|select/.test(transText)) return null;

    if (q.length > 20 && transText.length < q.length * 0.3) return null;

    const apiDetected = respData.detected || 'auto';
    if (apiDetected === TARGET_LANG || SKIP_LANGS.includes(apiDetected)) return null;

    return { text: transText, source: apiDetected };
  } catch (e) {
    console.warn(`Lingva failed: ${e.message}`);
    return null;
  }
}

async function translateWithMyMemory(q, source) {
  if (DEBUG) console.log(`Trying MyMemory: text="${q.substring(0, 50)}...", source=${source}`);
  try {
    const langPair = source === 'auto' ? `auto|${TARGET_LANG}` : `${source}|${TARGET_LANG}`;
    const response = await axiosInstance.get(MYMEMORY_TRANSLATE_API_URL, {
      params: { q, langpair: langPair }
    });
    const respData = response.data.responseData;
    const transText = response.data.matches[0]?.translation?.trim();
    if (!transText || transText.length < 1 || /menu-item|select/.test(transText)) return null;

    if (q.length > 20 && transText.length < q.length * 0.3) return null;

    const detSource = respData.detectedLanguage || source;
    if (detSource === TARGET_LANG || SKIP_LANGS.includes(detSource)) return null;

    return { text: transText, source: detSource };
  } catch (e) {
    console.warn(`MyMemory failed: ${e.message}`);
    return null;
  }
}

async function createInternalNote(conversationId, translation) {
  try {
    const noteBody = `Auto-translation (${translation.sourceLang} → ${translation.targetLang}): ${translation.text}`;
    await axiosInstance.post(
      `https://api.intercom.io/conversations/${conversationId}/reply`,
      { message_type: 'note', admin_id: ADMIN_ID, body: noteBody },
      {
        headers: {
          Authorization: INTERCOM_TOKEN,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Intercom-Version': INTERCOM_API_VERSION
        }
      }
    );
    if (DEBUG) console.log('Internal note created successfully');
  } catch (error) {
    console.error('Note error:', error.message);
    if (error.response) console.error('Note error response:', error.response.data);
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server on ${PORT}`));
