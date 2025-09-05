// index.mjs

import fs from 'fs';
import path from 'path';
import pLimit from 'p-limit';
import OpenAI from 'openai';
import Parser from 'rss-parser';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { createObjectCsvWriter } from 'csv-writer';

/* ===== ENV ===== */
const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REPO_URL = 'https://lommaks777.github.io/telegram-daily-research/';

const __dirname = path.resolve('.');
const CSV_FILE = path.join(__dirname, 'hypotheses.csv');
const DOCS_DIR = path.join(__dirname, 'docs');
fs.mkdirSync(DOCS_DIR, { recursive: true });

/* ===== CONFIG ===== */
const CONFIG = {
  thresholds: { min_potential: 6, score_weights: { potential: 0.6, ease: 0.4 } }
};
const WEIGHTS = CONFIG.thresholds.score_weights;

/* ===== FEEDS ===== */
const FEEDS = {
  sales: [
    'https://blog.hubspot.com/sales/rss.xml',
    'https://thesalesblog.com/blog/rss.xml',
    'https://www.rainsalestraining.com/blog/rss.xml',
    'https://clickfunnels.com/blog/feed',
    'https://cxl.com/blog/feed/'
  ],
  edtech: [
    'https://feeds.feedburner.com/elearningindustry',
    'https://feeds.feedburner.com/theelearningcoach',
    'https://sellcoursesonline.com/feed',
    'https://www.shiftelearning.com/blog/rss.xml',
    'https://elearninguncovered.com/feed'
  ],
  massage: [
    'https://discovermassage.com.au/feed',
    'https://www.massagetherapyfoundation.org/feed/',
    'https://www.academyofclinicalmassage.com/feed/',
    'https://realbodywork.com/feed',
    'https://themtdc.com/feed'
  ]
};

/* ===== RELEVANCE FILTERS ===== */
const MUST_HAVE_ANY = [
  /массаж/i, /школ/i, /курс/i, /студент/i, /ученик/i,
  /онлайн/i, /вебинар/i, /автовебинар/i, /терап/i, /клиент/i, /запис/i
];

const REJECT_PATTERNS = [
  /\bsaas\b/i, /\bkubernetes\b/i, /\bmicroservice/i, /\bapi gateway/i,
  /\bdevops\b/i, /\bcontainer/i, /\bmicro-?frontend/i, /\bk8s\b/i
];

function isLikelyEnglish(text = '') {
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const cyr = (text.match(/[А-Яа-яЁё]/g) || []).length;
  return latin > 120 && cyr < 10;
}
function containsAnyKeyword(text = '', patterns = []) {
  return patterns.some(rx => rx.test(text));
}
function isRelevant(idea = '', rationale = '', section = '', category = '') {
  const text = [idea, rationale, section, category].join(' ').trim();
  if (!idea.trim()) return false;
  if (isLikelyEnglish(text)) return false;
  if (REJECT_PATTERNS.some(rx => rx.test(text))) return false;
  if (!containsAnyKeyword(text, MUST_HAVE_ANY)) return false;
  return true;
}

/* ===== HELPERS ===== */
const limit = pLimit(3);
const todayRu = () => new Date().toLocaleDateString('ru-RU');
const score = (ease, potential) =>
  WEIGHTS.potential * Number(potential || 0) + WEIGHTS.ease * Number(ease || 0);

/* ===== RSS FETCH ===== */
const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'Mozilla/5.0 (DailyDigestBot)' }
});

async function pickLatest(feedUrls, take = 2, freshHours = 72) {
  const all = [];
  for (const url of feedUrls) {
    try {
      const feed = await parser.parseURL(url);
      for (const item of feed.items || []) {
        const ts = (item.isoDate || item.pubDate)
          ? new Date(item.isoDate || item.pubDate).valueOf()
          : 0;
        all.push({ title: item.title?.trim() || '(без названия)', link: item.link, ts, feedTitle: feed.title || url });
      }
    } catch (e) {
      console.error('RSS:', url, e.message);
    }
  }
  const freshLimit = Date.now() - freshHours * 3600 * 1000;
  const fresh = all.filter(x => x.ts >= freshLimit);
  return (fresh.length ? fresh : all).sort((a, b) => b.ts - a.ts).slice(0, take);
}

async function fetchReadable(url, maxChars = 8000) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (DailyDigestBot)' } });
    const html = await r.text();
    const dom = new JSDOM(html, { url, pretendToBeVisual: true });
    const reader = new Readability(dom.window.document);
    const parsed = reader.parse();
    return (parsed?.textContent || html.replace(/<\/?[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxChars);
  } catch { return ''; }
}

/* ===== GPT ===== */
function buildPrompt() {
  return `
Ты — консультант по росту онлайн-школы массажа.
Все гипотезы должны касаться именно онлайн-школы массажа.
Ограничения: бюджет ≤ $2000, срок теста ≤ 2 недели, без команды разработчиков.
Категории: "Реклама", "Воронка", "Продукт".
Верни ЧИСТЫЙ JSON-массив объектов:
{"idea":"...", "category":"Реклама|Воронка|Продукт", "ease":7, "potential":9, "rationale":"..."}
Пиши только на русском.`.trim();
}

async function gptHypotheses(openai, title, text) {
  const resp = await openai.responses.create({
    model: 'gpt-4.1-mini',
    input: [
      { role: 'system', content: buildPrompt() },
      { role: 'user', content: `Заголовок: ${title}\nТекст: ${text}` }
    ]
  });
  try { return JSON.parse(resp.output_text) || []; }
  catch { return []; }
}

