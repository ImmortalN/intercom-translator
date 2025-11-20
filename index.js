import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import http from 'http';
import dotenv from 'dotenv';
import NodeCache from 'node-cache';

dotenv.config();

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));

// ========================= CONFIG =========================
const INTERCOM_TOKEN = `Bearer ${process.env.INTERCOM_TOKEN}`;
const ADMIN_ID = process.env.ADMIN_ID;
const MYMEMORY_KEY = process.env.MYMEMORY_KEY || '';
const ENABLED = process.env.ENABLED === 'true';
const DEBUG = process.env.DEBUG === 'true';

const TARGET_LANG = 'en';
const SKIP_LANGS = ['en', 'ru', 'uk'];

const INTERCOM_API_VERSION = '2.11';
const INTERCOM_API_BASE = 'https://api.intercom.io';

// Самые надёжные инстансы (проверено 20.11.2025)
const PRIMARY_API = 'https://libretranslate.de/translate';
const BEST_FOR_HEBREW = 'https://translate.argosopentech.com/translate'; // ← идеальный иврит
const FALLBACK_APIS = [
  'https://translate.terraprint.co/translate',
  'https://translate.fedilab.app/translate'
];

const MYMEMORY_URL = 'https://api.mymemory.translated.net/get';

const CACHE = new NodeCache({ stdTTL: 3600, checkperiod: 120 });
const PROCESSED = new NodeCache({ stdTTL: 30, checkperiod: 60 }); // антидубль 30 сек

const axiosInstance = axios.create({
  timeout: 10000,
  httpAgent: new http.Agent({ keepAlive: true })
});

// Полный маппинг языков Intercom → коды
const LANG_MAP = {
  'en': 'en', 'ru': 'ru', 'uk': 'uk', 'es': 'es', 'de': 'de', 'fr': 'fr',
  'it': 'it', 'pt': 'pt', 'pl': 'pl', 'he': 'he', 'ar': 'ar', 'zh': 'zh',
  'English': 'en', 'Russian': 'ru', 'Ukrainian': 'uk',
  'Spanish': 'es', 'German': 'de', 'French': 'fr',
  'Italian': 'it', 'Portuguese': 'pt', 'Polish': 'pl',
  'Hebrew': 'he', 'Arabic': 'ar', 'Chinese': 'zh',
  'Chinese (Simplified)': 'zh', 'Chinese (Traditional)': 'zh'
};

// Защита от мусора
function isGarbage(text) {
  if (!text) return true;
  const t = text.toLowerCase();
  return t.includes('@@') ||
         t.includes('mainstre') ||
         t.includes('invalid source') ||
         t.includes('mymemory_translate_api_url') ||
         t.includes('example: langpair') ||
         (text.length > 300 && text.split(' ').length < 10);
}

// ========================= ХЕНДЛЕР =========================
app.get('/intercom-webhook', (_, res) => res.send('OK'));

app.post('/intercom-webhook', async (req, res) => {
  res.sendStatus(200);
  if (!ENABLED) return;

  try {
    const { topic, data } = req.body;
    if (!['conversation.user.replied', 'conversation.user.created'].includes(topic)) return;

    const conv = data.item;
    const convId = conv?.id;
    if (!convId) return;

    // Антидубль
    const key = `${convId}:${topic}`;
    if (PROCESSED.has(key)) return;
    PROCESSED.set(key, true);

    // Берём текст прямо из webhook — без лишнего fetch!
    const text = extractTextFromWebhook(conv, topic);
    if (!text || text.length < 3) return;

    // Язык из Intercom (самый приоритетный)
    const intercomLang = conv.language_override ||
                         conv.source?.language ||
                         conv.custom_attributes?.Language ||
                         'auto';

    if (DEBUG) console.log(`[ID:${convId}] Lang: ${intercomLang} | Text: ${text.substring(0, 100)}`);

    const translation = await translate(text, intercomLang);
    if (!translation) return;

    await createNote(convId, translation);
    console.log(`Переведено [${translation.sourceLang}→en] — ${convId}`);

  } catch (err) {
    console.error('Ошибка webhook:', err.message);
  }
});

