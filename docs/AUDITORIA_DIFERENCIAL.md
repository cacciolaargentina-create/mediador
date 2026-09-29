# Auditoría de diferencial competitivo — PuenteDigital/Mediador

**Fecha**: 2026-09-29. **Tipo**: auditoría de solo lectura, sin cambios de código. **Método**: verificación directa contra el código ejecutable real (lectura de archivos, `grep` de usos reales, endpoints, regression tests existentes) — nunca contra `IMPLEMENTATION_PLAN.md`, comentarios o mensajes de commit sin confirmarlo en código que corre de verdad. Donde un comentario o el plan dicen "esto existe" y no se encontró el código que lo ejecuta, se marca explícitamente como **solo planificado**.

**Contexto comercial** (dato del usuario, no del repo): la app está en `puentedigital.app`, con billing de Mercado Pago implementado pero **no conectado** (`MERCADOPAGO_ACCESS_TOKEN` vacío en producción). Planes: FREE (3 mediaciones activas, sin videollamadas de proveedor real), PROFESIONAL 15.000 ARS/mes, ESTUDIO 35.000 ARS/mes.

**Advertencia sobre el propio sesgo del auditor**: gran parte de este código se escribió en sesiones de este mismo asistente. Para esta auditoría se verificó cada afirmación releyendo el código como si no se conociera, y se usaron tres subagentes independientes (sin memoria de haber escrito nada de esto) para las áreas de IA/exportaciones/notificaciones, roles/estudios/admin, y videoconferencia/agenda/portal de abogados — sus hallazgos, con cita de archivo:línea, están integrados en este documento.

---

## PASO 1 — Auditoría por área

Clasificación de 5 estados (no se mezclan):
- **Existe y funciona**: código real, alcanzable por un endpoint con auth, verificado.
- **Existe pero incompleto**: la pieza central está, pero le falta algo real para cerrar el círculo.
- **Implementado con problemas de UX**: funciona, pero de forma confusa o con pasos manuales evitables.
- **Solo planificado**: aparece en un doc/comentario/nombre de commit, pero no hay código que lo ejecute.
- **No existe**: ni rastro.

### Dashboard / Centro de control

| Capacidad | Estado | Evidencia |
|---|---|---|
| Feed único "requiere atención" (vencidos, próximos, sin confirmar, inactivos) | Existe y funciona | `automationEngine.js` (`buildAttentionItems`), `routes/mediations.js` (`GET /dashboard`), 27/27 en `regression-test-bloque22-automation.js` |
| Responsable visible por ítem | Existe y funciona | agregado hoy (Bloque 31), `automationEngine.js` |
| "Tu día" (audiencias hoy/próximas) | Existe y funciona | `public/mediador.js` `renderTuDiaCard` |
| Asistente conversacional sobre el dashboard | Existe y funciona (con degradación honesta sin API key) | `routes/mediations.js:713-724`, `assistant.js` |

### Mediaciones

| Capacidad | Estado | Evidencia |
|---|---|---|
| CRUD, estados, historial de estados | Existe y funciona | `mediation_status_history`, nunca se borra una fila |
| Próxima acción estructurada (qué/quién/cuándo) | Existe y funciona | `mediations.nextActionText/ResponsibleType/DueDate` |
| Límite de 3 mediaciones activas en plan FREE | Existe y funciona, activo en producción hoy mismo | `entitlements.js:77-82`, wired en `routes/mediations.js:286`; `billingPaywallActive()` confirma activo en prod (no depende de que Mercado Pago esté conectado) |
| Vista "mediaciones del estudio" (multi-mediador) | Existe y funciona | `routes/mediations.js:781-823`, solo para `studioRole==='admin'` |

### Partes

| Capacidad | Estado | Evidencia |
|---|---|---|
| Alta, datos legales completos, vínculo a usuario | Existe y funciona | `parties` table |
| Invitación al portal (genera token) | Existe y funciona | `POST /:id/parties/:partyId/invite` |
| **Aviso automático a la parte de que fue invitada** | **No existe** | el endpoint de invitación solo devuelve `{portalToken, portalUrl}` — no llama a `sendText` ni a ningún canal (`routes/mediations.js:1315-1352`). El frontend copia el link al portapapeles (`public/mediador.js:2903-2910`) y el mediador lo manda él mismo, fuera de la plataforma |

