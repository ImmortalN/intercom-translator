import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import http from 'http';
import dotenv from 'dotenv';
import NodeCache from 'node-cache';
import crypto from 'node:crypto';

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

// Порог: если меньше слов — не переводим (убирает 99% мусора)
const MIN_WORDS_FOR_TRANSLATION = 5;

const INTERCOM_API_VERSION = '2.11';
const INTERCOM_API_BASE = 'https://api.intercom.io';

const LIBRE_INSTANCES = [
  'https://libretranslate.de/translate',
  'https://translate.terraprint.co/translate',
  'https://translate.fedilab.app/translate'
];

const MYMEMORY_URL = 'https://api.mymemory.translated.net/get';

const CACHE = new NodeCache({ stdTTL: 3600, checkperiod: 120 });
const PROCESSED = new NodeCache({ stdTTL: 60, checkperiod: 60 });

const axiosInstance = axios.create({
  timeout: 12000,
  httpAgent: new http.Agent({ keepAlive: true }),
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TranslationBot/1.0)' }
});

const LANG_MAP = {
  'en': 'en', 'ru': 'ru', 'uk': 'uk', 'es': 'es', 'de': 'de', 'fr': 'fr',
  'it': 'it', 'pt': 'pt', 'pl': 'pl', 'he': 'he', 'ar': 'ar', 'zh': 'zh',
  'English': 'en', 'Russian': 'ru', 'Ukrainian': 'uk',
  'Spanish': 'es', 'German': 'de', 'French': 'fr',
  'Italian': 'it', 'Portuguese': 'pt', 'Polish': 'pl',
  'Hebrew': 'he', 'Arabic': 'ar', 'Chinese': 'zh'
};

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

    const textHash = crypto.createHash('md5').update(conv.body || '').digest('hex').slice(0, 8);
    const key = `${convId}:${textHash}`;
    if (PROCESSED.has(key)) return;
    PROCESSED.set(key, true);

    const text = extractTextFromWebhook(conv, topic);
    if (!text || text.length < 3) return;

    const wordCount = text.trim().split(/\s+/).length;
    if (wordCount < MIN_WORDS_FOR_TRANSLATION) {
      if (DEBUG) console.log(`Короткое сообщение (${wordCount} слов) — пропускаем перевод: ${text.substring(0, 50)}`);
      return;
    }

    const intercomLang = conv.language_override ||
                         conv.source?.language ||
                         conv.custom_attributes?.Language ||
                         'auto';

    if (DEBUG) console.log(`[ID:${convId}] Lang: ${intercomLang} | Words: ${wordCount} | Text: ${text.substring(0, 120)}`);

    const translation = await translate(text, intercomLang);
    if (!translation) return;

    await createNote(convId, translation);
    console.log(`Переведено [${translation.sourceLang}→en] — ${convId}`);

  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

// ========================= ТЕКСТ =========================
function extractTextFromWebhook(conv, topic) {
  let body = '';
  if (topic === 'conversation.user.created' && conv.source?.body) {
    body = conv.source.body;
  } else {
    const parts = conv.conversation_parts?.conversation_parts || [];
    const last = parts
      .filter(p => ['user', 'contact', 'lead'].includes(p.author?.type) && p.body)
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
    body = last?.body || '';
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
  if (SKIP_LANGS.includes(langCode) || langCode === TARGET_LANG) return null;

  const cacheKey = `tr:${langCode}:${text.substring(0, 120)}`;
  if (CACHE.has(cacheKey)) return CACHE.get(cacheKey);

  const isHebrew = /[\u0590-\u05FF]/.test(text);
  const sourceForAPI = isHebrew ? 'he' : (langCode === 'auto' ? 'auto' : langCode);

  let result;

  for (const url of LIBRE_INSTANCES) {
    if (await isHealthy(url)) {
      result = await tryLibre(text, sourceForAPI, url);
      if (result) return cache(result);
    }
  }

  result = await tryMyMemory(text, sourceForAPI);
  if (result) return cache(result);

  return null;

  function cache(res) {
    CACHE.set(cacheKey, res);
    return res;
  }
}

async function isHealthy(baseUrl) {
  try {
    await axiosInstance.get(baseUrl.replace('/translate', '/languages'), { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function tryLibre(text, source, url) {
  try {
    const res = await axiosInstance.post(url, {
      q: text,
      source,
      target: 'en',
      format: 'text'
    }, { timeout: 10000 });

    const translated = res.data?.translatedText?.trim();
    if (translated && translated !== text && translated.length > 5) {
      return { text: translated, sourceLang: source === 'auto' ? 'auto' : source };
    }
  } catch (err) {
    if (DEBUG) console.log(`Libre ${url.split('/')[2]}: ${err.message}`);
  }
  return null;
}

async function tryMyMemory(text, source) {
  try {
    const pair = source === 'he' ? 'he|en' : (source === 'auto' ? 'auto|en' : `${source}|en`);
    const res = await axiosInstance.get(MYMEMORY_URL, {
      params: { q: text, langpair: pair, key: MYMEMORY_KEY || undefined }
    });
    const translated = res.data.responseData?.translatedText?.trim();
    if (translated && translated !== text && translated.length > 5) {
      return { text: translated, sourceLang: source === 'auto' ? 'auto' : source };
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
  console.log(`Автопереводчик запущен | Порог: ${MIN_WORDS_FOR_TRANSLATION} слов | ENABLED: ${ENABLED}`);
});
