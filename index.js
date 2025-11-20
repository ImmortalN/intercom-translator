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

const INTERCOM_API_VERSION = '2.11';
const INTERCOM_API_BASE = 'https://api.intercom.io';

// Максимально полный список стабильных бесплатных инстансов LibreTranslate (ноябрь 2025)
const LIBRE_INSTANCES = [
  'https://libretranslate.de/translate',              // Самый стабильный
  'https://translate.argosopentech.com/translate',    // Хороший для иврита
  'https://translate.terraprint.co/translate',        // Стабильный
  'https://translate.flossboxin.org.in/translate',    // Без ключа
  'https://translate.astian.org/translate',           // Альтернатива
  'https://translate.mentality.rip/translate',        // Дополнительный
  'https://libretranslate.pussthecat.org/translate',  // Дополнительный
  'https://translate.fedilab.app/translate'           // Резерв
];

const MYMEMORY_URL = 'https://api.mymemory.translated.net/get';

const CACHE = new NodeCache({ stdTTL: 3600, checkperiod: 120 });
const PROCESSED = new NodeCache({ stdTTL: 60, checkperiod: 60 });

const axiosInstance = axios.create({
  timeout: 12000,
  httpAgent: new http.Agent({ keepAlive: true }),
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IntercomTranslateBot/2.0)' }
});

// Маппинг языков Intercom → ISO
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
         (text.length > 300 && text.split(' ').length < 10);
}

// Функция для проверки, является ли перевод транслитом (простая евристика)
function isTranslit(original, translated) {
  // Для иврита: если перевод содержит только latin буквы, похожие на транслит
  if (/[\u0590-\u05FF]/.test(original) && /^[a-zA-Z\s.,!?-]+$/.test(translated)) {
    return true;
  }
  return false;
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

    const textHash = crypto.createHash('md5').update(conv.body || '').digest('hex').slice(0, 8);
    const key = `${convId}:${textHash}`;
    if (PROCESSED.has(key)) return;
    PROCESSED.set(key, true);

    const text = extractTextFromWebhook(conv, topic);
    if (!text || text.length < 3) return;

    const intercomLang = conv.language_override ||
                         conv.source?.language ||
                         conv.custom_attributes?.Language ||
                         'auto';

    if (DEBUG) console.log(`[ID:${convId}] Lang: ${intercomLang} | Text: ${text}`);

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

// ========================= ПЕРЕВОД =========================
async function translate(text, detectedLang) {
  if (text.length > 5000) text = text.substring(0, 5000);

  const langCode = LANG_MAP[detectedLang] || 'auto';
  if (SKIP_LANGS.includes(langCode) || langCode === TARGET_LANG) return null;

  const cacheKey = `tr:${langCode}:${text.substring(0, 120)}`;
  if (CACHE.has(cacheKey)) return CACHE.get(cacheKey);

  const isHebrew = /[\u0590-\u05FF]/.test(text);
  const sourceForAPI = isHebrew ? 'he' : (langCode === 'auto' ? 'auto' : langCode);

  let translationCandidates = [];

  // Параллельно пробуем все Libre (для максимальной надёжности)
  const promises = LIBRE_INSTANCES.map(async (url) => {
    if (await isHealthy(url)) {
      const result = await tryLibre(text, sourceForAPI, url);
      if (result && !isTranslit(text, result.text)) {
        translationCandidates.push(result);
      }
    }
  });

  await Promise.all(promises);

  // Если есть кандидаты — выбираем самый длинный (лучший)
  if (translationCandidates.length > 0) {
    translationCandidates.sort((a, b) => b.text.length - a.text.length);
    return cache(translationCandidates[0]);
  }

  // MyMemory как резерв
  const myMemoryResult = await tryMyMemory(text, sourceForAPI);
  if (myMemoryResult && !isTranslit(text, myMemoryResult.text)) return cache(myMemoryResult);

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
    if (!translated || translated === text || isGarbage(translated)) return null;

    return { text: translated, sourceLang: source === 'auto' ? 'auto' : source };
  } catch (err) {
    if (DEBUG) console.log(`Libre ${url.split('/')[2]}: ${err.message}`);
    return null;
  }
}

async function tryMyMemory(text, source) {
  try {
    const pair = source === 'he' ? 'he|en' : (source === 'auto' ? 'auto|en' : `${source}|en`);
    const res = await axiosInstance.get(MYMEMORY_URL, {
      params: { q: text, langpair: pair, key: MYMEMORY_KEY || undefined }
    });

    const translated = res.data.responseData?.translatedText?.trim();
    if (translated && translated !== text && !isGarbage(translated)) {
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
  console.log(`Автопереводчик запущен на порту ${PORT} | ENABLED: ${ENABLED}`);
});
