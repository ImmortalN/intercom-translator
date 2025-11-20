import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import http from 'http';
import dotenv from 'dotenv';
import NodeCache from 'node-cache';
import { francAll } from 'franc-all';

dotenv.config();

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));

// ========================= CONFIG =========================
const INTERCOM_TOKEN = `Bearer ${process.env.INTERCOM_TOKEN}`;
const ADMIN_ID = process.env.ADMIN_ID;
const MYMEMORY_KEY = process.env.MYMEMORY_KEY || '';
const ENABLED = process.env.ENABLED === 'true';
const TARGET_LANG = 'en';
const SKIP_LANGS = ['en', 'ru', 'uk'];
const DEBUG = process.env.DEBUG === 'true';

const INTERCOM_API_VERSION = '2.11';
const INTERCOM_API_BASE = 'https://api.intercom.io';

// Рабочие переводчики (ноябрь 2025)
const PRIMARY_TRANSLATE_API_URL = 'https://libretranslate.de/translate';
const FALLBACK_TRANSLATE_APIS = [
  'https://translate.terraprint.co/translate',
  'https://libretranslate.eownerdead.dedyn.io/translate'
];
const MYMEMORY_TRANSLATE_API_URL = 'https://api.mymemory.translated.net/get';

const TRANSLATION_CACHE = new NodeCache({ stdTTL: 3600, checkperiod: 120, useClones: false });
const REQUEST_TIMEOUT = 10000;

// ← ИСПРАВЛЕНО: правильное создание axiosInstance
const axiosInstance = axios.create({
  timeout: REQUEST_TIMEOUT,
  httpAgent: new http.Agent({ keepAlive: true })
});

// Маппинг языков (включая полные названия из Intercom)
const LANG_MAP = {
  'en': 'en', 'ru': 'ru', 'uk': 'uk', 'es': 'es', 'de': 'de', 'fr': 'fr',
  'it': 'it', 'pt': 'pt', 'pl': 'pl', 'cs': 'cs', 'nl': 'nl', 'tr': 'tr',
  'ar': 'ar', 'zh': 'zh', 'ko': 'ko', 'ja': 'ja', 'he': 'he',
  'English': 'en', 'Russian': 'ru', 'Ukrainian': 'uk',
  'Spanish': 'es', 'German': 'de', 'French': 'fr',
  'Italian': 'it', 'Portuguese': 'pt', 'Polish': 'pl',
  'Czech': 'cs', 'Dutch': 'nl', 'Turkish': 'tr',
  'Arabic': 'ar', 'Chinese': 'zh', 'Chinese (Simplified)': 'zh',
  'Chinese (Traditional)': 'zh', 'Hebrew': 'he'
};

// Защита от мусора
function isGarbageTranslation(text) {
  if (!text || typeof text !== 'string') return true;
  const lower = text.toLowerCase();
  return lower.includes('@@') ||
         lower.includes('mainstre') ||
         lower.includes('invalid source language') ||
         lower.includes('mymemory_translate_api_url') ||
         lower.includes('is an invalid') ||
         lower.includes('example: langpair') ||
         (text.length > 300 && text.split(' ').length < 15);
}

// ========================= ХЕНДЛЕРЫ =========================
app.get('/intercom-webhook', (req, res) => res.status(200).send('OK'));

