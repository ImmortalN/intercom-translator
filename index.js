import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import http from 'http';
import dotenv from 'dotenv';
import NodeCache from 'node-cache';
import crypto from 'node:crypto';
import { franc } from 'franc';  // npm i franc

dotenv.config();

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));

// ========================= CONFIG =========================
const INTERCOM_TOKEN = `Bearer ${process.env.INTERCOM_TOKEN?.trim()}`;
const ADMIN_ID = process.env.ADMIN_ID?.trim();
const DEEPL_KEY = process.env.DEEPL_KEY?.trim();
const MICROSOFT_KEY = process.env.MICROSOFT_KEY?.trim();
const MICROSOFT_REGION = process.env.MICROSOFT_REGION?.trim() || 'westeurope';
const MYMEMORY_KEY = process.env.MYMEMORY_KEY?.trim();       // платный ключ, если есть
const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL?.trim();   // для бесплатного лимита 50k/день

const ENABLED = process.env.ENABLED === 'true';
const DEBUG = process.env.DEBUG === 'true';
const TARGET_LANG = 'en';
const SKIP_LANGS = new Set(['en', 'ru', 'uk']);
const MIN_WORDS_FOR_TRANSLATION = 3;
const INTERCOM_API_VERSION = '2.11';
const INTERCOM_API_BASE = 'https://api.intercom.io';

const CACHE = new NodeCache({ stdTTL: 4 * 3600, checkperiod: 600 });
const PROCESSED = new NodeCache({ stdTTL: 300, checkperiod: 120 });

