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

app.post('/intercom-webhook', async (req, res) => {
  try {
    console.log('Webhook received. Full payload:', JSON.stringify(req.body, null, 2)); // Полный дебаг payload

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
    if (!conversationId) return res.sendStatus(200);

    // Дебаг структуры частей (как советует support)
    console.log('Conversation parts structure:', JSON.stringify(conversation?.conversation_parts, null, 2));
    console.log('Conversation body:', conversation?.body);

    // Извлечение текста: приоритет - последняя user part, fallback на body
    let messageText = '';
    const parts = conversation?.conversation_parts?.conversation_parts || [];
    const lastPart = parts.slice(-1)[0];
    if (lastPart && lastPart.author?.type === 'user' && lastPart.body) {
      messageText = lastPart.body.replace(/<[^>]+>/g, '').trim();
    } else if (conversation?.body) {
      messageText = conversation.body.replace(/<[^>]+>/g, '').trim();
    }
    console.log(`Extracted message text: ${messageText}`);
    if (!messageText || messageText.length < 2) {
      console.log('Empty or too short message - skipping');
      return res.sendStatus(200);
    }

    // Детект языка
    const detectParams = { client: 'gtx', dt: 'ld', q: messageText };
    const detectRes = await axios.post('https://translate.googleapis.com/translate_a/single', null, { params: detectParams });
    const sourceLang = detectRes.data?.[2]?.toLowerCase();
    console.log(`Detected language: ${sourceLang}`, detectRes.data);

    if (!sourceLang || SKIP_LANGS.includes(sourceLang)) {
      console.log(`Skipping translation for lang ${sourceLang}`);
      return res.sendStatus(200);
    }

    // Перевод
    const translateParams = { client: 'gtx', sl: sourceLang, tl: TARGET_LANG, dt: 't', q: messageText };
    const translateRes = await axios.post('https://translate.googleapis.com/translate_a/single', null, { params: translateParams });
    const translatedText = translateRes.data?.[0]?.[0]?.[0];
    if (!translatedText) {
      console.log('Translation failed');
      return res.sendStatus(200);
    }
    console.log(`Translated: ${translatedText}`);

    // Добавляем note через /reply (как советует support)
    const noteBody = `📝 Auto-translation (${sourceLang} → ${TARGET_LANG}): ${translatedText}\n\nOriginal: ${messageText}`;
    const replyPayload = {
      admin_id: ADMIN_ID,
      type: 'note',  // Для internal note
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
          Accept: 'application/json'
          // Убрано Intercom-Version - пусть дефолт
        }
      }
    );
    console.log('Intercom response:', reply充Res.data);  // Дебаг ответа

    res.sendStatus(200);
  } catch (err) {
    console.error('Error details:', err.response?.data || err.message, err.stack);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
