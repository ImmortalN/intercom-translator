import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import http from 'http';
import dotenv from 'dotenv';
import NodeCache from 'node-cache';
import crypto from 'node:crypto';
import { franc } from 'franc';

dotenv.config();

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));

// ========================= CONFIG =========================
const INTERCOM_TOKEN = `Bearer ${process.env.INTERCOM_TOKEN?.trim()}`;
const ADMIN_ID = process.env.ADMIN_ID?.trim();
const DEEPL_KEY = process.env.DEEPL_KEY?.trim();
const MYMEMORY_KEY = process.env.MYMEMORY_KEY?.trim();
const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL?.trim();

const ENABLED = process.env.ENABLED === 'true';
const DEBUG = process.env.DEBUG === 'true';
const TARGET_LANG = 'en';
const SKIP_LANGS = new Set(['en', 'ru', 'uk']);
const MIN_WORDS_FOR_TRANSLATION = 3;
const INTERCOM_API_VERSION = '2.11';
const INTERCOM_API_BASE = 'https://api.intercom.io';

const CACHE = new NodeCache({ stdTTL: 4 * 3600, checkperiod: 600 });
const PROCESSED = new NodeCache({ stdTTL: 300, checkperiod: 120 });

const axiosInstance = axios.create({
  timeout: 15000,
  httpAgent: new http.Agent({ keepAlive: true }),
  headers: { 'User-Agent': 'IntercomAutoTranslate/8.7' }
});

// Lingva публичные инстансы (без ключа)
const LINGVA_BASES = [
  'https://lingva.ml/api/v1',
  'https://translate.ploud.jp/api/v1',
  'https://lingva.garudalinux.org/api/v1',
  'https://lingva.lunar.icu/api/v1'
  // добавь новые из https://github.com/thedaviddelta/lingva-translate#instances
];

// LibreTranslate публичные (без ключа)
const LIBRE_APIS = [
  'https://translate.argosopentech.com/translate',
  'https://translate.terraprint.co/translate',
  'https://libretranslate.de/translate'
];

// ========================= УТИЛИТЫ =========================
// cleanText, isGarbage, isProbablyEnglish, extractTextFromWebhook, detectLanguageFallback — оставляем как есть

// ========================= ПЕРЕВОД =========================
async function translate(text, preferredLang = 'auto') {
  if (text.length > 5000) text = text.substring(0, 5000);

  let langCode = preferredLang.toLowerCase();
  if (langCode === 'auto') langCode = detectLanguageFallback(text);

  if (SKIP_LANGS.has(langCode)) {
    if (DEBUG) console.log(`[SKIP LANG] ${langCode}`);
    return null;
  }

  const cacheKey = `tr:${langCode}:${text.substring(0, 150)}`;
  if (CACHE.has(cacheKey)) {
    const cached = CACHE.get(cacheKey);
    if (cached === 'english') return null;
    if (DEBUG) console.log('[CACHE HIT]');
    return cached;
  }

  let result = null;

  // 1. DeepL
  if (DEEPL_KEY) {
    if (DEBUG) console.log('[TRY DEEPL]');
    result = await tryDeepL(text);
    if (result) return finalizeResult(result, text, cacheKey);
  }

  // 2. Lingva Translate (первый fallback по твоему желанию)
  if (DEBUG) console.log('[TRY LINGVA]');
  result = await tryLingva(text, langCode);
  if (result) return finalizeResult(result, text, cacheKey);

  // 3. Google Translate unofficial gtx (второй fallback)
  if (DEBUG) console.log('[TRY GOOGLE GTX]');
  result = await tryGoogleGTX(text, langCode);
  if (result) return finalizeResult(result, text, cacheKey);

  // 4. LibreTranslate
  if (DEBUG) console.log('[TRY LIBRETRANSLATE]');
  result = await tryLibreTranslate(text, langCode);
  if (result) return finalizeResult(result, text, cacheKey);

  // 5. MyMemory
  if (DEBUG) console.log('[TRY MYMEMORY]');
  result = await tryMyMemory(text);
  if (result) return finalizeResult(result, text, cacheKey);

  return null;
}

function finalizeResult(result, text, cacheKey) {
  if (isProbablyEnglish(text, result.text)) {
    CACHE.set(cacheKey, 'english');
    return null;
  }
  CACHE.set(cacheKey, result);
  return result;
}

// tryDeepL — без изменений

async function tryLingva(text, sourceLang) {
  for (const base of LINGVA_BASES) {
    try {
      const sl = sourceLang === 'auto' ? 'auto' : sourceLang;
      const url = `${base}/${sl}/en/${encodeURIComponent(text)}`;

      const res = await axiosInstance.get(url);
      const translated = res.data?.translation?.trim();

      if (translated && translated.length > 3 && !isGarbage(translated)) {
        if (DEBUG) console.log(`[LINGVA OK] ${base.split('//')[1].split('/')[0]}`);
        return { text: translated, sourceLang: sourceLang };
      }
    } catch (err) {
      if (DEBUG) console.log(`[LINGVA ERR] ${base} → ${err.message} (${err.response?.status || ''})`);
    }
  }
  return null;
}

async function tryGoogleGTX(text, sourceLang) {
  try {
    // Пауза, чтобы снизить риск бана IP
    await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000)); // 1.5–2.5 сек

    const sl = sourceLang === 'auto' ? 'auto' : sourceLang;
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=${sl}&tl=en&q=${encodeURIComponent(text)}`;

    const res = await axiosInstance.get(url);
    // Структура ответа gtx: [ [[translated, original, ...]], null, detected_lang, ... ]
    const translatedParts = res.data?.[0] || [];
    let translated = '';
    translatedParts.forEach(part => { if (part[0]) translated += part[0]; });
    translated = translated.trim();

    const detected = res.data?.[2] || sourceLang;

    if (translated && translated.length > 3) {
      if (DEBUG) console.log(`[GOOGLE GTX OK] ${detected} → en`);
      return { text: translated, sourceLang: detected.toLowerCase() };
    }
  } catch (err) {
    if (DEBUG) console.log(`[GOOGLE GTX ERR] ${err.message} (${err.response?.status || ''})`);
  }
  return null;
}

// tryLibreTranslate и tryMyMemory — без изменений

// createNote, webhook handler, app.listen — без изменений, только обнови версию в логах

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Автопереводчик v8.7 запущен (DeepL → Lingva → Google GTX → Libre → MyMemory)`);
  console.log(`→ DeepL: ${DEEPL_KEY ? 'ВКЛ' : 'ВЫКЛ'}`);
  console.log(`→ Lingva: ${LINGVA_BASES.length} публичных инстансов`);
  console.log(`→ Google GTX: unofficial (с паузой)`);
  console.log(`→ Libre: ${LIBRE_APIS.length} зеркал`);
  console.log(`→ MyMemory: ${MYMEMORY_KEY || MYMEMORY_EMAIL ? 'ВКЛ' : 'анонимно'}`);
  console.log(`→ Порт: ${PORT}`);
});
