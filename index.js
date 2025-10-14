import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import dotenv from 'dotenv';
import { franc } from 'franc-min';
import pino from 'pino';

dotenv.config();

const app = express();
app.use(bodyParser.json());

// Logger
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Configuration
const INTERCOM_TOKEN = `Bearer ${process.env.INTERCOM_TOKEN}`;
const ADMIN_ID = process.env.ADMIN_ID;
const ENABLED = process.env.ENABLED === 'true';
const TARGET_LANG = 'en';
const SKIP_LANGS = ['en', 'ru', 'uk'];
const INTERCOM_API_VERSION = '2.14';
const TRANSLATE_API_URL = 'https://translate.fedilab.app/translate';
const TRANSLATION_CACHE = new Map();
const HTML_CACHE = new Map();
const REQUEST_TIMEOUT = 5000;
const MIN_TEXT_LENGTH = 30;
const CACHE_MAX_SIZE = 1000;
const CACHE_TTL = 24 * 60 * 60 * 1000;
const MAX_NOTE_LENGTH = 1000;
const ENGLISH_KEYWORDS = [
  'okay', 'please', 'thanks', 'sorry', 'update', 'hello', 'hi',
  'for', 'post', 'image', 'added', 'in', 'an', 'the', 'to',
  'what', 'can', 'do', 'is', 'it', 'with', 'on', 'and', 'my'
];

// Проверка переменных окружения
if (!INTERCOM_TOKEN || INTERCOM_TOKEN === 'Bearer ') {
  logger.error('Fatal: INTERCOM_TOKEN is missing or invalid');
  process.exit(1);
}
if (!ADMIN_ID) {
  logger.error('Fatal: ADMIN_ID is missing');
  process.exit(1);
}
logger.info({ ENABLED, ADMIN_ID }, 'Server starting');

// Очистка кэша при старте
TRANSLATION_CACHE.clear();
HTML_CACHE.clear();
logger.info('Caches cleared at startup');

// Webhook verification endpoint
app.get('/intercom-webhook', (req, res) => {
  res.status(200).send('Webhook verified');
});

// Main webhook handler
app.post('/intercom-webhook', async (req, res) => {
  const start = Date.now();
  try {
    res.sendStatus(200);
    
    if (!ENABLED) {
      logger.info('Webhook processing disabled (ENABLED=false)');
      return;
    }
    
    const { topic, data } = req.body;
    
    if (!['conversation.user.replied', 'conversation.user.created'].includes(topic)) {
      return;
    }
    
    const conversation = data?.item;
    const conversationId = conversation?.id;
    
    if (!conversationId) {
      return;
    }
    
    const messageText = extractMessageText(conversation);
    if (!messageText || messageText.length < MIN_TEXT_LENGTH) {
      logger.info({ messageText }, 'Skipping short message');
      return;
    }
    
    if (conversation?.source?.author?.type === 'bot') {
      return;
    }
    
    // Проверка на английский по ключевым словам
    const isLikelyEnglish = ENGLISH_KEYWORDS.some(keyword => 
      messageText.toLowerCase().includes(keyword)
    );
    if (isLikelyEnglish) {
      logger.info({ messageText }, 'Message likely English based on keywords, skipping');
      return;
    }
    
    // Локальная проверка языка через franc
    const francLang = franc(messageText, { minLength: 3 });
    if (francLang === 'eng') {
      logger.info({ messageText }, 'Franc detected English, skipping');
      return;
    }
    
    const translation = await translateMessage(messageText);
    if (!translation) {
      return;
    }
    
    await createInternalNote(conversationId, translation);
    
    logger.info({ conversationId, duration: Date.now() - start }, 'Webhook processed');
    
  } catch (error) {
    logger.error({ error: error.response?.status || error.message }, 'Webhook error');
  }
});

// Extract message text efficiently
function extractMessageText(conversation) {
  const sources = [
    conversation?.conversation_parts?.conversation_parts?.slice(-1)[0]?.body,
    conversation?.conversation_parts?.conversation_parts?.[0]?.body,
    conversation?.source?.body,
    conversation?.body
  ];
  
  for (const source of sources) {
    if (source && conversation?.source?.author?.type !== 'bot') {
      return cleanHtml(source);
    }
  }
  return null;
}

// Clean HTML tags with caching
function cleanHtml(text) {
  if (HTML_CACHE.has(text)) {
    return HTML_CACHE.get(text);
  }
  const cleaned = text.replace(/<[^>]*>/g, '').trim();
  HTML_CACHE.set(text, cleaned);
  if (HTML_CACHE.size >= CACHE_MAX_SIZE) {
    HTML_CACHE.clear();
    logger.info('HTML cache cleared due to size limit');
  }
  return cleaned;
}

// Translate message with caching
async function translateMessage(text) {
  const cacheKey = `${text}:${TARGET_LANG}`;
  if (TRANSLATION_CACHE.has(cacheKey)) {
    const cachedTranslation = TRANSLATION_CACHE.get(cacheKey);
    if (SKIP_LANGS.includes(cachedTranslation.sourceLang)) {
      logger.info({ sourceLang: cachedTranslation.sourceLang, text }, 'Skipping cached translation');
      return null;
    }
    logger.info({ text, sourceLang: cachedTranslation.sourceLang }, 'Using cached translation');
    return cachedTranslation;
  }
  
  if (TRANSLATION_CACHE.size >= CACHE_MAX_SIZE) {
    TRANSLATION_CACHE.clear();
    logger.info('Translation cache cleared due to size limit');
  }
  
  try {
    const response = await axios.post(
      TRANSLATE_API_URL,
      { q: text, source: 'auto', target: TARGET_LANG, format: 'text' },
      { timeout: REQUEST_TIMEOUT }
    );
    
    const { translatedText, detectedLanguage } = response.data;
    const sourceLang = detectedLanguage?.language?.toLowerCase() || 'unknown';
    
    logger.info({ sourceLang, confidence: detectedLanguage?.confidence || 'unknown' }, 'Detected language');
    
    if (SKIP_LANGS.includes(sourceLang)) {
      logger.info({ sourceLang, text }, 'Skipping translation');
      return null;
    }
    
    const translation = { 
      text: translatedText.slice(0, MAX_NOTE_LENGTH), 
      sourceLang, 
      targetLang: TARGET_LANG, 
      timestamp: Date.now() 
    };
    TRANSLATION_CACHE.set(cacheKey, translation);
    
    // Очистка старых записей кэша
    for (const [key, value] of TRANSLATION_CACHE) {
      if (Date.now() - value.timestamp > CACHE_TTL) {
        TRANSLATION_CACHE.delete(key);
      }
    }
    
    return translation;
    
  } catch (error) {
    logger.error({ error: error.response?.status || error.message }, 'Translation error');
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
    
    const response = await axios.post(
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
    
    logger.info({ conversationId, status: response.status }, 'Note created');
    
  } catch (error) {
    logger.error({ conversationId, error: error.response?.status, details: error.response?.data || error.message }, 'Note creation error');
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  logger.info(`Translation webhook server running on port ${PORT}`);
});
