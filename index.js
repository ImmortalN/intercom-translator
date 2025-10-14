import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import dotenv from 'dotenv';
import { franc } from 'franc-min';

dotenv.config();

const app = express();
app.use(bodyParser.json());

// Configuration
const INTERCOM_TOKEN = `Bearer ${process.env.INTERCOM_TOKEN}`;
const ADMIN_ID = process.env.ADMIN_ID; // Убедитесь, что ADMIN_ID=5475435 в Render
const ENABLED = process.env.ENABLED === 'true';
const TARGET_LANG = 'en';
const SKIP_LANGS = ['en', 'ru', 'uk'];
const INTERCOM_API_VERSION = '2.14';
const TRANSLATE_API_URL = 'https://translate.fedilab.app/translate';
const TRANSLATION_CACHE = new Map();
const REQUEST_TIMEOUT = 5000;
const MIN_TEXT_LENGTH = 30; // Увеличено для исключения коротких фраз
const ENGLISH_KEYWORDS = [
  'okay', 'please', 'thanks', 'sorry', 'update', 'hello', 'hi',
  'for', 'post', 'image', 'added', 'in', 'an', 'the', 'to'
]; // Расширенный список

// Проверка переменных окружения при старте
if (!INTERCOM_TOKEN || INTERCOM_TOKEN === 'Bearer ') {
  console.error('Fatal: INTERCOM_TOKEN is missing or invalid');
  process.exit(1);
}
if (!ADMIN_ID) {
  console.error('Fatal: ADMIN_ID is missing');
  process.exit(1);
}
console.log('Server starting with ENABLED:', ENABLED, 'ADMIN_ID:', ADMIN_ID);

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
      console.log('Webhook processing disabled (ENABLED=false)');
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
      console.log(`Skipping short message: ${messageText}`);
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
      console.log('Message likely English based on keywords, skipping:', messageText);
      return;
    }
    
    // Локальная проверка языка через franc
    const francLang = franc(messageText, { minLength: 3 });
    if (francLang === 'eng') {
      console.log('Franc detected English, skipping:', messageText);
      return;
    }
    
    const translation = await translateMessage(messageText);
    if (!translation) {
      return;
    }
    
    await createInternalNote(conversationId, translation);
    
    console.log(`Webhook processed for conversation ${conversationId} in ${Date.now() - start}ms`);
    
  } catch (error) {
    console.error('Webhook error:', error.response?.status || error.message);
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

// Clean HTML tags
function cleanHtml(text) {
  return text.replace(/<[^>]+>/g, '').trim();
}

// Translate message with caching
async function translateMessage(text) {
  const cacheKey = `${text}:${TARGET_LANG}`;
  if (TRANSLATION_CACHE.has(cacheKey)) {
    console.log('Using cached translation');
    return TRANSLATION_CACHE.get(cacheKey);
  }
  
  try {
    const response = await axios.post(
      TRANSLATE_API_URL,
      { q: text, source: 'auto', target: TARGET_LANG, format: 'text' },
      { timeout: REQUEST_TIMEOUT }
    );
    
    const { translatedText, detectedLanguage } = response.data;
    const sourceLang = detectedLanguage?.language?.toLowerCase() || 'unknown';
    
    console.log(`Detected language: ${sourceLang}, Confidence: ${detectedLanguage?.confidence || 'unknown'}`);
    
    if (SKIP_LANGS.includes(sourceLang)) {
      console.log(`Skipping translation for ${sourceLang}: ${text}`);
      return null;
    }
    
    const translation = { text: translatedText, sourceLang, targetLang: TARGET_LANG };
    TRANSLATION_CACHE.set(cacheKey, translation);
    return translation;
    
  } catch (error) {
    console.error('Translation error:', error.response?.status || error.message);
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
    
    console.log('Note created for conversation', conversationId, 'Status:', response.status);
    
  } catch (error) {
    console.error('Note creation error for conversation', conversationId, ':', error.response?.status, error.response?.data || error.message);
  }
}

// Очистка кэша для проблемных сообщений
TRANSLATION_CACHE.delete('okay, please keep update me:en');
TRANSLATION_CACHE.delete('for 1 post i added an image::en');
console.log('Cleared cache for problematic messages');

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Translation webhook server running on port ${PORT}`);
});
