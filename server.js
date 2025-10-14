import express from "express";
import bodyParser from "body-parser";
import axios from "axios";

const app = express();
app.use(bodyParser.json());

// 🔑 Твой токен Intercom (должен иметь права на conversations:reply)
const INTERCOM_TOKEN = "Bearer <YOUR_INTERCOM_TOKEN>";

// 🚀 Обработчик вебхуков Intercom
app.post("/intercom-webhook", async (req, res) => {
  try {
    console.log("📩 Incoming webhook:", JSON.stringify(req.body, null, 2));

    // Проверяем нужные типы событий
    const topic = req.body?.topic;
    if (!["conversation.user.replied", "conversation.user.created"].includes(topic)) {
      console.log("⚠️ Not a supported topic. Skipping.");
      return res.sendStatus(200);
    }

    const conversation = req.body?.data?.item;
    const conversationId = conversation?.id;
    if (!conversationId) {
      console.log("⚠️ Missing conversation ID");
      return res.sendStatus(200);
    }

    // Попробуем извлечь текст сообщения
    let messageText =
      req.body?.data?.item?.body ||
      req.body?.data?.item?.conversation_parts?.[0]?.body ||
      req.body?.data?.item?.part?.body ||
      req.body?.data?.item?.conversation_message?.body;

    if (!messageText) {
      console.log("⚠️ No message text found.");
      return res.sendStatus(200);
    }

    // Убираем HTML теги
    messageText = messageText.replace(/<[^>]+>/g, "").trim();
    console.log("💬 Extracted message:", messageText);

    // 🌍 Пример перевода с помощью Google Translate API
    const targetLang = "en"; // переведи на нужный язык
    const translateRes = await axios.post(
      "https://translate.googleapis.com/translate_a/single",
      null,
      {
        params: {
          client: "gtx",
          sl: "auto",
          tl: targetLang,
          dt: "t",
          q: messageText,
        },
      }
    );

    const translatedText = translateRes.data?.[0]?.[0]?.[0];
    console.log("📝 Translated:", translatedText);

    if (!translatedText) {
      console.log("⚠️ No translation received.");
      return res.sendStatus(200);
    }

    // 🗒️ Добавляем перевод как note в тот же разговор
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

    console.log("✅ Translation note added!");
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Error handling webhook:", err.response?.data || err.message);
    res.sendStatus(500);
  }
});

// health check
app.get("/", (req, res) => res.send("Intercom Auto-Translator is running 🚀"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server listening on port ${PORT}`));
