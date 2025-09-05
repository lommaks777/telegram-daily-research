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

/* ========= ENV / PATHS ========= */
const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID   = process.env.TG_CHAT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PRUNE_CSV = String(process.env.PRUNE_CSV || '').toLowerCase() === 'true';

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const CSV_PATH   = path.join(__dirname, 'hypotheses.csv');
const DOCS_DIR   = path.join(__dirname, 'docs');
fs.mkdirSync(DOCS_DIR, { recursive: true });

/* ========= CONFIG ========= */
const defaultConfig = {
  business_context:
    "Онлайн-школа массажа. Воронка: таргет → автовебинар → цепочка писем → живые вебинары. KPI: рост LTV/маржинальности, снижение CPL.",
  constraints: { max_budget_usd: 2000, max_duration_weeks: 2, has_no_dev_team: true, reject_non_massage: true },
  scoring: {
    ease: { definition: "Сколько времени/ресурсов нужно (≤2 недели, ≤$2000, без dev)." },
    potential: { definition: "Снижение CPL, рост конверсии и LTV/маржинальности." }
  },
  thresholds: { min_potential: 6, min_score: null, score_weights: { potential:0.6, ease:0.4 } }
};
function loadConfig() {
  const p = path.join(__dirname, 'hypothesis-config.json');
  if (!fs.existsSync(p)) return defaultConfig;
  try { return { ...defaultConfig, ...JSON.parse(fs.readFileSync(p,'utf-8')) }; }
  catch { return defaultConfig; }
}
const CONFIG = loadConfig();

/* ========= RSS ========= */
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

/* ========= HELPERS / FILTERS ========= */
const parser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; DailyDigestBot/1.0; +https://github.com/)',
    'Accept': 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8'
  }
});
const limit = pLimit(3);

const FRESH_HOURS = 72;
const PER_SECTION = 2;
const MAX_CHARS = 8000;

const todayRu = () => new Date().toLocaleDateString('ru-RU');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const toTs = d => (d ? new Date(d).valueOf() : 0) || 0;

function score(ease, potential, weights = CONFIG.thresholds.score_weights) {
  const wP = Number(weights?.potential ?? 0.6);
  const wE = Number(weights?.ease ?? 0.4);
  return wP * Number(potential||0) + wE * Number(ease||0);
}
function passThresholds(h) {
  const t = CONFIG.thresholds || {};
  if (t.min_potential != null && Number(h.potential) < Number(t.min_potential)) return false;
  if (t.min_score != null && score(h.ease, h.potential) < Number(t.min_score)) return false;
  return true;
}

// мягкий англ-детектор: отбрасываем только явно англоязычные полотна
function isLikelyEnglish(s='') {
  const latin = (s.match(/[A-Za-z]/g)||[]).length;
  const cyr   = (s.match(/[А-Яа-яЁё]/g)||[]).length;
  return latin > 120 && cyr < 10;
}

// «чужие» темы
const REJECT_PATTERNS = [
  /\bsaas\b/i, /\bper[-\s]?user\b/i, /\bkubernetes\b/i, /\bapi\s?gateway\b/i,
  /\bcontainerization\b/i, /\bmicroservice/i, /\bmicro\-?frontend/i, /\bmulti\-tenant/i
];

// признаки применимости к школе массажа
const MUST_HAVE_ANY = [
  'массаж','мануальн','школ','школь','онлайн-школ','курс','курсы','обучен','обучающ',
  'ученик','студент','выпускник','урок','модуль','программа','сертифик',
  'вебинар','автовебинар','мастер-класс','практик','анатом','техника'
];

function containsAnyKeyword(s, list = MUST_HAVE_ANY) {
  const low = (s||'').toLowerCase();
  return list.some(k => low.includes(k));
}
function haystack(idea='', rationale='', section='') {
  return [idea, rationale, section].join(' ').toLowerCase();
}
function inferCategory(idea='') {
  const s = idea.toLowerCase();
  if (/(ads?|таргет|креатив|facebook|meta|tiktok|google|лендинг|посадочн|utm|аудитор)/.test(s)) return 'Реклама';
  if (/(воронк|webinar|вебинар|емейл|письм|ретаргет|лид-магнит|квиз|онбординг|lead|tripwire)/.test(s)) return 'Воронка';
  return 'Продукт';
}
function isRelevant(idea='', rationale='', section='', category='') {
  const text = haystack(idea, rationale, section);
  if (!idea.trim()) return false;
  if (isLikelyEnglish(text)) return false;
  if (REJECT_PATTERNS.some(rx => rx.test(text))) return false;
  const hasKeywords = containsAnyKeyword(text);
  const catOk = ['Реклама','Воронка','Продукт'].includes(category || '');
  return hasKeywords || catOk;
}

