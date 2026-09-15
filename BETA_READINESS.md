# BETA_READINESS.md — Mediador

Auditoría final antes de los primeros usuarios reales (Bloque 18).
Última actualización: 2026-09-15.

## 1. Estado general

**READY** (con salvedades listadas en §6 y §11 — ningún problema crítico o alto conocido sin resolver).

## 2. Tests ejecutados

No existía ningún test antes de este bloque (`test/`, `tests/`, `__tests__`, `*.spec.js`, `*.test.js`: ninguno en el repo). Se creó `scripts/regression-test.js` — batería HTTP/API real contra un servidor con `ENABLE_FAKE_LOGIN=1` y una base descartable. Cubre específicamente aislamiento entre mediaciones, el IDOR encontrado en este bloque, documentos, portal de partes y estudios.

Comando:
```
SQLITE_PATH=<scratch>/data.sqlite ENABLE_FAKE_LOGIN=1 PORT=3095 node server.js &
node scripts/regression-test.js http://localhost:3095
```

Resultado de la última corrida: **16 pasaron, 0 fallaron.** Sin errores en el log del servidor durante la corrida.

## 3. Cantidad de tests

- Totales: 16 (script automatizado) + ~35 verificaciones manuales vía curl/navegador durante la auditoría (no automatizadas, documentadas en este archivo).
- Pasados: 16/16 automatizados. Todas las manuales, PASS salvo el bug de §4.
- Fallidos: 0 (el único fallo encontrado — IDOR de confirmaciones — se corrigió antes de cerrar el bloque).

## 4. Bugs encontrados

| # | Severidad | Descripción | Causa |
|---|---|---|---|
| 1 | **CRÍTICO** | `POST /api/mediations/:id/hearings/:hearingId/confirmations/:partyId` no verificaba que `hearingId` perteneciera a la mediación `:id` de la URL — solo `requireMediationAccess` validaba el `:id`, pero la confirmación se buscaba por `hearingId+partyId` sin cruzar contra `mediationId`. Un mediador con acceso legítimo a SU mediación podía, cambiando el `hearingId`/`partyId` en la URL, modificar el estado de confirmación de una audiencia de OTRA mediación ajena. | Único endpoint de ~50 rutas de `:id`-scoped en `routes/mediations.js` que no seguía el patrón `x.mediationId === req.mediation.id` ya usado consistentemente en todos los demás (parties, lawyers, hearings, documents, tasks, commitments). |
| 2 | MEDIO | El motivo del checklist de preparación de audiencia mostraba nombres de campo internos (`partesIdentificadas`) en vez de texto legible. | Sin traducir server-side; el frontend sí tenía las etiquetas pero el texto se armaba en el backend. |
| 3 | MEDIO | Fechas ISO crudas (`2026-10-20`) en textos pensados para personas: notificaciones de WhatsApp a partes/abogados, texto "pendiente" del portal, próxima acción automática, títulos de timeline. | Faltaba formatear `hearing.date` antes de interpolarlo en los textos. |
| 4 | MEDIO | Mensaje de error de `POST /api/studios/leave` para el propietario decía "ninguna de las dos cosas está implementada todavía", pero transferir propiedad y dar de baja el estudio SÍ están implementados — el texto quedó desactualizado. | Se agregaron esas dos funcionalidades en un bloque posterior y nadie actualizó el mensaje. |
| 5 | BAJO | Mensajes de error de subida de archivo mostraban el texto crudo de Multer en inglés ("File too large") en vez de español con el límite real. | `err.message` de Multer usado directo sin traducir el caso `LIMIT_FILE_SIZE`. |

Los ítems 2-5 se corrigieron en el Bloque 17 (ya desplegado). El ítem 1 se encontró y corrigió en este bloque (Bloque 18).

## 5. Archivos modificados en este bloque

