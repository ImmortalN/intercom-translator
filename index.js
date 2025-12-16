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
  headers: { 'User-Agent': 'IntercomAutoTranslate/7.0' }
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
    if (DEBUG) console.log('[CACHE HIT] Перевод из кэша');
    return CACHE.get(cacheKey);
  }

  let result = null;

  // 1. DeepL
  if (DEEPL_KEY) {
    if (DEBUG) console.log('[TRY DEEPL]');
    result = await tryDeepL(text);
    if (result) return cacheResult(result);
  }

  // 2. Microsoft Translator (с регионом westeurope)
  if (MICROSOFT_KEY) {
    if (DEBUG) console.log('[TRY MICROSOFT]');
    result = await tryMicrosoft(text);
    if (result) return cacheResult(result);
  }

  // 3. MyMemory
  if (DEBUG) console.log('[TRY MYMEMORY]');
  result = await tryMyMemory(text);
  if (result) return cacheResult(result);

  if (DEBUG) console.log('[FAIL] Ни один переводчик не справился');
  return null;

  function cacheResult(res) {
    CACHE.set(cacheKey, res);
    return res;
  }
}

// DeepL
async function tryDeepL(text) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axiosInstance.post('https://api-free.deepl.com/v2/translate', null, {
        params: {
          auth_key: DEEPL_KEY,
          text,
          target_lang: 'EN',
          preserve_formatting: 1
        },
        timeout: 12000
      });

      const tr = res.data?.translations?.[0];
      const translated = tr?.text?.trim();
      const sourceLang = tr?.detected_source_language?.toLowerCase() || 'auto';

      if (translated && translated !== text && !isGarbage(translated)) {
        if (DEBUG) console.log(`[DEEPL OK] ${sourceLang} → en`);
        return { text: translated, sourceLang };
      }
    } catch (err) {
      const status = err.response?.status;
      if (DEBUG) console.log(`[DEEPL ERROR] попытка ${attempt}: ${err.message} (${status || 'нет'})`);
      if (status === 456) return null; // Лимит исчерпан
    }
  }
  return null;
}

// Microsoft Translator — ИСПРАВЛЕНО: добавлен регион westeurope
async function tryMicrosoft(text) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axiosInstance.post(
        'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=en',
        [{ Text: text }],
        {
          headers: {
            'Ocp-Apim-Subscription-Key': MICROSOFT_KEY,
            'Ocp-Apim-Subscription-Region': 'westeurope',  // ← Фикс ошибки 401
            'Content-Type': 'application/json'
          },
          timeout: 12000
        }
      );

      const tr = res.data[0]?.translations[0];
      const translated = tr?.text?.trim();
      const sourceLang = res.data[0]?.detectedLanguage?.language || 'auto';

      if (translated && translated !== text && !isGarbage(translated)) {
        if (DEBUG) console.log(`[MICROSOFT OK] ${sourceLang} → en`);
        return { text: translated, sourceLang };
      }
    } catch (err) {
      const status = err.response?.status;
      if (DEBUG) console.log(`[MICROSOFT ERROR] попытка ${attempt}: ${err.message} (${status || 'нет'})`);
      if (status === 429 || status >= 500) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }
  return null;
}

// MyMemory
async function tryMyMemory(text) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await axiosInstance.get('https://api.mymemory.translated.net/get', {
        params: {
          q: text,
          langpair: 'auto|en',
          key: MYMEMORY_KEY || undefined
        },
        timeout: 10000
      });

      const translated = res.data.responseData?.translatedText?.trim();
      if (translated && translated !== text && !isGarbage(translated)) {
        if (DEBUG) console.log('[MYMEMORY OK]');
        return { text: translated, sourceLang: 'auto' };
      }
    } catch (err) {
      if (DEBUG) console.log(`[MYMEMORY ERROR] попытка ${attempt}: ${err.message}`);
    }
  }
  return null;
}

// ========================= НОТА В INTERCOM =========================
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

// ========================= WEBHOOK =========================
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

// ========================= ЗАПУСК =========================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Автопереводчик v7 (с westeurope) запущен!`);
  console.log(`→ DeepL: ${DEEPL_KEY ? 'ВКЛ' : 'ВЫКЛ'}`);
  console.log(`→ Microsoft: ${MICROSOFT_KEY ? 'ВКЛ (регион westeurope)' : 'ВЫКЛ'}`);
  console.log(`→ MyMemory: ${MYMEMORY_KEY ? 'ВКЛ с ключом' : 'ВКЛ без ключа'}`);
  console.log(`→ Статус: ${ENABLED ? 'АКТИВЕН' : 'ВЫКЛЮЧЕН'}`);
  console.log(`→ Порт: ${PORT}`);
});