### Abogados

| Capacidad | Estado | Evidencia |
|---|---|---|
| Alta como dato del expediente | Existe y funciona | `lawyers` table |
| Portal propio (token, sin cuenta) | Existe y funciona | `routes/lawyer-portal.js`, ver audiencias/compromisos/documentos de su cliente, confirmar audiencia en nombre de la parte, subir documento, hilo propio con el mediador |
| Rol `abogado` dentro de `mediationAccess` (acceso interno con cuenta propia) | **Solo planificado** | el comentario en `mediationAccess.js:236` lo sugiere, pero `POST /:id/access` **rechaza explícitamente** `role:'abogado'` (`routes/mediations.js:1037`); nunca se crea esa fila en ningún lugar del código |
| Ver el hilo de mensajes de su cliente | Existe pero incompleto | solo lectura (`lawyer-portal.js:319-332`), no puede responder ahí — tiene un hilo separado con el mediador |
| Completar una tarea propia desde su portal | No existe | el Portal de Partes lo tiene (agregado hoy), el de Abogados no tiene endpoint equivalente |

### Audiencias

| Capacidad | Estado | Evidencia |
|---|---|---|
| Agendar, confirmar, reprogramar, cancelar | Existe y funciona | `hearings`, `hearing_confirmations`, `hearing_reschedule_requests` |
| Detección de conflictos de horario antes de guardar | Existe y funciona | `checkHearingConflicts` realmente llamado en `routes/mediations.js:1723-1730` y `2214-2222` |
| Videoconferencia — Google Meet | Existe y funciona | llamada real a Calendar API, OAuth por mediador (`videoProviders/googleMeetProvider.js:120-195`) |
| Videoconferencia — Zoom | Existe y funciona | Server-to-Server OAuth completo, CRUD real (`videoProviders/zoomProvider.js:25-105`) |
| Videoconferencia — Teams | Existe pero incompleto | usa Graph real, pero la reunión queda a nombre de un organizador fijo (nunca el mediador real), y "reprogramar" en realidad cancela y crea de nuevo (cambia el link) — `videoProviders/teamsProvider.js:41-73` |
| Videoconferencia — link manual | Existe y funciona | proveedor de primera clase, siempre disponible sin configurar nada |
| Prueba real contra las APIs externas de video (no mocks) | Solo planificado | el propio `regression-test-bloque28.js` admite que no hay credenciales de sandbox y no se ejercita la llamada real |
| Sugerir horarios libres al agendar | No existe | la disponibilidad/bloqueos solo se usan para RECHAZAR (409) un horario, nunca para proponer alternativas |
| Feed ICS (suscripción de solo lectura) | Existe y funciona | `routes/agenda.js:212-255` |

### Documentos

| Capacidad | Estado | Evidencia |
|---|---|---|
| Subida, versionado, tipos | Existe y funciona | `documents` table, `parentDocumentId` |
| Resumen por IA (PDF/imagen) | Existe y funciona | Claude lee el PDF nativo (sin librería de extracción), degrada con mensaje honesto para Word |
| "Revisar" un documento | **Implementado con problemas de UX** | es literalmente cambiar un `<select>` de estado (`pendiente_escaneo→recibido→...→revisado/observado/final`, `routes/mediations.js:2325-2340`) — no hay campo de comentario, ni checklist, ni forma de registrar QUÉ faltó cuando se marca "observado" |
| Tarea automática al recibir un documento | Existe y funciona | `sourceDocumentId`, Bloque 22 |

### Comunicaciones

| Capacidad | Estado | Evidencia |
|---|---|---|
| Chat interno mediador↔parte / mediador↔abogado, con adjuntos | Existe y funciona | `channels`/`messages` |
| Campo de medio (`via`) | Existe y funciona (recién agregado, Bloque 31) | `interno`/`sistema` reales hoy, `whatsapp`/`email` reservados |
| WhatsApp **two-way** para Mediador (la parte responde por WhatsApp y entra al chat) | **No existe** | el two-way real (`routes/whatsapp.js`, webhook de Meta) solo aplica al producto de coparentalidad (roles A/B); para Mediador, `notifyPartyAboutHearing`/`notifyLawyerAboutHearing` son **solo salientes** (`messaging.js:278-314`) |
| Email como canal | No existe, en absoluto | cero librerías de email en `package.json`, cero código de envío en todo el repo |
| Bandeja unificada de comunicaciones | Existe y funciona | `buildCommunicationsInbox`, Bloque 30 |

