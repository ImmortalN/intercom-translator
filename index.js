import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import http from 'http';
import dotenv from 'dotenv';
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
  'en': 'en', 'ru': 'ru', 'uk': 'uk', 'es': 'es', 'de': 'de', 'fr': 'fr',
  'it': 'it', 'pt': 'pt', 'pl': 'pl', 'cs': 'cs', 'nl': 'nl', 'tr': 'tr',
  'ar': 'ar', 'zh': 'zh', 'zh-Hant': 'zh', 'zh-Hans': 'zh',
  'English': 'en', 'Russian': 'ru', 'Ukrainian': 'uk', 'Spanish': 'es',
  'German': 'de', 'French': 'fr', 'Italian': 'it', 'Portuguese': 'pt',
  'Polish': 'pl', 'Czech': 'cs', 'Dutch': 'nl', 'Turkish': 'tr',
  'Arabic': 'ar', 'Chinese': 'zh',
  'Chinese (Taiwan)': 'zh-Hant', 'Chinese (Simplified)': 'zh-Hans', 'Chinese (Traditional)': 'zh-Hant', 'Traditional Chinese': 'zh-Hant',
  'ko': 'ko', 'ja': 'ja'
};
const INTERCOM_API_VERSION = '2.11';
const PRIMARY_TRANSLATE_API_URL = 'https://translate.fedilab.app/translate';
const FALLBACK_TRANSLATE_API_URL = 'https://libretranslate.com/translate';
const MYMEMORY_TRANSLATE_API_URL = 'https://api.mymemory.translated.net/get';
const TRANSLATION_CACHE = new NodeCache({ stdTTL: 3600, checkperiod: 120, useClones: false });
const REQUEST_TIMEOUT = 5000;
const DEBUG = process.env.DEBUG === 'true';

const axiosInstance = axios.create({
  timeout: REQUEST_TIMEOUT,
  httpAgent: new http.Agent({ keepAlive: true })
});

// Env check
if (!INTERCOM_TOKEN || INTERCOM_TOKEN === 'Bearer ') process.exit(1);
if (!ADMIN_ID) process.exit(1);
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
    if (DEBUG) console.log(`Extracted: "${messageText}"`);
    if (!messageText || messageText.length < 3) return;

    if (DEBUG) console.log('Conversation object:', JSON.stringify(conversation, null, 2));

    let detectedLang = conversation?.language_override || 
                       conversation?.language || 
                       conversation?.custom_attributes?.Language || 
                       conversation?.source?.language || 
                       'auto';
    if (DEBUG) console.log('Detected language from Intercom:', detectedLang);

    const translation = await translateMessage(messageText, detectedLang);
    if (!translation) return;
    await createInternalNote(conversationId, translation);
    console.log(`Processed ${conversationId} in ${Date.now() - start}ms`);
  } catch (error) {
    console.error('Webhook error:', error.message);
  }
});

function extractMessageText(conversation) {
  let parts = conversation?.conversation_parts?.conversation_parts || [];
  let rawBody = '';
  if (parts.length > 0) {
    if (DEBUG) console.log('Parts count:', parts.length);
    parts = parts
      .filter(p => p?.author?.type === 'user' && p?.body)
      .sort((a, b) => (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0));
    if (parts[0]) {
      rawBody = parts[0].body;
    }
  }
  if (!rawBody && conversation?.source?.author?.type === 'user' && conversation.source.body) {
    rawBody = conversation.source.body;
  }
  if (DEBUG && rawBody) console.log('Raw body before clean:', rawBody);
  return cleanText(rawBody);
}

function cleanText(text) {
  if (!text) return '';
  text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
              .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
              .replace(/<[^>]+>/g, ' ')
              .replace(/id="[^"]*"/gi, '') 
              .replace(/class="[^"]*"/gi, '')
              .replace(/menu-item-\d+/gi, '')
              .replace(/license849 key[:\s]*[a-f0-9]{32}/gi, '')
              .replace(/https?:\S+/g, '')
              .replace(/&nbsp;|\u00A0|\u200B/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();

  if (/[a-zA-Z]="[^"]*"/.test(text) || /menu|select|option|dropdown/.test(text.toLowerCase())) {
    if (DEBUG) console.log('Discarded as garbage:', text);
    return '';
  }
  return text;
}

