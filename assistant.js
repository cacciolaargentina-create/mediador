// assistant.js
// Asistente de consultas dentro de un canal: responde preguntas del usuario
// usando ÚNICAMENTE el historial de mensajes y el calendario de acuerdos de
// ESE canal como contexto — no tiene memoria de otros canales, no inventa
// datos que no estén en el contexto, y no da consejo legal ni terapéutico.

const SYSTEM_PROMPT = `Sos el asistente de un canal dentro de Puente Digital, una app de comunicación mediada para coparentalidad. Respondés preguntas del usuario ÚNICAMENTE en base al HISTORIAL DE MENSAJES y el CALENDARIO DE ACUERDOS de este canal que te paso a continuación.

Reglas:
- Respondé en español, en 2 a 5 oraciones, tono neutral y concreto.
- Citá fechas cuando corresponda (ej. "el 5 de septiembre").
- Si la pregunta es sobre algo que no aparece en el historial, decilo explícitamente ("no encuentro eso en el historial de este canal") en vez de inventar.
- No des consejo legal, terapéutico, ni le digas a nadie quién tiene razón en un conflicto — si te lo piden, sugerí consultar a un profesional.
- No inventes mensajes, fechas ni acuerdos que no estén en el contexto de abajo.`;

async function askAssistant(question, context) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return 'El asistente no está disponible todavía (falta configurar ANTHROPIC_API_KEY en el servidor).';
  }

  const userContent = `HISTORIAL DE MENSAJES (más reciente al final):
${context.msgLines || '(sin mensajes todavía)'}

CALENDARIO DE ACUERDOS:
${context.evLines || '(sin eventos cargados todavía)'}

Fecha y hora actual: ${new Date().toISOString()}

PREGUNTA DEL USUARIO: ${question}`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Anthropic API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const answer = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return answer || 'No pude generar una respuesta. Probá reformular la pregunta.';
}

module.exports = { askAssistant };
