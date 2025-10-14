import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import http from 'http';  // Для keep-alive
import dotenv from 'dotenv';
import { franc } from 'franc';
import NodeCache from 'node-cache';

dotenv.config();

const app = express();
app.use(bodyParser.json());

// Config
const INTERCOM_TOKEN = `Bearer ${process.env.INTERCOM_TOKEN}`;
const ADMIN_ID = process.env.ADMIN_ID;
const ENABLED = process.env.ENABLED === 'true';
const TARGET_LANG = 'en';
const SKIP_LANGS = ['en', 'ru', 'uk'];
const LANG_MAP = {
  'eng': 'en', 'rus': 'ru', 'ukr': 'uk', 'spa': 'es', 'deu': 'de', 'fra': 'fr',
  'ita': 'it', 'por': 'pt', 'pol': 'pl', 'ces': 'cs', 'nld': 'nl', 'tur': 'tr',
  'ara': 'ar', 'cmn': 'zh'
};
const INTERCOM_API_VERSION = '2.14';
const TRANSLATE_API_URL = 'https://translate.fedilab.app/translate';
const TRANSLATION_CACHE = new NodeCache({ stdTTL: 3600, checkperiod: 120, useClones: false });
const REQUEST_TIMEOUT = 3000;
const DEBUG = process.env.DEBUG === 'true';
const axiosInstance = axios.create({
  timeout: REQUEST_TIMEOUT,
  httpAgent: new http.Agent({ keepAlive: true })  // Keep-alive для скорости
});

// Env check
if (!INTERCOM_TOKEN || INTERCOM_TOKEN === 'Bearer ') {
  console.error('Fatal: INTERCOM_TOKEN missing');
  process.exit(1);
}
if (!ADMIN_ID) {
  console.error('Fatal: ADMIN_ID missing');
  process.exit(1);
}
console.log('Server starting with ENABLED:', ENABLED);

app.get('/intercom-webhook', (req, res) => res.status(200).send('Webhook verified'));

app.post('/intercom-webhook', async (req, res) => {
  const start = Date.now();
  try {
    res.sendStatus(200);
    if (!ENABLED) return;

    const { topic, data } = req.body;
    if (!['conversation.user.replied', 'conversation.user.created'].includes(topic)) return;

    const conversation = data?.item;
    const conversationId = conversation?.id;
    if (!conversationId) return;

    const messageText = extractMessageText(conversation);
    if (DEBUG) console.log(`Extracted for ${conversationId}: "${messageText}"`);
    if (!messageText || messageText.length < 3) return;

    const translation = await translateMessage(messageText);
    if (!translation) return;

    await createInternalNote(conversationId, translation);
    console.log(`Processed ${conversationId} in ${Date.now() - start}ms`);
  } catch (error) {
    console.error('Webhook error:', error.message);
  }
});

function extractMessageText(conversation) {
  let parts = conversation?.conversation_parts?.conversation_parts || [];
  if (parts.length > 0) {
    parts = parts
      .filter(p => p?.author?.type !== 'bot' && p?.body)
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    if (parts[0]) return cleanText(parts[0].body);
  }
  if (conversation?.source?.body && conversation.source.author.type !== 'bot') {
    return cleanText(conversation.source.body);
  }
  return null;
}

function cleanText(text) {
  if (!text) return '';
  return text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

async function translateMessage(text) {
  if (text.length > 1000) text = text.substring(0, 1000);  // Лимит для API

  const francCode = franc(text, { minLength: 3 });
  if (DEBUG) console.log(`Franc: ${francCode} for "${text.substring(0, 50)}..."`);

  if (francCode === 'und') return null;

  const sourceLang = LANG_MAP[francCode] || 'auto';
  if (SKIP_LANGS.includes(sourceLang)) return null;

  // Опциональный скип для ключей (удалите если не нужно)
  // if (/license key/i.test(text) || /^[a-f0-9]{32}$/i.test(text.trim())) return null;

  const cacheKey = `${text}:${sourceLang}:${TARGET_LANG}`;
  if (TRANSLATION_CACHE.has(cacheKey)) return TRANSLATION_CACHE.get(cacheKey);

  try {
    const apiSource = sourceLang === 'auto' ? 'auto' : sourceLang;
    const response = await axiosInstance.post(TRANSLATE_API_URL, {
      q: text, source: apiSource, target: TARGET_LANG, format: 'text'
    });
    const translatedText = response.data.translatedText;
    if (!translatedText) return null;

    const finalSource = apiSource === 'auto' ? (response.data.detectedLanguage?.language || sourceLang) : sourceLang;
    const translation = { text: translatedText, sourceLang: finalSource, targetLang: TARGET_LANG };
    TRANSLATION_CACHE.set(cacheKey, translation);
    return translation;
  } catch (error) {
    console.error('Translation error:', error.message);
    return null;
  }
}

async function createInternalNote(conversationId, translation) {
  try {
    const noteBody = `📝 Auto-translation (${translation.sourceLang} → ${translation.targetLang}): ${translation.text}`;
    await axiosInstance.post(
      `https://api.intercom.io/conversations/${conversationId}/reply`,
      { message_type: 'note', admin_id: ADMIN_ID, body: noteBody },
      { headers: {
        Authorization: INTERCOM_TOKEN,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Intercom-Version': INTERCOM_API_VERSION
      }}
    );
  } catch (error) {
    console.error('Note error for', conversationId, ':', error.message);
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
