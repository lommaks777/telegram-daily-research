// index.mjs — финал

import fs from 'fs';
import path from 'path';
import Parser from 'rss-parser';
import OpenAI from 'openai';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { createObjectCsvWriter } from 'csv-writer';

/* ========= ENV ========= */
const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID   = process.env.TG_CHAT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REPO_URL = 'https://lommaks777.github.io/telegram-daily-research/';

const ROOT = path.resolve('.');
const CSV_FILE = path.join(ROOT, 'hypotheses.csv');
const DOCS_DIR = path.join(ROOT, 'docs');
fs.mkdirSync(DOCS_DIR, { recursive: true });

/* ========= CONFIG ========= */
const CONFIG = {
  minPotential: 6,
  weights: { potential: 0.6, ease: 0.4 },
  freshHours: 72,
  perSection: 2
};
const W = CONFIG.weights;

/* ========= FEEDS ========= */
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

/* ========= RELEVANCE / FILTERS ========= */
const MUST_HAVE_ANY = [
  /массаж/i, /школ/i, /курс/i, /ученик|студент/i,
  /онлайн/i, /вебинар|автовебинар/i, /терап/i, /клиент/i, /запис/i
];
const REJECT_PATTERNS = [
  /\bsaas\b/i, /\bkubernetes\b/i, /\bmicroservice/i, /\bapi gateway/i,
  /\bdevops\b/i, /\bcontainer/i, /\bmicro-?frontend/i, /\bk8s\b/i
];

function isLikelyEnglish(text='') {
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const cyr   = (text.match(/[А-Яа-яЁё]/g) || []).length;
  return latin > 120 && cyr < 10;
}
function containsAnyKeyword(text='', patterns=[]) {
  return patterns.some(rx => rx.test(text));
}
function isRelevant(idea='', rationale='', section='', category='') {
  const text = [idea, rationale, section, category].join(' ').trim();
  if (!idea.trim()) return false;
  if (isLikelyEnglish(text)) return false;
  if (REJECT_PATTERNS.some(rx => rx.test(text))) return false;
  if (!containsAnyKeyword(text, MUST_HAVE_ANY)) return false;
  return true;
}

/* ========= HELPERS ========= */
const todayRu = () => new Date().toLocaleDateString('ru-RU');
const score = (ease, pot) => W.potential * Number(pot||0) + W.ease * Number(ease||0);

/* ========= RSS ========= */
const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'Mozilla/5.0 (DailyDigestBot; +github pages)' }
});

async function pickLatest(feedUrls, take=CONFIG.perSection, freshHours=CONFIG.freshHours) {
  const all = [];
  for (const url of feedUrls) {
    try {
      const feed = await parser.parseURL(url);
      for (const item of feed.items || []) {
        const ts = (item.isoDate || item.pubDate) ? new Date(item.isoDate || item.pubDate).valueOf() : 0;
        all.push({ title: item.title?.trim() || '(без названия)', link: item.link, ts, feedTitle: feed.title || url });
      }
    } catch (e) {
      console.error('RSS:', url, e.message);
    }
  }
  const freshLimit = Date.now() - freshHours * 3600 * 1000;
  const fresh = all.filter(x => x.ts >= freshLimit);
  return (fresh.length ? fresh : all).sort((a,b)=>b.ts-a.ts).slice(0, take);
}

/* ========= FETCH READABLE ========= */
async function fetchReadable(url, maxChars=8000) {
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
  } catch {
    return '';
  }
}

/* ========= GPT ========= */
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

/* ========= CSV IO (robust) ========= */
function parseCsvLine(line='') {
  const out=[]; let cur=''; let q=false;
  for (let i=0;i<line.length;i++){
    const ch=line[i];
    if (ch === '"'){
      if (q && line[i+1]==='"'){ cur+='"'; i++; }
      else q=!q;
    } else if (!q && ch===','){ out.push(cur); cur=''; }
    else cur+=ch;
  }
  out.push(cur);
  return out;
}
function loadCsv(file) {
  if (!fs.existsSync(file)) return [];
  let txt = fs.readFileSync(file, 'utf8');
  if (!txt || !txt.trim()) return [];
  txt = txt.replace(/^\uFEFF/, '');
  const lines = txt.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headerLine = lines.shift();
  if (!headerLine) return [];
  const headers = parseCsvLine(headerLine);
  if (!headers.length) return [];
  const rows=[];
  for (const l of lines){
    const vals = parseCsvLine(l);
    const obj={};
    headers.forEach((h,i)=> obj[h] = vals[i] ?? '');
    rows.push(obj);
  }
  return rows;
}
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

