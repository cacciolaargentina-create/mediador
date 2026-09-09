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

// Bloque 12 de Mediador (B2B) — misma regla de fondo que arriba (§24 de la
// especificación original: nunca decide quién tiene razón, nunca da
// consejo legal, nunca inventa), adaptada a que acá el contexto no es un
// chat de coparentalidad sino los datos estructurados de una mediación.
const MEDIATION_SYSTEM_PROMPT = `Sos el asistente de una mediación dentro de Mediador (producto B2B para mediadores profesionales, de Puente Digital). Respondés preguntas del mediador/a ÚNICAMENTE en base a los DATOS DE LA MEDIACIÓN que te paso a continuación (partes, abogados, audiencias, documentos, tareas, compromisos y timeline).

Reglas, sin excepción:
- Respondé en español, en 2 a 6 oraciones, tono profesional y concreto.
- Citá fechas, nombres y estados exactos cuando corresponda.
- Si la pregunta es sobre algo que no aparece en los datos de abajo, decilo explícitamente ("no encuentro eso en los datos de esta mediación") en vez de inventar.
- NUNCA decidís quién tiene razón entre las partes, NUNCA das consejo legal ni recomendás una estrategia jurídica, NUNCA inventás hechos, documentos o compromisos que no estén en el contexto.
- Si te piden un resumen, organizalo como: qué pasó, qué está pendiente, quién debe hacer qué, y para cuándo — pero solo con lo que efectivamente está en los datos.`;

// Bloque 12 — versión cross-mediación, para preguntas del estilo "¿qué
// mediaciones tienen algo pendiente esta semana?" que no son sobre una
// mediación puntual sino sobre el conjunto de las del mediador logueado.
const DASHBOARD_SYSTEM_PROMPT = `Sos el asistente operativo de un mediador/a dentro de Mediador (producto B2B de Puente Digital). Respondés preguntas sobre el CONJUNTO de sus mediaciones activas, usando ÚNICAMENTE el resumen de abajo (una fila por mediación con su estado, próxima acción, tareas y compromisos pendientes).

Reglas, sin excepción:
- Respondé en español, en 2 a 6 oraciones, priorizando lo más urgente primero (vencido antes que por vencer).
- Citá el código de mediación (ej. "MED-2026-0042") cuando te refieras a una puntual.
- Si la pregunta pide algo que no está en el resumen de abajo (por ejemplo, contenido de mensajes o detalle de documentos), decilo explícitamente en vez de inventar.
- NUNCA decidís quién tiene razón en ninguna mediación, NUNCA das consejo legal.`;

async function callAssistantAPI(systemPrompt, userContent) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return 'El asistente no está disponible todavía (falta configurar ANTHROPIC_API_KEY en el servidor).';
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
      max_tokens: 600,
      system: systemPrompt,
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

async function askAssistant(question, context) {
  const userContent = `HISTORIAL DE MENSAJES (más reciente al final):
${context.msgLines || '(sin mensajes todavía)'}

CALENDARIO DE ACUERDOS:
${context.evLines || '(sin eventos cargados todavía)'}

Fecha y hora actual: ${new Date().toISOString()}

PREGUNTA DEL USUARIO: ${question}`;
  return callAssistantAPI(SYSTEM_PROMPT, userContent);
}

// mediationContext: el texto ya armado (reusa buildMediationPlainContent
// de certificate.js — no se duplica esa lógica de armado acá).
async function askMediationAssistant(question, mediationContext) {
  const userContent = `DATOS DE LA MEDIACIÓN:\n${mediationContext}\n\nFecha y hora actual: ${new Date().toISOString()}\n\nPREGUNTA DEL MEDIADOR/A: ${question}`;
  return callAssistantAPI(MEDIATION_SYSTEM_PROMPT, userContent);
}

async function askDashboardAssistant(question, dashboardContext) {
  const userContent = `RESUMEN DE MEDIACIONES ACTIVAS:\n${dashboardContext}\n\nFecha y hora actual: ${new Date().toISOString()}\n\nPREGUNTA DEL MEDIADOR/A: ${question}`;
  return callAssistantAPI(DASHBOARD_SYSTEM_PROMPT, userContent);
}

module.exports = { askAssistant, askMediationAssistant, askDashboardAssistant };
