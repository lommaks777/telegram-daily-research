const esc = s => (s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');

export async function postToTelegram({ token, chatId, dateStr, grouped, siteUrl }) {
  if (!token || !chatId) return;
  const blocks=[];
  for (const [title, arr] of grouped) {
    if (!arr.length) continue;
    const lines = arr.map(h=>`• ${esc(h.idea)}
<i>Категория: ${h.category} · Простота: ${h.ease}/10 · Потенциал: ${h.potential}/10</i>
<code>${esc(h.source)}</code>`);
    blocks.push(`<b>${title}</b>\n${lines.join('\n\n')}`);
  }
  if (!blocks.length) return;
  const text = [`<b>Ежедневный ресерч — ${dateStr}</b>`, ...blocks, `\n🔗 Полная таблица: ${siteUrl}`].join('\n\n');

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ chat_id: chatId, text, parse_mode:'HTML', disable_web_page_preview:true })
  }).catch(()=>{});
}
