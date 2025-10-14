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
const INTERCOM_API_VERSION = '2.14'; // Ваша версия API
const TRANSLATE_API_URL = 'https://translate.fedilab.app/translate';
const TEST_CONVERSATION_ID = '215471280601196'; // Ограничение на тестовый чат

// Webhook verification endpoint
app.get('/intercom-webhook', (req, res) => {
  console.log('Webhook verification:', JSON.stringify(req.query, null, 2));
  res.status(200).send('Webhook verified');
});

// Main webhook handler
app.post('/intercom-webhook', async (req, res) => {
  try {
    // Always respond 200 first to avoid webhook timeout
    res.sendStatus(200);
    
    console.log('Webhook received:', JSON.stringify(req.body, null, 2));
    
    if (!INTERCOM_TOKEN) {
      console.error('Missing INTERCOM_TOKEN');
      return;
    }
    console.log('INTERCOM_TOKEN is set (length):', INTERCOM_TOKEN.length);
    
    if (!ADMIN_ID) {
      console.error('Missing ADMIN_ID');
      return;
    }
    console.log('Using ADMIN_ID:', ADMIN_ID);
    
    const { topic, data } = req.body;
    
    // Only process user messages
    if (!['conversation.user.replied', 'conversation.user.created'].includes(topic)) {
      console.log(`Ignoring topic: ${topic}`);
      return;
    }
    
    const conversation = data?.item;
    const conversationId = conversation?.id;
    
    // Process only the test conversation
    if (conversationId !== TEST_CONVERSATION_ID) {
      console.log(`Ignoring conversation ID: ${conversationId}, only processing ${TEST_CONVERSATION_ID}`);
      return;
    }
    
    console.log(`Processing test conversation ID: ${conversationId}`);
    
    let messageText = extractMessageText(conversation);
    
    if (!messageText || messageText.length < 2) {
      console.log('No valid message text found');
      return;
    }
    
    console.log(`Processing message: ${messageText}, Author type: ${conversation?.source?.author?.type || 'unknown'}`);
    
    if (conversation?.source?.author?.type === 'bot') {
      console.log('Message from bot - skipping');
      return;
    }
    
    const translation = await translateMessage(messageText);
    
    if (!translation) {
      console.log('Translation failed or not needed');
      return;
    }
    
    await createInternalNote(conversationId, translation);
    
  } catch (error) {
    console.error('Webhook error:', error.response?.status, error.response?.data || error.message, error.stack);
  }
});

// Extract message text from conversation payload
function extractMessageText(conversation) {
  const parts = conversation?.conversation_parts?.conversation_parts || [];
  
  // Try last part first (most recent message)
  const lastPart = parts[parts.length - 1];
  if (lastPart?.author?.type !== 'bot' && lastPart.body) {
    return cleanHtml(lastPart.body);
  }
  
  // Try first part
  const firstPart = parts[0];
  if (firstPart?.author?.type !== 'bot' && firstPart.body) {
    return cleanHtml(firstPart.body);
  }
  
  // Try source body
  if (conversation?.source?.body && conversation?.source?.author?.type !== 'bot') {
    return cleanHtml(conversation.source.body);
  }
  
  // Try conversation body
  if (conversation?.body && conversation?.source?.author?.type !== 'bot') {
    return cleanHtml(conversation.body);
  }
  
  return null;
}

// Clean HTML tags from message
function cleanHtml(text) {
  return text.replace(/<[^>]+>/g, '').trim();
}

// Translate message using LibreTranslate
async function translateMessage(text) {
  try {
    const response = await axios.post(TRANSLATE_API_URL, {
      q: text,
      source: 'auto',
      target: TARGET_LANG,
      format: 'text'
    });
    
    const { translatedText, detectedLanguage } = response.data;
    const sourceLang = detectedLanguage?.language?.toLowerCase() || 'unknown';
    
    console.log(`LibreTranslate response:`, JSON.stringify(response.data, null, 2));
    console.log(`Detected: ${sourceLang}, Translated: ${translatedText}`);
    
    // Skip if source language should be ignored
    if (SKIP_LANGS.includes(sourceLang)) {
      console.log(`Skipping translation for ${sourceLang}`);
      return null;
    }
    
    return {
      text: translatedText,
      sourceLang,
      targetLang: TARGET_LANG
    };
    
  } catch (error) {
    console.error('Translation error:', error.response?.status, error.response?.data || error.message);
    return null;
  }
}

// Create internal note with translation
async function createInternalNote(conversationId, translation) {
  try {
    const noteBody = `📝 Auto-translation (${translation.sourceLang} → ${translation.targetLang}): ${translation.text}`;
    
    const notePayload = {
      message_type: 'note',
      admin_id: process.env.ADMIN_ID,
      body: noteBody
    };
    
    console.log('Sending note to Intercom:', notePayload);
    const response = await axios.post(
      `https://api.intercom.io/conversations/${conversationId}/reply`,
      notePayload,
      {
        headers: {
          Authorization: INTERCOM_TOKEN,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Intercom-Version': INTERCOM_API_VERSION
        }
      }
    );
    
    console.log('Intercom response:', response.status, JSON.stringify(response.data, null, 2));
    
  } catch (error) {
    console.error('Note creation error:', error.response?.status, error.response?.data || error.message, error.stack);
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Translation webhook server running on port ${PORT}`);
});
