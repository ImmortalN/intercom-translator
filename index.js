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
const MYMEMORY_KEY = process.env.MYMEMORY_KEY || ''; // Рекомендую зарегистрировать бесплатный ключ для большего лимита
const ENABLED = process.env.ENABLED === 'true';
const DEBUG = process.env.DEBUG === 'true';
const TARGET_LANG = 'en';
const SKIP_LANGS = ['en', 'ru', 'uk'];
const MIN_WORDS_FOR_TRANSLATION = 3; // Пропускаем короткие сообщения (спасибо, ок и т.д.)
const INTERCOM_API_VERSION = '2.11';
const INTERCOM_API_BASE = 'https://api.intercom.io';

 // Актуальные живые публичные инстансы LibreTranslate (декабрь 2025)
const LIBRE_INSTANCES = [
  'https://libretranslate.com/translate',      // Основной официальный, часто работает
  'https://translate.fedilab.app/translate',   // Медленный, но стабильный резерв
  'https://lt.vern.cc/translate',              // Community, часто живой
  'https://translate.namazitime.ru/translate', // Ещё один резерв
  'https://translate.terraprint.co/translate'  // Старый, но иногда оживает
];

const CACHE = new NodeCache({ stdTTL: 4 * 3600, checkperiod: 600 }); // Кэш переводов 4 часа
const PROCESSED = new NodeCache({ stdTTL: 300, checkperiod: 120 }); // Антидубль 5 мин

const axiosInstance = axios.create({
  timeout: 15000,
  httpAgent: new http.Agent({ keepAlive: true }),
  headers: {
    'User-Agent': 'IntercomAutoTranslate/3.0',
    'Accept': 'application/json'
  }
});

// ========================= УТИЛИТЫ =========================
function cleanText(text = '') {
  if (!text) return '';
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGarbage(text = '') {
  if (!text) return true;
  const lower = text.toLowerCase();
  return lower.includes('@@') || lower.includes('mainstre') || lower.includes('invalid') ||
         lower.includes('mymemory') || lower.includes('example:');
}

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

// ========================= ПЕРЕВОД =========================
async function translate(text, detectedLang = 'auto') {
  if (text.length > 5000) text = text.substring(0, 5000);

  // Пропуск известных языков
  const langCode = detectedLang.toLowerCase();
  if (SKIP_LANGS.includes(langCode)) {
    if (DEBUG) console.log(`[SKIP LANG] Язык ${langCode} в skip-листе`);
    return null;
  }

  const isHebrew = /[\u0590-\u05FF]/.test(text);
  const sourceLang = isHebrew ? 'he' : (langCode === 'auto' ? 'auto' : langCode);

  const cacheKey = `tr:${sourceLang}:${text.substring(0, 150)}`;
  if (CACHE.has(cacheKey)) {
    if (DEBUG) console.log('[CACHE HIT]');
    return CACHE.get(cacheKey);
  }

  let result = null;

  // 1. LibreTranslate — пытаем все по порядку с retry
  for (const url of LIBRE_INSTANCES) {
    if (DEBUG) console.log(`[TRY LIBRE] ${url.split('/')[2]}`);
    result = await tryLibre(text, sourceLang, url);
    if (result) break;
  }

  // 2. MyMemory fallback
  if (!result) {
    if (DEBUG) console.log('[TRY MYMEMORY]');
    result = await tryMyMemory(text, sourceLang);
  }

  if (result) {
    CACHE.set(cacheKey, result);
    return result;
  }

  if (DEBUG) console.log('[FAIL] Все переводчики не сработали');
  return null;
}

async function tryLibre(text, source, url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axiosInstance.post(url, {
        q: text,
        source,
        target: 'en',
        format: 'text'
      }, { timeout: 12000 });

      const translated = res.data?.translatedText?.trim() || res.data?.translation?.trim();
      if (translated && translated !== text && translated.length > 3 && !isGarbage(translated)) {
        return { text: translated, sourceLang: source === 'auto' ? 'detected' : source };
      }
    } catch (err) {
      if (DEBUG) console.log(`[LIBRE ERROR] ${url.split('/')[2]} attempt ${attempt}: ${err.message} ${err.response?.status || ''}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  return null;
}

async function tryMyMemory(text, source) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const pair = source === 'he' ? 'he|en' : (source === 'auto' ? 'auto|en' : `${source}|en`);
      const res = await axiosInstance.get('https://api.mymemory.translated.net/get', {
        params: { q: text, langpair: pair, key: MYMEMORY_KEY || undefined },
        timeout: 10000
      });

      const translated = res.data.responseData?.translatedText?.trim();
      if (translated && translated !== text && translated.length > 3 && !isGarbage(translated)) {
        return { text: translated, sourceLang: source === 'auto' ? 'auto' : source };
      }
    } catch (err) {
      if (DEBUG) console.log(`[MYMEMORY ERROR] attempt ${attempt}: ${err.message}`);
    }
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
    console.error('Ошибка создания note:', err.response?.data || err.message);
  }
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

    const text = extractTextFromWebhook(conv, topic);
    if (!text || text.length < 5) return;

    const wordCount = text.trim().split(/\s+/).filter(w => w.length > 0).length;
    if (wordCount < MIN_WORDS_FOR_TRANSLATION) {
      if (DEBUG) console.log(`[SKIP SHORT] ${wordCount} слов: "${text.substring(0, 60)}"`);
      return;
    }

    // Антидубль
    const textHash = crypto.createHash('md5').update(text).digest('hex').slice(0, 8);
    const key = `${convId}:${textHash}`;
    if (PROCESSED.has(key)) return;
    PROCESSED.set(key, true);

    const intercomLang = conv.language_override || conv.source?.language || 'auto';

    if (DEBUG) console.log(`[TRANSLATE] ${wordCount} слов | Lang: ${intercomLang} | "${text.substring(0, 100)}"`);

    const translation = await translate(text, intercomLang);
    if (!translation) {
      if (DEBUG) console.log(`[FAIL] Не удалось перевести (ID: ${convId})`);
      return;
    }

    await createNote(convId, translation);
    console.log(`[SUCCESS] Переведено [${translation.sourceLang}→en] — ${convId}`);
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

// ========================= ЗАПУСК =========================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Автопереводчик v3 запущен!`);
  console.log(`→ Статус: ${ENABLED ? 'ВКЛЮЧЁН' : 'ВЫКЛЮЧЕН'}`);
  console.log(`→ Порог: ${MIN_WORDS_FOR_TRANSLATION} слов`);
  console.log(`→ Debug: ${DEBUG ? 'ВКЛ' : 'ВЫКЛ'}`);
  console.log(`→ Порт: ${PORT}`);
});