/* ========= CSV v0/v1 ========= */
function parseCsv(text) {
  const rows = [];
  let row=[], cell='', inQ=false, i=0;
  while (i<text.length) {
    const ch = text[i];
    if (ch === '"') {
      if (inQ && text[i+1] === '"') { cell+='"'; i+=2; continue; }
      inQ = !inQ; i++; continue;
    }
    if (!inQ && (ch===',' || ch==='\n' || ch==='\r')) {
      row.push(cell); cell='';
      if (ch===','){ i++; continue; }
      if (ch==='\r' && text[i+1]==='\n') i++;
      i++; if (row.length) { rows.push(row); row=[]; } continue;
    }
    cell += ch; i++;
  }
  if (cell.length || row.length){ row.push(cell); rows.push(row); }
  return rows.filter(r=>r.length>0);
}
const norm = s => (s||'').replace(/^\uFEFF/,'').trim().toLowerCase();

function tryParseV0(rows) {
  for (const r of rows) if (r.length < 6) return null;
  let hits = 0;
  for (const r of rows) {
    const e = Number(r[3]), p = Number(r[4]), u = String(r[5]||'');
    if (!Number.isFinite(e) || !Number.isFinite(p)) continue;
    if (/^https?:\/\//i.test(u)) hits++;
  }
  if (hits < Math.max(1, Math.floor(rows.length*0.6))) return null;

  const date = todayRu();
  const out = [];
  for (const r of rows) {
    const idea = r[2] || '';
    const cat = inferCategory(idea);
    out.push({
      Date: date, Section: r[0] || '', Source: r[1] || '',
      Category: cat, Idea: idea, Ease: Number(r[3]||0),
      Potential: Number(r[4]||0), Score: score(Number(r[3]||0), Number(r[4]||0)).toFixed(3),
      Link: r[5] || '', Rationale: ''
    });
  }
  return out;
}

function loadCsvRaw() {
  if (!fs.existsSync(CSV_PATH)) return [];
  const text = fs.readFileSync(CSV_PATH, 'utf-8');
  const rows = parseCsv(text);
  if (!rows.length) return [];

  const header = rows[0].map(h => h.replace(/^\uFEFF/, ''));
  const hasHeader = ['date','section','source','idea','ease','potential','score','link','rationale']
    .some(h => header.map(norm).includes(h));

  if (!hasHeader) {
    const parsed = tryParseV0(rows);
    if (parsed) return parsed;
  }

  const find = name => header.findIndex(h => norm(h) === norm(name));
  const iDate=find('Date'), iSection=find('Section'), iSource=find('Source'),
        iCategory=find('Category'), iIdea=find('Idea'), iEase=find('Ease'),
        iPotential=find('Potential'), iScore=find('Score'), iLink=find('Link'),
        iRationale=find('Rationale');

  const out = [];
  for (let k=1;k<rows.length;k++){
    const r = rows[k]; if (!r) continue;
    out.push({
      Date:        iDate      !== -1 ? r[iDate]      : '',
      Section:     iSection   !== -1 ? r[iSection]   : '',
      Source:      iSource    !== -1 ? r[iSource]    : '',
      Category:    iCategory  !== -1 ? r[iCategory]  : '',
      Idea:        iIdea      !== -1 ? r[iIdea]      : '',
      Ease:        iEase      !== -1 ? Number(r[iEase]      || 0) : 0,
      Potential:   iPotential !== -1 ? Number(r[iPotential] || 0) : 0,
      Score:       iScore     !== -1 ? Number(r[iScore]     || 0) : 0,
      Link:        iLink      !== -1 ? r[iLink]      : '',
      Rationale:   iRationale !== -1 ? r[iRationale] : ''
    });
  }
  return out;
}

function filteredView(rows) {
  return rows.filter(r => isRelevant(r.Idea||r.idea||'', r.Rationale||r.rationale||'', r.Section||r.section||'', r.Category||r.category||''));
}
async function maybePruneCsvFile(rows) {
  if (!PRUNE_CSV) return;
  const csvWriter = createObjectCsvWriter({
    path: CSV_PATH,
    header: [
      { id:'Date', title:'Date' },{ id:'Section', title:'Section' },{ id:'Source', title:'Source' },
      { id:'Category', title:'Category' },{ id:'Idea', title:'Idea' },{ id:'Ease', title:'Ease' },
      { id:'Potential', title:'Potential' },{ id:'Score', title:'Score' },{ id:'Link', title:'Link' },
      { id:'Rationale', title:'Rationale' }
    ],
    append: false
  });
  await csvWriter.writeRecords(rows);
}
const dedupKey = r => sha(`${(r.Section||'').toLowerCase().trim()}|${(r.Idea||'').toLowerCase().trim()}`);

/* ========= RSS fetch ========= */
async function pickLatest(feedUrls, take = PER_SECTION) {
  const all = [];
  for (const url of feedUrls) {
    try {
      const feed = await parser.parseURL(url);
      for (const item of feed.items || []) {
        const ts = toTs(item.isoDate || item.pubDate);
        all.push({ title: item.title?.trim() || '(без названия)', link: item.link, ts, feedTitle: feed.title || url });
      }
    } catch (err) {
      console.error('Ошибка чтения RSS:', url, err.message);
    }
  }
  const freshLimit = Date.now() - FRESH_HOURS*3600*1000;
  const fresh = all.filter(x => x.ts >= freshLimit);
  return (fresh.length?fresh:all).sort((a,b)=>b.ts-a.ts).slice(0, take);
}

async function fetchText(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent':'Mozilla/5.0 (compatible; DailyDigestBot/1.0; +https://github.com/)' }});
    const html = await r.text();
    try {
      const dom = new JSDOM(html, { url, pretendToBeVisual:true });
      const reader = new Readability(dom.window.document);
      const parsed = reader.parse();
      if (parsed?.textContent) return parsed.textContent.replace(/\s+/g,' ').trim().slice(0, MAX_CHARS);
    } catch {}
    return html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'')
               .replace(/<\/?[^>]+(>|$)/g,' ').replace(/\s{2,}/g,' ').trim().slice(0, MAX_CHARS);
  } catch { return ''; }
}

