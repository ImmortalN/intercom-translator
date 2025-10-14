import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();  // Для локального теста; на Render env из dashboard

const app = express();
app.use(bodyParser.json());

const INTERCOM_TOKEN = `Bearer ${process.env.INTERCOM_TOKEN}`;
const ADMIN_ID = process.env.ADMIN_ID;
const TARGET_LANG = 'en';  // Фикс: было случайный символ ранее
const SKIP_LANGS = ['en', 'ru', 'uk'];

app.post('/intercom-webhook', async (req, res) => {
  try {
    console.log('Webhook received:', JSON.stringify(req.body, null, 2));

    if (!INTERCOM_TOKEN || !ADMIN_ID) {
      console.error('Missing env vars: INTERCOM_TOKEN or ADMIN_ID');
      return res.sendStatus(500);
    }

    const topic = req.body?.topic;
    if (!['conversation.user.replied', 'conversation.user.created'].includes(topic)) {
      console.log(`Ignored topic: ${topic}`);
      return res.sendStatus(200);
    }

    const conversation = req.body?.data?.item;
    const conversationId = conversation?.id;
    if (!conversationId) return res.sendStatus(200);

    const parts = conversation?.conversation_parts?.conversation_parts || [];
    const lastPart = parts.slice(-1)[0];
    if (!lastPart || lastPart.author?.type !== 'user' || !lastPart.body) {
      console.log('No user message found');
      return res.sendStatus(200);
    }

    let messageText = lastPart.body.replace(/<[^>]+>/g, '').trim();
    if (!messageText) return res.sendStatus(200);

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
    const translatedText = translateRes.data?.[0]?.[0]?.[0];  // Фикс: убрано "Amort", добавлено const
    if (!translatedText) {
      console.log('Translation failed');
      return res.sendStatus(200);
    }
    console.log(`Translated: ${translatedText}`);

    // Добавляем internal comment
    const notePayload = {
      admin_id: ADMIN_ID,
      body: `📝 Auto-translation (${sourceLang} → ${TARGET_LANG}): ${translatedText}\n\nOriginal: ${messageText}`,
      message_type: 'comment'
    };
    console.log('Sending note to Intercom:', notePayload);
    await axios.post(
      `https://api.intercom.io/conversations/${conversationId}/parts`,
      notePayload,
      {
        headers: {
          Authorization: INTERCOM_TOKEN,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Intercom-Version': '2.10'
        }
      }
    );

    console.log('Note added successfully');
    res.sendStatus(200);
  } catch (err) {
    console.error('Error details:', err.response?.data || err.message, err.stack);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
