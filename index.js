import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(bodyParser.json());

const INTERCOM_TOKEN = `Bearer ${process.env.INTERCOM_TOKEN}`;
const ADMIN_ID = process.env.ADMIN_ID;
const TARGET_LANG = 'en';
const SKIP_LANGS = ['en', 'ru', 'uk'];
const INTERCOM_API_VERSION = '2.9'; // Смените на вашу версию из Intercom Webhook settings (или 'Unversioned')

app.get('/intercom-webhook', (req, res) => {
  console.log('Received GET test webhook:', JSON.stringify(req.query, null, 2));
  res.status(200).send('Webhook test successful');
});

app.post('/intercom-webhook', async (req, res) => {
  try {
    console.log('Webhook POST received. Full payload:', JSON.stringify(req.body, null, 2));

    if (!INTERCOM_TOKEN || !ADMIN_ID) {
      console.error('Missing env vars: INTERCOM_TOKEN or ADMIN_ID');
      return res.sendStatus(500);
    }

    const topic = req.body?.topic;
    console.log(`Topic: ${topic}`);
    if (!['conversation.user.replied', 'conversation.user.created'].includes(topic)) {
      console.log(`Ignored topic: ${topic}`);
      return res.sendStatus(200);
    }

    const conversation = req.body?.data?.item;
    const conversationId = conversation?.id;
    console.log(`Conversation ID: ${conversationId}`);
    if (!conversationId) {
      console.log('No conversation ID - skipping');
      return res.sendStatus(200);
    }

    // Дебаг структуры
    console.log('Conversation parts structure:', JSON.stringify(conversation?.conversation_parts, null, 2));
    console.log('Conversation body:', conversation?.body);
    console.log('Source body:', conversation?.source?.body);

    // Извлечение текста
    let messageText = '';
    const parts = conversation?.conversation_parts?.conversation_parts || [];
    const lastPart = parts.slice(-1)[0];
    const firstPart = parts[0];
    if (lastPart && lastPart.author?.type === 'user' && lastPart.body) {
      messageText = lastPart.body.replace(/<[^>]+>/g, '').trim();
    } else if (firstPart && firstPart.author?.type === 'user' && firstPart.body) {
      messageText = firstPart.body.replace(/<[^>]+>/g, '').trim();
    } else if (conversation?.source?.body) {
      messageText = conversation.source.body.replace(/<[^>]+>/g, '').trim();
    } else if (conversation?.body) {
      messageText = conversation.body.replace(/<[^>]+>/g, '').trim();
    }
    console.log(`Extracted message text: ${messageText}`);
    if (!messageText || messageText.length < 2) {
      console.log('Empty or too short message - skipping');
      return res.sendStatus(200);
    }

    // Hardcoded note для теста (раскомментируйте для проверки API)
    /*
    const noteBody = 'Test note from webhook';
    const replyPayload = {
      admin_id: ADMIN_ID,
      type: 'note',
      message_type: 'comment',
      body: noteBody
    };
    console.log('Sending test note to Intercom:', replyPayload);
    const replyRes = await axios.post(
      `https://api.intercom.io/conversations/${conversationId}/reply`,
      replyPayload,
      {
        headers: {
          Authorization: INTERCOM_TOKEN,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Intercom-Version': INTERCOM_API_VERSION
        }
      }
    );
    console.log('Intercom test note response:', replyRes.status, replyRes.data);
    return res.sendStatus(200);
    */

    // Детекция и перевод через LibreTranslate
    let sourceLang = '';
    let translatedText = '';
    try {
      const translateRes = await axios.post('https://libretranslate.de/translate', {
        q: messageText,
        source: 'auto',
        target: TARGET_LANG,
        format: 'text'
      });
      sourceLang = translateRes.data.detectedLanguage?.language?.toLowerCase() || 'auto';
      translatedText = translateRes.data.translatedText;
      console.log(`Detected language: ${sourceLang}, Translated: ${translatedText}`);
    } catch (err) {
      console.error('Translation failed:', err.response?.status, err.response?.data || err.message);
      return res.sendStatus(200);
    }
    if (!translatedText) {
      console.log('Translation returned empty');
      return res.sendStatus(200);
    }

    if (!sourceLang || SKIP_LANGS.includes(sourceLang)) {
      console.log(`Skipping translation for lang ${sourceLang}`);
      return res.sendStatus(200);
    }

    // Реальный note
    const noteBody = `📝 Auto-translation (${sourceLang} → ${TARGET_LANG}): ${translatedText}\n\nOriginal: ${messageText}`;
    const replyPayload = {
      admin_id: ADMIN_ID,
      type: 'note',
      message_type: 'comment',
      body: noteBody
    };
    console.log('Sending note to Intercom:', replyPayload);
    const replyRes = await axios.post(
      `https://api.intercom.io/conversations/${conversationId}/reply`,
      replyPayload,
      {
        headers: {
          Authorization: INTERCOM_TOKEN,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Intercom-Version': INTERCOM_API_VERSION
        }
      }
    );
    console.log('Intercom response:', replyRes.status, replyRes.data);

    res.sendStatus(200);
  } catch (err) {
    console.error('Error details:', err.response?.status, err.response?.data || err.message, err.stack);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