/* ========= GPT ========= */
function buildPrompt() {
  const { business_context, constraints, scoring } = CONFIG;
  return `
Ты — консультант по росту онлайн-школы массажа.
Контекст: ${business_context}
Ограничения: без отдела разработки: ${constraints.has_no_dev_team?'да':'нет'}, бюджет теста ≤ $${constraints.max_budget_usd}, срок проверки ≤ ${constraints.max_duration_weeks} недели. Если идея НЕ применима к школе массажа — НЕ выводи её вовсе.
Пиши ТОЛЬКО НА РУССКОМ.

Категории: "Реклама", "Воронка", "Продукт".
Верни ЧИСТЫЙ JSON-массив объектов:
{"idea":"коротко, обязательно в контексте школы массажа","category":"Реклама|Воронка|Продукт","ease":7,"potential":9,"rationale":"почему снизит CPL/повысит LTV/маржу именно для школы массажа"}`.trim();
}
async function gptHypotheses(title, text) {
  const sys = buildPrompt();
  const resp = await openai.responses.create({
    model: 'gpt-4.1-mini',
    input: [{ role:'system', content: sys }, { role:'user', content: `Заголовок: ${title}\nТекст: ${text}` }]
  });
  try {
    const arr = JSON.parse(resp.output_text) || [];
    return arr.map(x => ({
      ...x,
      category: ['Реклама','Воронка','Продукт'].includes(x.category) ? x.category : inferCategory(x.idea||'')
    }));
  } catch { return []; }
}

