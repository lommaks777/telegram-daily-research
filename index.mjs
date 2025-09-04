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

// ----------- ENV -----------
const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID   = process.env.TG_CHAT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('Missing TG_BOT_TOKEN or TG_CHAT_ID');
  // Не выходим: пусть сайт соберётся даже без Telegram
}
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ----------- PATHS -----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const CSV_PATH   = path.join(__dirname, 'hypotheses.csv');
const DOCS_DIR   = path.join(__dirname, 'docs');
fs.mkdirSync(DOCS_DIR, { recursive: true });

// ----------- CONFIG -----------
const defaultConfig = {
  business_context: "Онлайн-школа массажа. Воронка: таргет → автовебинар → цепочка писем → живые вебинары. KPI: рост LTV/маржинальности, снижение CPL.",
  constraints: { max_budget_usd: 2000, max_duration_weeks: 2, has_no_dev_team: true },
  scoring: {
    ease: {
      definition: "Сколько времени/ресурсов нужно (≤2 недели, ≤$2000, без dev).",
      scale: { "1": "Очень сложно", "5": "Средне", "10": "Очень легко: 1–3 дня, <$100" }
    },
    potential: {
      definition: "Снижение CPL, рост конверсии и LTV/маржинальности.",
      scale: { "1": "Минимально", "5": "Умеренно (10–20%)", "10": "Сильно (x2 и более)" }
    }
  },
  thresholds: {
    // гипотезы ниже порога — НЕ записываем в CSV/таблицу и НЕ публикуем
    min_potential: 6,
    // необязательно: если укажешь, будет фильтроваться и по интегральному скору
    min_score: null, // например 6.0
    score_weights: { potential: 0.6, ease: 0.4 }
  }
};

function loadConfig() {
  const cfgPath = path.join(__dirname, 'hypothesis-config.json');
  if (!fs.existsSync(cfgPath)) return defaultConfig;
  try { return { ...defaultConfig, ...JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) }; }
  catch { return defaultConfig; }
}
const CONFIG = loadConfig();

// ----------- FEEDS -----------
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
    'https://www.massagetherapyfoundation.org/feed/', // важно: www.
    'https://www.academyofclinicalmassage.com/feed/',
    'https://realbodywork.com/feed',
    'https://themtdc.com/feed'
  ]
};

// ----------- RSS PARSER -----------
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

function sha(s){ return crypto.createHash('sha256').update(s).digest('hex'); }
function toTs(dateLike) {
  const d = dateLike ? new Date(dateLike) : null;
  return d && !Number.isNaN(d.valueOf()) ? d.valueOf() : 0;
}

async function pickLatest(feedUrls, take = PER_SECTION) {
  const all = [];
  for (const url of feedUrls) {
    try {
      const feed = await parser.parseURL(url);
      for (const item of feed.items || []) {
        const ts = toTs(item.isoDate || item.pubDate);
        all.push({
          title: item.title?.trim() || '(без названия)',
          link: item.link,
          ts,
          feedTitle: feed.title || url
        });
      }
    } catch (err) {
      console.error('Ошибка чтения RSS:', url, err.message);
    }
  }
  const freshLimit = Date.now() - FRESH_HOURS * 3600 * 1000;
  const fresh = all.filter(x => x.ts >= freshLimit);
  return (fresh.length ? fresh : all).sort((a, b) => b.ts - a.ts).slice(0, take);
}

// ----------- ARTICLE FETCH -----------
async function fetchText(url) {
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DailyDigestBot/1.0; +https://github.com/)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    const html = await r.text();

    try {
      const dom = new JSDOM(html, { url, pretendToBeVisual: true });
      const reader = new Readability(dom.window.document);
      const parsed = reader.parse();
      if (parsed?.textContent) {
        return parsed.textContent.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
      }
    } catch (e) {
      console.error('Readability/JSDOM error:', e.message);
    }

    // fallback: грубо вычистим теги
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<\/?[^>]+(>|$)/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, MAX_CHARS);
  } catch {
    return '';
  }
}

// ----------- GPT HYPOTHESES -----------
function buildPrompt() {
  const { business_context, constraints, scoring, thresholds } = CONFIG;
  return `
Ты — консультант по росту онлайн-школы массажа.
Контекст: ${business_context}
Ограничения: без отдела разработки: ${constraints.has_no_dev_team ? 'да' : 'нет'}, бюджет теста ≤ $${constraints.max_budget_usd}, срок проверки ≤ ${constraints.max_duration_weeks} недели.

Шкалы оценки:
- "Простота (ease)" (1–10): ${scoring.ease.definition}. Примеры: ${JSON.stringify(scoring.ease.scale)}
- "Потенциал (potential)" (1–10): ${scoring.potential.definition}. Примеры: ${JSON.stringify(scoring.potential.scale)}

Требования:
- Генерируй гипотезы ТОЛЬКО релевантные для воронки (таргет → автовебинар → письма → живые вебинары) и продукта школы массажа (апсейл, контент, пакетирование и т.п.).
- НЕ предлагай идеи, требующие разработки/кодинга/долгих интеграций.
- Учитывай, что гипотезы дешевле — лучше, но высокий потенциал важнее.
- Для каждой гипотезы верни объект с полями:
  { "idea": "суть", "ease": <1-10>, "potential": <1-10>, "rationale": "почему и как это бьёт по CPL/LTV" }

Ответ — ЧИСТЫЙ JSON массив без пояснений.
`;
}