### Timeline

| Capacidad | Estado | Evidencia |
|---|---|---|
| Registro automático (altas, documentos, audiencias, tareas, compromisos, cierre) | Existe y funciona | `mediationEvents` + `logMediationEvent`, disparado desde ~25 puntos distintos del código |
| Filtro por tipo/categoría | Existe y funciona (frontend agregado hoy, Bloque 31) | backend ya soportaba `?type=`, faltaba exponerlo |
| Un evento por cada mensaje de chat | **No existe, a propósito** | decisión explícita del Bloque 19, con test de regresión que verifica que NO pasa (evita inundar el timeline) |

### Tareas, compromisos y vencimientos

| Capacidad | Estado | Evidencia |
|---|---|---|
| CRUD, estados, detección de vencidos en vivo | Existe y funciona | `tasks`/`commitments`, `automationEngine.js` |
| Vista cross-expediente con filtros | Existe y funciona (agregado hoy, Bloque 31) | `GET /api/mediations/commitments` |
| Observaciones y evidencia (documento) en un compromiso | Existe y funciona (agregado hoy, Bloque 31) | `commitments.notes/documentId` |
| Delegar una tarea a una parte, completable desde su portal | Existe y funciona (agregado hoy, Bloque 31) | `tasks.assignedToPartyId` |
| Escalamiento por fallos consecutivos de contacto | Existe y funciona | `jobs.js`, `whatsappLog.partyId` |

### Portal de partes

| Capacidad | Estado | Evidencia |
|---|---|---|
| Acceso por token, sin cuenta | Existe y funciona | `routes/party-portal.js` |
| Ver audiencia próxima, estado, documentos, compromisos | Existe y funciona | |
| Confirmar/pedir cambio de audiencia | Existe y funciona | reprogramación estructurada |
| Responder mensajes, subir/descargar documentos | Existe y funciona | permisos de aislamiento verificados (una parte nunca ve documentos/hilos de otra) |
| Tareas propias + info del mediador | Existe y funciona (agregado hoy, Bloque 31) | |

### Exportaciones y firma

| Capacidad | Estado | Evidencia |
|---|---|---|
| PDF certificado con contenido real de la mediación | Existe y funciona | `certificate.js:241-364` — partes, abogados, audiencias, documentos, compromisos, timeline reales, no placeholder |
| Firma electrónica Ed25519 | Existe pero incompleto | sin `SIGNING_PRIVATE_KEY`/`PUBLIC_KEY` configuradas, el PDF sale igual pero **sin firmar**, sin fallar (`signing.js:50`) |
| Página pública de verificación (`/verificar/:hash`) | Existe y funciona, sin ningún test de regresión | `routes/verify.js:64-112` |
| Paquete .zip con documentos originales + informe | Existe y funciona | `archiver` real, incluye los archivos originales, no solo metadata (esto corrige una limitación que el propio `IMPLEMENTATION_PLAN.md` describía como pendiente en la era del Bloque 8 — el doc quedó desactualizado en sentido inverso: describe un problema que ya se resolvió) |

### IA

| Capacidad | Estado | Evidencia |
|---|---|---|
| Asistente sobre una mediación / sobre el dashboard | Existe y funciona | llamada real a Claude (`claude-sonnet-4-6`), degrada con mensaje fijo sin API key, sin romper nada |
| Sugerir tareas desde una nota | Existe y funciona | nunca crea nada solo, el humano siempre confirma (testeado explícitamente) |
| Límite de uso/costo de IA para Mediador (B2B) | **No existe** | `quota.js` (`requireQuotaOrSubscription`) solo se aplica al producto de coparentalidad (`routes/channels.js`, `routes/draft.js`) — los 4 endpoints de IA de Mediador no tienen ningún límite. Además, `hasActiveSubscription()` está *hardcodeada a `false`* siempre — es un stub que nunca se conectó al sistema de billing real del Bloque 29 |

