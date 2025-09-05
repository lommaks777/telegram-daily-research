import OpenAI from 'openai';

export function buildPrompt(CONFIG) {
  const { business_context, constraints } = CONFIG;
  return `
Ты — консультант по росту онлайн-школы массажа.
Контекст: ${business_context}
Ограничения: без отдела разработки: ${constraints.has_no_dev_team?'да':'нет'}, бюджет теста ≤ $${constraints.max_budget_usd}, срок проверки ≤ ${constraints.max_duration_weeks} недели. Если идея НЕ применима к школе массажа — НЕ выводи её вовсе.
Пиши ТОЛЬКО НА РУССКОМ.

Категории: "Реклама", "Воронка", "Продукт".
Верни ЧИСТЫЙ JSON-массив объектов:
{"idea":"коротко, обязательно в контексте школы массажа","category":"Реклама|Воронка|Продукт","ease":7,"potential":9,"rationale":"почему снизит CPL/повысит LTV/маржу именно для школы массажа"}`.trim();
}

export async function gptHypotheses(openai, prompt, title, text) {
  const resp = await openai.responses.create({
    model: 'gpt-4.1-mini',
    input: [{ role:'system', content: prompt }, { role:'user', content: `Заголовок: ${title}\nТекст: ${text}` }]
  });
  try { return JSON.parse(resp.output_text)||[]; }
  catch { return []; }
}
