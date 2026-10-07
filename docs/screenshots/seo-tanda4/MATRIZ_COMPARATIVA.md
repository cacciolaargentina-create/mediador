# Matriz comparativa — Mediador vs. competidores (investigación)

**Antes de escribir una sola página.** Todo lo de acá es investigación —
cero código tocado. Fecha de consulta de las fuentes públicas: 1 de
octubre de 2026.

## Quién es quién

- **medi.ar** — el único competidor **directo** confirmado: software de
  mediación específico (no gestión legal general), mismo público
  declarado (mediadores, abogados, centros de mediación, estudios
  jurídicos). Investigado con detalle acá abajo.
- **Veredicta, LITIS, IUSNET** — software de gestión legal **general**
  para abogados (expedientes judiciales, no mediación específicamente).
  Ninguno de los tres menciona mediación en su sitio público (confirmado
  en la auditoría de la Tanda 2, docs/AUDITORIA_SEO.md). No son
  comparables punto a punto con Mediador sin forzar la comparación — los
  dejo fuera de la matriz por ese motivo, no los investigué más a fondo
  para esto.

---

## 1. Precios — verificado, con fuente

| | **Mediador** | **medi.ar** |
|---|---|---|
| Plan gratuito | $0/mes | $0/mes |
| Plan medio | $30.000/mes (Profesional) | $40.000/mes (Básico) |
| Plan superior | $50.000/mes (Estudio) | $90.000/mes (Profesional) |
| Moneda | ARS | ARS, "incluyen IVA" (textual) |

**Nota:** precio actualizado el 1/10/2026 (suba de $15.000/$35.000 a
$30.000/$50.000, decisión tomada en base a esta misma investigación —
seguimos más baratos que medi.ar en los dos escalones, y la cantidad de
mediaciones activas simultáneas de Profesional/Estudio no cambió, sigue
sin límite). Las secciones de abajo de este documento quedaron redactadas
contra los precios viejos en la fecha en que se escribieron — el número
que vale es siempre el de esta tabla.

