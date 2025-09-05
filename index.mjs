import fs from 'fs';
import path from 'path';
import pLimit from 'p-limit';
import OpenAI from 'openai';

import { csvPath, loadCsvRaw, appendCsv } from './src/csv.js';
import { pickLatest, fetchReadable } from './src/rss.js';
import { buildPrompt, gptHypotheses } from './src/gpt.js';
import { postToTelegram } from './src/telegram.js';
import { writeSite } from './src/site.js';

/* ===== ENV / PATHS ===== */
const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID   = process.env.TG_CHAT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REPO_URL = 'https://lommaks777.github.io/telegram-daily-research/';

const __dirname = path.resolve('.');
const CSV_FILE  = csvPath(__dirname);
const DOCS_DIR  = path.join(__dirname, 'docs');
fs.mkdirSync(DOCS_DIR, { recursive: true });

/* ===== CONFIG ===== */
const defaultConfig = JSON.parse(fs.readFileSync('hypothesis-config.json','utf8'));
const CONFIG = defaultConfig;
const WEIGHTS = CONFIG.thresholds?.score_weights || { potential:0.6, ease:0.4 };

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

/* ===== HELPERS ===== */
const limit = pLimit(3);
const todayRu = () => new Date().toLocaleDateString('ru-RU');
const score = (ease, potential) => WEIGHTS.potential*Number(potential||0) + WEIGHTS.ease*Number(ease||0);

// фильтрация «релевантных»
function isRelevant(idea='', rationale='', section='', category='') {
  const text = [idea, rationale, section].join(' ');
  if (!idea.trim()) return false;
  if (isLikelyEnglish(text)) return false;
  if (REJECT_PATTERNS.some(rx => rx.test(text))) return false;
  if (!containsAnyKeyword(text, MUST_HAVE_ANY)) return false;
  return true;
}

/* ===== MAIN BUILD STEPS ===== */
async function buildSection(title, list, openai, prompt){
  const out=[];
  for(const it of list){
    const text = await limit(()=>fetchReadable(it.link));
    const hyps = await limit(()=>gptHypotheses(openai, prompt, it.title, text));
    for(const h of hyps){
      if (Number(h.potential||0) < Number(CONFIG.thresholds.min_potential||0)) continue;
      out.push({
        Date: todayRu(), Section: title, Source: it.feedTitle,
        Category: ['Реклама','Воронка','Продукт'].includes(h.category) ? h.category : inferCategory(h.idea||''),
        Idea: (h.idea||'').trim(), Ease: Number(h.ease||0), Potential: Number(h.potential||0),
        Score: score(h.ease, h.potential), Link: it.link, Rationale: (h.rationale||'').trim()
      });
    }
  }
  return out;
}

function inferCategory(idea=''){
  const s=idea.toLowerCase();
  if (/(ads?|таргет|креатив|facebook|meta|tiktok|google|лендинг|посадочн|utm|аудитор)/.test(s)) return 'Реклама';
  if (/(воронк|webinar|вебинар|емейл|письм|ретаргет|лид-магнит|квиз|онбординг|lead|tripwire)/.test(s)) return 'Воронка';
  return 'Продукт';
}

async function main() {
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  const prompt = buildPrompt(CONFIG);
  const dateStr = todayRu();

  // 1) читаем CSV
  const rawBefore = loadCsvRaw(CSV_FILE);

  // 2) RSS
  const [s, e, m] = await Promise.all([
    pickLatest(FEEDS.sales, 2, 72),
    pickLatest(FEEDS.edtech, 2, 72),
    pickLatest(FEEDS.massage, 2, 72)
  ]);

  // 3) GPT → гипотезы
  const sales   = await buildSection('🚀 Продажи и маркетинг', s, openai, prompt);
  const edtech  = await buildSection('📚 EdTech', e, openai, prompt);
  const massage = await buildSection('💆‍♂️ Массаж', m, openai, prompt);

  // 4) анти-дубли поверх имеющихся
  const seen = new Set(rawBefore.map(r => (r.Section+'|'+(r.Idea||'')).toLowerCase()));
  const toAppend = [];
  for (const h of [...sales, ...edtech, ...massage]) {
    const key = (h.Section+'|'+h.Idea).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (isRelevant(h.Idea, h.Rationale, h.Section)) toAppend.push(h);
  }

  // 5) дозапись
  await appendCsv(CSV_FILE, toAppend);

  // 6) перечитываем CSV и делаем витрины
  const rawNow   = loadCsvRaw(CSV_FILE);
  const cleanNow = rawNow.filter(r => isRelevant(r.Idea, r.Rationale, r.Section));

  // 7) сайт
  writeSite({
    docsDir: DOCS_DIR,
    cleanRows: cleanNow,
    rawRows: rawNow,
    weights: WEIGHTS
  });

  // 8) телеграм (только релевантные)
  const grouped = new Map([
    ['🚀 Продажи и маркетинг', cleanNow.filter(x=>x.Section==='🚀 Продажи и маркетинг')],
    ['📚 EdTech',              cleanNow.filter(x=>x.Section==='📚 EdTech')],
    ['💆‍♂️ Массаж',           cleanNow.filter(x=>x.Section==='💆‍♂️ Массаж')],
  ]);
  await postToTelegram({
    token: BOT_TOKEN,
    chatId: CHAT_ID,
    dateStr,
    grouped,
    siteUrl: REPO_URL
  });

  console.log(`Done. Appended: ${toAppend.length}. Clean view: ${cleanNow.length}. Raw total: ${rawNow.length}.`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