- `routes/mediations.js` — fix del IDOR (#1).
- `routes/studios.js` — mensaje de error desactualizado (#4).
- `routes/auth.js` — ruta `/auth/fake-login`, apagada por default (`ENABLE_FAKE_LOGIN`), necesaria para poder correr `scripts/regression-test.js` contra cualquier entorno de prueba futuro.
- `scripts/regression-test.js` — nuevo, batería de regresión.
- `BETA_READINESS.md` — este documento.

## 6. Prueba end-to-end

**Pasó de principio a fin**, probada dos veces (Bloque 17 y Bloque 18, en servidores aislados con base descartable):
crear mediador → crear estudio → invitar asistente → crear mediación → agregar parte y abogado → asignar acceso → programar audiencia → proponer varios horarios → confirmar propuesta → pedir cambio (parte) → reprogramar (mediador) → checklist de preparación → marcar realizada → ver resumen → cerrar mediación (bloqueada por checklist, forzada con confirmación) → exportar.

No cubierto en esta corrida específica: conflicto de horario/disponibilidad/bloqueo del mediador (existe y se probó en el Bloque 16, no se re-testeó ahora), ni "entrar a audiencia" con `meetingUrl` real (el botón solo aparece si hay link, se verificó por código que no aparece si no lo hay).

## 7. Seguridad

Auditoría completa de autorización en `routes/mediations.js` (52 endpoints), `routes/agenda.js`, `routes/studios.js`, `routes/party-portal.js`, `routes/lawyer-portal.js`: cada sub-recurso (`partyId`, `lawyerId`, `hearingId`, `docId`, `taskId`, `commitmentId`, `accessId`) se cruza contra `mediationId` **excepto** el caso #1, ya corregido.

Pruebas de aislamiento reales (no solo inspección de código), con dos mediadores y dos mediaciones separadas:
- Ver/editar/cerrar/exportar una mediación ajena por API → 403 en los cuatro casos.
- ID de mediación inexistente → 404 (no 500, no filtra si existe o no).
- Exploit específico del bug #1 (mezclar el `:id` propio con `hearingId`/`partyId` ajenos) → 404, dato ajeno intacto.
- Descarga de documento ajeno, con `:id` propio y con `:id` ajeno → 404 y 403 respectivamente.
- Path traversal en `docId` (`../../../etc/passwd`) → 404 limpio (el `storagePath` real nunca sale del servidor ni se arma desde input del cliente).
- Token de portal de parte inválido → 404. Token viejo tras regenerar → 404 (invalidado). Token cruzado (parte B intentando confirmar audiencia de A) → 404.
- Abogado con portal en la mediación A intentando acceder a la mediación B sin estar vinculado ahí → 403.
- Escalada de privilegios: usuario no-admin de estudio intentando invitar/asignar → 403.
- `.env` no está trackeado en git; `.gitignore` cubre `.env`, `data.sqlite`, `uploads/`, claves `.pem`/`_id_ed25519`. Sin secretos hardcodeados encontrados en archivos trackeados (`git grep` por patrones de API key/password). Confirmado que `ENABLE_FAKE_LOGIN` no está seteado en el `.env` de producción.

## 8. Portales

**Parte: PASS.** Ve su mediación, estado, próxima audiencia; confirma/pide cambio (formulario real, sin `prompt()` desde Bloque 17); ve documentos y compromisos propios; sube documentos si está habilitado. Aislamiento verificado (no puede ver otra mediación ni tocar audiencias ajenas vía manipulación de ID).

**Abogado: PASS.** Portal con lista de mediaciones (una fila por mediación en la que representa a alguien), aislado correctamente entre ellas — mismo token puede reusarse en varias mediaciones (por email) pero cada una resuelve su propia parte/audiencias/documentos sin filtrar nada de las demás. Verificado que no puede acceder a una mediación en la que no representa a nadie.

## 9. DB / migraciones

**DB nueva: PASS.** Arranque limpio contra SQLite vacía, las 33 tablas se crean correctamente, sin errores.

**DB existente: PASS.** Arranque contra la base de desarrollo acumulada (10 usuarios reales de pruebas anteriores, historial de los Bloques 1-17) — cero errores de `ensureColumns`, cero "no such column".

Este bloque no agregó columnas ni tablas nuevas (el fix de seguridad es puramente de lógica).

## 10. Responsive

**iPhone (390×844): PASS.** Dashboard y Expediente probados — sin overflow horizontal, nav inferior y sub-menú de secciones legibles y usables, botones con tamaño tocable.

**Desktop (1440×900): PASS.** Mismas pantallas — contenido centrado con ancho máximo, no se estira ni se rompe.

No re-verificado en esta pasada específica (sí en el Bloque 17, a un tamaño mobile distinto): Estadísticas, Agenda, Preparación como pantalla standalone, Resumen, Portal de parte/abogado a 390×844 exacto.

## 11. Bugs pendientes

**Críticos:** ninguno conocido.

**Altos:** ninguno conocido.

**Medios:**
- Comportamiento a confirmar con el dueño del producto (no es un bug, es una decisión de diseño ya existente desde el Bloque 14 que vale la pena revisar): un mediador que se une a un estudio hace que **todas sus mediaciones previas** (incluso las creadas antes de unirse) queden visibles para el administrador del estudio, porque la pertenencia se deriva de `mediatorUserId` en el momento de la consulta, no de un vínculo fijado al crear la mediación. Puede ser el comportamiento deseado, pero conviene que quede confirmado antes de que un estudio real lo descubra por sorpresa.
- Jobs periódicos (`checkMediationDeadlines`, recordatorios): se revisó el código y tienen guards explícitos contra duplicación (`alreadyAlerted`, `alreadyReminded` antes de cada aviso), pero no se ejecutó el job real en vivo dos veces seguidas para confirmar la idempotencia end-to-end en esta pasada — quedó verificado por lectura de código, no por prueba en caliente.

**Bajos:**
- No se hizo una caminata "a ciegas" (Fase 17, sin mirar código) separada de las pruebas técnicas — todo el testing de UX de primer uso se hizo con conocimiento completo del sistema (Bloque 17). Sigue siendo válido como prueba funcional, pero no reemplaza una prueba de usabilidad con alguien ajeno al desarrollo.
- Responsive no re-verificado en todas las pantallas listadas en la Fase 13 (ver §10).

## 12. POST-BETA (deliberadamente fuera de alcance)

- SIGIM, marketplace, directorio público de mediadores, matching B2C.
- Integración con Google Calendar / Outlook (el feed ICS de solo lectura, del Bloque 16, sigue siendo la única vía de sincronización de calendario).
- Billing / suscripciones.
- IA avanzada o asesoramiento jurídico automatizado.
- Indicador visible de "preparada/pendiente/crítica" en la fila de audiencia sin necesitar un clic (discutido en Bloque 17 §5, requeriría traer el checklist de cada audiencia al cargar el expediente).
- Suite de tests automatizada más completa (unitarios + Playwright) — por ahora `scripts/regression-test.js` cubre la superficie de seguridad más sensible vía HTTP real, no reemplaza una suite exhaustiva.

## 13. Veredicto

**READY FOR FIRST REAL USERS**

Por qué: se auditaron los 52 endpoints de `:id`-scoped de Mediador uno por uno contra el patrón de aislamiento, se encontró un único problema de severidad crítica (IDOR en confirmaciones de audiencia), se corrigió, y se verificó con un exploit real (no solo lectura de código) que el fix funciona y que el dato ajeno queda intacto. El flujo completo — desde crear una mediación hasta cerrarla, pasando por audiencias, propuestas, reprogramaciones, documentos, portales de parte y abogado, y estudio multiusuario — se probó de punta a punta con HTTP real contra una base descartable, dos veces, sin errores de servidor. Las migraciones funcionan tanto en una base nueva como en la base acumulada de desarrollo. No quedan secretos expuestos ni endpoints de debug activos en producción.

La razón por la que esto no es un "PASS sin salvedades": la profundidad de prueba no fue pareja en las 19 fases — jobs periódicos y responsive se verificaron por código/parcialmente en vez de en caliente en todas las pantallas, y no hubo una caminata ciega separada de usuario real. Ninguna de esas brechas es, por sí sola, motivo para bloquear un lanzamiento con un grupo chico de primeros usuarios controlados — pero si el objetivo es escalar más allá de eso, esas fases merecen una segunda pasada.
