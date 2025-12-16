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
const DEEPL_KEY = process.env.DEEPL_KEY; // Обязательно! Получи на deepl.com
const MYMEMORY_KEY = process.env.MYMEMORY_KEY || ''; // Опционально, для fallback
const ENABLED = process.env.ENABLED === 'true';
const DEBUG = process.env.DEBUG === 'true';
const TARGET_LANG = 'EN-US'; // DeepL любит EN-US/EN-GB, но EN тоже работает
const SKIP_LANGS = ['en', 'ru', 'uk'];
const MIN_WORDS_FOR_TRANSLATION = 3;
const INTERCOM_API_VERSION = '2.11';
const INTERCOM_API_BASE = 'https://api.intercom.io';

const CACHE = new NodeCache({ stdTTL: 4 * 3600, checkperiod: 600 });
const PROCESSED = new NodeCache({ stdTTL: 300, checkperiod: 120 });

const axiosInstance = axios.create({
  timeout: 15000,
  httpAgent: new http.Agent({ keepAlive: true }),
  headers: { 'User-Agent': 'IntercomAutoTranslate/4.0' }
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
  return lower.includes('@@') || lower.includes('invalid') || lower.includes('error');
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

  const langCode = detectedLang.toLowerCase();
  if (SKIP_LANGS.includes(langCode)) {
    if (DEBUG) console.log(`[SKIP LANG] ${langCode}`);
    return null;
  }

  const cacheKey = `tr:${langCode}:${text.substring(0, 150)}`;
  if (CACHE.has(cacheKey)) {
    if (DEBUG) console.log('[CACHE HIT]');
    return CACHE.get(cacheKey);
  }

  let result = null;

  // 1. DeepL — основной (лучшее качество)
  if (DEEPL_KEY) {
    if (DEBUG) console.log('[TRY DEEPL]');
    result = await tryDeepL(text);
    if (result) {
      CACHE.set(cacheKey, result);
      return result;
    }
  } else {
    console.warn('DEEPL_KEY не задан — DeepL пропущен');
  }

  // 2. MyMemory fallback
  if (DEBUG) console.log('[TRY MYMEMORY]');
  result = await tryMyMemory(text);
  if (result) {
    CACHE.set(cacheKey, result);
    return result;
  }

  if (DEBUG) console.log('[FAIL] Все переводчики не сработали');
  return null;
}

async function tryDeepL(text) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axiosInstance.post('https://api-free.deepl.com/v2/translate', null, {
        params: {
          auth_key: DEEPL_KEY,
          text,
          target_lang: TARGET_LANG.split('-')[0].toUpperCase(),
          tag_handling: 'xml',
          ignore_tags: 'a,url'
        }
      });

      const translated = res.data?.translations?.[0]?.text?.trim();
      const sourceLang = res.data?.translations?.[0]?.detected_source_language?.toLowerCase();

      if (translated && translated !== text && !isGarbage(translated)) {
        return { text: translated, sourceLang: sourceLang || 'auto' };
      }
    } catch (err) {
      if (DEBUG) console.log(`[DEEPL ERROR] attempt ${attempt}: ${err.message} ${err.response?.status || ''}`);
      if (err.response?.status === 429 || err.response?.status >= 500) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }
  return null;
}

async function tryMyMemory(text) {
  // (тот же код, что был раньше — оставляю как резерв)
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await axiosInstance.get('https://api.mymemory.translated.net/get', {
        params: { q: text, langpair: 'auto|en', key: MYMEMORY_KEY || undefined },
        timeout: 10000
      });

      const translated = res.data.responseData?.translatedText?.trim();
      if (translated && translated !== text && !isGarbage(translated)) {
        return { text: translated, sourceLang: 'auto' };
      }
    } catch (err) {
      if (DEBUG) console.log(`[MYMEMORY ERROR] attempt ${attempt}: ${err.message}`);
    }
  }
  return null;
}

// ========================= НОТС + ХЕНДЛЕР =========================
// (тот же код, что в предыдущей версии — работает отлично)

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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Автопереводчик v4 (DeepL) запущен!`);
  console.log(`→ DeepL ключ: ${DEEPL_KEY ? 'ЗАДАН' : 'НЕ ЗАДАН — НЕ БУДЕТ РАБОТАТЬ!'}`);
  console.log(`→ Статус: ${ENABLED ? 'ВКЛ' : 'ВЫКЛ'}`);
  console.log(`→ Порт: ${PORT}`);
});
