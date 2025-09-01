import Parser from 'rss-parser';
import OpenAI from 'openai';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import pLimit from 'p-limit';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createObjectCsvWriter } from 'csv-writer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('Missing TG_BOT_TOKEN or TG_CHAT_ID');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const parser = new Parser({ timeout: 15000 });
const limit = pLimit(3);

// === Настройки ===
const FRESH_HOURS = 72;
const PER_SECTION = 2;
const MAX_CHARS = 8000;
const DEDUPE_WINDOW_DAYS = 21; // окно против дублей

// === Источники ===
const FEEDS = {
  sales: [
    // Современные подходы в продажах
    'https://blog.hubspot.com/sales/rss.xml',                // HubSpot – блог о продажах
    'https://thesalesblog.com/blog/rss.xml',                 // The Sales Blog (Anthony Iannarino)
    'https://www.rainsalestraining.com/blog/rss.xml',        // Rain Group Sales Blog
    'https://clickfunnels.com/blog/feed',                    // ClickFunnels Blog
    'https://cxl.com/blog/feed/'                             // CXL (ConversionXL)
  ],
  edtech: [
    // Разработка и продвижение онлайн-курсов
    'https://feeds.feedburner.com/elearningindustry',        // eLearning Industry
    'https://feeds.feedburner.com/theelearningcoach',        // The eLearning Coach (Connie Malamed)
    'https://sellcoursesonline.com/feed',                    // Sell Courses Online Blog
    'https://www.shiftelearning.com/blog/rss.xml',           // SHIFT’s eLearning Blog
    'https://elearninguncovered.com/feed'                    // E-Learning Uncovered
  ],
  massage: [
    // Онлайновые курсы и ресурсы по массажу
    'https://discovermassage.com.au/feed',                   // Discover Massage Australia Blog
    'https://massagetherapyfoundation.org/feed/',            // Massage Therapy Foundation News
    'https://www.academyofclinicalmassage.com/feed/',        // Academy of Clinical Massage
    'https://realbodywork.com/feed',                         // Real Bodywork
    'https://themtdc.com/feed'                               // Massage Therapist Development Centre
  ]
};

// === Хранилище состояния (для анти-дублей) ===
const STATE_PATH = path.join(__dirname, 'state.json');
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return { links: {}, hyps: {} }; } }
function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }
function nowTs() { return Math.floor(Date.now() / 1000); }
function cutoffTs(days) { return nowTs() - days * 86400; }
function sha(s){ return crypto.createHash('sha256').update(s).digest('hex'); }

function toTs(dateLike) {
  const d = dateLike ? new Date(dateLike) : null;
  return d && !Number.isNaN(d.valueOf()) ? d.valueOf() : 0;
}

async function pickLatest(feedUrls, take = PER_SECTION) {
  const all = [];
  for (const url of feedUrls) {
    const feed = await parser.parseURL(url);
    for (const item of feed.items || []) {
      const ts = toTs(item.isoDate || item.pubDate);
      all.push({ title: item.title?.trim() || '(без названия)', link: item.link, ts });
    }
  }
  const freshLimit = Date.now() - FRESH_HOURS * 3600 * 1000;
  const fresh = all.filter(x => x.ts >= freshLimit);
  return (fresh.length ? fresh : all).sort((a, b) => b.ts - a.ts).slice(0, take * 2); // берём с запасом, дальше отрежем дубли
}

async function fetchText(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (+digest-bot)' } });
    const html = await r.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    return (reader.parse()?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
  } catch { return ''; }
}

async function gptHypotheses(title, text) {
  const sys = 'Ты — аналитик онлайн-школы массажа. Разбери статью на гипотезы. Для каждой верни JSON c полями: idea, ease (1–10: 10 — проще всего), potential (1–10: 10 — самый большой денежный эффект), rationale (почему). Коротко и по делу.';
  const resp = await openai.responses.create({
    model: 'gpt-4.1-mini',
    input: [
      { role: 'system', content: sys },
      { role: 'user', content: `Заголовок: ${title}\nТекст: ${text}` }
    ]
  });
  try { return JSON.parse(resp.output_text); } catch { return []; }
}

function esc(s=''){ return s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }

function chooseNewLinks(items, state) {
  const cut = cutoffTs(DEDUPE_WINDOW_DAYS);
  const filtered = [];
  for (const it of items) {
    const key = sha(it.link || it.title);
    const ts = state.links[key] || 0;
    if (ts < cut) filtered.push(it);
  }
  return filtered.slice(0, PER_SECTION);
}

function recordPostedLinks(items, state){
  for (const it of items) {
    const key = sha(it.link || it.title);
    state.links[key] = nowTs();
  }
}

function dedupeHyps(hyps, state){
  const cut = cutoffTs(DEDUPE_WINDOW_DAYS);
  const out = [];
  for (const h of hyps) {
    const key = sha((h.idea||'').toLowerCase().trim() + '|' + (h.section||''));
    const ts = state.hyps[key] || 0;
    if (ts < cut) { out.push(h); state.hyps[key] = nowTs(); }
  }
  return out;
}

