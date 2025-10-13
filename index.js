const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const ENABLED = process.env.ENABLED === 'true';
const TARGET_LANG = process.env.TARGET_LANG || 'en';

app.get('/', (req, res) => {
  res.send('Server is running. Webhook endpoint: /webhook');
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // сразу 200 для Intercom

  if (!ENABLED) return;

  console.log('Webhook payload:', JSON.stringify(req.body, null, 2));

  let messageText = req.body?.data?.item?.body;
  if (!messageText) {
    messageText = req.body?.data?.item?.conversation_parts?.conversation_parts[0]?.body;
  }

  // Убираем HTML теги
  if (messageText) messageText = messageText.replace(/<[^>]+>/g, '').trim();

  let conversationId = req.body?.data?.item?.id || req.body?.data?.item?.conversation?.id;

  if (!messageText || !conversationId) {
    console.log('No message text or conversation ID found. Skipping.');
    return;
  }

  try {
    const translateResponse = await axios.post('https://libretranslate.com/translate', {
      q: messageText,
      source: 'auto',
      target: TARGET_LANG,
      format: 'text'
    });

    const translatedText = translateResponse.data.translatedText;

    await axios.post(
      `https://api.intercom.io/conversations/${conversationId}/reply`,
      {
        type: 'note',
        message_type: 'comment',
        body: `📝 Перевод: ${translatedText}`
      },
      {
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`Message translated for conversation ${conversationId}: ${translatedText}`);
  } catch (err) {
    console.error('Error translating message:', err.response?.data || err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
