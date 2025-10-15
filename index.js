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

// Полностью бесплатные API (без ключей и лимитов на ключи, только публичные instances/rate limits)
const LIBRE_INSTANCES = [  // Несколько instances LibreTranslate (Argos) - бесплатные, open-source, если один down - следующий
  'https://libretranslate.de/translate',  // Стабильный для zh, europe
  'https://libretranslate.com/translate',  // Официальный
  'https://translate.fedilab.app/translate',  // Fedilab instance
  'https://translate.argosopentech.com/translate',  // Argos main
  'https://libretranslate.cf/translate'  // Community fallback
];
const MYMEMORY_TRANSLATE_API_URL = 'https://api.mymemory.translated.net/get';  // Бесплатно без key (low rate ~5000 слов/day, но для вашего объема хватит)
const TRANSLATION_CACHE = new NodeCache({ stdTTL: 3600, checkperiod: 120, useClones: false });
const REQUEST_TIMEOUT = 8000;
const DEBUG = process.env.DEBUG === 'true';

const axiosInstance = axios.create({
  timeout: REQUEST_TIMEOUT,
  httpAgent: new http.Agent({ keepAlive: true })
});

// Env check
if (!INTERCOM_TOKEN || INTERCOM_TOKEN === 'Bearer ') process.exit(1);
if (!ADMIN_ID) process.exit(1);
console.log('Server starting with ENABLED:', ENABLED);
console.log(`Using ${LIBRE_INSTANCES.length} LibreTranslate instances for redundancy`);

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
              .replace(/<br\s*\/?>/gi, '\n')  // Сохраняем переносы для многострочных текстов
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

  let sourceLang = detectedLang && LANG_MAP[detectedLang] ? LANG_MAP[detectedLang] : 'auto';
  if (sourceLang.startsWith('zh')) sourceLang = 'zh';
  if (DEBUG) console.log('Normalized source lang for API:', sourceLang);

  let apiSource = sourceLang === 'zh' ? 'zh' : (sourceLang !== 'auto' ? sourceLang : 'auto');

  if (sourceLang === 'und' || SKIP_LANGS.includes(sourceLang)) {
    if (DEBUG) console.log('Skipping translation: Based on Intercom lang in SKIP_LANGS');
    return null;
  }

  if (sourceLang === TARGET_LANG) {
    if (DEBUG) console.log('Skipping translation: Source language matches target language');
    return null;
  }

  const cacheKey = `${text}:${sourceLang}:${TARGET_LANG}`;
  if (TRANSLATION_CACHE.has(cacheKey)) {
    if (DEBUG) console.log('Returning cached translation');
    return TRANSLATION_CACHE.get(cacheKey);
  }

  let result;

  // Для zh: force 'zh' и приоритет instances хорошие для азиатских
  if (sourceLang === 'zh') {
    for (const url of LIBRE_INSTANCES) {
      result = await translateWithLibre(text, 'zh', url);
      if (result) break;
    }
    if (!result) result = await translateWithMyMemory(text, 'zh');
  } else {
    for (const url of LIBRE_INSTANCES) {
      result = await translateWithLibre(text, apiSource, url);
      if (result) break;
    }
    if (!result) result = await translateWithMyMemory(text, apiSource);
  }

  if (!result) return null;

  const translation = { text: result.text, sourceLang: result.source, targetLang: TARGET_LANG };
  TRANSLATION_CACHE.set(cacheKey, translation);
  return translation;
}

async function translateWithLibre(q, source, url) {
  if (DEBUG) console.log(`Trying Libre instance ${url}: text="${q}", source=${source}`);
  try {
    const response = await axiosInstance.post(url, {
      q, source, target: TARGET_LANG, format: 'text'
    });
    const respData = response.data;
    if (DEBUG) console.log('Libre response:', JSON.stringify(respData, null, 2));

    let transText = respData.translatedText?.trim();
    if (!transText || transText.length < 1 || /menu-item|select|id=/.test(transText)) return null;

    const apiDetected = respData.detectedLanguage?.language || source;
    const confidence = respData.detectedLanguage?.confidence || 100;

    if (confidence < 70) return null;
    if (apiDetected === TARGET_LANG || SKIP_LANGS.includes(apiDetected)) return null;

    // Проверка на полный перевод: если оригинал имеет \n или >50 chars, а перевод короче 50% - skip to next
    if (q.includes('\n') && !transText.includes(' ') && transText.length < q.length / 2) {
      if (DEBUG) console.log('Incomplete translation detected, skipping instance');
      return null;
    }

    return { text: transText, source: apiDetected };
  } catch (e) {
    console.warn(`Libre ${url} failed: ${e.message} - switching to next`);
    return null;
  }
}

async function translateWithMyMemory(q, source) {
  if (DEBUG) console.log(`Trying MyMemory: text="${q}", source=${source}`);
  try {
    const langPair = source === 'auto' ? 'auto|en' : `${source}|en`;
    const response = await axiosInstance.get(MYMEMORY_TRANSLATE_API_URL, {
      params: { q, langpair: langPair }
    });
    const respData = response.data.responseData;
    const transText = response.data.matches[0]?.translation?.trim();
    if (!transText || transText.length < 1 || /menu-item|select/.test(transText)) return null;

    // Аналогичная проверка на полноту
    if (q.includes('\n') && transText.length < q.length / 2) return null;

    const detSource = respData.detectedLanguage || source;
    if (detSource === TARGET_LANG || SKIP_LANGS.includes(detSource)) return null;

    return { text: transText, source: detSource };
  } catch (e) {
    console.warn(`MyMemory failed: ${e.message}`);
    return null;
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
