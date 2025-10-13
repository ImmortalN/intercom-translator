const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const ENABLED = process.env.ENABLED === 'true';
const TARGET_LANG = process.env.TARGET_LANG || 'en';

app.post('/webhook', async (req, res) => {
  if (!ENABLED) return res.sendStatus(200);

  const messageText = req.body?.data?.item?.body;
  if (!messageText) return res.sendStatus(200);

  try {
    const translateResponse = await axios.post('https://libretranslate.com/translate', {
      q: messageText,
      source: 'auto',
      target: TARGET_LANG,
      format: 'text'
    });

    const translatedText = translateResponse.data.translatedText;

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

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
