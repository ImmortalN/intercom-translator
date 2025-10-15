import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import http from 'http';
import dotenv from 'dotenv';
import NodeCache from 'node-cache';
import { francAll } from 'franc-all';

dotenv.config();
const app = express();
app.use(bodyParser.json());

// Config
const INTERCOM_TOKEN = `Bearer ${process.env.INTERCOM_TOKEN}`;
const ADMIN_ID = process.env.ADMIN_ID;
const MYMEMORY_KEY = process.env.MYMEMORY_KEY || '';
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
  'ko': 'ko', 'ja': 'ja',
  'zh-TW': 'zh', 'zh-CN': 'zh'
};
const INTERCOM_API_VERSION = '2.11';
const INTERCOM_API_BASE = 'https://api.intercom.io';
const PRIMARY_TRANSLATE_API_URL = 'https://translate.fedilab.app/translate';
const FALLBACK_TRANSLATE_API_URL = 'https://libretranslate.com/translate';
const MYMEMORY_TRANSLATE_API_URL = 'https://api.mymemory.translated.net/get';
const TRANSLATION_CACHE = new NodeCache({ stdTTL: 3600, checkperiod: 120, useClones: false });
const REQUEST_TIMEOUT = 10000;
const DEBUG = process.env.DEBUG === 'true';  // Рекомендую false в проде

const axiosInstance = axios.create({
  timeout: REQUEST_TIMEOUT,
  httpAgent: new http.Agent({ keepAlive: true })
});

// Env check
if (!INTERCOM_TOKEN || INTERCOM_TOKEN === 'Bearer ') process.exit(1);
if (!ADMIN_ID) process.exit(1);
console.log('Server starting with ENABLED:', ENABLED);
if (MYMEMORY_KEY) console.log('MyMemory key loaded - rate limits reduced');

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

    const fullConversation = await fetchMinimalConversation(conversationId);
    if (!fullConversation) return;

    const messageText = extractMessageText(fullConversation, topic);
    if (DEBUG) console.log(`Extracted: "${messageText}"`);
    if (!messageText || messageText.length < 3) return;

    // Проверка на дубликат
    const cacheKeyPrev = `prev:${conversationId}`;
    const prevText = TRANSLATION_CACHE.get(cacheKeyPrev);
    if (prevText === messageText) {
      if (DEBUG) console.log('Duplicate message skipped');
      return;
    }

    let detectedLang = fullConversation?.language_override || 
                       fullConversation?.language || 
                       fullConversation?.custom_attributes?.Language || 
                       fullConversation?.source?.language || 
                       'auto';
    if (DEBUG) console.log('Detected language from Intercom:', detectedLang);

    const translation = await translateMessage(messageText, detectedLang);
    if (!translation) return;
    await createInternalNote(conversationId, translation);
    TRANSLATION_CACHE.set(cacheKeyPrev, messageText);  // Сохраняем для следующего
    console.log(`Processed ${conversationId} in ${Date.now() - start}ms`);
  } catch (error) {
    console.error('Webhook error:', error.message);
  }
});

async function fetchMinimalConversation(conversationId) {
  try {
    const response = await axiosInstance.get(
      `${INTERCOM_API_BASE}/conversations/${conversationId}`,
      {
        headers: {
          Authorization: INTERCOM_TOKEN,
          Accept: 'application/json',
          'Intercom-Version': INTERCOM_API_VERSION
        }
      }
    );
    if (DEBUG) console.log('Fetched conversation ID:', conversationId);
    return response.data;
  } catch (error) {
    console.error('Error fetching conversation:', error.message);
    if (error.response) console.error('Fetch error response:', error.response.data);
    return null;
  }
}

function extractMessageText(conversation, webhookTopic) {
  let rawBody = '';
  let parts = conversation?.conversation_parts?.conversation_parts || [];

  if (webhookTopic === 'conversation.user.created' && ['user', 'contact', 'lead'].includes(conversation?.source?.author?.type) && conversation.source.body) {
    rawBody = conversation.source.body;
    if (DEBUG) console.log('Using source.body for user.created');
  } else if (parts.length > 0) {
    if (DEBUG) console.log('Parts total count:', parts.length);
    parts = parts
      .filter(p => {
        const authorType = p?.author?.type;
        const partType = p?.part_type;
        // Только user/lead/contact и только comment
        return ['user', 'contact', 'lead'].includes(authorType) && partType === 'comment' && p?.body;
      })
      .sort((a, b) => (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0));
    if (DEBUG) console.log('Filtered client parts count:', parts.length);
    if (parts[0]) {
      rawBody = parts[0].body;
    }
  }
  if (DEBUG && rawBody) console.log('Raw body before clean:', rawBody);
  return cleanText(rawBody);
}