### Notificaciones

| Capacidad | Estado | Evidencia |
|---|---|---|
| Jobs periódicos (recordatorios, vencimientos, "audiencia por empezar") | Existe y funciona | todos con `setInterval` real en `server.js:289-326` |
| Push del navegador | Existe pero sin cobertura de test | requiere VAPID keys, ningún regression test lo ejercita |
| WhatsApp saliente (avisos) | Existe y funciona | `notifyPartyAboutHearing`/`notifyLawyerAboutHearing` |
| WhatsApp entrante (two-way) para Mediador | No existe (ver Comunicaciones) | |
| Email | No existe | |

### Roles, permisos y seguridad

| Capacidad | Estado | Evidencia |
|---|---|---|
| Aislamiento entre mediadores/estudios | Existe y funciona, testeado | `getMyMediations`, `regression-test.js:84-88` |
| Auth + control de acceso en cada endpoint de `mediations.js` | Existe y funciona | los ~65 endpoints revisados tienen `requireAuth`+`requireMediationAccess` |
| Filtro de notas/eventos privados (`mediator_only`) frente a un abogado | Existe y funciona, sin test dedicado | |
| Admin de plataforma (dashboard, usuarios, billing, salud) | Existe y funciona | `routes/admin-mediador.js`, guard único en la línea 76 |
| Impersonación ("ver como usuario") realmente de solo lectura | **Implementado con problemas de diseño** | no hay ningún middleware que bloquee escritura durante una sesión de impersonación — es un registro de auditoría sobre una vista que YA era de solo lectura, no un mecanismo de enforcement real |
| Feature flags que cambien comportamiento | **No existe** | la tabla y el CRUD del admin console existen, pero ningún otro archivo del repo lee un feature flag para decidir algo |
| Audit log (`logAudit`) | Existe y funciona | 38 sitios de escritura en 9 archivos |
| Acceso excepcional de soporte (auditado, con vencimiento) | Existe y funciona | único mecanismo de "Admin Console 2.0" con enforcement real verificado |

### Multiusuario / Estudios

| Capacidad | Estado | Evidencia |
|---|---|---|
| Un estudio con más de un mediador | Existe y funciona | |
| Invitación de punta a punta | Existe y funciona | token → preview → accept con validación de email |
| Facturación por estudio (no solo individual) | Existe y funciona | `billing_accounts.studioId` |
| Límite de miembros por plan (`maxStudyMembers`) | **Definido pero no se aplica en ningún lado** | `canAddStudyMember()` existe en `entitlements.js:85-91` pero no se llama desde ningún endpoint — un estudio FREE puede sumar miembros sin límite real |
| Agenda "avanzada" distinta por plan (`advancedAgenda`) | **Definido pero no se aplica en ningún lado** | `canUseAdvancedAgenda()` existe pero tampoco se llama nunca — FREE y pagos tienen exactamente la misma agenda hoy |

---

## PASO 2 — Las 10 oportunidades de diferencial (evaluadas)

Para cada una: impacto para el mediador, frecuencia, tiempo ahorrado/riesgo evitado, dificultad, diferenciación real frente a medi.ar y frente a WhatsApp+Drive, prioridad.

1. **Aviso automático al invitar a una parte/abogado** (WhatsApp saliente reusando la infraestructura ya existente) — Impacto alto (hoy el primer contacto se hace por fuera de la plataforma, rompiendo la trazabilidad desde el minuto cero). Frecuencia: cada mediación nueva. Complejidad baja (reusa `sendText`/`notifyPartyAboutHearing`, ya existen). Diferencial: WhatsApp a mano no dispara esto solo; medi.ar no maneja invitación de partes en absoluto. **P0.**

2. **Corregir la integridad del paywall**: cuota de IA para Mediador y límites de plan (`advancedAgenda`, `maxStudyMembers`) que hoy están definidos pero no se aplican — Impacto alto en lo comercial (cobrar 15.000-35.000 ARS/mes por diferenciadores que no existen en el código es un riesgo de reclamo, no de producto). Complejidad baja (son 2-3 líneas de `if` en los endpoints correctos). No es "diferencial" frente a la competencia — es prerrequisito para que el argumento comercial sea honesto. **P0.**