const axiosInstance = axios.create({
  timeout: 15000,
  httpAgent: new http.Agent({ keepAlive: true }),
  headers: { 'User-Agent': 'IntercomAutoTranslate/8.3' }
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

function isProbablyEnglish(original, translated) {
  const o = original.toLowerCase().replace(/[^\w\s]/g, '');
  const t = translated.toLowerCase().replace(/[^\w\s]/g, '');
  if (o.length < 5 || t.length < 5) return false;
  const maxLen = Math.max(o.length, t.length);
  let diffCount = Math.abs(o.length - t.length);
  for (let i = 0; i < Math.min(o.length, t.length); i++) {
    if (o[i] !== t[i]) diffCount++;
  }
  const similarity = 1 - diffCount / maxLen;
  return similarity > 0.88;
}

// ========================= ИЗВЛЕЧЕНИЕ + ОПРЕДЕЛЕНИЕ ЯЗЫКА =========================
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

function detectLanguageFallback(text) {
  const code = franc(text, { minLength: 4 });
  return code === 'und' ? 'auto' : (code === 'eng' ? 'en' : code.slice(0, 2));
}

// ========================= ПЕРЕВОД =========================
async function translate(text, preferredLang = 'auto') {
  if (text.length > 5000) text = text.substring(0, 5000);

  let langCode = preferredLang.toLowerCase();
  if (langCode === 'auto') langCode = detectLanguageFallback(text);

  if (SKIP_LANGS.has(langCode)) {
    if (DEBUG) console.log(`[SKIP LANG] ${langCode}`);
    return null;
  }

  const cacheKey = `tr:${langCode}:${text.substring(0, 150)}`;
  if (CACHE.has(cacheKey)) {
    const cached = CACHE.get(cacheKey);
    if (cached === 'english') return null;
    if (DEBUG) console.log('[CACHE HIT]');
    return cached;
  }

  let result = null;

  // 1. DeepL (теперь с правильным заголовком — обязательно!)
  if (DEEPL_KEY) {
    if (DEBUG) console.log('[TRY DEEPL]');
    result = await tryDeepL(text);
    if (result) {
      if (isProbablyEnglish(text, result.text)) {
        if (DEBUG) console.log('[SKIP ENGLISH] DeepL вернул почти оригинал');
        CACHE.set(cacheKey, 'english');
        return null;
      }
      CACHE.set(cacheKey, result);
      return result;
    }
  }

  // 2. Microsoft
  if (MICROSOFT_KEY) {
    if (DEBUG) console.log('[TRY MICROSOFT]');
    result = await tryMicrosoft(text);
    if (result) {
      if (isProbablyEnglish(text, result.text)) {
        if (DEBUG) console.log('[SKIP ENGLISH] Microsoft вернул почти оригинал');
        CACHE.set(cacheKey, 'english');
        return null;
      }
      CACHE.set(cacheKey, result);
      return result;
    }
  }

  // 3. MyMemory
  if (DEBUG) console.log('[TRY MYMEMORY]');
  result = await tryMyMemory(text);
  if (result) {
    if (isProbablyEnglish(text, result.text)) {
      if (DEBUG) console.log('[SKIP ENGLISH] MyMemory вернул почти оригинал');
      CACHE.set(cacheKey, 'english');
      return null;
    }
    CACHE.set(cacheKey, result);
    return result;
  }

  return null;
}

async function tryDeepL(text) {
  try {
    const res = await axiosInstance.post('https://api-free.deepl.com/v2/translate', {
      text: [text],
      target_lang: 'EN',
      preserve_formatting: true
    }, {
      headers: {
        'Authorization': `DeepL-Auth-Key ${DEEPL_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const tr = res.data?.translations?.[0];
    const translated = tr?.text?.trim();
    if (translated && translated.length > 3 && !isGarbage(translated)) {
      const src = tr?.detected_source_language?.toLowerCase() || 'auto';
      if (DEBUG) console.log(`[DEEPL OK] ${src} → en`);
      return { text: translated, sourceLang: src };
    }
  } catch (err) {
    const status = err.response?.status;
    if (DEBUG) console.log(`[DEEPL ERR] ${err.message} (${status || 'нет'})`);
    if (status === 456) console.log('[DEEPL] Квота исчерпана — месяц подождать');
  }
  return null;
}

async function tryMicrosoft(text) {
  try {
    const res = await axiosInstance.post(
      `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=en`,
      [{ Text: text }],
      {
        headers: {
          'Ocp-Apim-Subscription-Key': MICROSOFT_KEY,
          'Ocp-Apim-Subscription-Region': MICROSOFT_REGION,
          'Content-Type': 'application/json'
        }
      }
    );

    const tr = res.data?.[0]?.translations?.[0];
    const translated = tr?.text?.trim();
    if (translated && translated.length > 3 && !isGarbage(translated)) {
      const src = res.data[0]?.detectedLanguage?.language?.toLowerCase() || 'auto';
      if (DEBUG) console.log(`[MICROSOFT OK] ${src} → en`);
      return { text: translated, sourceLang: src };
    }
  } catch (err) {
    const status = err.response?.status;
    if (DEBUG) console.log(`[MICROSOFT ERR] ${err.message} (${status || 'нет'})`);
    if (status === 401) console.log('[MICROSOFT] 401 — проверь ключ и регион в Azure Portal');
    if (status === 429) console.log('[MICROSOFT] 429 — rate limit, подожди 5–10 мин');
  }
  return null;
}

async function tryMyMemory(text) {
  try {
    const params = { q: text, langpair: 'auto|en' };

    if (MYMEMORY_KEY) {
      params.key = MYMEMORY_KEY;
      if (DEBUG) console.log('[MYMEMORY] Используем платный key');
    } else if (MYMEMORY_EMAIL) {
      params.de = MYMEMORY_EMAIL;
      if (DEBUG) console.log('[MYMEMORY] Используем email для повышенного лимита');
    } else {
      if (DEBUG) console.log('[MYMEMORY] Анонимный режим — лимит очень низкий');
    }

    const res = await axiosInstance.get('https://api.mymemory.translated.net/get', { params });

    const translated = res.data?.responseData?.translatedText?.trim();
    if (translated && translated.length > 3 && !isGarbage(translated)) {
      if (DEBUG) console.log('[MYMEMORY OK]');
      return { text: translated, sourceLang: 'auto' };
    }
  } catch (err) {
    const status = err.response?.status;
    if (DEBUG) console.log(`[MYMEMORY ERR] ${err.message} (${status || 'нет'})`);
    if (status === 429) console.log('[MYMEMORY] 429 — дневной лимит исчерпан, новая почта или подожди до завтра');
  }
  return null;
}

// ========================= СОЗДАНИЕ NOTE =========================
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
    console.error('Note creation error:', err.response?.data || err.message);
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

    const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount < MIN_WORDS_FOR_TRANSLATION) {
      if (DEBUG) console.log(`[SKIP SHORT] ${wordCount} слов`);
      return;
    }

    const textHash = crypto.createHash('md5').update(text).digest('hex').slice(0, 8);
    const key = `${convId}:${textHash}`;
    if (PROCESSED.has(key)) return;
    PROCESSED.set(key, true);

    const intercomLang = conv.language_override || conv.source?.language || 'auto';
    if (DEBUG) console.log(`[REQ] ${wordCount} слов | Lang: ${intercomLang} | "${text.substring(0, 80)}..."`);

    const translation = await translate(text, intercomLang);
    if (!translation) return;

    await createNote(convId, translation);
    console.log(`[OK] Переведено [${translation.sourceLang}→en] — ${convId}`);
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Автопереводчик v8.3 запущен`);
  console.log(`→ DeepL: ${DEEPL_KEY ? 'ВКЛ (новый auth)' : 'ВЫКЛ'}`);
  console.log(`→ Microsoft (${MICROSOFT_REGION}): ${MICROSOFT_KEY ? 'ВКЛ' : 'ВЫКЛ'}`);
  console.log(`→ MyMemory: ${MYMEMORY_KEY ? 'с ключом' : MYMEMORY_EMAIL ? 'с email' : 'анонимно'}`);
  console.log(`→ Порт: ${PORT}`);
});
