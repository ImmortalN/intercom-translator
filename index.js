const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const ENABLED = process.env.ENABLED === 'true';
const TARGET_LANG = process.env.TARGET_LANG || 'en';

// Проверка, что сервер работает
app.get('/', (req, res) => {
  res.send('✅ Server is running. Webhook endpoint: /webhook');
});

// Основной обработчик вебхуков
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Intercom требует быстрый ответ

  if (!ENABLED) return;

  console.log('📩 Incoming webhook:');
  console.log(JSON.stringify(req.body, null, 2));

  // --- 1. Извлекаем текст сообщения из возможных мест ---
  let messageText = req.body?.data?.item?.body ||
                    req.body?.data?.item?.conversation_parts?.[0]?.body ||
                    req.body?.data?.item?.part?.body ||
                    req.body?.data?.item?.conversation_message?.body;

  if (!messageText) {
    console.log('⚠️ No message text found. Skipping.');
    return;
  }

  // --- 2. Убираем HTML-теги ---
  messageText = messageText.replace(/<[^>]+>/g, '').trim();

  // --- 3. Получаем ID диалога ---
  let conversationId = req.body?.data?.item?.id ||
                       req.body?.data?.item?.conversation?.id;

  if (!conversationId) {
    console.log('⚠️ No conversation ID found. Skipping.');
    return;
  }

  // --- 4. Переводим сообщение ---
  try {
    console.log(`🌐 Translating message: "${messageText}"`);
    const translateResponse = await axios.post('https://libretranslate.com/translate', {
      q: messageText,
      source: 'auto',
      target: TARGET_LANG,
      format: 'text'
    });

    const translatedText = translateResponse.data.translatedText;
    console.log(`✅ Translation result: ${translatedText}`);

    // --- 5. Добавляем перевод как Internal Note ---
    await axios.post(
      `https://api.intercom.io/conversations/${conversationId}/reply`,
      {
        type: 'note',
        message_type: 'comment',
        body: `📝 Translation (${TARGET_LANG}): ${translatedText}`
      },
      {
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`💬 Note added to conversation ${conversationId}`);
  } catch (err) {
    console.error('❌ Error translating or posting note:', err.response?.data || err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