async function gptHypotheses(title, text) {
  const sys = buildPrompt();
  const resp = await openai.responses.create({
    model: 'gpt-4.1-mini',
    input: [
      { role: 'system', content: sys },
      { role: 'user', content: `Заголовок: ${title}\nТекст: ${text}` }
    ]
  });
  try {
    return JSON.parse(resp.output_text);
  } catch (e) {
    console.error('GPT parse error:', e.message);
    return [];
  }
}

// ----------- CSV I/O & DEDUPE -----------
function loadCsv() {
  if (!fs.existsSync(CSV_PATH)) return [];
  const raw = fs.readFileSync(CSV_PATH, 'utf-8').split(/\r?\n/).filter(Boolean);
  if (raw.length <= 1) return [];
  const header = raw[0].split(',');
  const rows = raw.slice(1).map(line => {
    // простейший CSV — без экранирования запятых внутри текста
    const cols = line.split(',');
    const obj = {};
    header.forEach((h, i) => obj[h] = cols[i]);
    // нормализуем числовые поля
    obj.Ease = Number(obj.Ease || 0);
    obj.Potential = Number(obj.Potential || 0);
    obj.Score = Number(obj.Score || 0);
    return obj;
  });
  return rows;
}

function buildDedupSet(rows) {
  const set = new Set();
  for (const r of rows) {
    const key = sha(`${(r.Section||'').toLowerCase().trim()}|${(r.Idea||'').toLowerCase().trim()}`);
    set.add(key);
  }
  return set;
}

// ----------- SECTION BUILD -----------
function score(ease, potential, weights = CONFIG.thresholds.score_weights) {
  const wP = Number(weights?.potential ?? 0.6);
  const wE = Number(weights?.ease ?? 0.4);
  return wP * potential + wE * ease;
}

function passThresholds(h) {
  const t = CONFIG.thresholds || {};
  if (t.min_potential != null && Number(h.potential) < Number(t.min_potential)) return false;
  if (t.min_score != null && score(h.ease, h.potential) < Number(t.min_score)) return false;
  return true;
}

async function buildSection(title, items) {
  const out = [];
  for (const it of items) {
    const text = await limit(() => fetchText(it.link));
    const hyps = await limit(() => gptHypotheses(it.title, text));
    for (const h of hyps) {
      if (!h?.idea) continue;
      if (!passThresholds(h)) continue; // режем низкий ROI
      out.push({
        section: title,
        source: it.feedTitle,
        link: it.link,
        idea: (h.idea || '').trim(),
        ease: Number(h.ease || 0),
        potential: Number(h.potential || 0),
        rationale: (h.rationale || '').trim()
      });
    }
  }
  return out;
}

// ----------- TELEGRAM -----------
function esc(s=''){ return s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }

async function postToTelegram(dateStr, bySection) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  const blocks = [];
  for (const [title, arr] of bySection) {
    if (!arr.length) continue;
    const lines = arr.map(h => `• ${esc(h.idea)}
<i>Простота: ${h.ease}/10 · Потенциал: ${h.potential}/10</i>
<code>${esc(h.source)}</code>`);
    blocks.push(`<b>${title}</b>\n${lines.join('\n\n')}`);
  }
  if (!blocks.length) return;
  const text = [`<b>Ежедневный ресерч — ${dateStr}</b>`, ...blocks, `\n🔗 Полная таблица: https://lommaks777.github.io/telegram-daily-research/`]
    .join('\n\n');
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
  } catch (e) {
    console.error('Telegram error:', e.message);
  }
}

