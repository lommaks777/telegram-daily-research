import Parser from 'rss-parser';
import OpenAI from 'openai';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import pLimit from 'p-limit';

const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('Missing TG_BOT_TOKEN or TG_CHAT_ID');
  process.exit(1);
}

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const parser = new Parser({ timeout: 15000 });

// ===== Источники (редактируй под себя) =====
const FEEDS = {
  sales: [
    'https://blog.hubspot.com/marketing/rss.xml',
    'https://blog.hubspot.com/sales/rss.xml',
    'https://cxl.com/blog/feed/',
    'https://www.producthunt.com/feed'
  ],
  edtech: [
    'https://www.classcentral.com/report/feed/',
    'https://www.edsurge.com/articles_rss',
    'https://www.reddit.com/r/edtech/.rss',
    'https://edtechmagazine.com/k12/rss.xml'
  ],
  massage: [
    'https://www.reddit.com/r/massage/.rss',
    'https://www.reddit.com/r/MassageTherapists/.rss',
    'https://news.google.com/rss/search?q=massage%20therapy%20study%20OR%20randomized%20controlled%20trial&hl=en-US&gl=US&ceid=US:en'
  ]
};

const FRESH_HOURS = 72;                // «свежесть» материалов
const PER_SECTION = 2;                 // карточек из каждой категории
const CONCURRENCY = 3;                 // параллелизм
const MAX_CHARS_PER_ARTICLE = 8000;    // сколько текста отдаём в GPT

function toTs(dateLike) {
  const d = dateLike ? new Date(dateLike) : null;
  return d && !Number.isNaN(d.valueOf()) ? d.valueOf() : 0;
}

async function pickLatest(feedUrls, take = PER_SECTION) {
  const all = [];
  for (const url of feedUrls) {
    try {
      const feed = await parser.parseURL(url);
      for (const item of (feed.items || [])) {
        const ts = toTs(item.isoDate || item.pubDate || item.published || item.date);
        all.push({
          source: feed.title || url,
          title: item.title?.trim() || '(без названия)',
          link: item.link || item.guid || url,
          ts
        });
      }
    } catch (e) {
      console.error('Feed error:', url, e.message);
    }
  }
  const freshLimit = Date.now() - FRESH_HOURS * 3600 * 1000;
  const fresh = all.filter(x => x.ts >= freshLimit);
  const pool = (fresh.length ? fresh : all).sort((a, b) => b.ts - a.ts);
  return pool.slice(0, take);
}

function esc(s = '') {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function fetchArticleText(url) {
  try {
    const r = await fetch(url, { redirect: 'follow' });
    const html = await r.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    const text = (article?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_CHARS_PER_ARTICLE);
    return text;
  } catch (e) {
    console.error('Fetch/Readability error:', url, e.message);
    return '';
  }
}

async function gptSummary(title, text) {
  if (!openai) return '';
  const sys = 'Ты — редактор телеграм-дайджеста для предпринимателя онлайн-школы массажа.'
    + '\nСделай 1–2 предложения: почему читать и какая практическая польза (продажи/продукт/обучение). Без воды.';
  try {
    const resp = await openai.responses.create({
      model: 'gpt-4.1-mini',
      input: [
        { role: 'system', content: sys },
        { role: 'user', content: `Заголовок: ${title}\nТекст: ${text}` }
      ]
    });
    return resp.output_text?.trim() || '';
  } catch (e) {
    console.error('OpenAI summary error:', e.message);
    return '';
  }
}

async function formatItemGPT(x) {
  const text = await fetchArticleText(x.link);
  const summary = await gptSummary(x.title, text);
  return `• <a href="${x.link}">${esc(x.title)}</a>${summary ? `\n<i>${esc(summary)}</i>` : ''}`;
}

async function section(title, items) {
  if (!items.length) return '';
  const limit = pLimit(CONCURRENCY);
  const formatted = await Promise.all(items.map(item => limit(() => formatItemGPT(item))));
  return `<b>${title}</b>\n${formatted.join('\n\n')}`;
}

async function generateHumanTakeaway(sections) {
  if (!openai) return '';
  const bullets = sections
    .flatMap(s => s.items.map(x => `• [${s.title}] ${x.title}`))
    .slice(0, 8)
    .join('\n');
  const sys = 'Ты — продукт-менеджер онлайн-школы массажа. Кратко предложи 1–2 предложения: конкретный эксперимент «Что протестировать у нас» (лендинг/оффер/воронка/удержание/геймификация). Без воды.';
  try {
    const resp = await openai.responses.create({
      model: 'gpt-4.1-mini',
      input: [
        { role: 'system', content: sys },
        { role: 'user', content: bullets }
      ]
    });
    const text = resp.output_text?.trim();
    return text ? `💡 <b>Что протестировать у нас:</b> ${esc(text)}` : '';
  } catch (e) {
    console.error('OpenAI takeaway error:', e.message);
    return '';
  }
}

async function main() {
  const [sales, edtech, massage] = await Promise.all([
    pickLatest(FEEDS.sales),
    pickLatest(FEEDS.edtech),
    pickLatest(FEEDS.massage)
  ]);

  const date = new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const takeaway = await generateHumanTakeaway([
    { title: 'Продажи', items: sales },
    { title: 'EdTech', items: edtech },
    { title: 'Массаж', items: massage }
  ]);

  const parts = [
    `<b>Ежедневный ресерч — ${date}</b>`,
    await section('🚀 Продажи и маркетинг', sales),
    await section('📚 Продукт онлайн-обучения (EdTech)', edtech),
    await section('💆‍♂️ Массаж / мануальная терапия', massage),
    takeaway,
    '',
    '⚙️ Автопост. Источники настраиваются в репозитории.'
  ].filter(Boolean);

  const text = parts.join('\n\n');

  const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Telegram error: ${resp.status} ${t}`);
  }

  console.log('Posted');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