// ========================= ТЕКСТ =========================
function extractTextFromWebhook(conv, topic) {
  let body = '';

  if (topic === 'conversation.user.created' && conv.source?.body) {
    body = conv.source.body;
  } else {
    const parts = conv.conversation_parts?.conversation_parts || [];
    const lastUserPart = parts
      .filter(p => ['user', 'contact', 'lead'].includes(p.author?.type) && p.body)
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
    body = lastUserPart?.body || '';
  }

  return cleanText(body);
}

function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ========================= ПЕРЕВОД =========================
async function translate(text, detectedLang) {
  if (text.length > 5000) text = text.substring(0, 5000);

  const langCode = LANG_MAP[detectedLang] || 'auto';

  // Пропускаем английский/русский/украинский
  if (SKIP_LANGS.includes(langCode) || langCode === TARGET_LANG) {
    if (DEBUG) console.log('Пропуск: язык в SKIP_LANGS или уже en');
    return null;
  }

  const cacheKey = `tr:${langCode}:${text.substring(0, 120)}`;
  if (CACHE.has(cacheKey)) return CACHE.get(cacheKey);

  let result;

  // Иврит — всегда в Argos (идеальный перевод)
  if (langCode === 'he' || /[\u0590-\u05FF]/.test(text)) {
    result = await tryAPI(text, 'he', BEST_FOR_HEBREW);
    if (result) return cache(result);
  }

  // Обычная цепочка
  result = await tryAPI(text, langCode === 'auto' ? 'auto' : langCode, PRIMARY_API);
  if (result) return cache(result);

  for (const url of FALLBACK_APIS) {
    result = await tryAPI(text, langCode === 'auto' ? 'auto' : langCode, url);
    if (result) return cache(result);
  }

  // MyMemory как последний резерв
  result = await tryMyMemory(text, langCode);
  if (result) return cache(result);

  return null;

  function cache(res) {
    CACHE.set(cacheKey, res);
    return res;
  }
}

async function tryAPI(text, source, url) {
  try {
    const res = await axiosInstance.post(url, {
      q: text,
      source,
      target: 'en',
      format: 'text'
    }, { timeout: 9000 });

    const translated = (res.data?.translatedText || '').trim();
    if (!translated || translated === text || isGarbage(translated)) return null;

    const detected = res.data.detectedLanguage?.language || source;
    if (detected === 'en') return null;

    return { text: translated, sourceLang: detected.slice(0, 2) };
  } catch (err) {
    if (DEBUG) console.log(`API ${url.split('/')[2]}: ${err.message}`);
    return null;
  }
}

async function tryMyMemory(text, sourceLang) {
  try {
    const pair = sourceLang === 'he' ? 'he|en' : (sourceLang === 'auto' ? 'auto|en' : `${sourceLang}|en`);
    const res = await axiosInstance.get(MYMEMORY_URL, {
      params: { q: text, langpair: pair, key: MYMEMORY_KEY || undefined }
    });
    const translated = res.data.responseData?.translatedText?.trim();
    if (translated && !isGarbage(translated) && translated !== text) {
      return { text: translated, sourceLang: sourceLang === 'auto' ? 'auto' : sourceLang };
    }
  } catch (err) {
    if (DEBUG) console.log('MyMemory error:', err.message);
  }
  return null;
}

// ========================= НОТС =========================
async function createNote(convId, translation) {
  try {
    await axiosInstance.post(
      `${INTERCOM_API_BASE}/conversations/${convId}/reply`,
      {
        message_type: 'note',
        admin_id: ADMIN_ID,
        body: `Auto-translation (${translation.sourceLang} → en):\n${translation.text}`
      },
      {
        headers: {
          Authorization: INTERCOM_TOKEN,
          'Intercom-Version': INTERCOM_API_VERSION,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (err) {
    console.error('Ошибка создания нотса:', err.message);
  }
}

// ========================= ЗАПУСК =========================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Автопереводчик запущен на порту ${PORT}`);
  console.log(`Режим: ${ENABLED ? 'ВКЛЮЧЁН' : 'ВЫКЛЮЧЕН'} | DEBUG: ${DEBUG}`);
});