// ----------- SITE BUILD -----------
function writeSiteFromAllRows(rows) {
  // rows — это ВСЕ строки из CSV (старые + новые)
  const weights = CONFIG.thresholds?.score_weights || { potential: 0.6, ease: 0.4 };
  const enriched = rows.map(r => {
    const ease = Number(r.Ease || r.ease || 0);
    const potential = Number(r.Potential || r.potential || 0);
    const sc = Number(r.Score || score(ease, potential, weights));
    return {
      date: r.Date || r.date,
      section: r.Section || r.section,
      source: r.Source || r.source,
      idea: r.Idea || r.idea,
      ease, potential,
      score: sc,
      rationale: r.Rationale || r.rationale || '',
      link: r.Link || r.link || ''
    };
  });

  // JSON
  fs.writeFileSync(path.join(DOCS_DIR, 'hypotheses.json'), JSON.stringify(enriched, null, 2));

  // HTML
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
</style>
</head><body>
<h1>Топ гипотез (по score)</h1>
<p><small>Score = ${weights.potential}×Potential + ${weights.ease}×Ease. В таблице сохраняются все прошедшие порог гипотезы, старые записи не удаляются.</small></p>
<table id="t"><thead><tr>
<th data-k="date">Дата</th>
<th data-k="section">Раздел</th>
<th data-k="source">Источник</th>
<th data-k="idea">Гипотеза</th>
<th data-k="ease">Простота</th>
<th data-k="potential">Потенциал</th>
<th data-k="score">Score</th>
<th data-k="rationale">Почему</th>
<th data-k="link">Ссылка</th>
</tr></thead><tbody></tbody></table>
<script>
let data=[],key='score',dir=-1;
async function load(){ const r=await fetch('hypotheses.json'); data=await r.json(); render(); }
function sortFn(a,b){ if(a[key]===b[key]) return 0; return (a[key]>b[key]?1:-1)*dir; }
function render(){
  const tb=document.querySelector('tbody'); tb.innerHTML='';
  const rows=[...data].sort(sortFn);
  for(const x of rows){
    const tr=document.createElement('tr');
    tr.innerHTML=\`<td>\${x.date||''}</td><td>\${x.section||''}</td><td>\${x.source||''}</td>
    <td>\${x.idea||''}</td><td><span class="pill">\${x.ease}</span></td>
    <td><span class="pill">\${x.potential}</span></td><td><span class="pill">\${(x.score||0).toFixed(1)}</span></td>
    <td>\${x.rationale||''}</td><td>\${x.link?'<a target="_blank" href="'+x.link+'">link</a>':''}</td>\`;
    tb.appendChild(tr);
  }
}
document.querySelectorAll('th').forEach(th=> th.onclick=()=>{ key=th.dataset.k; dir*=-1; render(); });
load();
</script>
</body></html>`;
  fs.writeFileSync(path.join(DOCS_DIR, 'index.html'), html);
}

// ----------- MAIN -----------
async function main(){
  const date = new Date().toLocaleDateString('ru-RU');

  // 1) читаем CSV (старые записи), строим set дублей
  const existing = loadCsv();              // [{Date,Section,Source,Idea,Ease,Potential,Score,Link,Rationale}]
  const dedupSet = buildDedupSet(existing);

  // 2) парсим фиды, собираем новые гипотезы (после порогов)
  const [salesRaw, edtechRaw, massageRaw] = await Promise.all([
    pickLatest(FEEDS.sales),
    pickLatest(FEEDS.edtech),
    pickLatest(FEEDS.massage)
  ]);

  const salesHyps   = await buildSection('🚀 Продажи и маркетинг', salesRaw);
  const edtechHyps  = await buildSection('📚 EdTech', edtechRaw);
  const massageHyps = await buildSection('💆‍♂️ Массаж', massageRaw);

  const newCandidates = [...salesHyps, ...edtechHyps, ...massageHyps];

  // 3) режем дубли по (section+idea) относительно всего CSV
  const reallyNew = [];
  for (const h of newCandidates) {
    const key = sha(`${h.section.toLowerCase().trim()}|${h.idea.toLowerCase().trim()}`);
    if (dedupSet.has(key)) continue;
    dedupSet.add(key);
    reallyNew.push(h);
  }

  // 4) отправка в Telegram (только то, что отобрали)
  const grouped = new Map([
    ['🚀 Продажи и маркетинг', reallyNew.filter(x=>x.section==='🚀 Продажи и маркетинг')],
    ['📚 EdTech',              reallyNew.filter(x=>x.section==='📚 EdTech')],
    ['💆‍♂️ Массаж',           reallyNew.filter(x=>x.section==='💆‍♂️ Массаж')],
  ]);
  await postToTelegram(date, grouped); // не валит ран при ошибке

  // 5) дозаписываем в CSV ТОЛЬКО прошедшие фильтр (старые не трогаем)
  if (reallyNew.length) {
    // вычислим Score сразу для сохранения
    const weights = CONFIG.thresholds?.score_weights || { potential: 0.6, ease: 0.4 };
    const toAppend = reallyNew.map(x => ({
      Date: date,
      Section: x.section,
      Source: x.source,
      Idea: x.idea,
      Ease: x.ease,
      Potential: x.potential,
      Score: score(x.ease, x.potential, weights).toFixed(3),
      Link: x.link,
      Rationale: x.rationale || ''
    }));

    const csvWriter = createObjectCsvWriter({
      path: CSV_PATH,
      header: [
        { id: 'Date', title: 'Date' },
        { id: 'Section', title: 'Section' },
        { id: 'Source', title: 'Source' },
        { id: 'Idea', title: 'Idea' },
        { id: 'Ease', title: 'Ease' },
        { id: 'Potential', title: 'Potential' },
        { id: 'Score', title: 'Score' },
        { id: 'Link', title: 'Link' },
        { id: 'Rationale', title: 'Rationale' }
      ],
      append: fs.existsSync(CSV_PATH)
    });
    await csvWriter.writeRecords(toAppend);
  }

  // 6) перезагружаем ВСЁ из CSV и пересобираем сайт (старые остаются)
  const allRows = loadCsv();
  writeSiteFromAllRows(allRows);

  console.log(`Done. New hypotheses saved: ${reallyNew.length}. CSV total: ${allRows.length}.`);
}

main();
