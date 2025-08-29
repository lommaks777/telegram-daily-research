import Parser from 'rss-parser';

const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID; // -100XXXXXXXXXX или @username

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('Missing TG_BOT_TOKEN or TG_CHAT_ID');
  process.exit(1);
}

const parser = new Parser({ timeout: 15000 });

// ===================== Источники (можно редактировать) =====================
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

// Сколько часов считаем «свежими» материалами
const FRESH_HOURS = 72; // 3 дня

function toTs(dateLike) {
  const d = dateLike ? new Date(dateLike) : null;
  return d && !Number.isNaN(d.valueOf()) ? d.valueOf() : 0;
}

async function pickLatest(feedUrls, take = 2) {
  const all = [];
  for (const url of feedUrls) {
    try {
      const feed = await parser.parseURL(url);
      for (const item of feed.items || []) {
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
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function section(title, items) {
  if (!items.length) return '';
  const lines = items.map((x) => `• <a href="${x.link}">${esc(x.title)}</a>`).join('\n');
  return `<b>${title}</b>\n${lines}`;
}

async function main() {
  const [sales, edtech, massage] = await Promise.all([
    pickLatest(FEEDS.sales, 2),
    pickLatest(FEEDS.edtech, 2),
    pickLatest(FEEDS.massage, 2)
  ]);

  const date = new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const parts = [
    `<b>Ежедневный ресерч — ${date}</b>`,
    section('🚀 Продажи и маркетинг', sales),
    section('📚 Продукт онлайн‑обучения (EdTech)', edtech),
    section('💆‍♂️ Массаж / мануальная терапия', massage),
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
