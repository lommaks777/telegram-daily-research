import Parser from 'rss-parser';
import OpenAI from 'openai';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import pLimit from 'p-limit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createObjectCsvWriter } from 'csv-writer';

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === RSS источники ===
const FEEDS = {
  sales: [
    'https://blog.hubspot.com/sales/rss.xml',         // HubSpot – блог о продажах
    'https://thesalesblog.com/blog/rss.xml',          // The Sales Blog (Anthony Iannarino)
    'https://www.rainsalestraining.com/blog/rss.xml', // Rain Group Sales Blog
    'https://clickfunnels.com/blog/feed',             // ClickFunnels Blog
    'https://cxl.com/blog/feed/'                      // CXL (ConversionXL)
  ],
  edtech: [
    'https://feeds.feedburner.com/elearningindustry', // eLearning Industry
    'https://feeds.feedburner.com/theelearningcoach', // The eLearning Coach (Connie Malamed)
    'https://sellcoursesonline.com/feed',             // Sell Courses Online Blog
    'https://www.shiftelearning.com/blog/rss.xml',    // SHIFT’s eLearning Blog
    'https://elearninguncovered.com/feed'             // E-Learning Uncovered
  ],
  massage: [
    'https://discovermassage.com.au/feed',            // Discover Massage Australia Blog
    'https://massagetherapyfoundation.org/feed/',     // Massage Therapy Foundation News
    'https://www.academyofclinicalmassage.com/feed/', // Academy of Clinical Massage
    'https://realbodywork.com/feed',                  // Real Bodywork
    'https://themtdc.com/feed'                        // Massage Therapist Development Centre
  ]
};

const FRESH_HOURS = 72;
const PER_SECTION = 2;
const MAX_CHARS = 8000;

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
      all.push({
        title: item.title?.trim() || '(без названия)',
        link: item.link,
        ts,
        source: feed.title || url
      });
    }
  }
  const freshLimit = Date.now() - FRESH_HOURS * 3600 * 1000;
  const fresh = all.filter(x => x.ts >= freshLimit);
  return (fresh.length ? fresh : all).sort((a, b) => b.ts - a.ts).slice(0, take);
}

async function fetchText(url) {
  try {
    const r = await fetch(url);
    const html = await r.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    return (reader.parse()?.textContent || '').slice(0, MAX_CHARS);
  } catch {
    return '';
  }
}

async function analyzeHypotheses(title, text) {
  const prompt = `Разбери статью на гипотезы для онлайн-школы массажа. Для каждой:
- Кратко сформулируй идею.
- Укажи источник (если есть).
- Оцени простоту тестирования (1–10).
- Оцени денежный потенциал (1–10).
Верни в формате JSON: [{"idea":"...","ease":7,"potential":9}]`;
  const resp = await openai.responses.create({
    model: 'gpt-4.1-mini',
    input: [
      { role: 'system', content: prompt },
      { role: 'user', content: `Заголовок: ${title}\nТекст: ${text}` }
    ]
  });
  try {
    return JSON.parse(resp.output_text);
  } catch {
    return [];
  }
}

async function section(title, items) {
  const results = [];
  for (const x of items) {
    const text = await fetchText(x.link);
    const hyps = await analyzeHypotheses(x.title, text);
    hyps.forEach(h =>
      results.push({ section: title, source: x.source, link: x.link, ...h })
    );
  }
  const lines = results.map(
    h => `• ${h.idea}\n<i>Простота: ${h.ease}/10, Потенциал: ${h.potential}/10</i>\n<code>${h.source}</code>`
  );
  return { text: `<b>${title}</b>\n${lines.join('\n\n')}`, data: results };
}

async function main() {
  const [sales, edtech, massage] = await Promise.all([
    pickLatest(FEEDS.sales),
    pickLatest(FEEDS.edtech),
    pickLatest(FEEDS.massage)
  ]);

  const date = new Date().toLocaleDateString('ru-RU');
  const sec1 = await section('🚀 Продажи и маркетинг', sales);
  const sec2 = await section('📚 EdTech', edtech);
  const sec3 = await section('💆‍♂️ Массаж', massage);

  // === Telegram пост ===
  const parts = [
    `<b>Ежедневный ресерч — ${date}</b>`,
    sec1.text,
    sec2.text,
    sec3.text
  ];
  const text = parts.join('\n\n');

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' })
  });

  // === CSV для истории ===
  const csvWriter = createObjectCsvWriter({
    path: 'hypotheses.csv',
    header: [
      { id: 'section', title: 'Section' },
      { id: 'source', title: 'Source' },
      { id: 'idea', title: 'Idea' },
      { id: 'ease', title: 'Ease' },
      { id: 'potential', title: 'Potential' },
      { id: 'link', title: 'Link' }
    ],
    append: true
  });
  const all = [...sec1.data, ...sec2.data, ...sec3.data].map(x => ({ date, ...x }));
  await csvWriter.writeRecords(all);

  // === HTML + JSON для Pages (/docs) ===
  const docsDir = path.join(__dirname, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });

  // сортировка по скору (0.6*potential + 0.4*ease)
  const top = all.map(x => ({
    ...x,
    score: 0.6 * x.potential + 0.4 * x.ease
  })).sort((a, b) => b.score - a.score);

  fs.writeFileSync(
    path.join(docsDir, 'hypotheses.json'),
    JSON.stringify(top, null, 2)
  );

  fs.writeFileSync(
    path.join(docsDir, 'index.html'),
    `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Гипотезы — приоритеты</title>
<style>
body{font-family:system-ui,Arial,sans-serif;margin:24px}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ddd;padding:8px}
th{cursor:pointer;background:#f7f7f7}
tr:nth-child(even){background:#fafafa}
.pill{padding:2px 8px;border-radius:12px;background:#eee}
</style>
</head><body>
<h1>Топ гипотез (сортировка по score)</h1>
<p>Обновляется ежедневно из RSS.</p>
<table id="t"><thead><tr>
<th data-k="date">Дата</th>
<th data-k="section">Раздел</th>
<th data-k="source">Источник</th>
<th data-k="idea">Гипотеза</th>
<th data-k="ease">Простота</th>
<th data-k="potential">Потенциал</th>
<th data-k="score">Score</th>
<th data-k="link">Ссылка</th>
</tr></thead><tbody></tbody></table>
<script>
let data=[],key='score';
async function load(){
 const r=await fetch('hypotheses.json');
 data=await r.json();
 render();
}
function render(){
 const tb=document.querySelector('tbody');
 tb.innerHTML='';
 const rows=[...data].sort((a,b)=> b[key]-a[key]);
 for(const x of rows){
   const tr=document.createElement('tr');
   tr.innerHTML=\`<td>\${x.date}</td><td>\${x.section}</td><td>\${x.source}</td>
   <td>\${x.idea}</td><td><span class="pill">\${x.ease}</span></td>
   <td><span class="pill">\${x.potential}</span></td>
   <td><span class="pill">\${x.score.toFixed(1)}</span></td>
   <td><a href="\${x.link}" target="_blank">link</a></td>\`;
   tb.appendChild(tr);
 }
}
document.querySelectorAll('th').forEach(th=>{
 th.onclick=()=>{ key=th.dataset.k; render(); };
});
load();
</script>
</body></html>`
  );
}

main();
