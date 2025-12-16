import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import http from 'http';
import dotenv from 'dotenv';
import NodeCache from 'node-cache';
import crypto from 'node:crypto';

dotenv.config();

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));  // ← Исправлено: одна скобка

// ========================= CONFIG =========================
const INTERCOM_TOKEN = `Bearer ${process.env.INTERCOM_TOKEN}`;
const ADMIN_ID = process.env.ADMIN_ID;

const DEEPL_KEY = process.env.DEEPL_KEY?.trim();
const MICROSOFT_KEY = process.env.MICROSOFT_KEY?.trim();
const MYMEMORY_KEY = process.env.MYMEMORY_KEY?.trim() || '';

const ENABLED = process.env.ENABLED === 'true';
const DEBUG = process.env.DEBUG === 'true';

const TARGET_LANG = 'en';
const SKIP_LANGS = ['en', 'ru', 'uk'];
const MIN_WORDS_FOR_TRANSLATION = 3;

const INTERCOM_API_VERSION = '2.11';
const INTERCOM_API_BASE = 'https://api.intercom.io';

const CACHE = new NodeCache({ stdTTL: 4 * 3600, checkperiod: 600 });
const PROCESSED = new NodeCache({ stdTTL: 300, checkperiod: 120 });

const axiosInstance = axios.create({
  timeout: 15000,
  httpAgent: new http.Agent({ keepAlive: true }),
  headers: { 'User-Agent': 'IntercomAutoTranslate/8.1' }
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
  return lower.includes('@@') || lower.includes('invalid') || 
         lower.includes('error') || lower.includes('translation not found') ||
         lower.includes('mymemory');
}

// Простое сравнение похожести (достаточно для английского)
function isProbablyEnglish(original, translated) {
  const o = original.toLowerCase().replace(/[^\w\s]/g, '');
  const t = translated.toLowerCase().replace(/[^\w\s]/g, '');
  if (o.length === 0) return true;
  const maxLen = Math.max(o.length, t.length);
  let diffCount = 0;
  for (let i = 0; i < Math.min(o.length, t.length); i++) {
    if (o[i] !== t[i]) diffCount++;
  }
  diffCount += Math.abs(o.length - t.length);
  const similarity = 1 - diffCount / maxLen;
  return similarity > 0.85; // >85% совпадений → английский
}

// ========================= ИЗВЛЕЧЕНИЕ ТЕКСТА =========================
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
    if (DEBUG) console.log(`[SKIP LANG] Язык ${langCode} пропущен`);
    return null;
  }

  const cacheKey = `tr:${langCode}:${text.substring(0, 150)}`;
  if (CACHE.has(cacheKey)) {
    const cached = CACHE.get(cacheKey);
    if (cached === 'english') {
      if (DEBUG) console.log('[CACHE ENGLISH]');
      return null;
    }
    if (DEBUG) console.log('[CACHE HIT]');
    return cached;
  }

  let result = null;

  if (DEEPL_KEY) {
    if (DEBUG) console.log('[TRY DEEPL]');
    result = await tryDeepL(text);
    if (result && isProbablyEnglish(text, result.text)) {
      if (DEBUG) console.log('[SKIP ENGLISH] DeepL вернул почти оригинал');
      CACHE.set(cacheKey, 'english');
      return null;
    }
    if (result) {
      CACHE.set(cacheKey, result);
      return result;
    }
  }

  if (MICROSOFT_KEY) {
    if (DEBUG) console.log('[TRY MICROSOFT]');
    result = await tryMicrosoft(text);
    if (result && isProbablyEnglish(text, result.text)) {
      if (DEBUG) console.log('[SKIP ENGLISH] Microsoft вернул почти оригинал');
      CACHE.set(cacheKey, 'english');
      return null;
    }
    if (result) {
      CACHE.set(cacheKey, result);
      return result;
    }
  }

  if (DEBUG) console.log('[TRY MYMEMORY]');
  result = await tryMyMemory(text);
  if (result && isProbablyEnglish(text, result.text)) {
    if (DEBUG) console.log('[SKIP ENGLISH] MyMemory вернул почти оригинал');
    CACHE.set(cacheKey, 'english');
    return null;
  }
  if (result) {
    CACHE.set(cacheKey, result);
    return result;
  }

  return null;
}

async function tryDeepL(text) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axiosInstance.post('https://api-free.deepl.com/v2/translate', null, {
        params: { auth_key: DEEPL_KEY, text, target_lang: 'EN', preserve_formatting: 1 },
        timeout: 12000
      });
      const tr = res.data?.translations?.[0];
      const translated = tr?.text?.trim();
      const sourceLang = tr?.detected_source_language?.toLowerCase() || 'auto';
      if (translated && translated.length > 3 && !isGarbage(translated)) {
        if (DEBUG) console.log(`[DEEPL OK] ${sourceLang} → en`);
        return { text: translated, sourceLang };
      }
    } catch (err) {
      const status = err.response?.status;
      if (DEBUG) console.log(`[DEEPL ERROR] попытка ${attempt}: ${err.message} (${status || 'нет'})`);
      if (status === 456) return null;
    }
  }
  return null;
}

async function tryMicrosoft(text) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axiosInstance.post(
        'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=en',
        [{ Text: text }],
        {
          headers: {
            'Ocp-Apim-Subscription-Key': MICROSOFT_KEY,
            'Ocp-Apim-Subscription-Region': 'westeurope',
            'Content-Type': 'application/json'
          },
          timeout: 12000
        }
      );
      const tr = res.data[0]?.translations[0];
      const translated = tr?.text?.trim();
      const sourceLang = res.data[0]?.detectedLanguage?.language || 'auto';
      if (translated && translated.length > 3 && !isGarbage(translated)) {
        if (DEBUG) console.log(`[MICROSOFT OK] ${sourceLang} → en`);
        return { text: translated, sourceLang };
      }
    } catch (err) {
      const status = err.response?.status;
      if (DEBUG) console.log(`[MICROSOFT ERROR] попытка ${attempt}: ${err.message} (${status || 'нет'})`);
    }
  }
  return null;
}

async function tryMyMemory(text) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await axiosInstance.get('https://api.mymemory.translated.net/get', {
        params: { q: text, langpair: 'auto|en', key: MYMEMORY_KEY || undefined },
        timeout: 10000
      });
      const translated = res.data.responseData?.translatedText?.trim();
      if (translated && translated.length > 3 && !isGarbage(translated)) {
        if (DEBUG) console.log('[MYMEMORY OK]');
        return { text: translated, sourceLang: 'auto' };
      }
    } catch (err) {
      if (DEBUG) console.log(`[MYMEMORY ERROR] попытка ${attempt}: ${err.message}`);
    }
  }
  return null;
}

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
    if (!translation) return;

    await createNote(convId, translation);
    console.log(`[SUCCESS] Переведено [${translation.sourceLang}→en] — ${convId}`);
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Автопереводчик v8.1 запущен и готов!`);
  console.log(`→ DeepL: ${DEEPL_KEY ? 'ВКЛ' : 'ВЫКЛ'}`);
  console.log(`→ Microsoft (westeurope): ${MICROSOFT_KEY ? 'ВКЛ' : 'ВЫКЛ'}`);
  console.log(`→ Порт: ${PORT}`);
});