3. **Revisión de documentos con sustancia real** (observación/comentario al marcar un documento, no solo un estado) — Impacto alto y muy frecuente (cada documento de cada mediación pasa por acá). Complejidad baja (mismo patrón que `commitments.notes`, agregado hoy). Diferencial: en WhatsApp+Drive, "por qué está mal este documento" se pierde en un chat; acá quedaría en el propio documento, visible en el timeline. **P1.**

4. **Pantalla de preparación de audiencia** ("todo lo que necesito saber, en una pantalla, 10 minutos antes") — el cálculo (`getHearingPreparationState`) ya existe en `automationEngine.js`, falta la pantalla dedicada que lo muestre de forma accionable antes de entrar a la audiencia. Impacto alto, frecuencia alta (cada audiencia). Complejidad baja-media (es casi todo frontend, sobre datos que ya se calculan). Diferencial fuerte: ni medi.ar ni WhatsApp arman este resumen solos — hoy el mediador lo arma mentalmente revisando 4-5 pantallas distintas. **P1.**

5. **Borrador de acta/minuta asistido por IA al cerrar una audiencia** — usar el asistente ya existente para generar un texto base (quién estuvo, qué se acordó, próximos pasos) a partir de compromisos creados/resultado registrado, que el mediador edita y confirma (nunca se envía solo, mismo criterio que `suggestTasksFromNote`). Impacto alto, ahorra tiempo de redacción real. Complejidad media (requiere diseñar el prompt y el flujo de edición/confirmación). Diferencial fuerte frente a redactar a mano en Word. **P1.**

6. **Sugerir horarios disponibles al agendar** (hoy solo rechaza conflictos) — Impacto medio, frecuencia alta. Complejidad baja (los datos de disponibilidad/bloqueos ya existen y ya se consultan para rechazar; falta invertir la consulta para proponer). Diferencial medio frente a Google Calendar a mano. **P2.**

7. **Cerrar la paridad del Portal de Abogados** (permitir responder en el hilo con su cliente si el mediador lo habilita, completar tareas propias) — Impacto medio, frecuencia media. Complejidad baja (mismo patrón que se hizo hoy para partes). **P2.**

8. **Dar visibilidad real a la página de verificación pública** (`/verificar/:hash`) — ya existe y funciona, pero no tiene ningún test de regresión y probablemente nadie la conoce como argumento de venta ("cualquiera puede verificar gratis, sin login, que este documento salió de Mediador"). Impacto medio en diferenciación (es un argumento de confianza fuerte frente a un PDF exportado de Drive), esfuerzo bajo (agregar el test + mostrarlo mejor en el propio PDF/constancia). **P2.**

9. **Reforzar impersonación y feature flags como lo que dicen ser** — hoy son promesas sin enforcement real. No es un diferencial de cara al mediador cliente, pero si alguna vez se usa la impersonación en una auditoría de seguridad o ante un cliente grande (ESTUDIO), la brecha entre "dice que es de solo lectura" y "es de solo lectura de verdad" es un riesgo reputacional. **P2** (deuda técnica, no producto).

10. **WhatsApp two-way real para Mediador** (que una parte responda por WhatsApp y el mensaje entre al chat de su expediente, igual que ya funciona en el producto de coparentalidad) — Impacto muy alto (es probablemente EL diferencial más fuerte posible frente a "medi.ar + WhatsApp aparte", porque uniría el canal donde las partes ya están con la trazabilidad del expediente). Complejidad alta (aprobación de Meta Business, plantillas de mensaje, costo por conversación, reglas de ventana de 24hs). Es la pieza de mayor impacto potencial, pero la de mayor riesgo de ejecución — no es P0 por eso mismo. **P1, con la arquitectura ya preparada (`via`) para cuando se decida construirla.**

---

## PASO 3 — Momentos de dolor

