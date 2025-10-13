const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// Переменные окружения
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN; // токен Intercom
const ENABLED = process.env.ENABLED === 'true';     // включение/выключение автоперевода
const TARGET_LANG = process.env.TARGET_LANG || 'en'; // язык перевода

// Тестовая страница для проверки сервера
app.get('/', (req, res) => {
  res.send('Server is running. Webhook endpoint: /webhook');
});

// Webhook для Intercom
app.post('/webhook', async (req, res) => {
  // Сразу отвечаем 200, чтобы Intercom считал запрос успешным
  res.sendStatus(200);

  if (!ENABLED) return;

  // Логируем полный payload для отладки
  console.log('Webhook payload:', JSON.stringify(req.body, null, 2));

  // Пытаемся извлечь текст сообщения
  let messageText = req.body?.data?.item?.body;
  if (!messageText) {
    // fallback для реальных payload
    messageText = req.body?.data?.item?.conversation_parts?.conversation_parts[0]?.body;
  }

  // Получаем правильный conversation ID
  let conversationId = req.body?.data?.item?.id || req.body?.data?.item?.conversation?.id;

  if (!messageText || !conversationId) {
    console.log('No message text or conversation ID found. Skipping.');
    return;
  }

  try {
    // Переводим сообщение через LibreTranslate
    const translateResponse = await axios.post('https://libretranslate.com/translate', {
      q: messageText,
      source: 'auto',
      target: TARGET_LANG,
      format: 'text'
    });

    const translatedText = translateResponse.data.translatedText;

    // Отправляем Internal Note в Intercom
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
    console.error('Error translating message:', err.message);
  }
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
