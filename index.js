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
const TARGET_LANG = 'en';
const SKIP_LANGS = new Set(['en', 'ru', 'uk']);
const DEBUG = process.env.DEBUG === 'true';

const INTERCOM_API_BASE = 'https://api.intercom.io';
const INTERCOM_API_VERSION = '2.11';

// Самые надёжные бесплатные инстансы (ноябрь 2025)
const PRIMARY_TRANSLATE_API_URL = 'https://libretranslate.de/translate';        // №1
const FALLBACK_TRANSLATE_API_URL = 'https://translate.terraprint021.translate'; // №2 (очень живучий)

const MYMEMORY_TRANSLATE_API_URL = 'https://api.mymemory.translated.net/get';

const CACHE = new NodeCache({ stdTTL: 3600, checkperiod: 120 });
const PROCESSED = new NodeCache({ stdTTL: 3600 }); // антидубли

const axiosInstance = axios.create({
  timeout: 10000,
  httpAgent: new http.Agent({ keepAlive: true })
});

// Маппинг всех возможных значений language_override
const LANG_MAP = {
  // Коды
  'en': 'en', 'ru': 'ru', 'uk': 'uk', 'es': 'es', 'de': 'de', 'fr': 'fr',
  'it': 'it', 'pt': 'pt', 'pl': 'pl', 'cs': 'cs', 'nl': 'nl', 'tr': 'tr',
  'ar': 'ar', 'zh': 'zh', 'ko': 'ko', 'ja': 'ja', 'he': 'he',
  // Полные названия (Intercom часто отдаёт именно их!)
  'English': 'en', 'Russian': 'ru', 'Ukrainian': 'uk',
  'Spanish': 'es', 'German': 'de', 'French': 'fr',
  'Italian': 'it', 'Portuguese': 'pt', 'Polish': 'pl',
  'Czech': 'cs', 'Dutch': 'nl', 'Turkish': 'tr',
  'Arabic': 'ar', 'Chinese': 'zh', 'Hebrew': 'he',
  'Chinese (Simplified)': 'zh', 'Chinese (Traditional)': 'zh',
  'zh-CN': 'zh', 'zh-TW': 'zh'
};

// Проверка на мусор
function isGarbage(text) {
  if (!text) return true;
  const lower = text.toLowerCase();
  return lower.includes('@@') ||
         lower.includes('mainstre') ||
         lower.includes('invalid source language') ||
         lower.includes('mymemory_translate_api_url') ||
         lower.includes('is an invalid') ||
         (text.length > 200 && text.split(/\s+/).length < 10);
}

// ========================= ОСНОВНОЙ ХЕНДЛЕР =========================
app.post('/intercom-webhook', async (req, res) => {
  res.sendStatus(200);
  if (!ENABLED) return;

  try {
    const { topic, data } = req.body;
    if (!['conversation.user.replied', 'conversation.user.created'].includes(topic)) return;

    const conv = data.item;
    const convId = conv?.id;
    if (!convId) return;

    const fullConv = await fetchConversation(convId);
    if (!fullConv) return;

    const text = extractMessageText(fullConv, topic);
    if (!text || text.length < 3) return;

    // Антидубль
    const dupKey = `dup:${convId}:${text.substring(0, 60)}`;
    if (PROCESSED.has(dupKey)) return;
    PROCESSED.set(dupKey, true);

    // Самое важное: берём язык из Intercom
    const intercomLang = fullConv.language_override ||
                         fullConv.source?.language ||
                         fullConv.custom_attributes?.Language ||
                         'auto';

    const translation = await translateMessage(text, intercomLang);
    if (!translation) return;

    await createInternalNote(convId, translation);
    console.log(`Переведено [${translation.sourceLang}→en] — ${convId}`);

  } catch (err) {
    console.error('Ошибка:', err.message);
  }
});

// ========================= ВСПОМОГАТЕЛЬНЫЕ =========================
async function fetchConversation(id) {
  try {
    const res = await axiosInstance.get(`${INTERCOM_API_BASE}/conversations/${id}`, {
      headers: { Authorization: INTERCOM_TOKEN, 'Intercom-Version': INTERCOM_API_VERSION }
    });
    return res.data;
  } catch (err) {
    console.error('Не удалось получить разговор:', err.message);
    return null;
  }
}

function extractMessageText(conv, topic) {
  let body = '';
  if (topic === 'conversation.user.created' && conv.source?.body) {
    body = conv.source.body;
  } else {
    const parts = conv.conversation_parts?.conversation_parts || [];
    const userPart = parts
      .filter(p => ['user', 'lead', 'contact'].includes(p.author?.type) && p.body)
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
    body = userPart?.body || '';
  }
  return cleanText(body);
}

function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ========================= ПЕРЕВОД =========================
async function translateMessage(text, intercomLang) {
  if (text.length > 5000) text = text.substring(0, 5000);

  // 1. Приоритет — язык из Intercom
  if (intercomLang && intercomLang !== 'auto') {
    const mapped = LANG_MAP[intercomLang];
    if (mapped && SKIP_LANGS.has(mapped)) {
      if (DEBUG) console.log('Пропуск по language_override:', intercomLang);
      return null;
    }
    if (mapped === TARGET_LANG) return null;
  }

  const cacheKey = `tr:${text.substring(0, 150)}:${intercomLang}`;
  if (CACHE.has(cacheKey)) return CACHE.get(cacheKey);

  // Попробуем PRIMARY → FALLBACK → MyMemory
  let result = await tryLibre(text);
  if (!result) result = await tryMyMemory(text);

  if (result && !isGarbage(result.text)) {
    CACHE.set(cacheKey, result);
    return result;
  }

  CACHE.set(cacheKey, 'garbage');
  return null;
}

async function tryLibre(text) {
  for (const url of [PRIMARY_TRANSLATE_API_URL, FALLBACK_TRANSLATE_API_URL]) {
    try {
      const res = await axiosInstance.post(url, {
        q: text, source: 'auto', target: 'en', format: 'text'
      }, { timeout: 9000 });

      const translated = (res.data?.translatedText || '').trim();
      if (translated && translated !== text && !isGarbage(translated)) {
        return { text: translated, sourceLang: 'auto', targetLang: 'en' };
      }
    } catch (err) {
      if (DEBUG) console.log(`Libre ${url.split('/')[2]} упал:`, err.message);
    }
  }
  return null;
}

async function tryMyMemory(text) {
  if (text.includes('מאושר') || /[\u0590-\u05FF]/.test(text)) return null; // иврит ломается

  try {
    const res = await axiosInstance.get(MYMEMORY_TRANSLATE_API_URL, {
      params: { q: text, langpair: 'auto|en', key: MYMEMORY_KEY || undefined }
    });
    const translated = res.data.responseData?.translatedText?.trim();
    if (translated && translated !== text && !isGarbage(translated)) {
      return { text: translated, sourceLang: 'auto', targetLang: 'en' };
    }
  } catch (err) {
    if (DEBUG) console.log('MyMemory упал:', err.message);
  }
  return null;
}

async function createInternalNote(convId, translation) {
  try {
    await axiosInstance.post(
      `${INTERCOM_API_BASE}/conversations/${convId}/reply`,
      {
        message_type: 'note',
        admin_id: ADMIN_ID,
        body: `Auto-translation → en:\n${translation.text}`
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
    console.error('Не удалось создать нотс:', err.message);
  }
}

// ========================= ЗАПУСК =========================
app.get('/intercom-webhook', (_, res) => res.send('OK'));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Автопереводчик запущен на порту ${PORT}`));