**Antes de la audiencia** — hoy el mediador revisa manualmente: si las partes confirmaron (`hearing_confirmations`, visible pero repartido entre la lista de audiencias y el centro de atención), si hay documentos sin revisar (lista aparte), si hay tareas/compromisos críticos pendientes (otra lista más). El cálculo de "¿está lista esta audiencia?" YA EXISTE (`getHearingPreparationState`) pero no tiene una pantalla propia — el mediador arma el panorama juntando 3-4 pantallas a mano. Ver oportunidad #4.

**Durante la audiencia** — no hay ninguna vista pensada para este momento puntual (una sola pantalla con: datos de contacto, historial reciente, compromisos previos de esta mediación, plantilla para anotar el resultado). Hoy se depende de tener el expediente completo abierto y navegar sus secciones.

**Después de la audiencia** — cambiar el estado de la audiencia a "realizada" y cargar compromisos ya funciona (`CREATE_COMMITMENTS` sugerido automáticamente), pero el acta/resumen en sí se escribe aparte (Word, a mano). Ver oportunidad #5.

**Antes del vencimiento** — esto es lo mejor cubierto del producto: compromisos y tareas próximos a vencer ya aparecen solos en el dashboard y en la nueva pantalla de Compromisos, sin que el mediador tenga que acordarse de revisar nada. Punto fuerte real, ya construido.

**Cuando una parte no responde** — detectado automáticamente (`getPartiesWithNoResponse`, umbral configurable), aparece en el centro de atención. Lo que falta es la ACCIÓN en sí: hoy "contactar" significa que el mediador escribe manualmente; no hay un recordatorio automático saliente por WhatsApp cuando se cruza el umbral (solo se detecta y se muestra, nunca se dispara un aviso solo).

**Múltiples mediaciones (triage)** — bien resuelto: el centro de atención ya es justamente esto, una lista priorizada cross-expediente. La pantalla nueva de Compromisos (Bloque 31) extiende el mismo criterio.

---

## PASO 4 — Automatizaciones: qué puede pasar de manual a "Puente lo hace solo"

| Hoy manual | Automatizable con lo que ya existe | Esfuerzo |
|---|---|---|
| Avisar a una parte que fue invitada | Reusar `sendText`/`notifyPartyAboutHearing` en el propio endpoint de invitación | Bajo |
| Redactar el acta después de la audiencia | Borrador con IA a partir de compromisos + resultado (siempre con confirmación humana) | Medio |
| Armar el panorama antes de una audiencia | Pantalla dedicada sobre `getHearingPreparationState`, ya calculado | Bajo |
| Avisar de nuevo cuando una parte sigue sin responder | Disparar `notifyPartyAboutHearing`-like automáticamente al cruzar el umbral, no solo mostrarlo en el dashboard | Medio |
| Revisar si un documento cumple lo pedido | Checklist configurable por tipo de documento + comentario obligatorio al observar | Medio |
| Detectar casos sin actividad | Ya automatizado (`getInactiveMediations`) — sin trabajo pendiente | — |

---

## PASO 5 — El diferencial real, sin marketing

- Puente ya detecta automáticamente compromisos vencidos y tareas sin resolver y los prioriza en una sola lista por severidad. En el flujo de WhatsApp + Drive esto requiere abrir cada chat y cada carpeta a mano, mediación por mediación.
- Puente ya arma un timeline verificable de cada expediente sin que nadie tenga que cargarlo (altas, documentos, audiencias, cambios de estado quedan solos). En WhatsApp esa historia está repartida en mensajes sueltos, sin orden ni forma de exportarla.
- Puente ya genera un PDF certificado con firma electrónica y una página pública donde cualquiera puede verificar que ese documento salió de la mediación real — sin login. Un PDF exportado de Drive no tiene forma de probar que no fue editado después.
- Puente ya aísla lo que ve una parte de lo que ve la otra, y lo que ve un abogado de las notas privadas del mediador, a nivel de servidor. Un grupo de WhatsApp no puede separar esto — todos ven todo, o hay que armar grupos separados a mano y arriesgarse a un error.
- Puente todavía NO avisa solo cuando invita a una parte por primera vez — hoy ese primer contacto lo hace el mediador a mano, por fuera de la plataforma (WhatsApp personal). Esto es honesto: hasta que se resuelva la oportunidad #1, la trazabilidad tiene un agujero real en el arranque de cada expediente.
- Puente todavía NO tiene un canal de WhatsApp de ida y vuelta para las partes de una mediación (sí lo tiene para coparentalidad) — hoy solo manda avisos salientes con un link al portal. Mientras eso no exista, una parte que prefiere WhatsApp por sobre "entrar a un portal" sigue comunicándose por fuera del sistema con el mediador.

