import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import http from 'http';
import dotenv from 'dotenv';
import NodeCache from 'node-cache';
import { franc } from 'franc';

dotenv.config();

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));

// ========================= CONFIG =========================
const INTERCOM_TOKEN = `Bearer ${process.env.INTERCOM_TOKEN}`;
const ADMIN_ID = process.env.ADMIN_ID;
const ENABLED = process.env.ENABLED === 'true';
const TARGET_LANG = 'en';
const SKIP_LANGS = new Set(['en', 'ru', 'uk']);
const DEBUG = process.env.DEBUG === 'true';

// Самые надёжные бесплатные инстансы (ноябрь 2025)
const LIBRE_APIS = [
  'https://libretranslate.de/translate',           // №1 по стабильности
  'https://translate.argosopentech.com/translate',
  'https://translate.terraprint.co/translate'
];

const CACHE = new NodeCache({ stdTTL: 48 * 3600, checkperiod: 3600 });
const PROCESSED = new NodeCache({ stdTTL: 3600 });

const axiosInstance = axios.create({
  timeout: 7500,
  httpAgent: new http.Agent({ keepAlive: true })
});

// ========================= УТИЛИТЫ =========================
function cleanText(text = '') {
  if (!text) return '';
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isObviouslyGarbage(text) {
  if (!text) return true;
  const lower = text.toLowerCase();
  if (lower.includes('invalid source language')) return true;
  if (lower.includes('auto')) return true;
  if (lower.includes('@@')) return true;
  if (lower.includes('mainstre')) return true;
  if (/^['"]?auto['"]? is an invalid/i.test(lower)) return true;
  if (text.length > 500 && text.split(' ').length < 10) return true; // повторяшки
  return false;
}

function extractMessageText(conv) {
  const parts = conv.conversation_parts?.conversation_parts || [];
  const userParts = parts
    .filter(p => p.author?.type === 'user' && p.body)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  
  return cleanText(userParts[0]?.body || conv.source?.body || '');
}

// ========================= ПЕРЕВОД =========================
async function translateMessage(text) {
  if (text.length > 4500) text = text.substring(0, 4500);
  if (text.length < 6) return null;

  // 1. Самая важная проверка — это английский?
  const detected = franc(text, { minLength: 6, whitelist: ['eng', 'rus', 'ukr', 'spa', 'deu', 'fra', 'ita', 'por', 'pol', 'ces', 'nld', 'tur', 'ara', 'cmn', 'jpn', 'kor'] });
  
  if (detected === 'eng' || detected === 'rus' || detected === 'ukr') {
    if (DEBUG) console.log('Язык определён как en/ru/uk — пропускаем перевод');
    return null;
  }

  const sourceLang = {
    spa: 'es', deu: 'de', fra: 'fr', ita: 'it', por: 'pt', pol: 'pl',
    ces: 'cs', nld: 'nl', tur: 'tr', ara: 'ar', cmn: 'zh', kor: 'ko', jpn: 'ja'
  }[detected] || 'auto';

  if (sourceLang !== 'auto' && (SKIP_LANGS.has(sourceLang) || sourceLang === TARGET_LANG)) {
    return null;
  }

  const cacheKey = `tr:${sourceLang}:${text.substring(0, 120)}`;
  if (CACHE.has(cacheKey)) return CACHE.get(cacheKey);

  for (const url of LIBRE_APIS) {
    try {
      const res = await axiosInstance.post(url, {
        q: text,
        source: sourceLang,
        target: TARGET_LANG,
        format: 'text'
      }, { timeout: 6500 });

      const translated = (res.data?.translatedText || res.data?.translation || '').trim();

      if (!translated || translated === text.trim()) continue;
      if (isObviouslyGarbage(translated)) {
        if (DEBUG) console.log(`Блокировка мусора от ${url}:`, translated.substring(0, 120));
        continue;
      }

      const finalSrc = (res.data.detectedLanguage?.language || sourceLang).toLowerCase();
      if (finalSrc === TARGET_LANG || SKIP_LANGS.has(finalSrc)) continue;

      const result = { text: translated, sourceLang: finalSrc, targetLang: TARGET_LANG };
      CACHE.set(cacheKey, result);
      return result;

    } catch (e) {
      if (DEBUG) console.log(`Ошибка ${url.split('/')[2]}: ${e.message}`);
    }
  }

  return null;
}

// ========================= ХЕНДЛЕР =========================
app.post('/intercom-webhook', async (req, res) => {
  res.sendStatus(200);
  if (!ENABLED) return;

  try {
    const { topic, data } = req.body;
    if (!['conversation.user.replied', 'conversation.user.created'].includes(topic)) return;

    const convId = data.item?.id;
    if (!convId) return;

    const text = extractMessageText(data.item);
    if (!text) return;

    const hash = `${convId}:${text.substring(0, 80)}`;
    if (PROCESSED.has(hash)) return;
    PROCESSED.set(hash, true);

    const translation = await translateMessage(text);
    if (!translation) return;

    const note = `Auto-translation (${translation.sourceLang} → en):\n${translation.text}`;

    await axiosInstance.post(
      `https://api.intercom.io/conversations/${convId}/reply`,
      {
        message_type: 'note',
        admin_id: ADMIN_ID,
        body: note
      },
      {
        headers: {
          Authorization: INTERCOM_TOKEN,
          'Intercom-Version': '2.11',
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`Переведено [${translation.sourceLang}→en] — ${convId}`);
  } catch (err) {
    console.error('Ошибка:', err.message);
  }
});

app.get('/intercom-webhook', (_, res) => res.send('OK'));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Автопереводчик запущен на порту ${PORT}`));