async function buildSection(title, rawItems, state){
  const items = chooseNewLinks(rawItems, state);
  const res = [];
  for (const x of items) {
    const text = await limit(() => fetchText(x.link));
    const hyps = await limit(() => gptHypotheses(x.title, text));
    for (const h of hyps) {
      res.push({ section: title, source: x.link, idea: h.idea, ease: h.ease, potential: h.potential, rationale: h.rationale });
    }
  }
  const unique = dedupeHyps(res, state);
  const lines = unique.map(h => `• ${esc(h.idea)}\n<i>Простота: ${h.ease}/10 · Потенциал: ${h.potential}/10</i>\n<code>${esc(h.rationale||'')}</code>`);
  return { text: `<b>${title}</b>\n${lines.join('\n\n')}`, data: unique, postedItems: items };
}

async function main(){
  const state = loadState();
  const [salesRaw, edtechRaw, massageRaw] = await Promise.all([
    pickLatest(FEEDS.sales),
    pickLatest(FEEDS.edtech),
    pickLatest(FEEDS.massage)
  ]);

  const date = new Date().toLocaleDateString('ru-RU');
  const s1 = await buildSection('🚀 Продажи и маркетинг', salesRaw, state);
  const s2 = await buildSection('📚 EdTech', edtechRaw, state);
  const s3 = await buildSection('💆‍♂️ Массаж', massageRaw, state);

  // Сообщение в канал (уже без дублей)
  const parts = [`<b>Ежедневный ресерч — ${date}</b>`, s1.text, s2.text, s3.text, '', '⚙️ Автопост. Без дублей за последние 21 день.'];
  const text = parts.filter(Boolean).join('\n\n');

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });

  // Сохраняем гипотезы в CSV (растущая база)
  const csvPath = path.join(__dirname, 'hypotheses.csv');
  const csvWriter = createObjectCsvWriter({
    path: csvPath,
    header: [
      { id: 'date', title: 'Date' },
      { id: 'section', title: 'Section' },
      { id: 'idea', title: 'Idea' },
      { id: 'ease', title: 'Ease' },
      { id: 'potential', title: 'Potential' },
      { id: 'rationale', title: 'Rationale' },
      { id: 'source', title: 'Source' }
    ],
    append: fs.existsSync(csvPath)
  });
  const all = [...s1.data, ...s2.data, ...s3.data].map(x => ({ date, ...x }));
  if (all.length) await csvWriter.writeRecords(all);

  // Собираем сайт (GitHub Pages): JSON + HTML, сортировка (потенциал ↓, простота ↓)
  const siteDir = path.join(__dirname, 'site');
  fs.mkdirSync(siteDir, { recursive: true });
  const top = all.sort((a,b)=> (b.potential - a.potential) || (b.ease - a.ease)).slice(0, 200);
  fs.writeFileSync(path.join(siteDir, 'hypotheses.json'), JSON.stringify(top, null, 2));
  fs.writeFileSync(path.join(siteDir, 'index.html'), `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Гипотезы — приоритеты</title>
<style>body{font-family:system-ui,Arial,sans-serif;margin:24px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px}th{cursor:pointer;background:#f7f7f7}tr:nth-child(even){background:#fafafa}.pill{padding:2px 8px;border-radius:12px;background:#eee}</style>
</head><body>
<h1>Топ гипотез (сначала высокий потенциал и простота)</h1>
<p>Клик по заголовку колонки — сортировка. Данные обновляются ежедневно.</p>
<table id="t"><thead><tr>
<th data-k="date">Дата</th>
<th data-k="section">Раздел</th>
<th data-k="idea">Гипотеза</th>
<th data-k="ease">Простота</th>
<th data-k="potential">Потенциал</th>
<th data-k="rationale">Почему</th>
<th data-k="source">Источник</th>
</tr></thead><tbody></tbody></table>
<script>
let data=[],key='potential';
async function load(){ const r = await fetch('hypotheses.json'); data = await r.json(); render(); }
function render(){ const tb=document.querySelector('tbody'); tb.innerHTML='';
  const rows=[...data].sort((a,b)=> (b[key]-a[key]) || (b.potential-a.potential) || (b.ease-a.ease));
  for(const x of rows){ const tr=document.createElement('tr');
    tr.innerHTML = \`<td>\${x.date||''}</td><td>\${x.section||''}</td><td>\${x.idea||''}</td><td><span class="pill">\${x.ease}</span></td><td><span class="pill">\${x.potential}</span></td><td>\${x.rationale||''}</td><td><a href="\${x.source}" target="_blank">link</a></td>\`;
    tb.appendChild(tr);
  }
}
document.querySelectorAll('th').forEach(th=> th.onclick=()=>{ key=th.dataset.k; render(); });
load();
</script>
</body></html>`);
  // Обновляем отметки о размещённых ссылках
  recordPostedLinks([...s1.postedItems, ...s2.postedItems, ...s3.postedItems], state);
  saveState(state);
}

main();