/* ========= BUILD SECTION / TG ========= */
async function buildSection(title, items) {
  const out = [];
  for (const it of items) {
    const text = await limit(()=>fetchText(it.link));
    const hyps = await limit(()=>gptHypotheses(it.title, text));
    for (const h of hyps) {
      if (!passThresholds(h)) continue;
      out.push({ section:title, source:it.feedTitle, link:it.link,
                 idea:h.idea?.trim()||'', category:h.category,
                 ease:Number(h.ease||0), potential:Number(h.potential||0),
                 rationale:(h.rationale||'').trim() });
    }
  }
  return out;
}
const esc = s => (s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
async function postToTelegram(dateStr, bySection) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  const blocks=[];
  for (const [title, arr] of bySection) {
    if (!arr.length) continue;
    const lines = arr.map(h=>`• ${esc(h.idea)}
<i>Категория: ${h.category} · Простота: ${h.ease}/10 · Потенциал: ${h.potential}/10</i>
<code>${esc(h.source)}</code>`);
    blocks.push(`<b>${title}</b>\n${lines.join('\n\n')}`);
  }
  if (!blocks.length) return;
  const text = [`<b>Ежедневный ресерч — ${dateStr}</b>`, ...blocks, `\n🔗 Полная таблица: https://lommaks777.github.io/telegram-daily-research/`].join('\n\n');
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id:CHAT_ID, text, parse_mode:'HTML', disable_web_page_preview:true })
    });
  } catch {}
}

