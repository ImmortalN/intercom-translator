import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import dotenv from 'dotenv';
import { franc } from 'franc';
import NodeCache from 'node-cache';

dotenv.config();

const app = express();
app.use(bodyParser.json());

// Configuration
const INTERCOM_TOKEN = `Bearer ${process.env.INTERCOM_TOKEN}`;
const ADMIN_ID = process.env.ADMIN_ID;
const ENABLED = process.env.ENABLED === 'true';
const TARGET_LANG = 'en';
const SKIP_LANGS = ['en', 'ru', 'uk'];
// Расширенный маппинг franc (ISO 639-3) на ISO 639-1. Добавьте любые языки для детекции.
const LANG_MAP = {
  'eng': 'en',
  'rus': 'ru',
  'ukr': 'uk',
  'spa': 'es',  // Spanish
  'deu': 'de',  // German
  'fra': 'fr',  // French
  'ita': 'it',  // Italian
  'por': 'pt',  // Portuguese
  'pol': 'pl',  // Polish
  'ces': 'cs',  // Czech
  'nld': 'nl',  // Dutch
  'tur': 'tr',  // Turkish
  'ara': 'ar',  // Arabic
  'cmn': 'zh',  // Chinese (Mandarin)
  // Добавьте больше по необходимости (список кодов franc: https://github.com/wooorm/franc/blob/main/packages/franc-min/index.json)
};
const INTERCOM_API_VERSION = '2.14';
const TRANSLATE_API_URL = 'https://translate.fedilab.app/translate';
const TRANSLATION_CACHE = new NodeCache({ stdTTL: 3600, checkperiod: 120 });
const REQUEST_TIMEOUT = 3000;

// Проверка env
if (!INTERCOM_TOKEN || INTERCOM_TOKEN === 'Bearer ') {
  console.error('Fatal: INTERCOM_TOKEN missing');
  process.exit(1);
}
if (!ADMIN_ID) {
  console.error('Fatal: ADMIN_ID missing');
  process.exit(1);
}
console.log('Server starting with ENABLED:', ENABLED, 'ADMIN_ID:', ADMIN_ID);

// Webhook verify
app.get('/intercom-webhook', (req, res) => res.status(200).send('Webhook verified'));

// Main handler
app.post('/intercom-webhook', async (req, res) => {
  const start = Date.now();
  try {
    res.sendStatus(200);

    if (!ENABLED) {
      console.log('Webhook disabled');
      return;
    }

    const { topic, data } = req.body;
    if (!['conversation.user.replied', 'conversation.user.created'].includes(topic)) return;

    const conversation = data?.item;
    const conversationId = conversation?.id;
    if (!conversationId) return;

    const messageText = extractMessageText(conversation);
    if (!messageText || messageText.length < 5) {  // Уменьшил для теста, потом верните 10
      console.log('Skipping: message too short or empty');
      return;
    }

    if (conversation?.source?.author?.type === 'bot') return;

    const translation = await translateMessage(messageText);
    if (!translation) return;

    await createInternalNote(conversationId, translation);

    console.log(`Processed ${conversationId} in ${Date.now() - start}ms`);
  } catch (error) {
    console.error('Webhook error:', error.message);
  }
});

// Extract text
function extractMessageText(conversation) {
  const sources = [
    conversation?.source?.body,
    ...(conversation?.conversation_parts?.conversation_parts || []).map(part => part.body)
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

// Translate
async function translateMessage(text) {
  // Локальная детекция (без whitelist — детектируем все)
  const francCode = franc(text, { minLength: 3 });
  console.log(`Franc detected raw code: ${francCode} for text: "${text.substring(0, 50)}..."`);  // Дебаг лог

  let sourceLang = LANG_MAP[francCode] || 'auto';  // Fallback на auto если неизвестный

  if (francCode === 'und') {
    console.log('Undetermined language, using auto detect in API');
    // return null;  // Раскомментируйте, если строго скип und
  }

  if (sourceLang !== 'auto' && SKIP_LANGS.includes(sourceLang)) {
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
      { q: text, source: sourceLang, target: TARGET_LANG, format: 'text' },
      { timeout: REQUEST_TIMEOUT }
    );

    const translatedText = response.data.translatedText;
    if (!translatedText) return null;

    // Если source был auto, можно взять detected из API (опционально)
    const finalSource = sourceLang === 'auto' ? response.data.detectedLanguage?.language || 'unknown' : sourceLang;

    const translation = { text: translatedText, sourceLang: finalSource, targetLang: TARGET_LANG };
    TRANSLATION_CACHE.set(cacheKey, translation);
    return translation;
  } catch (error) {
    console.error('Translation error:', error.message);
    return null;
  }
}

// Create note
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
