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

// Ты поставила 3 — оставляем 3. Это идеально: пропускает "спасибо", "ок", "да", но ловит нормальные фразы
const MIN_WORDS_FOR_TRANSLATION = 3;

const INTERCOM_API_VERSION = '2.11';
const INTERCOM_API_BASE = 'https://api.intercom.io';

// Самые надёжные и живые инстансы LibreTranslate (проверено 20.11.2025)
const LIBRE_INSTANCES = [
  'https://libretranslate.de/translate',        // №1 — всегда работает
  'https://translate.terraprint.co/translate',  // №2 — отличная стабильность
  'https://translate.fedilab.app/translate'     // №3 — резерв
];

const MYMEMORY_URL = 'https://api.mymemory.translated.net/get';

const CACHE = new NodeCache({ stdTTL: 3600, checkperiod: 120 });
const PROCESSED = new NodeCache({ stdTTL: 60, checkperiod: 60 });

const axiosInstance = axios.create({
  timeout: 12000,
  httpAgent: new http.Agent({ keepAlive: true }),
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; IntercomAutoTranslate/2.0)',
    'Accept': 'application/json'
  }
});

// Полный маппинг языков Intercom → ISO
const LANG_MAP = {
  'en': 'en', 'ru': 'ru', 'uk': 'uk', 'es': 'es', 'de': 'de', 'fr': 'fr',
  'it': 'it', 'pt': 'pt', 'pl': 'pl', 'he': 'he', 'ar': 'ar', 'zh': 'zh',
  'English': 'en', 'Russian': 'ru', 'Ukrainian': 'uk',
  'Spanish': 'es', 'German': 'de', 'French': 'fr',
  'Italian': 'it', 'Portuguese': 'pt', 'Polish': 'pl',
  'Hebrew': 'he', 'Arabic': 'ar', 'Chinese': 'zh',
  'Chinese (Simplified)': 'zh', 'Chinese (Traditional)': 'zh'
};

// ========================= УТИЛИТЫ =========================
function isGarbage(text) {
  if (!text) return true;
  const t = text.toLowerCase();
  return t.includes('@@') || t.includes('mainstre') ||
         t.includes('invalid source') || t.includes('example: langpair') ||
     t.includes('mymemory') || (text.length > 300 && text.split(' ').length < 8);
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

    // Антидубль по ID + хэш текста
    const textHash = crypto.createHash('md5').update(conv.body || '').digest('hex').slice(0, 8);
    const key = `${convId}:${textHash}`;
    if (PROCESSED.has(key)) return;
    PROCESSED.set(key, true);

    const text = extractTextFromWebhook(conv, topic);
    if (!text || text.length < 3) return;

    const wordCount = text.trim().split(/\s+/).filter(w => w.length > 0).length;

    // Главное правило: меньше 3 слов — не переводим (99% мусора)
    if (wordCount < MIN_WORDS_FOR_TRANSLATION) {
      if (DEBUG) console.log(`[SKIP] ${wordCount} слов(а) — пропуск: "${text.substring(0, 60)}"`);
      return;
    }

    const intercomLang = conv.language_override ||
                         conv.source?.language ||
                         conv.custom_attributes?.Language ||
                         'auto';

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
  if (SKIP_LANGS.includes(langCode)) return null;

  const cacheKey = `tr:${langCode}:${text.substring(0, 120)}`;
  if (CACHE.has(cacheKey)) return CACHE.get(cacheKey);

  const isHebrew = /[\u0590-\u05FF]/.test(text);
  const sourceLang = isHebrew ? 'he' : (langCode === 'auto' ? 'auto' : langCode);

  let result;

  // 1. LibreTranslate — основной движок
  for (const url of LIBRE_INSTANCES) {
    if (await isHealthy(url)) {
      result = await tryLibre(text, sourceLang, url);
      if (result) return cache(result);
    }
  }

  // 2. MyMemory — резерв (с принудительным he|en для иврита)
  result = await tryMyMemory(text, sourceLang);
  if (result) return cache(result);

  return null;

  function cache(res) {
    CACHE.set(cacheKey, res);
    return res;
  }
}

// Health-check
async function isHealthy(baseUrl) {
  try {
    await axiosInstance.get(baseUrl.replace('/translate', '/languages'), { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// LibreTranslate с retry
async function tryLibre(text, source, url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await axiosInstance.post(url, {
        q: text,
        source,
        target: 'en',
        format: 'text'
      }, { timeout: 10000 });

      const translated = res.data?.translatedText?.trim();
      if (translated && translated !== text && translated.length > 5 && !isGarbage(translated)) {
        return { text: translated, sourceLang: source === 'auto' ? 'he' : source };
      }
    } catch (err) {
      if (DEBUG && i === 2) console.log(`Libre failed (${url.split('/')[2]}): ${err.message}`);
      if (err.response?.status !== 502 && err.response?.status !== 429) break;
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
  return null;
}

// MyMemory — только как последний резерв
async function tryMyMemory(text, source) {
  try {
    const pair = source === 'he' ? 'he|en' : 'auto|en';
    const res = await axiosInstance.get(MYMEMORY_URL, {
      params: { q: text, langpair: pair, key: MYMEMORY_KEY || undefined }
    });
    const translated = res.data.responseData?.translatedText?.trim();
    if (translated && translated !== text && translated.length > 5 && !isGarbage(translated)) {
      return { text: translated, sourceLang: source === 'auto' ? 'he' : source };
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
    console.error('Ошибка создания нотса:', err.response?.data || err.message);
  }
}

// ========================= ЗАПУСК =========================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Автопереводчик запущен!`);
  console.log(`→ Порог перевода: ${MIN_WORDS_FOR_TRANSLATION} слов(а)`);
  console.log(`→ Статус: ${ENABLED ? 'ВКЛЮЧЁН' : 'ВЫКЛЮЧЕН'}`);
  console.log(`→ Порт: ${PORT}`);
});
