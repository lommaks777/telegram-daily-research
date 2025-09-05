import fs from 'fs';
import path from 'path';
import { createObjectCsvWriter } from 'csv-writer';

export function csvPath(baseDir) { return path.join(baseDir, 'hypotheses.csv'); }

export function parseCsv(text) {
  // минимальный парсер CSV (поддержка кавычек)
  const rows=[]; let row=[], cell='', inQ=false;
  for (let i=0;i<text.length;i++){
    const ch=text[i];
    if(ch===`"`){ if(inQ && text[i+1]==='"'){ cell+='"'; i++; } else inQ=!inQ; continue; }
    if(!inQ && (ch===','||ch==='\n'||ch==='\r')){
      row.push(cell); cell='';
      if(ch===',') continue;
      if(ch==='\r' && text[i+1]==='\n') i++;
      if(row.length) rows.push(row), row=[];
      continue;
    }
    cell+=ch;
  }
  if(cell.length||row.length){ row.push(cell); rows.push(row); }
  return rows;
}

const norm = s => (s||'').replace(/^\uFEFF/,'').trim().toLowerCase();

export function loadCsvRaw(file) {
  if (!fs.existsSync(file)) return [];
  const rows = parseCsv(fs.readFileSync(file,'utf8'));
  if (!rows.length) return [];
  const header = rows[0].map(h=>h.replace(/^\uFEFF/,''));
  const find = name => header.findIndex(h => norm(h)===norm(name));

  const iDate=find('Date'), iSection=find('Section'), iSource=find('Source'),
        iCategory=find('Category'), iIdea=find('Idea'), iEase=find('Ease'),
        iPotential=find('Potential'), iScore=find('Score'), iLink=find('Link'),
        iRationale=find('Rationale');

  const out=[];
  for(let k=1;k<rows.length;k++){
    const r=rows[k]; if(!r) continue;
    out.push({
      Date:        iDate      !==-1 ? r[iDate]      : '',
      Section:     iSection   !==-1 ? r[iSection]   : '',
      Source:      iSource    !==-1 ? r[iSource]    : '',
      Category:    iCategory  !==-1 ? r[iCategory]  : '',
      Idea:        iIdea      !==-1 ? r[iIdea]      : '',
      Ease:        iEase      !==-1 ? Number(r[iEase]      || 0) : 0,
      Potential:   iPotential !==-1 ? Number(r[iPotential] || 0) : 0,
      Score:       iScore     !==-1 ? Number(r[iScore]     || 0) : 0,
      Link:        iLink      !==-1 ? r[iLink]      : '',
      Rationale:   iRationale !==-1 ? r[iRationale] : ''
    });
  }
  return out;
}

export async function appendCsv(file, rows) {
  if (!rows?.length) return;
  const csvWriter = createObjectCsvWriter({
    path: file,
    header: [
      { id:'Date', title:'Date' },{ id:'Section', title:'Section' },{ id:'Source', title:'Source' },
      { id:'Category', title:'Category' },{ id:'Idea', title:'Idea' },{ id:'Ease', title:'Ease' },
      { id:'Potential', title:'Potential' },{ id:'Score', title:'Score' },{ id:'Link', title:'Link' },
      { id:'Rationale', title:'Rationale' }
    ],
    append: true
  });
  await csvWriter.writeRecords(rows);
}
