import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import http from 'http';
import dotenv from 'dotenv';
import NodeCache from 'node-cache';
import francAll from 'franc-all';  // Добавляем franc для fallback детекции языка

dotenv.config();
const app = express();
app.use(bodyParser.json());

// Config
const INTERCOM_TOKEN = `Bearer ${process.env.INTERCOM_TOKEN}`;
const ADMIN_ID = process.env.ADMIN_ID;
const ENABLED = process.env.ENABLED === 'true';
const TARGET_LANG = 'en';
const SKIP_LANGS = ['en', 'ru', 'uk'];
const LANG_MAP = {
  // ISO 639-1 коды
  'en': 'en', 'ru': 'ru', 'uk': 'uk', 'es': 'es', 'de': 'de', 'fr': 'fr',
  'it': 'it', 'pt': 'pt', 'pl': 'pl', 'cs': 'cs', 'nl': 'nl', 'tr': 'tr',
  'ar': 'ar', 'zh': 'zh', 'zh-Hant': 'zh', 'zh-Hans': 'zh',  // Поддержка китайских вариантов
  // Названия языков из Intercom
  'English': 'en', 'Russian': 'ru', 'Ukrainian': 'uk', 'Spanish': 'es',
  'German': 'de', 'French': 'fr', 'Italian': 'it', 'Portuguese': 'pt',
  'Polish': 'pl', 'Czech': 'cs', 'Dutch': 'nl', 'Turkish': 'tr',
  'Arabic': 'ar', 'Chinese': 'zh',
  // Дополнительные из Intercom (для китайского и вариаций)
  'Chinese (Taiwan)': 'zh-Hant', 'Chinese (Simplified)': 'zh-Hans', 'Chinese (Traditional)': 'zh-Hant', 'Traditional Chinese': 'zh-Hant',
  'ko': 'ko', 'ja': 'ja',  // Добавил корейский и японский
  // Дополнительные варианты
  'zh-TW': 'zh', 'zh-CN': 'zh'
};
const INTERCOM_API_VERSION = '2.11';
const PRIMARY_TRANSLATE_API_URL = 'https://translate.fedilab.app/translate';  // Primary: libretranslate
const FALLBACK_TRANSLATE_API_URL = 'https://libretranslate.com/translate';  // Fallback: официальный libretranslate
const MYMEMORY_TRANSLATE_API_URL = 'https://api.mymemory.translated.net/get';  // Additional fallback: MyMemory
const TRANSLATION_CACHE = new NodeCache({ stdTTL: 3600, checkperiod: 120, useClones: false });
const REQUEST_TIMEOUT = 10000;  // Увеличил таймаут для стабильности
const DEBUG = process.env.DEBUG === 'true';

const axiosInstance = axios.create({
  timeout: REQUEST_TIMEOUT,
  httpAgent: new http.Agent({ keepAlive: true })
});

// Env check
if (!INTERCOM_TOKEN || INTERCOM_TOKEN === 'Bearer ') process.exit(1);
if (!ADMIN_ID) process.exit(1);
console.log('Server starting with ENABLED:', ENABLED);

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

    let detectedLang = conversation?.language_override || 
                       conversation?.language || 
                       conversation?.custom_attributes?.Language || 
                       conversation?.source?.language || 
                       'auto';
    if (DEBUG) console.log('Detected language from Intercom:', detectedLang);

    const translation = await translateMessage(messageText, detectedLang);
    if (!translation) return;
    await createInternalNote(conversationId, translation);
    console.log(`Processed ${conversationId} in ${Date.now() - start}ms`);
  } catch (error) {
    console.error('Webhook error:', error.message);
  }
});

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
  text = text
    .replace(/<br\s*\/?>/gi, '\n')  // Сохраняем <br> как перенос строки
    .replace(/<p>/gi, '\n').replace(/<\/p>/gi, '\n')  // Обрабатываем параграфы
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')  // Остальные теги на пробел
    .replace(/id="[^"]*"/gi, '') 
    .replace(/class="[^"]*"/gi, '')
    .replace(/menu-item-\d+/gi, '')
    .replace(/license849 key[:\s]*[a-f0-9]{32}/gi, '')
    .replace(/https?:\S+/g, '')  // Убрал http(s) ссылки
    .replace(/&nbsp;|\u00A0|\u200B/g, ' ')
    .replace(/\s+/g, ' ')  // Сжимаем пробелы, но \n остаются
    .trim();

  // Ослабленный фильтр мусора: только для коротких текстов с UI-словами
  const lowerText = text.toLowerCase();
  if ((/[a-zA-Z]="[^"]*"/.test(text) || /menu|select|option|dropdown/.test(lowerText)) && text.length < 50) {
    if (DEBUG) console.log('Discarded as garbage:', text);
    return '';
  }
  return text;
}

