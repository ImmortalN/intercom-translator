import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import dotenv from 'dotenv';
import { franc } from 'franc';  // Локальная детекция языка
import NodeCache from 'node-cache';  // Кэш с TTL

dotenv.config();

const app = express();
app.use(bodyParser.json());

// Configuration
const INTERCOM_TOKEN = `Bearer ${process.env.INTERCOM_TOKEN}`;
const ADMIN_ID = process.env.ADMIN_ID;
const ENABLED = process.env.ENABLED === 'true';
const TARGET_LANG = 'en';
const SKIP_LANGS = ['en', 'ru', 'uk'];
// Маппинг кодов franc (ISO 639-3) на наши (для ru/en/uk; другие можно добавить)
const LANG_MAP = {
  'eng': 'en',
  'rus': 'ru',
  'ukr': 'uk',
  // Добавьте другие если нужно, e.g., 'spa': 'es'
};
const INTERCOM_API_VERSION = '2.14';
const TRANSLATE_API_URL = 'https://translate.fedilab.app/translate';
const TRANSLATION_CACHE = new NodeCache({ stdTTL: 3600, checkperiod: 120 }); // TTL 1 час, проверка каждые 2 мин
const REQUEST_TIMEOUT = 3000; // Уменьшенный таймаут для скорости

// Проверка переменных окружения
if (!INTERCOM_TOKEN || INTERCOM_TOKEN === 'Bearer ') {
  console.error('Fatal: INTERCOM_TOKEN is missing or invalid');
  process.exit(1);
}
if (!ADMIN_ID) {
  console.error('Fatal: ADMIN_ID is missing');
  process.exit(1);
}
console.log('Server starting with ENABLED:', ENABLED, 'ADMIN_ID:', ADMIN_ID);

// Webhook verification
app.get('/intercom-webhook', (req, res) => {
  res.status(200).send('Webhook verified');
});

// Main webhook handler
app.post('/intercom-webhook', async (req, res) => {
  const start = Date.now();
  try {
    res.sendStatus(200); // Быстрый ответ

    if (!ENABLED) {
      console.log('Webhook processing disabled');
      return;
    }

    const { topic, data } = req.body;
    if (!['conversation.user.replied', 'conversation.user.created'].includes(topic)) {
      return;
    }

    const conversation = data?.item;
    const conversationId = conversation?.id;
    if (!conversationId) return;

    const messageText = extractMessageText(conversation);
    if (!messageText || messageText.length < 10 || messageText.split(' ').length < 3) {
      console.log('Skipping: message too short or empty');
      return;
    }

    if (conversation?.source?.author?.type === 'bot') return;

    const translation = await translateMessage(messageText);
    if (!translation) return;

    await createInternalNote(conversationId, translation);

    console.log(`Processed conversation ${conversationId} in ${Date.now() - start}ms`);
  } catch (error) {
    console.error('Webhook error:', error.message);
  }
});

// Extract message text
function extractMessageText(conversation) {
  const sources = [
    conversation?.source?.body,
    ... (conversation?.conversation_parts?.conversation_parts || []).map(part => part.body)
  ].filter(Boolean);

  for (const source of sources) {
    if (source) return cleanHtml(source);
  }
  return null;
}

// Clean HTML
function cleanHtml(text) {
  return text.replace(/<[^>]+>/g, '').trim();
}

// Translate with local lang detect + caching
async function translateMessage(text) {
  // Локальная детекция языка (быстро, оффлайн)
  const francCode = franc(text, { minLength: 3, whitelist: Object.keys(LANG_MAP) }); // Ограничить whitelist для скорости
  if (francCode === 'und') {
    console.log('Skipping: undetermined language');
    return null;
  }
  const sourceLang = LANG_MAP[francCode];
  if (!sourceLang || SKIP_LANGS.includes(sourceLang)) {
    console.log(`Skipping: source lang ${sourceLang} in skip list`);
    return null;
  }

  const cacheKey = `${text}:${TARGET_LANG}`;
  if (TRANSLATION_CACHE.has(cacheKey)) {
    console.log('Cache hit');
    return TRANSLATION_CACHE.get(cacheKey);
  }

  try {
    const response = await axios.post(
      TRANSLATE_API_URL,
      { q: text, source: sourceLang, target: TARGET_LANG, format: 'text' }, // Указываем source для точности
      { timeout: REQUEST_TIMEOUT }
    );

    const translatedText = response.data.translatedText;
    if (!translatedText) return null;

    const translation = { text: translatedText, sourceLang, targetLang: TARGET_LANG };
    TRANSLATION_CACHE.set(cacheKey, translation);
    return translation;
  } catch (error) {
    console.error('Translation error:', error.message);
    return null;
  }
}

// Create internal note
async function createInternalNote(conversationId, translation) {
  try {
    const noteBody = `📝 Auto-translation (${translation.sourceLang} → ${translation.targetLang}): ${translation.text}`;
    const notePayload = {
      message_type: 'note',
      admin_id: ADMIN_ID,
      body: noteBody
    };

    await axios.post(
      `https://api.intercom.io/conversations/${conversationId}/reply`,
      notePayload,
      {
        headers: {
          Authorization: INTERCOM_TOKEN,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Intercom-Version': INTERCOM_API_VERSION
        },
        timeout: REQUEST_TIMEOUT
       }
    );

    console.log('Note created for', conversationId);
  } catch (error) {
    console.error('Note error for', conversationId, ':', error.message);
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
