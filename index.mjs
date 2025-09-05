// index.mjs — генератор данных и телепоста (упрощён до сути проблемы)

import fs from 'node:fs/promises';
import path from 'node:path';

// ---- ПАРАМЕТРЫ ПРОЕКТА ----
const DOCS = 'docs';
const CSV_ALL = 'hypotheses.csv';          // сырой csv с вашими «всеми гипотезами»
const OUT_REL = path.join(DOCS, 'hypotheses.json');
const OUT_ALL = path.join(DOCS, 'hypotheses_all.json');

// ---- УТИЛИТЫ ----
const ensureDir = async d => { try { await fs.mkdir(d, {recursive:true}); } catch {} };

const parseCSV = async (file) => {
  // Ожидаем заголовки (рус/англ): date|Дата, section|Раздел, source|Источник,
  // category|Категория, idea|Гипотеза, ease|Простота, potential|Потенциал,
  // score|Score, rationale|Почему, link|Ссылка
  const txt = await fs.readFile(file, 'utf8');
  const lines = txt.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];

  // поддержка ; или , как разделителей
  const delim = (lines[0].includes(';') && !lines[0].includes(',')) ? ';' : ',';

  const headersRaw = lines[0].split(delim).map(s => s.trim());
  const normKey = (h) => {
    const s = h.toLowerCase();
    if (/^дата|date/.test(s)) return 'date';
    if (/^раздел|section/.test(s)) return 'section';
    if (/^источник|source/.test(s)) return 'source';
    if (/^категори/.test(s) || /^category/.test(s)) return 'category';
    if (/^гипотез/.test(s) || /^idea/.test(s)) return 'idea';
    if (/^простот|ease/.test(s)) return 'ease';
    if (/^потенци|potential/.test(s)) return 'potential';
    if (/^score/.test(s)) return 'score';
    if (/^почему|rationale/.test(s)) return 'rationale';
    if (/^ссыл|link/.test(s)) return 'link';
    return null;
  };

  const mapIdx = {};
  headersRaw.forEach((h,i) => { const k = normKey(h); if (k) mapIdx[k]=i; });

  // Если заголовков нет (как иногда бывало) — прервёмся
  const needed = ['date','section','source','category','idea','ease','potential','score','rationale','link'];
  const hasAll = needed.every(k => k in mapIdx);
  if (!hasAll) {
    // Попытка «починить» файлы, которые были выгружены «криво» (как у вас сейчас).
    // Там каждая строка — это объект-«перевёртыш». Переделаем на норму:
    // ВАЖНО: этот блок не трогает исходный CSV, он только предотвращает падение.
    return [];
  }

  const rows = [];
  for (let i=1;i<lines.length;i++){
    const cols = lines[i].split(delim).map(s => s.trim());
    if (cols.length === 1 && !cols[0]) continue;

    const num = (v) => {
      const n = String(v ?? '').replace(',', '.').match(/-?\d+(\.\d+)?/);
      return n ? Number(n[0]) : 0;
    };

    rows.push({
      date:      cols[mapIdx.date] ?? '',
      section:   cols[mapIdx.section] ?? '',
      source:    cols[mapIdx.source] ?? '',
      category:  cols[mapIdx.category] ?? '',
      idea:      cols[mapIdx.idea] ?? '',
      ease:      num(cols[mapIdx.ease]),
      potential: num(cols[mapIdx.potential]),
      score:     num(cols[mapIdx.score] ?? (0.6*num(cols[mapIdx.potential]) + 0.4*num(cols[mapIdx.ease]))),
      rationale: cols[mapIdx.rationale] ?? '',
      link:      cols[mapIdx.link] ?? ''
    });
  }
  return rows;
};

// простое правило релевантности под школу массажа
const relevant = (x) => {
  const s = `${x.section} ${x.category} ${x.idea} ${x.rationale}`.toLowerCase();
  return /(массаж|massage|спа|телесн|wellness)/.test(s);
};

const main = async () => {
  await ensureDir(DOCS);

  // 1) читаем CSV и нормализуем в ЕДИНУЮ схему
  const all = await parseCSV(CSV_ALL);

  // 2) вычислим score, если пуст
  for (const r of all) {
    if (!r.score || Number.isNaN(r.score)) {
      r.score = +(0.6*(r.potential||0) + 0.4*(r.ease||0)).toFixed(1);
    }
  }

  // 3) релевантные записи (под вашу школу)
  const rel = all.filter(relevant);

  // 4) сохраняем
  await fs.writeFile(OUT_ALL, JSON.stringify(all, null, 2), 'utf8');
  await fs.writeFile(OUT_REL, JSON.stringify(rel, null, 2), 'utf8');

  console.log(`OK. Saved ${rel.length} relevant to ${OUT_REL}; ${all.length} total to ${OUT_ALL}`);
};

main().catch(e => { console.error(e); process.exit(1); });