/* ===== CSV ===== */
function appendCsv(file, rows) {
  if (!rows?.length) return Promise.resolve();
  const writer = createObjectCsvWriter({
    path: file,
    header: [
      { id: 'Date', title: 'Date' }, { id: 'Section', title: 'Section' },
      { id: 'Source', title: 'Source' }, { id: 'Category', title: 'Category' },
      { id: 'Idea', title: 'Idea' }, { id: 'Ease', title: 'Ease' },
      { id: 'Potential', title: 'Potential' }, { id: 'Score', title: 'Score' },
      { id: 'Link', title: 'Link' }, { id: 'Rationale', title: 'Rationale' }
    ],
    append: true
  });
  return writer.writeRecords(rows);
}
function loadCsv(file) {
  if (!fs.existsSync(file)) return [];
  const txt = fs.readFileSync(file, 'utf8');
  const [headerLine, ...lines] = txt.split(/\r?\n/).filter(Boolean);
  const headers = headerLine.split(',');
  return lines.map(l => {
    const vals = l.split(',');
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i]; });
    return obj;
  });
}

/* ===== SITE ===== */
function writeSite(cleanRows, rawRows) {
  fs.writeFileSync(path.join(DOCS_DIR, 'hypotheses.json'), JSON.stringify(cleanRows, null, 2));
  fs.writeFileSync(path.join(DOCS_DIR, 'hypotheses_all.json'), JSON.stringify(rawRows, null, 2));
  // простая HTML-таблица (оставил из предыдущей версии)
  const html = `<!doctype html><html><head><meta charset="utf-8"/><title>Гипотезы</title></head>
<body><h1>Гипотезы</h1><pre id="data"></pre>
<script>fetch('hypotheses.json').then(r=>r.json()).then(j=>{document.getElementById('data').textContent=JSON.stringify(j,null,2)});</script>
</body></html>`;
  fs.writeFileSync(path.join(DOCS_DIR, 'index.html'), html);
}

/* ===== TELEGRAM ===== */
async function postToTelegram({ token, chatId, dateStr, grouped }) {
  if (!token || !chatId) return;
  const blocks = [];
  for (const [title, arr] of grouped) {
    if (!arr.length) continue;
    const lines = arr.map(h =>
      `• ${h.Idea}\n<i>Категория: ${h.Category} · Простота: ${h.Ease}/10 · Потенциал: ${h.Potential}/10</i>`
    );
    blocks.push(`<b>${title}</b>\n${lines.join('\n\n')}`);
  }
  if (!blocks.length) return;
  const text = [`<b>Ежедневный ресерч — ${dateStr}</b>`, ...blocks, `\n🔗 ${REPO_URL}`].join('\n\n');
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
}

/* ===== MAIN ===== */
async function buildSection(title, list, openai) {
  const out = [];
  for (const it of list) {
    const text = await fetchReadable(it.link);
    const hyps = await gptHypotheses(openai, it.title, text);
    for (const h of hyps) {
      if (Number(h.potential || 0) < CONFIG.thresholds.min_potential) continue;
      out.push({
        Date: todayRu(), Section: title, Source: it.feedTitle,
        Category: h.category || 'Продукт',
        Idea: (h.idea || '').trim(), Ease: Number(h.ease || 0),
        Potential: Number(h.potential || 0), Score: score(h.ease, h.potential),
        Link: it.link, Rationale: (h.rationale || '').trim()
      });
    }
  }
  return out;
}

async function main() {
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  const dateStr = todayRu();

  const rawBefore = loadCsv(CSV_FILE);

  const [s, e, m] = await Promise.all([
    pickLatest(FEEDS.sales), pickLatest(FEEDS.edtech), pickLatest(FEEDS.massage)
  ]);

  const sales = await buildSection('🚀 Продажи и маркетинг', s, openai);
  const edtech = await buildSection('📚 EdTech', e, openai);
  const massage = await buildSection('💆‍♂️ Массаж', m, openai);

  const seen = new Set(rawBefore.map(r => (r.Section + '|' + (r.Idea || '')).toLowerCase()));
  const toAppend = [];
  for (const h of [...sales, ...edtech, ...massage]) {
    const key = (h.Section + '|' + h.Idea).toLowerCase();
    if (seen.has(key)) continue;
    if (isRelevant(h.Idea, h.Rationale, h.Section)) toAppend.push(h);
  }

  await appendCsv(CSV_FILE, toAppend);

  const rawNow = loadCsv(CSV_FILE);
  const cleanNow = rawNow.filter(r => isRelevant(r.Idea, r.Rationale, r.Section));

  writeSite(cleanNow, rawNow);

  const grouped = new Map([
    ['🚀 Продажи и маркетинг', cleanNow.filter(x => x.Section === '🚀 Продажи и маркетинг')],
    ['📚 EdTech', cleanNow.filter(x => x.Section === '📚 EdTech')],
    ['💆‍♂️ Массаж', cleanNow.filter(x => x.Section === '💆‍♂️ Массаж')],
  ]);
  await postToTelegram({ token: BOT_TOKEN, chatId: CHAT_ID, dateStr, grouped });

  console.log(`Done. Appended: ${toAppend.length}. Clean: ${cleanNow.length}. Raw total: ${rawNow.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
