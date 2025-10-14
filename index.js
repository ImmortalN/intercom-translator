import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(bodyParser.json());

// Configuration
const INTERCOM_TOKEN = `Bearer ${process.env.INTERCOM_TOKEN}`;
const TARGET_LANG = 'en';
const SKIP_LANGS = ['en', 'ru', 'uk'];
const TRANSLATE_API_URL = 'https://translate.fedilab.app/translate';

// Webhook verification endpoint
app.get('/intercom-webhook', (req, res) => {
  console.log('Webhook verification:', JSON.stringify(req.query, null, 2));
  res.status(200).send('Webhook verified');
});

// Main webhook handler
app.post('/intercom-webhook', async (req, res) => {
  try {
    res.sendStatus(200);
    
    console.log('Webhook received:', JSON.stringify(req.body, null, 2));
    
    if (!INTERCOM_TOKEN) {
      console.error('Missing INTERCOM_TOKEN');
      return;
    }
    
    const { topic, data } = req.body;
    
    if (!['conversation.user.replied', 'conversation.user.created'].includes(topic)) {
      console.log(`Ignoring topic: ${topic}`);
      return;
    }
    
    const conversation = data?.item;
    const conversationId = conversation?.id;
    
    console.log(`Conversation ID: ${conversationId}`);
    
    if (!conversationId) {
      console.log('No conversation ID found');
      return;
    }
    
    let messageText = extractMessageText(conversation);
    
    if (!messageText || messageText.length < 2) {
      console.log('No valid message text found');
      return;
    }
    
    console.log(`Processing message: ${messageText}`);
    
    if (conversation?.source?.author?.type === 'bot') {
      console.log('Message from bot - skipping');
      return;
    }
    
    const translation = await translateMessage(messageText);
    
    if (!translation) {
      console.log('Translation failed or not needed');
      return;
    }
    
    await createInternalNote(conversationId, translation, messageText);
    
  } catch (error) {
    console.error('Webhook error:', error.message);
  }
});

function extractMessageText(conversation) {
  const parts = conversation?.conversation_parts?.conversation_parts || [];
  
  const lastPart = parts[parts.length - 1];
  if (lastPart?.author?.type !== 'bot' && lastPart.body) {
    return cleanHtml(lastPart.body);
  }
  
  const firstPart = parts[0];
  if (firstPart?.author?.type !== 'bot' && firstPart.body) {
    return cleanHtml(firstPart.body);
  }
  
  if (conversation?.source?.body && conversation?.source?.author?.type !== 'bot') {
    return cleanHtml(conversation.source.body);
  }
  
  if (conversation?.body && conversation?.source?.author?.type !== 'bot') {
    return cleanHtml(conversation.body);
  }
  
  return null;
}

function cleanHtml(text) {
  return text.replace(/<[^>]+>/g, '').trim();
}

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
    
    console.log(`Detected: ${sourceLang}, Translated: ${translatedText}`);
    
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
    console.error('Translation error:', error.message);
    return null;
  }
}

async function createInternalNote(conversationId, translation, originalText) {
  try {
    const noteBody = `📝 Auto-translation (${translation.sourceLang} → ${translation.targetLang}): ${translation.text}\n\nOriginal: ${originalText}`;
    
    // Create internal note using conversation parts endpoint
    const notePayload = {
      type: 'note',
      body: noteBody
    };
    
    console.log('Creating internal note:', notePayload);
    
    const response = await axios.post(
      `https://api.intercom.io/conversations/${conversationId}/reply`,
      notePayload,
      {
        headers: {
          'Authorization': INTERCOM_TOKEN,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      }
    );
    
    console.log('Internal note created successfully:', response.status);
    
  } catch (error) {
    console.error('Note creation error:', error.response?.status, error.response?.data || error.message);
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Translation webhook server running on port ${PORT}`);
});
