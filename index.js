const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// Переменные окружения
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN; // токен Intercom
const ENABLED = process.env.ENABLED === 'true';     // включение/выключение
const TARGET_LANG = process.env.TARGET_LANG || 'en'; // язык перевода

// Webhook для Intercom
app.post('/webhook', async (req, res) => {
  // Сразу отвечаем 200, чтобы Intercom тест прошёл
  res.sendStatus(200);

  // Если автоперевод выключен — ничего не делаем
  if (!ENABLED) return;

  // Проверяем, есть ли текст сообщения
  const messageText = req.body?.data?.item?.body;
  if (!messageText) return;

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
      `https://api.intercom.io/conversations/${req.body.data.item.id}/reply`,
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

    console.log(`Message translated: ${translatedText}`);
  } catch (err) {
    console.error('Error translating message:', err.message);
  }
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