function cleanText(text) {
  if (!text) return '';
  text = text
    .replace(/<br\s*\/?>/gi, ' [LINEBREAK] ')
    .replace(/<\/p>/gi, ' [LINEBREAK] ')
    .replace(/<p>/gi, '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/id="[^"]*"/gi, '') 
    .replace(/class="[^"]*"/gi, '')
    .replace(/menu-item-\d+/gi, '')
    .replace(/license849 key[:\s]*[a-f0-9]{32}/gi, '')
    .replace(/https?:\S+/g, '')
    .replace(/&nbsp;|\u00A0|\u200B/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\[LINEBREAK\]/g, '\n')
    .trim();

  text = text.split('\n').map(line => line.trim()).filter(line => line.length > 0).join('\n');

  const lowerText = text.toLowerCase();
  if ((/[a-zA-Z]="[^"]*"/.test(text) || /menu|select|option|dropdown/.test(lowerText)) && text.length < 50) {
    if (DEBUG) console.log('Discarded as garbage:', text);
    return '';
  }
  return text;
}

async function translateMessage(text, detectedLang) {
  if (text.length > 5000) text = text.substring(0, 5000);

  let sourceLang = detectedLang && LANG_MAP[detectedLang] ? LANG_MAP[detectedLang] : 'auto';
  if (sourceLang.startsWith('zh')) sourceLang = 'zh';
  if (DEBUG) console.log('Normalized source lang for API:', sourceLang);

  let apiSource = sourceLang;
  if (sourceLang === 'auto') {
    let francCode = 'und';  
    try {
      francCode = francAll(text, { minLength: 3 });  
    } catch (err) {
      console.warn('Franc detection failed:', err.message);
    }
    const francMap = {
      'cmn': 'zh', 'yue': 'zh', 'zho': 'zh',  
      'eng': 'en', 'rus': 'ru', 'ukr': 'uk', 'spa': 'es', 'deu': 'de', 'fra': 'fr',
      'ita': 'it', 'por': 'pt', 'pol': 'pl', 'ces': 'cs', 'nld': 'nl', 'tur': 'tr',
      'ara': 'ar', 'kor': 'ko', 'jpn': 'ja'
    };
    apiSource = francMap[francCode] || LANG_MAP[francCode] || 'auto';
    if (DEBUG) console.log('Franc fallback detected:', francCode, '->', apiSource);
  }
  if (apiSource === 'zh-Hant' || apiSource === 'zh-Hans') apiSource = 'zh';

  if (apiSource === 'und' || SKIP_LANGS.includes(apiSource)) {
    if (DEBUG) console.log('Skipping translation: Language is undefined or in SKIP_LANGS');
    return null;
  }

  if (apiSource === TARGET_LANG) {
    if (DEBUG) console.log('Skipping translation: Source language matches target language');
    return null;
  }

  const cacheKey = `${text}:${apiSource}:${TARGET_LANG}`;
  if (TRANSLATION_CACHE.has(cacheKey)) {
    if (DEBUG) console.log('Returning cached translation');
    return TRANSLATION_CACHE.get(cacheKey);
  }

  try {
    const result = await translateWithAPI(text, apiSource, PRIMARY_TRANSLATE_API_URL);
    if (result) return cacheAndReturn(result.text, result.source);
  } catch (e) { console.warn('Primary API failed, trying MyMemory', e.message); }

  let result = await tryMyMemoryWithRetry(text, apiSource);
  if (result) return cacheAndReturn(result.text, result.source);

  try {
    result = await translateWithAPI(text, apiSource, FALLBACK_TRANSLATE_API_URL);
    if (result) return cacheAndReturn(result.text, result.source);
  } catch (e) { console.warn('Fallback API failed', e.message); }

  return null;

  async function translateWithAPI(q, source, url) {
    if (DEBUG) console.log(`Sending to API ${url}: text="${q}", source=${source}`);
    const response = await axiosInstance.post(url, {
      q, source, target: TARGET_LANG, format: 'text'
    });
    const respData = response.data;
    if (DEBUG) console.log('API response:', JSON.stringify(respData, null, 2));

    let transText = respData.translatedText?.trim();
    if (!transText || transText.length < 1 || transText === q.trim()) return null;

    const apiDetected = respData.detectedLanguage?.language || source;
    const confidence = respData.detectedLanguage?.confidence || 100;
    let detSource = source === 'auto' ? apiDetected : source;

    if (confidence < 50) return null;  
    if (detSource === TARGET_LANG || SKIP_LANGS.includes(detSource)) return null;

    return { text: transText, source: detSource };
  }

  async function tryMyMemoryWithRetry(q, source) {
    const lines = q.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    const translations = [];
    let detSource = source;

    const paramsBase = {
      langpair: source === 'auto' ? 'auto|en' : `${source}|en`
    };
    if (MYMEMORY_KEY) paramsBase.key = MYMEMORY_KEY;

    for (const line of lines) {
      let success = false;
      for (let retry = 0; retry < 3; retry++) {
        let response;
        try {
          const params = { ...paramsBase, q: line };
          response = await axiosInstance.get(MYMEMORY_TRANSLATE_API_URL, { params });
          success = true;
        } catch (err) {
          if (err.response?.status === 429) {
            const wait = 2000 * (retry + 1);
            console.warn(`MyMemory rate limit, waiting ${wait}ms and retry ${retry + 1}`);
            await new Promise(resolve => setTimeout(resolve, wait));
            continue;
          }
          console.warn('MyMemory request failed for line:', line, err.message);
          break;
        }
        const respData = response.data.responseData;
        const match = response.data.matches[0]?.translation?.trim();
        if (!match || match === line.trim()) break;

        translations.push(match);
        if (!detSource || detSource === 'auto') {
          detSource = respData.detectedLanguage || source;
        }
        break;
      }
      if (!success) continue;
    }

    if (translations.length === 0) return null;
    const transText = translations.join('\n');

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
    const noteBody = `Auto-translation (${translation.sourceLang} → ${translation.targetLang}): ${translation.text}`;
    await axiosInstance.post(
      `${INTERCOM_API_BASE}/conversations/${conversationId}/reply`,
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