**Fuente Mediador**: `billing_plans` en la base real de producción,
verificado en el deploy del 1/10/2026 (`routes/billing.js`,
`entitlements.js`).
**Fuente medi.ar**: sección de precios de [medi.ar](https://medi.ar/),
consultada el 1/10/2026 — cita textual: "Gratis $0/mes", "Básico
$40.000/mes", "Profesional $90.000/mes", "Todos los precios expresados en
pesos argentinos e incluyen IVA".

**Mediador es más barato en los dos escalones pagos** — esto se puede
afirmar con fuente verificada de los dos lados.

---

## 2. Qué incluye cada plan — verificado, con fuente

| | Mediador FREE | Mediador PROFESIONAL | Mediador ESTUDIO | medi.ar Gratis | medi.ar Básico | medi.ar Profesional |
|---|---|---|---|---|---|---|
| Mediaciones | 3 **activas simultáneas**, sin límite mensual | Ilimitadas | Ilimitadas | 20 **por mes** | 80 **por mes** | 500 **por mes** |
| Usuarios del equipo | 1 | 1 mediador + 1 asistente | Ilimitados | 1 | 5 | Ilimitados |

**⚠️ Ojo con esta fila — las unidades NO son comparables directo.**
Mediador mide "mediaciones activas" (cuántas tenés abiertas al mismo
tiempo, sin límite de cuántas creás o cerrás por mes). medi.ar mide
"mediaciones por mes" (un tope que se reinicia cada mes,
independientemente de cuántas tengas abiertas a la vez). Son dos
conceptos distintos — cualquier texto que los compare tiene que explicar
la diferencia, nunca poner los números uno al lado del otro como si
fueran lo mismo.

**Fuente medi.ar**: sección de planes de [medi.ar](https://medi.ar/),
consultada el 1/10/2026 — cita textual: "Gratis: 20 mediaciones por mes,
1 usuario, 1 plantilla de documentos" / "Básico: 80 mediaciones por mes,
5 usuarios, 5 plantillas" / "Profesional: 500 mediaciones por mes,
usuarios ilimitados, plantillas ilimitadas".

---

## 3. Funciones — verificado, con fuente de los dos lados

| Función | Mediador | medi.ar | Fuente |
|---|---|---|---|
| Agenda con detección de choques de horario | Sí, todos los planes | Sí ("agenda inteligente", cálculo de turnos libres) | medi.ar: texto propio del sitio. Mediador: `agenda.js`/`checkHearingConflicts`, verificado en código |
| Videollamada integrada | Sí — Google Meet, Zoom y Microsoft Teams (solo plan Profesional/Estudio) | Sí — Google Meet únicamente, en todos los planes | medi.ar: "Las mediaciones virtuales incluyen automáticamente un enlace de Google Meet" (no menciona Zoom/Teams). Mediador: `videoProviders/` (3 adapters reales), gateado por plan en `entitlements.js` |
| Suscripción de calendario (Google/Apple/Outlook) | Sí — feed ICS de solo lectura | Integración directa con Google Calendar (no verificado si es de solo lectura o sincroniza en los dos sentidos) | Mediador: `routes/agenda.js` (`/feed.ics`). medi.ar: "Integración Google Calendar" (sin detalle de si es de ida y vuelta) |
| Notificaciones automáticas | Sí — push, WhatsApp y email | Sí — "notificaciones automáticas", email confirmado; **no encontramos mención de WhatsApp** | medi.ar: sin mención de WhatsApp en ningún lugar del sitio consultado |
| Plantillas de documentos configurables por el usuario | **No** — Mediador genera actas con formatos fijos (apertura, audiencia, cierre, incomparecencia, reprogramación), no un editor de plantillas libres | Sí — "Creá plantillas y generá documentos con la información de cada mediación en un clic" | medi.ar: cita textual del sitio. **Esto es algo que medi.ar tiene y Mediador no** |
| Directorio de empresas / aseguradoras | **No** | Sí | medi.ar: listado explícito en el sitio. **Mediador no tiene esto** |
| Acta de cierre con firma electrónica + verificación pública | Sí, todos los planes (incluido el gratuito) | No encontramos mención | Mediador: `certificate.js`/`signing.js`, página pública `/verificar/:hash`. medi.ar: sin mención de firma electrónica en el sitio consultado |
| Portal para partes sin necesitar cuenta | Sí, todos los planes | No encontramos mención | Mediador: `routes/party-portal.js`, confirmado con paridad completa (auditoría de clasificación, categoría "diferencial"). medi.ar: sin mención |
| Portal para abogados sin necesitar cuenta | Sí, todos los planes — **con una limitación real: puede confirmar audiencias y chatear con el mediador, pero no puede completar tareas** (sí puede la parte) | No encontramos mención | Mediador: `routes/lawyer-portal.js` — ver docs/AUDITORIA_CLASIFICACION_PRODUCTO.md, categoría "incompleta" por esta limitación puntual. Si escribimos sobre esto, hay que decir la limitación, no solo "sí tiene" |
| Permisos por rol dentro del equipo (admin / mediador / asistente) | Sí | Los planes dan un número de usuarios, pero el sitio no detalla si hay roles o permisos distintos entre ellos | Mediador: `routes/studios.js`. medi.ar: no verificado, no se puede afirmar que NO lo tengan, solo que no lo vimos publicado |
| Asistente de inteligencia artificial | Sí (Claude), con degradación honesta si falta la clave de API | No encontramos mención | Mediador: `assistant.js`. medi.ar: sin mención en el sitio consultado |
| Cómputo de plazos legales (días hábiles, Ley 26.589) con fuente normativa | Sí — motor dedicado con feriados/días hábiles, notificación fehaciente, plazo de 60 días | No encontramos mención | Mediador: `legalDeadlines.js`/`businessCalendar.js` (Bloque 43). medi.ar: sin mención |
| Calculadora de honorarios con fuente normativa | Sí | No encontramos mención | Mediador: `honorariosSeed.js`. medi.ar: sin mención |
| WhatsApp saliente | Sí | No encontramos mención | Mediador: `whatsapp.js`. medi.ar: sin mención |

### Lo que NO pudimos verificar de medi.ar (no entra en ninguna página sin marcarlo así)

- Si tienen o no permisos/roles distintos entre los usuarios de un mismo plan (solo publican la cantidad, no el detalle).
- Si la integración con Google Calendar es de solo lectura o de ida y vuelta.
- Si tienen firma electrónica, portal de partes/abogados, o algún motor de plazos legales — **no mencionado**, que no es lo mismo que confirmado que no lo tienen. Si no está en su sitio público, lo tratamos como "no publicado", nunca como "no lo tienen".
- Antigüedad de la empresa, cantidad de clientes, casos de éxito — no vimos esa información en lo que revisamos.
- Cualquier dato de su empresa (CUIT, razón social) — no aparece en el sitio.

### Lo que medi.ar tiene y Mediador no (para que la comparación sea honesta en los dos sentidos)

1. **Plantillas de documentos configurables por el usuario** — Mediador genera actas con formato fijo, no deja crear plantillas propias.
2. **Directorio de empresas y de aseguradoras** — Mediador no tiene esto.
3. **Integración directa con Google Calendar** (más allá del feed de solo lectura que ofrece Mediador) — no pudimos confirmar si es bidireccional, pero es una integración más directa que un feed ICS en cualquier caso.

---

## 4. Qué páginas se justifican — mi recomendación

Candidatas originales: una comparación directa, y una de "alternativas a"
más general.

**Mi lectura, después de esta investigación: se justifica UNA sola
página**, no dos.

- **"Mediador vs. medi.ar" (comparación directa) — sí se justifica.**
  Es el único competidor directo verificado, hay datos concretos de los
  dos lados (precios reales, features reales), y es exactamente la
  búsqueda de alta intención comercial que se quiere captar.
- **"Alternativas a medi.ar" — no la armaría como página aparte.** Con un
  solo competidor directo verificado, una página de "alternativas"
  terminaría siendo, en los hechos, el mismo contenido que la comparación
  directa con otro título — exactamente la clase de página hecha "solo
  para repetir una keyword" que se pidió evitar. La búsqueda de
  "alternativas a medi.ar" la puede responder perfectamente la misma
  página de comparación directa (le agrego esa frase al title/description
  como ángulo secundario, sin crear una segunda página con el mismo
  contenido).

Si en el futuro aparece un segundo competidor directo real (no uno de
gestión legal general), ahí sí tendría sentido una página de
"alternativas" que compare contra varios a la vez.

---

## Antes de seguir

Antes de escribir la página, confirmame:
1. Que esta matriz está bien — en particular la fila de "mediaciones
   activas vs. por mes", que es la más delicada de explicar bien.
2. Que estás de acuerdo con UNA sola página ("Mediador vs. medi.ar", con
   el ángulo de "alternativa" incluido) en vez de dos.
3. Que el apartado "lo que medi.ar tiene y Mediador no" te parece bien
   como está — va a aparecer en la página, tal como pediste (si el
   competidor hace algo mejor, decirlo).
