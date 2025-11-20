import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import http from 'http';
import dotenv from 'dotenv';
import NodeCache from 'node-cache';
import { franc } from 'franc'; // вернёмся к обычному franc — он стабильнее

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

// РАБОЧИЕ БЕСПЛАТНЫЕ ПЕРЕВОДЧИКИ (актуально на ноябрь 2025)
const LIBRE_APIS = [
  'https://libretranslate.de/translate',        // самый стабильный
  'https://translate.argosopentech.com/translate',
  'https://translate.terraprint.co/translate',
  'https://libretranslate.p.rapidapi.com/translate', // если захочешь потом платный
  // 'https://translate.fedilab.app/translate'   // оставляем как крайний резерв
];

const INTERCOM_API_VERSION = '2.11';
const REQUEST_TIMEOUT = 8000;

const CACHE = new NodeCache({ stdTTL: 24 * 3600, checkperiod: 600 });
const PROCESSED = new NodeCache({ stdTTL: 3600 }); // антиспам дублей

const axiosInstance = axios.create({
  timeout: REQUEST_TIMEOUT,
  httpAgent: new http.Agent({ keepAlive: true })
});

// ========================= УТИЛИТЫ =========================
const LANG_MAP = {
  eng: 'en', rus: 'ru', ukr: 'uk', spa: 'es', deu: 'de', fra: 'fr',
  ita: 'it', por: 'pt', pol: 'pl', ces: 'cs', nld: 'nl', tur: 'tr',
  ara: 'ar', cmn: 'zh', yue: 'zh', kor: 'ko', jpn: 'ja', hin: 'hi'
};

function cleanText(text = '') {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/license849 key[:\s]*[a-f0-9]{32}/gi, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGarbage(text, original) {
  if (!text || text.includes('@@') || text.includes('mainstre')) return true;
  if (text.length > original.length * 5) return true;
  const words = text.toLowerCase().split(/\s+/);
  const count = {};
  for (const w of words) {
    if (w.length < 3) continue;
    count[w] = (count[w] || 0) + 1;
    if (count[w] > 8) return true;
  }
  return false;
}

function extractMessageText(conv) {
  const parts = conv.conversation_parts?.conversation_parts || [];
  const userParts = parts
    .filter(p => ['user', 'lead', 'contact'].includes(p.author?.type) && p.part_type === 'comment' && p.body)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

  return cleanText(userParts[0]?.body || conv.source?.body || '');
}

// ========================= ПЕРЕВОД =========================
async function translateMessage(text, hintLang = 'auto') {
  if (text.length > 4800) text = text.substring(0, 4800);

  let source = 'auto';
  if (hintLang && hintLang !== 'auto') {
    source = LANG_MAP[hintLang] || hintLang.split('-')[0];
  }

  // franc как fallback
  if (source === 'auto') {
    const code = franc(text, { minLength: 3 });
    source = LANG_MAP[code] || 'auto';
  }

  if (source !== 'auto' && (SKIP_LANGS.has(source) || source === TARGET_LANG)) {
    return null;
  }

  const cacheKey = `tr:${text.substring(0, 100)}:${source}:${TARGET_LANG}`;
  if (CACHE.has(cacheKey)) return CACHE.get(cacheKey);

  // 1. Попробуем рабочие LibreTranslate
  for (const url of LIBRE_APIS) {
    try {
      const res = await axiosInstance.post(url, {
        q: text,
        source: source === 'auto' ? 'auto' : source,
        target: TARGET_LANG,
        format: 'text'
      }, { timeout: 7000 });

      const translated = res.data?.translatedText || res.data?.translation;
      if (translated && !isGarbage(translated, text) && translated.trim() !== text.trim()) {
        const finalSrc = (res.data.detectedLanguage?.language || source).toLowerCase();
        if (finalSrc !== TARGET_LANG && !SKIP_LANGS.has(finalSrc)) {
          const result = { text: translated.trim(), sourceLang: finalSrc, targetLang: TARGET_LANG };
          CACHE.set(cacheKey, result);
          return result;
        }
      }
    } catch (e) {
      if (DEBUG) console.log(`Libre failed: ${url.split('/')[2]}`, e.message);
    }
  }

  // 2. MyMemory как последний резерв
  if (MYMEMORY_KEY || text.split('\n').length === 1) {
    try {
      const pair = source === 'auto' ? 'auto|en' : `${source}|en`;
      const res = await axiosInstance.get('https://api.mymemory.translated.net/get', {
        params: { q: text, langpair: pair, key: MYMEMORY_KEY || undefined }
      });
      const translated = res.data.responseData?.translatedText;
      if (translated && !isGarbage(translated, text) && translated !== text) {
        const result = { text: translated, sourceLang: source === 'auto' ? 'auto' : source, targetLang: 'en' };
        CACHE.set(cacheKey, result);
        return result;
      }
    } catch (e) {
      if (DEBUG) console.log('MyMemory failed:', e.message);
    }
  }

  return null;
}

// ========================= ОСНОВНОЙ ХЕНДЛЕР =========================
app.post('/intercom-webhook', async (req, res) => {
  res.sendStatus(200);
  if (!ENABLED) return;

  try {
    const { topic, data } = req.body;
    if (!['conversation.user.replied', 'conversation.user.created'].includes(topic)) return;

    const convId = data.item?.id;
    if (!convId) return;

    const text = extractMessageText(data.item);
    if (!text || text.length < 5) return;

    // Антидубликат по хэшу
    const hash = `${convId}:${text.substring(0, 60)}`;
    if (PROCESSED.has(hash)) return;
    PROCESSED.set(hash, true);

    const translation = await translateMessage(text);
    if (!translation) return;

    const note = `Auto-translation (${translation.sourceLang} to en): ${translation.text}`;
    await axiosInstance.post(
      `https://api.intercom.io/conversations/${convId}/reply`,
      { message_type: 'note', admin_id: ADMIN_ID, body: note },
      { headers: { Authorization: INTERCOM_TOKEN, 'Intercom-Version': INTERCOM_API_VERSION } }
    );

    console.log(`Переведено [${translation.sourceLang} to en] — ${convId}`);
  } catch (err) {
    console.error('Ошибка:', err.message);
  }
});

app.get('/intercom-webhook', (_, res) => res.send('OK'));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Автопереводчик работает на порту ${PORT}`));
