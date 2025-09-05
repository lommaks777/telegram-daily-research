import fs from 'fs';
import path from 'path';

export function writeSite({ docsDir, cleanRows, rawRows, weights }) {
  const rel = cleanRows.map(nrm);
  const all = rawRows.map(nrm);

  fs.writeFileSync(path.join(docsDir,'hypotheses.json'), JSON.stringify(rel, null, 2));
  fs.writeFileSync(path.join(docsDir,'hypotheses_all.json'), JSON.stringify(all, null, 2));

  const html = `<!doctype html><html lang="ru"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Гипотезы — приоритеты</title>
<style>
body{font-family:system-ui,Arial,sans-serif;margin:24px}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ddd;padding:8px;vertical-align:top}
th{cursor:pointer;background:#f7f7f7}
tr:nth-child(even){background:#fafafa}
.pill{padding:2px 8px;border-radius:12px;background:#eee}
.controls{margin:12px 0;display:flex;gap:8px;flex-wrap:wrap}
button{padding:6px 10px;border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer}
button.active{background:#efefef}
.note{margin:8px 0;color:#666}
</style></head><body>
<h1>Топ гипотез (по score)</h1>
<p class="note">Score = ${weights.potential}×Potential + ${weights.ease}×Ease. Можно переключать: релевантные / все записи.</p>

<div class="controls">
  <button id="viewRel" class="active">Релевантные</button>
  <button id="viewAll">Все</button>
  <button data-filter="all" class="active">Все</button>
  <button data-filter="Реклама">Реклама</button>
  <button data-filter="Воронка">Воронка</button>
  <button data-filter="Продукт">Продукт</button>
</div>

<table id="t"><thead><tr>
<th data-k="date">Дата</th><th data-k="section">Раздел</th><th data-k="source">Источник</th>
<th data-k="category">Категория</th><th data-k="idea">Гипотеза</th>
<th data-k="ease">Простота</th><th data-k="potential">Потенциал</th><th data-k="score">Score</th>
<th data-k="rationale">Почему</th><th data-k="link">Ссылка</th>
</tr></thead><tbody></tbody></table>

<script>window.__REL__=${JSON.stringify(rel)};window.__ALL__=${JSON.stringify(all)};</script>
<script>
let data=[], all=[], key='score', dir=-1, filter='all', useAll=false;
async function tryFetch(u){ try{ const r=await fetch(u+'?ts='+Date.now()); if(!r.ok) throw 0; return await r.json(); }catch{return null;}}
async function load(){
  const a=await tryFetch('hypotheses.json'); const b=await tryFetch('hypotheses_all.json');
  data=Array.isArray(a)?a:Array.isArray(window.__REL__)?window.__REL__:[];
  all =Array.isArray(b)?b:Array.isArray(window.__ALL__)?window.__ALL__:[];
  if(!data.length && all.length){ useAll=true; document.getElementById('viewAll').classList.add('active'); document.getElementById('viewRel').classList.remove('active'); }
  render();
}
function sortFn(a,b){ const av=a[key], bv=b[key]; if(av===bv) return 0; return (av>bv?1:-1)*dir; }
function render(){
  const tb=document.querySelector('tbody'); tb.innerHTML='';
  const src=useAll?all:data;
  const rows=[...src].filter(x=> filter==='all'?true:(x.category===filter)).sort(sortFn);
  for(const x of rows){
    const sc=Number.isFinite(x.score)?x.score:Number(x.score||0);
    const tr=document.createElement('tr');
    tr.innerHTML=\`<td>\${x.date||''}</td><td>\${x.section||''}</td><td>\${x.source||''}</td>
<td>\${x.category||''}</td><td>\${x.idea||''}</td>
<td><span class="pill">\${Number.isFinite(x.ease)?x.ease:''}</span></td>
<td><span class="pill">\${Number.isFinite(x.potential)?x.potential:''}</span></td>
<td><span class="pill">\${Number.isFinite(sc)?sc.toFixed(1):'0.0'}</span></td>
<td>\${x.rationale||''}</td><td>\${x.link?'<a target="_blank" href="'+x.link+'">link</a>':''}</td>\`;
    tb.appendChild(tr);
  }
}
document.querySelectorAll('th').forEach(th=> th.onclick=()=>{ key=th.dataset.k; dir*=-1; render(); });
document.querySelectorAll('.controls button[data-filter]').forEach(b=> b.onclick=()=>{ document.querySelectorAll('.controls button[data-filter]').forEach(x=>x.classList.remove('active')); b.classList.add('active'); filter=b.dataset.filter; render(); });
document.getElementById('viewRel').onclick=()=>{ useAll=false; document.getElementById('viewRel').classList.add('active'); document.getElementById('viewAll').classList.remove('active'); render(); };
document.getElementById('viewAll').onclick=()=>{ useAll=true; document.getElementById('viewAll').classList.add('active'); document.getElementById('viewRel').classList.remove('active'); render(); };
load();
</script></body></html>`;
  fs.writeFileSync(path.join(docsDir,'index.html'), html);
}

function nrm(r={}){ // нормализация ключей для фронта
  return {
    date: r.Date ?? r.date ?? '',
    section: r.Section ?? r.section ?? '',
    source: r.Source ?? r.source ?? '',
    category: r.Category ?? r.category ?? '',
    idea: r.Idea ?? r.idea ?? '',
    ease: Number(r.Ease ?? r.ease ?? 0),
    potential: Number(r.Potential ?? r.potential ?? 0),
    score: Number(r.Score ?? r.score ?? 0),
    rationale: r.Rationale ?? r.rationale ?? '',
    link: r.Link ?? r.link ?? ''
  };
}