/* ========= SITE (JSON + HTML) ========= */
function writeSite(cleanRows, rawRows) {
  fs.writeFileSync(path.join(DOCS_DIR, 'hypotheses.json'), JSON.stringify(cleanRows, null, 2));
  fs.writeFileSync(path.join(DOCS_DIR, 'hypotheses_all.json'), JSON.stringify(rawRows, null, 2));

  const html = `<!doctype html><html lang="ru"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Гипотезы онлайн-школы массажа</title>
<style>
body{font-family:system-ui,Arial,sans-serif;margin:24px}
h1{margin:0 0 8px}
.note{color:#666;margin:8px 0 12px}
.controls{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
button{padding:6px 10px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer}
button.active{background:#efefef}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #e6e6e6;padding:8px;vertical-align:top}
th{background:#fafafa;cursor:pointer}
.pill{padding:2px 8px;border-radius:12px;background:#f0f0f0}
a{color:#0b69d0;text-decoration:none}
a:hover{text-decoration:underline}
</style></head><body>
<h1>Топ гипотез (по score)</h1>
<p class="note">Score = ${W.potential}×Potential + ${W.ease}×Ease. Можно переключать: релевантные / все записи.</p>
<div class="controls">
  <button id="rel" class="active">Релевантные</button>
  <button id="all">Все</button>
  <button id="tab-ads">Реклама</button>
  <button id="tab-funnel">Воронка</button>
  <button id="tab-product">Продукт</button>
</div>
<table id="t"><thead><tr>
  <th data-k="date">Дата</th>
  <th data-k="section">Раздел</th>
  <th data-k="source">Источник</th>
  <th data-k="category">Категория</th>
  <th data-k="idea">Гипотеза</th>
  <th data-k="ease">Простота</th>
  <th data-k="potential">Потенциал</th>
  <th data-k="score">Score</th>
  <th data-k="rationale">Почему</th>
  <th data-k="link">Ссылка</th>
</tr></thead><tbody></tbody></table>

<script>
let rel=true, cat='ALL', k='score', dir=-1, relData=[], allData=[];
async function get(u){ try{const r=await fetch(u+'?ts='+Date.now()); if(!r.ok) throw 0; return await r.json();}catch{return [];}}
function norm(x){return {
  date:x.date||x.Date||'',
  section:x.section||x.Section||'',
  source:x.source||x.Source||'',
  category:x.category||x.Category||'',
  idea:x.idea||x.Idea||'',
  ease:Number(x.ease??x.Ease??0),
  potential:Number(x.potential??x.Potential??0),
  score:Number(x.score??x.Score??0),
  rationale:x.rationale||x.Rationale||'',
  link:x.link||x.Link||''
};}
function passCat(x){
  if(cat==='ALL') return true;
  if(cat==='Реклама') return /реклам/i.test(x.category);
  if(cat==='Воронка') return /ворон/i.test(x.category);
  if(cat==='Продукт') return /продукт/i.test(x.category);
  return true;
}
function render(){
  const tb=document.querySelector('tbody'); tb.innerHTML='';
  const data = (rel ? relData : allData).map(norm).filter(passCat);
  data.sort((a,b)=> (a[k]===b[k]?0:(a[k]>b[k]?1:-1))*dir);
  for(const x of data){
    const tr=document.createElement('tr');
    tr.innerHTML=\`
      <td>\${x.date}</td><td>\${x.section}</td><td>\${x.source}</td>
      <td>\${x.category}</td><td>\${x.idea}</td>
      <td><span class="pill">\${x.ease}</span></td>
      <td><span class="pill">\${x.potential}</span></td>
      <td><span class="pill">\${x.score.toFixed(1)}</span></td>
      <td>\${x.rationale}</td>
      <td>\${x.link ? '<a target="_blank" href="'+x.link+'">link</a>' : ''}</td>\`;
    tb.appendChild(tr);
  }
}
async function boot(){
  relData = await get('hypotheses.json');
  allData = await get('hypotheses_all.json');
  // если релевантных пока нет — покажем ВСЕ по умолчанию
  if(!relData.length && allData.length){
    rel=false;
    document.getElementById('all').classList.add('active');
    document.getElementById('rel').classList.remove('active');
  }
  render();
}
document.querySelectorAll('th').forEach(th => th.onclick=()=>{k=th.dataset.k; dir*=-1; render();});
document.getElementById('rel').onclick=()=>{rel=true;  this?.classList?.add?.('active'); document.getElementById('rel').classList.add('active'); document.getElementById('all').classList.remove('active'); render();};
document.getElementById('all').onclick=()=>{rel=false; document.getElementById('all').classList.add('active'); document.getElementById('rel').classList.remove('active'); render();};
document.getElementById('tab-ads').onclick=()=>{cat='Реклама'; render();};
document.getElementById('tab-funnel').onclick=()=>{cat='Воронка'; render();};
document.getElementById('tab-product').onclick=()=>{cat='Продукт'; render();};
boot();
</script>
</body></html>`;
  fs.writeFileSync(path.join(DOCS_DIR, 'index.html'), html);
}