async function translateMessage(text, detectedLang) {
  if (text.length > 2000) text = text.substring(0, 2000);  // Увеличил лимит, чтобы реже обрезать

  let sourceLang = detectedLang && LANG_MAP[detectedLang] ? LANG_MAP[detectedLang] : 'auto';
  if (sourceLang.startsWith('zh')) sourceLang = 'zh';
  if (DEBUG) console.log('Normalized source lang for API:', sourceLang);

  // Fallback детекция с franc если auto и API может не справиться
  let apiSource = sourceLang;
  if (sourceLang === 'auto') {
    const francCode = francAll(text, { minLength: 3, whitelist: Object.keys(LANG_MAP) });
    apiSource = LANG_MAP[francCode] || 'auto';
    if (DEBUG) console.log('Franc fallback detected:', francCode, '->', apiSource);
  }
  if (apiSource === 'zh-Hant' || apiSource === 'zh-Hans') apiSource = 'zh';

  if (apiSource === 'und' || SKIP_LANGS.includes(apiSource)) {
    if (DEBUG) console.log('Skipping translation: Language is undefined or in SKIP_LANGS');
    return null;
  }

  if (apiSource === TARGET_LANG) {
    if (DEBUG) console.log('Skipping translation: Source language matches target language');
    return null;
  }

  const cacheKey = `${text}:${apiSource}:${TARGET_LANG}`;
  if (TRANSLATION_CACHE.has(cacheKey)) {
    if (DEBUG) console.log('Returning cached translation');
    return TRANSLATION_CACHE.get(cacheKey);
  }

  // Try primary, then fallbacks
  let translatedText, finalSource;
  try {
    const result = await translateWithAPI(text, apiSource, PRIMARY_TRANSLATE_API_URL);
    if (result) return cacheAndReturn(result.text, result.source);
  } catch (e) { console.warn('Primary API failed, trying fallback', e.message); }

  try {
    const result = await translateWithAPI(text, apiSource, FALLBACK_TRANSLATE_API_URL);
    if (result) return cacheAndReturn(result.text, result.source);
  } catch (e) { console.warn('Fallback1 API failed, trying MyMemory', e.message); }

  try {
    const result = await translateWithMyMemory(text, apiSource);
    if (result) return cacheAndReturn(result.text, result.source);
  } catch (e) { console.error('All APIs failed', e.message); }

  return null;

  async function translateWithAPI(q, source, url) {
    if (DEBUG) console.log(`Sending to API ${url}: text="${q}", source=${source}`);
    const response = await axiosInstance.post(url, {
      q, source, target: TARGET_LANG, format: 'text'
    });
    const respData = response.data;
    if (DEBUG) console.log('API response:', JSON.stringify(respData, null, 2));

    let transText = respData.translatedText?.trim();
    if (!transText || transText.length < 1 || transText === q.trim()) return null;
    // Убрал жёсткий фильтр на 'select' etc., чтобы не отбрасывать валидные переводы
    // Если нужно, добавьте мягкую проверку: if (/menu-item|dropdown-ui/.test(transText.toLowerCase())) return null;

    const apiDetected = respData.detectedLanguage?.language || source;
    const confidence = respData.detectedLanguage?.confidence || 100;
    let detSource = source === 'auto' ? apiDetected : source;

    if (confidence < 50) return null;  // Пониженный порог уверенности
    if (detSource === TARGET_LANG || SKIP_LANGS.includes(detSource)) return null;

    return { text: transText, source: detSource };
  }

  async function translateWithMyMemory(q, source) {
    // Поддержка многострочки: переводим по частям если \n
    const lines = q.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    const translations = [];
    let detSource = source;

    for (const line of lines) {
      const langPair = source === 'auto' ? 'auto|en' : `${source}|en`;
      const response = await axiosInstance.get(MYMEMORY_TRANSLATE_API_URL, {
        params: { q: line, langpair: langPair }
      });
      const respData = response.data.responseData;
      const match = response.data.matches[0]?.translation?.trim();
      if (!match || match === line.trim()) continue;

      translations.push(match);
      if (!detSource || detSource === 'auto') {
        detSource = respData.detectedLanguage || source;
      }
    }

    if (translations.length === 0) return null;
    const transText = translations.join('\n');

    if (detSource === TARGET_LANG || SKIP_LANGS.includes(detSource)) return null;

    return { text: transText, source: detSource };
  }

  function cacheAndReturn(text, src) {
    const translation = { text, sourceLang: src, targetLang: TARGET_LANG };
    TRANSLATION_CACHE.set(cacheKey, translation);
    return translation;
  }
}

async function createInternalNote(conversationId, translation) {
  try {
    const noteBody = `📝 Auto-translation (${translation.sourceLang} → ${translation.targetLang}): ${translation.text}`;
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