---

## PASO 6 — Propuesta final

### A. Qué ya tenemos (sólido, verificado)

Centro de atención cross-expediente con severidad y responsable; timeline automático con filtro; compromisos y tareas con vencimiento detectado en vivo, ahora con vista global, observaciones y evidencia; portal de partes completo (audiencias, documentos, mensajes, compromisos, tareas, info del mediador); videoconferencia real con Google Meet y Zoom; exportación certificada con firma electrónica y verificación pública; asistente de IA real (Claude) con degradación honesta; aislamiento de datos verificado entre mediadores, estudios, partes y abogados; multiusuario por estudio con facturación propia; jobs de recordatorio realmente programados.

### B. Qué está incompleto

Portal de Abogados sin paridad completa con el de Partes (no completa tareas, no responde en el hilo de su cliente); firma electrónica que se omite silenciosamente sin configurar claves; revisión de documentos sin sustancia (solo un estado, sin comentario); cuota de IA que no cubre el producto B2B; dos diferenciadores de plan pago (`advancedAgenda`, `maxStudyMembers`) definidos en el código pero sin ningún endpoint que los aplique; impersonación de admin sin enforcement real de solo lectura; feature flags sin ningún lector en el resto del código; WhatsApp/Teams con limitaciones puntuales ya detalladas arriba.

### C. Las 10 oportunidades — ver detalle completo en el Paso 2.

Resumen de prioridades:
- **P0**: (1) aviso automático al invitar, (2) integridad del paywall (cuota de IA + límites de plan que hoy no se aplican).
- **P1**: (3) revisión de documentos con sustancia, (4) pantalla de preparación de audiencia, (5) acta asistida por IA, (10) WhatsApp two-way para Mediador (alto impacto, alta complejidad — arquitectura ya preparada).
- **P2**: (6) sugerir horarios libres, (7) paridad del portal de abogados, (8) visibilidad de la verificación pública, (9) impersonación/feature flags reales.

### D. Las 3 que deberían desarrollarse primero

1. **Aviso automático al invitar a una parte/abogado** — cierra el agujero de trazabilidad más visible del producto, con el menor esfuerzo posible (reusa infraestructura de WhatsApp saliente que ya existe).
2. **Revisión de documentos con sustancia** — toca todas las mediaciones, todo el tiempo, y es la misma receta (campo de texto + referencia) que ya se usó hoy para compromisos — riesgo técnico bajo, impacto diario alto.
3. **Pantalla de preparación de audiencia** — el cálculo más difícil (`getHearingPreparationState`) ya está hecho desde hace bloques; falta ponerle una pantalla que lo muestre en el momento en que realmente importa. Es, con diferencia, la relación esfuerzo/impacto más favorable de toda la lista.

### E. Qué NO desarrollar (por ahora)

- WhatsApp two-way para Mediador **de forma apurada**: no arrancarlo sin resolver antes costo por conversación, aprobación de Meta y plantillas — es la oportunidad #10, real pero no P0.
- Cualquier forma de integración con SIGIM: sigue sin existir una vía oficial (API o convenio), tal como ya estaba decidido antes de esta auditoría.
- Marketplace, directorio público de mediadores, matching, perfiles públicos: fuera de alcance por decisión de producto ya tomada, no tocado ni evaluado acá.
- Video conferencing propio (no usar los tres proveedores ya integrados): no tiene sentido, Google Meet y Zoom ya funcionan de verdad.
- Agregar más "funciones" al admin console (feature flags más finos, impersonación más sofisticada) antes de que las que ya existen tengan enforcement real — es deuda técnica, no una oportunidad de venta.
- Cobrar por `advancedAgenda`/límite de miembros de estudio como si ya diferenciaran algo real, hasta resolver el punto B/oportunidad #2 — cobrar por una diferencia que no existe en el código es el riesgo más inmediato de todos los de esta lista.