/* ========= TELEGRAM ========= */
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
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
}

/* ========= PIPELINE ========= */
async function buildSection(title, list, openai) {
  const out = [];
  for (const it of list) {
    const text = await fetchReadable(it.link);
    const hyps = await gptHypotheses(openai, it.title, text);
    for (const h of hyps) {
      if (Number(h.potential || 0) < CONFIG.minPotential) continue;
      out.push({
        Date: todayRu(), Section: title, Source: it.feedTitle || '',
        Category: h.category || 'Продукт',
        Idea: (h.idea || '').trim(),
        Ease: Number(h.ease || 0),
        Potential: Number(h.potential || 0),
        Score: score(h.ease, h.potential),
        Link: it.link,
        Rationale: (h.rationale || '').trim()
      });
    }
  }
  return out;
}

async function main() {
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  const dateStr = todayRu();

  const before = loadCsv(CSV_FILE);
  const seen = new Set(before.map(r => (r.Section + '|' + (r.Idea||'')).toLowerCase()));

  const [s, e, m] = await Promise.all([
    pickLatest(FEEDS.sales),
    pickLatest(FEEDS.edtech),
    pickLatest(FEEDS.massage)
  ]);

  const sales   = await buildSection('🚀 Продажи и маркетинг', s, openai);
  const edtech  = await buildSection('📚 EdTech', e, openai);
  const massage = await buildSection('💆‍♂️ Массаж', m, openai);

  const incoming = [...sales, ...edtech, ...massage];
  const toAppend = [];
  for (const h of incoming) {
    const key = (h.Section + '|' + h.Idea).toLowerCase();
    if (seen.has(key)) continue;
    if (isRelevant(h.Idea, h.Rationale, h.Section, h.Category)) toAppend.push(h);
  }

  await appendCsv(CSV_FILE, toAppend);

  const raw = loadCsv(CSV_FILE);
  const clean = raw.filter(r => isRelevant(r.Idea, r.Rationale, r.Section, r.Category));

  writeSite(clean, raw);

  const grouped = new Map([
    ['🚀 Продажи и маркетинг', clean.filter(x => x.Section === '🚀 Продажи и маркетинг')],
    ['📚 EdTech',              clean.filter(x => x.Section === '📚 EdTech')],
    ['💆‍♂️ Массаж',            clean.filter(x => x.Section === '💆‍♂️ Массаж')],
  ]);
  await postToTelegram({ token: BOT_TOKEN, chatId: CHAT_ID, dateStr, grouped });

  console.log(`Done. Appended: ${toAppend.length}. Clean: ${clean.length}. Raw total: ${raw.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
