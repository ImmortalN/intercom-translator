// index.js
import express from "express";
import bodyParser from "body-parser";
import axios from "axios";

const app = express();
app.use(bodyParser.json());

// 🔑 Токен Intercom (замени на свой)
const INTERCOM_TOKEN = "Bearer <YOUR_INTERCOM_TOKEN>";

// 🔧 Целевой язык перевода (например, английский)
const TARGET_LANG = "en";

// Вебхук для Intercom
app.post("/intercom-webhook", async (req, res) => {
  try {
    const topic = req.body?.topic;
    if (!["conversation.user.replied", "conversation.user.created"].includes(topic)) {
      return res.sendStatus(200);
    }

    const conversation = req.body?.data?.item;
    const conversationId = conversation?.id;
    if (!conversationId) return res.sendStatus(200);

    // Получаем текст сообщения без HTML тегов
    let messageText = conversation?.body?.replace(/<[^>]+>/g, "").trim();
    if (!messageText) return res.sendStatus(200);

    // 🔄 Перевод через Google Translate (бесплатный endpoint)
    const translateRes = await axios.post(
      "https://translate.googleapis.com/translate_a/single",
      null,
      {
        params: {
          client: "gtx",
          sl: "auto",
          tl: TARGET_LANG,
          dt: "t",
          q: messageText,
        },
      }
    );

    const translatedText = translateRes.data?.[0]?.[0]?.[0];
    if (!translatedText) return res.sendStatus(200);

    // 📝 Добавляем note в Intercom
    await axios.post(
      `https://api.intercom.io/conversations/${conversationId}/reply`,
      {
        type: "note",
        message_type: "comment",
        body: `📝 Translation: ${translatedText}`,
      },
      {
        headers: {
          Authorization: INTERCOM_TOKEN,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }
    );

    console.log(`Translated conversation ${conversationId}: ${translatedText}`);
    res.sendStatus(200);

  } catch (err) {
    console.error("Error:", err.response?.data || err.message);
    res.sendStatus(500);
  }
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