async function translateMessage(text, detectedLang) {
  if (text.length > 1000) text = text.substring(0, 1000);

  // Ключ: ВСЕГДА используем 'auto' для source в API, игнорируя Intercom detectedLang для source
  // Потому что Intercom может ошибаться (как в вашем примере с "a Ok, voy a ello..." на Chinese), а API детект лучше справится с миксом.
  // Только SKIP_LANGS проверяем если forced, но здесь auto.
  const apiSource = 'auto';  // Фикс для мультиязыка и ошибок Intercom
  let intercomSource = detectedLang && LANG_MAP[detectedLang] ? LANG_MAP[detectedLang] : 'auto';
  if (intercomSource.startsWith('zh')) intercomSource = 'zh';

  if (intercomSource === 'und' || SKIP_LANGS.includes(intercomSource)) {
    if (DEBUG) console.log('Skipping translation: Based on Intercom lang in SKIP_LANGS');
    return null;
  }

  // Если Intercom говорит en/ru/uk, skip даже если текст микс (доверяем Intercom для skip, но переводим если API увидит другое? Нет, skip рано.
  if (SKIP_LANGS.includes(intercomSource)) return null;

  const cacheKey = `${text}:${apiSource}:${TARGET_LANG}`;
  if (TRANSLATION_CACHE.has(cacheKey)) {
    if (DEBUG) console.log('Returning cached translation');
    return TRANSLATION_CACHE.get(cacheKey);
  }

  let translatedText, finalSource;
  try {
    const result = await translateWithAPI(text, apiSource, PRIMARY_TRANSLATE_API_URL);
    if (result) return cacheAndReturn(result.text, result.source);
  } catch (e) { console.warn('Primary API failed, trying fallback'); }

  try {
    const result = await translateWithAPI(text, apiSource, FALLBACK_TRANSLATE_API_URL);
    if (result) return cacheAndReturn(result.text, result.source);
  } catch (e) { console.warn('Fallback1 API failed, trying MyMemory'); }

  try {
    const result = await translateWithMyMemory(text, apiSource);
    if (result) return cacheAndReturn(result.text, result.source);
  } catch (e) { console.error('All APIs failed'); }

  return null;

  async function translateWithAPI(q, source, url) {
    if (DEBUG) console.log(`Sending to API ${url}: text="${q}", source=${source}`);
    const response = await axiosInstance.post(url, {
      q, source, target: TARGET_LANG, format: 'text'
    });
    const respData = response.data;
    if (DEBUG) console.log('API response:', JSON.stringify(respData, null, 2));

    let transText = respData.translatedText?.trim();
    if (!transText || transText.length < 1 || /menu-item|select/.test(transText)) return null;

    const apiDetected = respData.detectedLanguage?.language || 'unknown';
    let detSource = source === 'auto' ? apiDetected : intercomSource;

    // Если translated почти равен original (для микс: если детект en но текст es, переведёт только es часть, но ок)
    if (transText === q.trim() && detSource !== TARGET_LANG) return null;  // Только если не изменилось и не target

    const confidence = respData.detectedLanguage?.confidence || 100;
    if (confidence < 50) return null;  // Низкая уверенность - skip

    if (detSource === TARGET_LANG || SKIP_LANGS.includes(detSource)) return null;

    return { text: transText, source: detSource };
  }

  async function translateWithMyMemory(q, source) {
    const langPair = `${source === 'auto' ? 'auto' : source}|en`;
    const response = await axiosInstance.get(MYMEMORY_TRANSLATE_API_URL, {
      params: { q, langpair: langPair }
    });
    const respData = response.data.responseData;
    const matches = response.data.matches || [];
    let transText = matches[0]?.translation?.trim();
    if (!transText) return null;

    let detSource = respData.detectedLanguage || 'unknown';
    if (detSource === TARGET_LANG || SKIP_LANGS.includes(detSource)) return null;

    return { text: transText, source: detSource };
  }

  function cacheAndReturn(text, src) {
    const translation = { text, sourceLang: src, targetLang: TARGET_LANG };
    TRANSLATION_CACHE.set(cacheKey, translation);
    return translation;
  }
}

async function createInternalNote(conversationId, translation) {
  try {
    const noteBody = `📝 Auto-translation (${translation.sourceLang} → ${translation.targetLang}): ${translation.text}`;
    await axiosInstance.post(
      `https://api.intercom.io/conversations/${conversationId}/reply`,
      { message_type: 'note', admin_id: ADMIN_ID, body: noteBody },
      {
        headers: {
          Authorization: INTERCOM_TOKEN,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Intercom-Version': INTERCOM_API_VERSION
        }
      }
    );
    if (DEBUG) console.log('Internal note created successfully');
  } catch (error) {
    console.error('Note error:', error.message);
    if (error.response) console.error('Note error response:', error.response.data);
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server on ${PORT}`));
