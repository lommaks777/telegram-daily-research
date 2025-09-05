import Parser from 'rss-parser';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

const parser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (DailyDigestBot)',
    'Accept': 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8'
  }
});

export async function pickLatest(feedUrls, take=2, freshHours=72) {
  const all=[];
  for (const url of feedUrls) {
    try {
      const feed = await parser.parseURL(url);
      for (const item of feed.items||[]) {
        const ts = (item.isoDate||item.pubDate) ? new Date(item.isoDate||item.pubDate).valueOf() : 0;
        all.push({ title:item.title?.trim()||'(без названия)', link:item.link, ts, feedTitle: feed.title||url });
      }
    } catch(e){ console.error('RSS:', url, e.message); }
  }
  const freshLimit = Date.now() - freshHours*3600*1000;
  const fresh = all.filter(x=>x.ts>=freshLimit);
  return (fresh.length?fresh:all).sort((a,b)=>b.ts-a.ts).slice(0,take);
}

export async function fetchReadable(url, maxChars=8000) {
  try{
    const r = await fetch(url, { headers:{'User-Agent':'Mozilla/5.0 (DailyDigestBot)'} });
    const html = await r.text();
    try{
      const dom = new JSDOM(html,{url,pretendToBeVisual:true});
      const reader = new Readability(dom.window.document);
      const parsed = reader.parse();
      if (parsed?.textContent) return parsed.textContent.replace(/\s+/g,' ').trim().slice(0,maxChars);
    }catch{}
    return html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'')
               .replace(/<\/?[^>]+(>|$)/g,' ').replace(/\s{2,}/g,' ').trim().slice(0,maxChars);
  }catch{ return ''; }
}
