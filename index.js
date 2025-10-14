import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(bodyParser.json());

// Configuration
const INTERCOM_TOKEN = `Bearer ${process.env.INTERCOM_TOKEN}`;
const ADMIN_ID = process.env.ADMIN_ID; // Убедитесь, что ADMIN_ID=5475435 в Render
const TARGET_LANG = 'en';
const SKIP_LANGS = ['en', 'ru', 'uk'];
const INTERCOM_API_VERSION = '2.14';
const TRANSLATE_API_URL = 'https://translate.fedilab.app/translate';
const TEST_CONVERSATION_ID = '215471280601196';
const TRANSLATION_CACHE = new Map(); // Простое кэширование переводов
const REQUEST_TIMEOUT = 5000; // Таймаут 5 секунд для сетевых запросов

// Проверка переменных окружения при старте
if (!INTERCOM_TOKEN || INTERCOM_TOKEN === 'Bearer ') {
  console.error('Fatal: INTERCOM_TOKEN is missing or invalid');
  process.exit(1);
}
if (!ADMIN_ID) {
  console.error('Fatal: ADMIN_ID is missing');
  process.exit(1);
}
console.log('Server starting with ADMIN_ID:', ADMIN_ID);

// Webhook verification endpoint
app.get('/intercom-webhook', (req, res) => {
  console.log('Webhook verification received');
  res.status(200).send('Webhook verified');
});

// Main webhook handler
app.post('/intercom-webhook', async (req, res) => {
  try {
    // Respond immediately to avoid webhook timeout
    res.sendStatus(200);
    
    const { topic, data } = req.body;
    
    // Only process user messages
    if (!['conversation.user.replied', 'conversation.user.created'].includes(topic)) {
      return;
    }
    
    const conversation = data?.item;
    const conversationId = conversation?.id;
    
    // Process only the test conversation
    if (conversationId !== TEST_CONVERSATION_ID) {
      return;
    }
    
    const messageText = extractMessageText(conversation);
    if (!messageText || messageText.length < 2) {
      return;
    }
    
    if (conversation?.source?.author?.type === 'bot') {
      return;
    }
    
    const translation = await translateMessage(messageText);
    if (!translation) {
      return;
    }
    
    await createInternalNote(conversationId, translation);
    
  } catch (error) {
    console.error('Webhook error:', error.response?.status || error.message);
  }
});

// Extract message text efficiently
function extractMessageText(conversation) {
  const parts = conversation?.conversation_parts?.conversation_parts || [];
  const sources = [
    parts[parts.length - 1]?.body, // Last part
    parts[0]?.body, // First part
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
    console.log('Using cached translation for:', text);
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
    
    if (SKIP_LANGS.includes(sourceLang)) {
      return null;
    }
    
    const translation = { text: translatedText, sourceLang, targetLang: TARGET_LANG };
    TRANSLATION_CACHE.set(cacheKey, translation); // Cache result
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
    console.error('Note creation error:', error.response?.status, error.response?.data || error.message);
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Translation webhook server running on port ${PORT}`);
});
