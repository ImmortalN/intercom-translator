import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import dotenv from 'dotenv';
import { franc } from 'franc';
import NodeCache from 'node-cache';

dotenv.config();

const app = express();
app.use(bodyParser.json());

// Config (без изменений)
const INTERCOM_TOKEN = `Bearer ${process.env.INTERCOM_TOKEN}`;
const ADMIN_ID = process.env.ADMIN_ID;
const ENABLED = process.env.ENABLED === 'true';
const TARGET_LANG = 'en';
const SKIP_LANGS = ['en', 'ru', 'uk'];
const LANG_MAP = {
  'eng': 'en', 'rus': 'ru', 'ukr': 'uk', 'spa': 'es', 'deu': 'de', 'fra': 'fr',
  'ita': 'it', 'por': 'pt', 'pol': 'pl', 'ces': 'cs', 'nld': 'nl', 'tur': 'tr',
  'ara': 'ar', 'cmn': 'zh'
};
const INTERCOM_API_VERSION = '2.14';
const TRANSLATE_API_URL = 'https://translate.fedilab.app/translate';
const TRANSLATION_CACHE = new NodeCache({ stdTTL: 3600, checkperiod: 120 });
const REQUEST_TIMEOUT = 3000;

// Env check (без изменений)
if (!INTERCOM_TOKEN || INTERCOM_TOKEN === 'Bearer ') {
  console.error('Fatal: INTERCOM_TOKEN missing');
  process.exit(1);
}
if (!ADMIN_ID) {
  console.error('Fatal: ADMIN_ID missing');
  process.exit(1);
}
console.log('Server starting with ENABLED:', ENABLED, 'ADMIN_ID:', ADMIN_ID);

app.get('/intercom-webhook', (req, res) => res.status(200).send('Webhook verified'));

app.post('/intercom-webhook', async (req, res) => {
  const start = Date.now();
  try {
    res.sendStatus(200);
    if (!ENABLED) return;

    const { topic, data } = req.body;
    if (!['conversation.user.replied', 'conversation.user.created'].includes(topic)) return;

    const conversation = data?.item;
    const conversationId = conversation?.id;
    if (!conversationId) return;

    const messageText = extractMessageText(conversation);
    console.log(`Extracted text for ${conversationId}: "${messageText}"`);  // Дебаг

    if (!messageText || messageText.length < 5) {
      console.log('Skipping: too short');
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

// Улучшенная экстракция: последняя user часть
function extractMessageText(conversation) {
  let parts = conversation?.conversation_parts?.conversation_parts || [];
  if (parts.length > 0) {
    // Сортируем по created_at desc и фильтруем user + с body
    parts = parts
      .filter(part => part?.author?.type !== 'bot' && part?.body)
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    if (parts[0]) return cleanHtml(parts[0].body);
  }
  // Fallback на source если нет parts
  if (conversation?.source?.body && conversation.source.author.type !== 'bot') {
    return cleanHtml(conversation.source.body);
  }
  return null;
}

function cleanHtml(text) {
  return text.replace(/<[^>]+>/g, '').trim().replace(/\s+/g, ' ');  // Нормализация пробелов
}

async function translateMessage(text) {
  const francCode = franc(text, { minLength: 3 });
  console.log(`Franc raw: ${francCode} for "${text.substring(0, 50)}..."`);

  if (francCode === 'und') {
    console.log('Skipping: undetermined language');
    return null;
  }

  const sourceLang = LANG_MAP[francCode] || 'auto';
  if (SKIP_LANGS.includes(sourceLang)) {
    console.log(`Skipping: ${sourceLang} in skip list`);
    return null;
  }

  // Скип если выглядит как код/лицензия (опционально, для вашего случая)
  if (/^[a-f0-9]{32}$/i.test(text.trim()) || text.match(/license key/i)) {
    console.log('Skipping: looks like license key');
    return null;
  }

  const cacheKey = `${text}:${sourceLang}:${TARGET_LANG}`;
  if (TRANSLATION_CACHE.has(cacheKey)) {
    console.log('Cache hit');
    return TRANSLATION_CACHE.get(cacheKey);
  }

  try {
    const apiSource = sourceLang === 'auto' ? 'auto' : sourceLang;
    const response = await axios.post(
      TRANSLATE_API_URL,
      { q: text, source: apiSource, target: TARGET_LANG, format: 'text' },
      { timeout: REQUEST_TIMEOUT }
    );

    const translatedText = response.data.translatedText;
    if (!translatedText) return null;

    const finalSource = apiSource === 'auto' ? (response.data.detectedLanguage?.language || sourceLang) : sourceLang;
    const translation = { text: translatedText, sourceLang: finalSource, targetLang: TARGET_LANG };
    TRANSLATION_CACHE.set(cacheKey, translation);
    return translation;
  } catch (error) {
    console.error('Translation error:', error.message);
    return null;
  }
}

async function createInternalNote(conversationId, translation) {
  // Без изменений
  try {
    const noteBody = `📝 Auto-translation (${translation.sourceLang} → ${translation.targetLang}): ${translation.text}`;
    const notePayload = { message_type: 'note', admin_id: ADMIN_ID, body: noteBody };
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
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