app.post('/intercom-webhook', async (req, res) => {
  res.sendStatus(200);
  if (!ENABLED) return;

  try {
    const { topic, data } = req.body;
    if (!['conversation.user.replied', 'conversation.user.created'].includes(topic)) return;

    const conversation = data?.item;
    const conversationId = conversation?.id;
    if (!conversationId) return;

    const fullConversation = await fetchMinimalConversation(conversationId);
    if (!fullConversation) return;

    const messageText = extractMessageText(fullConversation, topic);
    if (!messageText || messageText.length < 3) return;

    // Антидубль
    const prevKey = `prev:${conversationId}`;
    if (TRANSLATION_CACHE.get(prevKey) === messageText) return;

    let detectedLang = fullConversation?.language_override ||
                       fullConversation?.language ||
                       fullConversation?.custom_attributes?.Language ||
                       fullConversation?.source?.language ||
                       'auto';

    if (DEBUG) console.log('Intercom language:', detectedLang, '| Text:', messageText.substring(0, 80));

    const translation = await translateMessage(messageText, detectedLang);
    if (!translation) return;

    await createInternalNote(conversationId, translation);
    TRANSLATION_CACHE.set(prevKey, messageText);

    console.log(`Переведено [${translation.sourceLang}→en] — ${conversationId}`);
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

// ========================= ВСПОМОГАТЕЛЬНЫЕ =========================
async function fetchMinimalConversation(id) {
  try {
    const res = await axiosInstance.get(`${INTERCOM_API_BASE}/conversations/${id}`, {
      headers: {
        Authorization: INTERCOM_TOKEN,
        'Intercom-Version': INTERCOM_API_VERSION,
        Accept: 'application/json'
      }
    });
    return res.data;
  } catch (err) {
    console.error('Failed to fetch conversation:', err.message);
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
      .filter(p => ['user', 'contact', 'lead'].includes(p.author?.type) && p.body)
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
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ========================= ПЕРЕВОД =========================
async function translateMessage(text, detectedLang) {
  if (text.length > 5000) text = text.substring(0, 5000);

  // Приоритет — language_override из Intercom
  const mappedLang = LANG_MAP[detectedLang];
  if (mappedLang && (SKIP_LANGS.includes(mappedLang) || mappedLang === TARGET_LANG)) {
    if (DEBUG) console.log('Пропуск по language_override:', detectedLang);
    return null;
  }

  const cacheKey = `tr:${text.substring(0, 150)}:${mappedLang || 'auto'}`;
  if (TRANSLATION_CACHE.has(cacheKey)) return TRANSLATION_CACHE.get(cacheKey);

  // 1. Primary
  let result = await tryTranslateAPI(text, PRIMARY_TRANSLATE_API_URL);
  if (result) return cacheAndReturn(result);

  // 2. Fallbacks
  for (const url of FALLBACK_TRANSLATE_APIS) {
    result = await tryTranslateAPI(text, url);
    if (result) return cacheAndReturn(result);
  }

  // 3. MyMemory (только если не иврит и не редкие)
  if (!/[\u0590-\u05FF]/.test(text)) {
    result = await tryMyMemory(text);
    if (result) return cacheAndReturn(result);
  }

  return null;

  async function tryTranslateAPI(q, url) {
    try {
      const res = await axiosInstance.post(url, {
        q, source: 'auto', target: 'en', format: 'text'
      }, { timeout: 9000 });

      const translated = (res.data?.translatedText || '').trim();
      if (!translated || translated === q.trim() || isGarbageTranslation(translated)) return null;

      return { text: translated, sourceLang: 'auto', targetLang: 'en' };
    } catch (err) {
      if (DEBUG) console.log(`API ${url.split('/')[2]} failed:`, err.message);
      return null;
    }
  }

  async function tryMyMemory(q) {
    try {
      const res = await axiosInstance.get(MYMEMORY_TRANSLATE_API_URL, {
        params: { q, langpair: 'auto|en', key: MYMEMORY_KEY || undefined }
      });
      const translated = res.data.responseData?.translatedText?.trim();
      if (translated && !isGarbageTranslation(translated) && translated !== q.trim()) {
        return { text: translated, sourceLang: 'auto', targetLang: 'en' };
      }
    } catch (err) {
      if (DEBUG) console.log('MyMemory failed:', err.message);
    }
    return null;
  }

  function cacheAndReturn(result) {
    const final = { ...result, sourceLang: result.sourceLang || 'auto' };
    TRANSLATION_CACHE.set(cacheKey, final);
    return final;
  }
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
    console.error('Failed to create note:', err.message);
  }
}

// ========================= ЗАПУСК =========================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Автопереводчик запущен на порту ${PORT}`));