/* ========= SITE ========= */
function writeSite(allRowsFiltered, allRowsRaw) {
  fs.writeFileSync(path.join(DOCS_DIR, 'hypotheses.json'), JSON.stringify(allRowsFiltered, null, 2));
  fs.writeFileSync(path.join(DOCS_DIR, 'hypotheses_all.json'), JSON.stringify(allRowsRaw, null, 2));

  const w = CONFIG.thresholds?.score_weights || { potential:0.6, ease:0.4 };
  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Гипотезы — приоритеты</title>
<style>
body{font-family:system-ui,Arial,sans-serif;margin:24px}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ddd;padding:8px;vertical-align:top}
th{cursor:pointer;background:#f7f7f7}
tr:nth-child(even){background:#fafafa}
.pill{padding:2px 8px;border-radius:12px;background:#eee}
small{color:#666}
.controls{margin:12px 0;display:flex;gap:8px;flex-wrap:wrap}
button{padding:6px 10px;border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer}
button.active{background:#efefef}
</style>
</head><body>
<h1>Топ гипотез (по score)</h1>
<p><small>Score = ${w.potential}×Potential + ${w.ease}×Ease. В таблице можно переключать: только релевантные для школы массажа / все записи.</small></p>
<div class="controls">
  <button id="viewRel" class="active">Релевантные</button>
  <button id="viewAll">Все</button>
  <button data-filter="all" class="active">Все</button>
  <button data-filter="Реклама">Реклама</button>
  <button data-filter="Воронка">Воронка</button>
  <button data-filter="Продукт">Продукт</button>
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
let data=[], all=[], key='score', dir=-1, filter='all', useAll=false;

async function load(){
  const [r1,r2] = await Promise.all([
    fetch('hypotheses.json?ts='+Date.now()),
    fetch('hypotheses_all.json?ts='+Date.now())
  ]);
  data = await r1.json();
  all  = await r2.json();
  render();
}

function sortFn(a,b){ if(a[key]===b[key]) return 0; return (a[key]>b[key]?1:-1)*dir; }

function render(){
  const tb=document.querySelector('tbody'); tb.innerHTML='';
  const src = useAll ? all : data;
  const rows=[...src].filter(x=> filter==='all'?true:(x.category===filter)).sort(sortFn);
  for(const x of rows){
    const tr=document.createElement('tr');
    tr.innerHTML=\`<td>\${x.date||''}</td><td>\${x.section||''}</td><td>\${x.source||''}</td>
    <td>\${x.category||''}</td>
    <td>\${x.idea||''}</td><td><span class="pill">\${x.ease}</span></td>
    <td><span class="pill">\${x.potential}</span></td><td><span class="pill">\${(x.score||0).toFixed(1)}</span></td>
    <td>\${x.rationale||''}</td><td>\${x.link?'<a target="_blank" href="'+x.link+'">link</a>':''}</td>\`;
    tb.appendChild(tr);
  }
}

document.querySelectorAll('th').forEach(th=> th.onclick=()=>{ key=th.dataset.k; dir*=-1; render(); });
document.querySelectorAll('.controls button[data-filter]').forEach(b=>{
  b.onclick=()=>{ document.querySelectorAll('.controls button[data-filter]').forEach(x=>x.classList.remove('active')); b.classList.add('active'); filter=b.dataset.filter; render(); };
});
document.getElementById('viewRel').onclick=()=>{ useAll=false; document.getElementById('viewRel').classList.add('active'); document.getElementById('viewAll').classList.remove('active'); render(); };
document.getElementById('viewAll').onclick=()=>{ useAll=true;  document.getElementById('viewAll').classList.add('active'); document.getElementById('viewRel').classList.remove('active'); render(); };

load();
</script>
</body></html>`;
  fs.writeFileSync(path.join(DOCS_DIR, 'index.html'), html);
}

/* ========= MAIN ========= */
async function main(){
  const dateStr = todayRu();

  // 1) читаем CSV
  const allRaw = loadCsvRaw();

  // 2) фильтрованная «чистая» витрина
  const clean = filteredView(allRaw);

  // 3) dedup по витрине
  const dedup = new Set(clean.map(dedupKey));

  // 4) RSS → GPT
  const [salesRaw, edtechRaw, massageRaw] = await Promise.all([
    pickLatest(FEEDS.sales), pickLatest(FEEDS.edtech), pickLatest(FEEDS.massage)
  ]);
  const sales   = await buildSection('🚀 Продажи и маркетинг', salesRaw);
  const edtech  = await buildSection('📚 EdTech', edtechRaw);
  const massage = await buildSection('💆‍♂️ Массаж', massageRaw);

  // 5) анти-дубли, мягкая релевантность
  const weights = CONFIG.thresholds?.score_weights || { potential:0.6, ease:0.4 };
  const toAppend = [];
  for (const h of [...sales, ...edtech, ...massage]) {
    const row = {
      Date: dateStr, Section: h.section, Source: h.source,
      Category: h.category, Idea: h.idea, Ease: h.ease, Potential: h.potential,
      Score: score(h.ease, h.potential, weights).toFixed(3), Link: h.link, Rationale: h.rationale || ''
    };
    const key = dedupKey(row);
    if (dedup.has(key)) continue;
    dedup.add(key);
    toAppend.push(row);
  }

  // 6) дозаписываем
  if (toAppend.length) {
    const csvWriter = createObjectCsvWriter({
      path: CSV_PATH,
      header: [
        { id:'Date', title:'Date' },{ id:'Section', title:'Section' },{ id:'Source', title:'Source' },
        { id:'Category', title:'Category' },{ id:'Idea', title:'Idea' },{ id:'Ease', title:'Ease' },
        { id:'Potential', title:'Potential' },{ id:'Score', title:'Score' },{ id:'Link', title:'Link' },
        { id:'Rationale', title:'Rationale' }
      ],
      append: fs.existsSync(CSV_PATH)
    });
    await csvWriter.writeRecords(toAppend);
  }

  // 7) перечитываем CSV (raw + clean), при необходимости — «подчищаем» файл
  const rawNow   = loadCsvRaw();
  const cleanNow = filteredView(rawNow);
  if (PRUNE_CSV) await maybePruneCsvFile(cleanNow);

  // 8) телеграм — только чистые
  const grouped = new Map([
    ['🚀 Продажи и маркетинг', cleanNow.filter(x=>x.Section==='🚀 Продажи и маркетинг')],
    ['📚 EdTech',              cleanNow.filter(x=>x.Section==='📚 EdTech')],
    ['💆‍♂️ Массаж',           cleanNow.filter(x=>x.Section==='💆‍♂️ Массаж')],
  ]);
  await postToTelegram(dateStr, grouped);

  // 9) сайт — две витрины
  writeSite(
    cleanNow.map(r=>({
      date:r.Date, section:r.Section, source:r.Source, category:r.Category,
      idea:r.Idea, ease:Number(r.Ease||0), potential:Number(r.Potential||0),
      score:Number(r.Score||0), rationale:r.Rationale||'', link:r.Link||''
    })),
    rawNow.map(r=>({
      date:r.Date, section:r.Section, source:r.Source, category:r.Category,
      idea:r.Idea, ease:Number(r.Ease||0), potential:Number(r.Potential||0),
      score:Number(r.Score||0), rationale:r.Rationale||'', link:r.Link||''
    }))
  );

  console.log(`Done. Appended: ${toAppend.length}. Clean view: ${cleanNow.length}. Raw total: ${rawNow.length}.`);
}

main();
