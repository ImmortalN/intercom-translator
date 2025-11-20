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

// ======================== CONFIG ========================
const INTERCOM_TOKEN = `Bearer ${process.env.INTERCOM_TOKEN}`;
const ADMIN_ID = process.env.ADMIN_ID;
const ENABLED = process.env.ENABLED === 'true';
const DEBUG = process.env.DEBUG === 'true';

// Самые живучие бесплатные инстансы (ноябрь 2025)
const LIBRE_APIS = [
  'https://libretranslate.de/translate',
  'https://translate.argosopentech.com/translate',
  'https://translate.terraprint.co/translate'
];

const CACHE = new NodeCache({ stdTTL: 48 * 3600, checkperiod: 3600 });
const PROCESSED = new NodeCache({ stdTTL: 3600 }); // антиспам дублей

const axiosInstance = axios.create({
  timeout: 9000,
  httpAgent: new http.Agent({ keepAlive: true })
});

// ======================== УТИЛИТЫ ========================
function cleanText(text = '') {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Жёсткая, но точная защита от известного мусора
function isGarbage(translated, original) {
  if (!translated) return true;
  const t = translated.toLowerCase();
  if (t.includes('@@')) return true;
  if (t.includes('mainstre')) return true;
  if (t.includes('invalid source language')) return true;
  if (t.includes('is an invalid')) return true;
  if (translated.length > original.length * 6) return true;

  // повтор одного слова >10 раз
  const words = translated.split(/\s+/);
  const count = {};
  for (const w of words) {
    if (w.length > 2) {
      count[w] = (count[w] || 0) + 1;
      if (count[w] > 10) return true;
    }
  }
  return false;
}

function extractMessageText(conv) {
  const parts = conv.conversation_parts?.conversation_parts || [];
  const userPart = parts
    .filter(p => p.author?.type === 'user' && p.body)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];

  return cleanText(userPart?.body || conv.source?.body || '');
}

// ======================== ПЕРЕВОД ========================
async function translateMessage(text) {
  if (text.length < 4 || text.length > 4900) return null;

  // 1. Быстрая проверка — явно английский/русский/украинский?
  const detected = franc(text, { minLength: 3 });
  if (detected === 'eng' || detected === 'rus' || detected === 'ukr') {
    if (DEBUG) console.log('Пропуск: en/ru/uk', detected);
    return null;
  }

  // 2. Кэш
  const cacheKey = `tr:${text.substring(0, 200)}`;
  if (CACHE.has(cacheKey)) {
    const cached = CACHE.get(cacheKey);
    if (cached !== 'garbage') return cached;
    return null;
  }

  // 3. Перебираем три живых инстанса
  for (const url of LIBRE_APIS) {
    try {
      const res = await axiosInstance.post(url, {
        q: text,
        source: 'auto',
        target: 'en',
        format: 'text'
      }, { timeout: 8000 });

      const translated = (res.data?.translatedText || '').trim();
      if (!translated || translated === text.trim()) continue;
      if (isGarbage(translated, text)) {
        CACHE.set(cacheKey, 'garbage'); // больше не пытаемся
        continue;
      }

      const result = { 
        text: translated, 
        sourceLang: (res.data.detectedLanguage?.language || 'auto').slice(0, 2),
        targetLang: 'en'
      };

      CACHE.set(cacheKey, result);
      return result;

    } catch (e) {
      if (DEBUG) console.log(`Ошибка ${url.split('/')[2]}: ${e.message}`);
    }
  }

  // Если все упали — кэшируем, что это мусор, чтобы не долбить снова
  CACHE.set(cacheKey, 'garbage');
  return null;
}

// ======================== WEBHOOK ========================
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

    // Антидубль
    const hash = `${convId}:${text.substring(0, 80)}`;
    if (PROCESSED.has(hash)) return;
    PROCESSED.set(hash, true);

    const translation = await translateMessage(text);
    if (!translation) return;

    const note = `Auto-translation (${translation.sourceLang} to en):\n${translation.text}`;

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

    console.log(`Переведено [${translation.sourceLang} to en] — ${convId}`);
  } catch (err) {
    console.error('Ошибка webhook:', err.message);
  }
});

app.get('/intercom-webhook', (_, res) => res.send('OK'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Автопереводчик запущен на порту ${PORT}`));
