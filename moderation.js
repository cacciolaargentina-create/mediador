// moderation.js
// Llama a la API de Anthropic para analizar un mensaje antes de que se envíe.
// Necesita ANTHROPIC_API_KEY en el .env (a diferencia del prototipo en artifact,
// acá SÍ hace falta tu propia API key: https://console.anthropic.com/settings/keys).

const SYSTEM_PROMPT = `Sos el motor de moderación de una app de comunicación mediada para exparejas en contexto de coparentalidad. Tu única tarea es analizar UN mensaje y responder SOLO con un objeto JSON, sin texto adicional, sin markdown, sin backticks.

Formato exacto:
{"flagged": boolean, "category": string, "reason": string, "reformulation": string}

Reglas:
- "flagged" es true si el mensaje contiene insultos, amenazas, acusaciones personales, sarcasmo hiriente, o lenguaje que probablemente escale el conflicto en vez de resolver un tema práctico (horarios, entregas, acuerdos, salud o educación de hijos).
- Si "flagged" es false, "category", "reason" y "reformulation" deben ser strings vacíos "".
- Si "flagged" es true: "category" es una etiqueta corta (2-4 palabras) en español, "reason" explica en una oración por qué puede escalar el conflicto, y "reformulation" es una reescritura breve, neutral, centrada en hechos y en el tema práctico de fondo (nunca inventes hechos nuevos, mantené la intención práctica original).
- No es tu trabajo decidir quién tiene razón. No uses comillas dobles dentro de los valores de texto.`;

async function analyzeMessage(text) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY no configurada — se omite la moderación.');
    return { flagged: false, category: '', reason: '', reformulation: '' };
  }

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Anthropic API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const textBlocks = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const clean = textBlocks.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

module.exports = { analyzeMessage };
