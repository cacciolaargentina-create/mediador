# Auditoría SEO — Mediador

**Fecha**: 2026-10-01. Alcance: **solo superficie pública** (landing, páginas legales, páginas sin login). No se tocó ni se evaluó el dashboard, el expediente, ni ninguna pantalla logueada más que para confirmar que están correctamente fuera del índice. **Cero código modificado** — esto es auditoría, como se pidió.

**Qué es dato verificado y qué es hipótesis** (se marca en cada sección, pero quede dicho una vez): todo lo de las Partes 1-3 (arquitectura, técnico, seguridad) es verificado contra el código real del repo. La Parte de competidores (5) es verificada contra lo que esos sitios muestran públicamente hoy (con fuente citada). La Parte de keywords (4) es **100% hipótesis** — no usé ni tengo acceso a Google Keyword Planner, Search Console con datos históricos, SEMrush, Ahrefs ni ninguna herramienta de volumen de búsqueda real. Nunca voy a presentar un número de búsquedas mensuales como si lo midiera.

---

## PARTE 1 — Arquitectura pública (inventario completo)

| Ruta | Pública/Privada | Indexable hoy | Title | Description | H1 | Canonical | Problemas |
|---|---|---|---|---|---|---|---|
| `/` (`index.html`) | Pública | Sí (debería) | "Mediador" — genérico | **Ninguna** | 1, correcto | **Ninguno** | Ver Parte 2/3: contenido oculto tras JS, sin metadatos |
| `/legal.html` | Pública | Sí | "Mediador — Marco legal" | Ninguna | 1 | Ninguno | Sin description/canonical |
| `/privacidad.html` | Pública | Sí | "Mediador — Política de privacidad" | Ninguna | 1 | Ninguno | Sin description/canonical |
| `/terminos.html` | Pública | Sí | "Mediador — Términos y condiciones" | Ninguna | 1 | Ninguno | Sin description/canonical |
| `/legal-puente.html` | Pública (sin querer) | Sí, hoy | "Puente Digital — Marco legal" | Ninguna | 1 | Ninguno | Marca descontinuada (ver decisión ya tomada) — **debe salir del índice** |
| `/privacidad-puente.html` | Pública (sin querer) | Sí, hoy | "Puente Digital — Política de privacidad" | Ninguna | 1 | Ninguno | Ídem |
| `/terminos-puente.html` | Pública (sin querer) | Sí, hoy | "Puente Digital — Términos y condiciones" | Ninguna | 1 | Ninguno | Ídem |
| `/chat.html` | **Semi-pública** (acceso sin cuenta de Google vía `guestToken`, ver `routes/guest.js`) | Sí, hoy | "Puente Digital" | Ninguna | **4** (uno por pantalla interna) | Ninguno | Es la app de coparentalidad en sí, no una página de marketing. Múltiples H1. Marca descontinuada. **Debe salir del índice** |
| `/portal.html` | **Privada de hecho** (token no adivinable, pero sin login) | Sí, hoy — **sin ningún control** | "Mi mediación" | Ninguna | — (JS) | Ninguno | **Ver Parte 3 — prioridad máxima** |
| `/lawyer-portal.html` | Privada de hecho (token) | Sí, hoy — **sin ningún control** | "Portal de Abogados" | Ninguna | — (JS) | Ninguno | **Ver Parte 3 — prioridad máxima** |
| `/studio-invitation.html` | Transicional (token, requiere login para aceptar) | Sí, hoy | "Invitación a un estudio" | Ninguna | — | Ninguno | No debería indexarse, no es contenido de marketing |
| `/admin.html` | Privada (admin) | Sí, hoy — **sin `noindex`** | "Puente Digital — Admin" | Ninguna | — | Ninguno | **Sin noindex. Ver Parte 3** |
| `/admin-mediador.html` | Privada (admin) | **No** — ya tiene `noindex, nofollow` | "Mediador — Centro de control" | — | — | — | Ya está bien, sin cambios |
| `/radar.html` | Privada (admin) | **No** — ya tiene `noindex, nofollow` | "Mediador — Radar competitivo" | — | — | — | Ya está bien, sin cambios |

**Login/registro**: no son páginas propias — `/auth/google` es un redirect directo a Google OAuth (sin HTML intermedio). No hay nada que optimizar ahí; el "registro" es el mismo botón "Empezar gratis con Google" de la landing.

**Blog/recursos**: no existe. Ver Parte 7.

**Rutas de API accesibles sin autenticación** que devuelven datos (no HTML, pero igual rastreables en teoría): `GET /api/health`, `GET /verificar/:hash` (página pública de verificación de documentos certificados — matrícula pública intencional, correcto que exista, pero nunca debería indexarse como "contenido" — es una herramienta de verificación puntual). No encontré más endpoints GET sin auth que devuelvan contenido sustancial.

---

## PARTE 2 — SEO técnico (detalle)

### Title / Meta description / Headings
- **Title**: presente en las 14 páginas públicas, pero genérico y sin keyword alguna salvo el nombre de marca. Ninguno comunica qué hace el producto.
- **Meta description**: ausente en el 100% de las páginas públicas.
- **H1**: correcto (uno solo) en `index.html`, `legal.html`, `privacidad.html`, `terminos.html` y sus pares `-puente`. **Incorrecto en `chat.html`** (4 H1).
- **H2/H3**: la landing usa `<h2>` para cada sección ("Sabé qué pasó.", "Sabé qué falta.", "Sabé qué sigue.", "Cada persona ve lo que le corresponde.", "Un tablero para todo el estudio.", "Preguntas frecuentes") y `<h3>` dentro de cards de rol y FAQ. Jerarquía correcta, sin saltos (no hay H3 antes de un H2 en la misma sección).

### Canonical
Ausente en el 100% de las páginas. Esto importa especialmente para `legal.html` vs `legal-puente.html` (contenido legal casi idéntico en dos URLs) y para cualquier variante `http`/`www` que nginx no esté canonicalizando (no pude verificar la config de nginx desde el repo).

### robots.txt / sitemap.xml
Ninguno de los dos existe. Sin `robots.txt`, el comportamiento por defecto de los crawlers es "todo permitido" — es decir, hoy **no hay ninguna barrera a nivel de robots.txt** para `/portal.html`, `/lawyer-portal.html`, `/admin.html`, `/chat.html` ni las rutas `-puente`.

### Open Graph / Twitter Cards
Cero, confirmado por grep en todo `public/*.html`. Compartir el link de Mediador por WhatsApp hoy muestra una vista previa genérica del navegador (sin imagen, sin título ni descripción curados) — mala primera impresión para el canal de difusión más probable (un mediador recomendándoselo a otro por WhatsApp).

### Schema.org / datos estructurados
Cero `application/ld+json` en todo el repo.

### URLs
Limpias, sin parámetros de tracking, sin IDs expuestos en las públicas. Las páginas `-puente` son el único problema real de duplicación de URL/contenido.

### Enlaces internos
La landing es casi una isla: nav con anchors internos (`#como-funciona`, `#estudios`, `#seguridad`, `#preguntas`) y 3 links de footer a legales + un `mailto:`. **Cero enlaces internos hacia contenido adicional** porque no existe (no hay `/recursos` todavía). Esto no es un error hoy, pero limita cuánto puede "repartir autoridad" la landing una vez que haya más páginas.

### Imágenes / alt text
Una sola imagen real en la landing (`/images/bridge.jpeg`, fondo del hero) con `alt=""` — correcto, es decorativa. Los logos SVG también llevan `alt=""`, aceptable porque siempre aparecen junto al texto "Mediador" visible. Sin `width`/`height` en el `<img>` del hero (riesgo de CLS). Sin versión WebP/AVIF.

### Rendimiento / Core Web Vitals (sin herramienta de medición real — esto es lectura de código, no un Lighthouse corrido)
- `mediador.js`: 276 KB, un solo bundle para landing + SPA completa, sin `defer`.
- `https://cdn.socket.io/4.7.5/socket.io.min.js` cargado en la landing pública — innecesario para un visitante anónimo, candidato directo a sacar de esta página.
- Hero image sin optimizar (134 KB, JPEG plano, candidato a LCP malo).
- 5 hojas de estilo separadas (~92 KB combinados).
- No corrí Lighthouse/PageSpeed Insights real contra producción — lo que sigue es lectura de código, no una métrica medida. Si se quiere un número real de Core Web Vitals, hay que correrlo contra `https://puentedigital.app` con la herramienta real.

### Mobile
Hay media queries dedicadas (`responsive.css`) y la landing ya se ve bien en mobile por el trabajo de bloques anteriores (confirmado visualmente en sesiones previas de este mismo proyecto). No encontré overflow ni contenido cortado en la landing específicamente.

### Contenido duplicado
El par `legal.html`/`legal-puente.html` (y equivalentes privacidad/términos) es contenido casi idéntico en dos URLs distintas, indexable hoy — duplicación real.

### Errores 404 / redirects
No hay una ruta 404 personalizada (`server.js` no define ningún catch-all) — Express devuelve su 404 default, que sí es un HTTP 404 real (no un "soft 404" con status 200), así que no es un problema de indexación, solo de experiencia (una página fea si alguien cae en un link roto). No pude verificar la configuración de nginx/redirects `www`↔sin-`www` o `http`↔`https` desde el repo — queda pendiente de revisar del lado del servidor si se quiere canonicalizar el dominio por completo.

### Headers relevantes
`helmet()` está activo (buena base de seguridad general), pero no setea `X-Robots-Tag`. No hay ningún header de robots a nivel HTTP hoy — todo el control que existe (los dos `noindex` de `admin-mediador.html`/`radar.html`) vive solo en el `<meta>` de esas dos páginas HTML.

---

## PARTE 3 — Seguridad SEO (lo más urgente de toda la auditoría)

Verifiqué específicamente que lo privado no sea indexable. **No lo es, en varios casos.**

| Qué | Estado real | Riesgo |
|---|---|---|
| Dashboard, expedientes, partes, documentos, comunicaciones, timeline, notas internas | Viven en `/app` (SPA), nunca en una URL propia renderizable sin sesión — un crawler sin cookie de sesión no puede llegar al contenido en sí. **Correctamente no indexables por diseño de la SPA**, no por una medida explícita de SEO. | Bajo, pero no está reforzado — ver recomendación de `X-Robots-Tag` global |
| **`/portal.html` (portal de partes)** | **Sin `noindex`, sin entrada en robots.txt (que no existe), reachable por cualquiera con el link.** Es una página con el nombre, los documentos y la actividad de una mediación real de una persona real. | **Alto.** Si Google llega a indexar un link de portal filtrado (compartido sin querer, por ejemplo en un grupo de WhatsApp o reenviado), ese contenido privado queda buscable. |
| **`/lawyer-portal.html`** | Mismo caso que arriba — datos de la representación de un abogado en una mediación puntual. | **Alto**, mismo motivo |
| **`/studio-invitation.html`** | Token de invitación a un estudio — menos sensible que los portales (no expone datos de una mediación), pero tampoco debería ser indexable | Medio |
| **`/admin.html`** | Panel de administración de la plataforma (coparentalidad), sin `noindex` | Medio — no expone datos de un caso puntual sin login, pero es superficie de administración que no debería aparecer en un buscador bajo ningún concepto |
| `/chat.html` | App de coparentalidad, sin `noindex` | Medio — no es "datos de una mediación de Mediador", pero es la aplicación en sí, marca descontinuada |

**Por qué esto es grave y no solo "falta un meta tag"**: un portal de parte/abogado es accesible por **cualquiera que tenga el link**, sin login. El único motivo por el que hoy "no es público" es que el token es largo y no adivinable — eso protege contra que alguien lo *adivine*, pero no contra que Google lo *indexe* si ese link circula una sola vez por un canal que un crawler alcance (un grupo público, un documento compartido, un historial de WhatsApp Web cacheado, etc.). Es exactamente el escenario que el pedido original describe como el que hay que prevenir con `noindex` real, no solo con la oscuridad del token.

**Recomendación de fondo** (se detalla en el diagnóstico final): `noindex` por `<meta>` en cada uno de estos HTML, **más** un header `X-Robots-Tag: noindex, nofollow` a nivel de servidor para esas rutas — así queda protegido incluso si alguna vez se sirve ese HTML sin pasar por el archivo estático (defensa en profundidad, tal como se pidió explícitamente).

---

## PARTE 4 — Arquitectura de keywords (HIPÓTESIS, no datos medidos)

Sin Keyword Planner, Search Console con histórico, ni ninguna herramienta de volumen real, lo siguiente es **mi estimación cualitativa de intención de búsqueda**, agrupada por intención, no un dato de tráfico. Marco entre paréntesis mi confianza (alta/media/baja) en que el término tiene volumen real — esa confianza es también subjetiva, no medida.

**Intención: "quiero una herramienta" (comercial, alta prioridad de conversión)**
- "software para mediadores" (confianza alta — es literalmente lo que es medi.ar, que ya posiciona para esto)
- "sistema para mediadores"
- "gestión de mediaciones" / "software de gestión de mediaciones"
- "herramientas para mediadores"
- "software para estudios de mediación"

**Intención informacional/normativa (tráfico más alto probable, conversión más baja, pero correcto para el /recursos)**
- "mediación prejudicial" / "mediación prejudicial obligatoria"
- "qué es SIGIM" / "SIGIM mediación"
- "MEPRE sistema"
- "mediación CABA" / "mediación Provincia de Buenos Aires" (intención con componente geográfico — probablemente dos públicos distintos, dos jurisdicciones distintas, ver Parte 6)
- "honorarios de mediadores" / "cómo se calculan los honorarios del mediador" (Mediador ya tiene una calculadora real — esto conecta directo con una función del producto)
- "gestión de expedientes para mediadores"
- "documentación de una mediación" / "qué documentos necesito para una mediación"

**Intención de marca/competencia (bajo volumen esperado, pero relevante)**
- "medi.ar alternativa" / "alternativas a medi.ar" (no atacar de forma agresiva o comparativa negativa — ver Parte 6, nunca denigrar competencia)
- "mediador argentina software"

**Lo que NO voy a hacer**: no voy a inventar un número ("500 búsquedas/mes") para ninguno de estos. Si se quiere ese dato real, hace falta Google Keyword Planner (requiere cuenta de Google Ads, aunque sea sin campaña activa) o una herramienta paga (Ahrefs, Semrush, Ubersuggest). Lo puedo estructurar para cargar ahí en cuanto haya una cuenta disponible.

---

## PARTE 5 — Competidores (investigado por web, con fuente)

### [medi.ar](https://medi.ar/) — el único competidor directo confirmado

- **Título de la página**: *"Software de mediación | Agenda y gestión de mediaciones online | medi.ar"* — título con keyword explícita, bien construido.
- **Propuesta**: *"Tus mediaciones, en orden y en un solo lugar"* — mensaje casi idéntico en espíritu al de Mediador ("El sistema operativo de tu mediación").
- **Términos que enfatizan**: agenda inteligente, cero errores de agenda, menos tareas manuales, sin solapamientos, disponible 24/7 en la nube.
- **Estructura del sitio**: Cómo funciona, Características, Integraciones, Precios, FAQ. Integra con Google Calendar y Google Meet.
- **CTA**: "Probar gratis" / "Agendar prueba gratuita", sin tarjeta.
- **Público declarado**: mediadores, abogados, centros de mediación, estudios jurídicos, cámaras empresariales.
- **Lo que NO tienen** (oportunidad real, verificada): **cero blog, cero sección de recursos, cero contenido sobre SIGIM, MEPRE, mediación prejudicial, honorarios, o cualquier tema informativo**. No mencionan CABA ni PBA específicamente, solo "Argentina" en general.

### Legal-tech generalista (no mediación específica, pero compite por atención/presupuesto)

- **[Veredicta](https://veredicta.com.ar/)**, **[LITIS](https://litis.com.ar/)**, **[IUSNET](https://www.iusnet.com.ar/)** — gestión de expedientes judiciales para abogados en general. Veredicta tiene **blog activo** con estrategia de comparación directa contra competidores (Lex-Doctor, LITIS, Lexius, Juztina, LegalSurf) y guías por área de práctica (laboral, penal, civil, familia). **No mencionan mediación en ningún lado** de lo que revisé.

### Lo que falta en el mercado (oportunidad concreta, no hipótesis — es ausencia verificada)

Ningún competidor revisado (ni medi.ar ni los generalistas) tiene contenido educativo sobre mediación prejudicial, SIGIM, MEPRE, honorarios de mediador o diferencias CABA/PBA. Un `/recursos` bien hecho, con fuentes citadas, sería contenido que hoy **nadie en este nicho está haciendo** — la oportunidad de SEO más clara de toda esta auditoría.

Sources:
- [Software de mediación — medi.ar](https://medi.ar/)
- [MEPRE - Sistema de Mediación Prejudicial](https://www.argentina.gob.ar/justicia/mediacion/mepre)
- [Software para Abogados en Argentina — Veredicta](https://veredicta.com.ar/blog/mejor-software-gestion-legal-abogados-argentina)
- [Gestión de Expedientes Judiciales — Veredicta](https://veredicta.com.ar/soluciones/expedientes)
- [LITIS - Software para abogados 100% Cloud](https://litis.com.ar/)
- [IUSNET - Sistema para Abogados](https://www.iusnet.com.ar/)

---

## PARTE 6 — Arquitectura SEO propuesta (evaluación de las URLs sugeridas)

Evalúo cada una por intención de búsqueda real y si hay contenido genuino para sostenerla — **no creo que haya que crear las 8 automáticamente**.

| URL propuesta | ¿Intención propia? | ¿Contenido real disponible hoy? | Veredicto |
|---|---|---|---|
| `/` | Sí — marca + producto | Sí (landing existente) | Mantener, arreglar metadatos |
| `/software-para-mediadores` | Dudoso — es básicamente sinónimo de `/` | Sería el mismo contenido reescrito | **No crear aparte.** Mejor: que `/` ya apunte a esa frase en su title/H1/contenido. Una página aparte con el mismo contenido que la home es canibalización, no una página nueva |
| `/sistema-para-mediadores` | Mismo caso que arriba | Mismo contenido | **No crear.** Mismo motivo — es la misma intención que `/software-para-mediadores` y que `/` |
| `/gestion-de-mediaciones` | Parcialmente distinta — más orientada a "cómo organizo el trabajo" que a "qué producto uso" | Hay contenido real posible (la landing ya tiene secciones de esto: "Sabé qué pasó/falta/sigue") | **Evaluar como sección de la landing primero**, no como página aparte, hasta que haya evidencia de que la intención realmente diverge |
| `/mediacion-caba` | Sí, intención geográfica real y distinta de PBA (normativa, plazos y organismos distintos) | **No hoy** — haría falta contenido verificado y propio de la jurisdicción CABA, con fuente oficial | Página real candidata, pero recién cuando haya contenido verificado que la sostenga — no antes |
| `/mediacion-pba` | Sí, misma lógica que CABA | No hoy | Ídem — candidata futura, no ahora |
| `/sigim` | Sí, intención informacional clara ("qué es SIGIM") | Puede armarse con fuentes oficiales (ya hay una auditoría técnica de SIGIM en `docs/AUDITORIA_SIGIM.md` del propio proyecto) | **Buena candidata para el /recursos** (no como landing de producto — es contenido educativo, no vende directamente) |
| `/mediare` | Sí, mismo tipo de intención que SIGIM | Necesita investigación propia (no se auditó MEDIARE en este proyecto todavía) | Candidata para /recursos, pendiente de investigar el sistema real antes de escribir nada |
| `/recursos` | Sí, es el contenedor de todo lo anterior | Ver Parte 7 | **Sí crear** — es el hub, no una página de keyword suelta |

**Conclusión de esta parte**: de las 8 propuestas, recomiendo **no crear como landing de producto aparte** `/software-para-mediadores` ni `/sistema-para-mediadores` (duplicarían la home). `/gestion-de-mediaciones` queda en espera de ver si de verdad diverge o si es la misma landing. `/mediacion-caba` y `/mediacion-pba` son candidatas reales pero necesitan contenido verificado antes de existir — no antes. `/sigim` y `/mediare` encajan como **artículos dentro de `/recursos`**, no como páginas de producto sueltas. `/recursos` sí se justifica como estructura.

---

## PARTE 7 — Centro de recursos (evaluación de contenido, con las salvedades pedidas)

Evalúo cada tema propuesto por si hay fuente verificable y por el riesgo de afirmar algo no vigente:

| Tema | Fuente disponible | Riesgo si se hace mal | Evaluación |
|---|---|---|---|
| Qué es SIGIM | Sí — `docs/AUDITORIA_SIGIM.md` (ya investigado en este proyecto) + fuente oficial `argentina.gob.ar/justicia/mediacion` | Afirmar que Mediador se integra con SIGIM sin que sea cierto | Viable, **con disclaimer explícito de que Mediador NO tiene integración oficial** |
| SIGIM y MEPRE (diferencias) | Parcial — hay que verificar si son el mismo sistema o distintos (la búsqueda de hoy sugiere que MEPRE es el sistema de carga y SIGIM es mencionado como "Sistema Informatizado de Gestión Integral de la Mediación" en una fuente, pero no verifiqué si son sinónimos o sistemas distintos) | Confundir dos sistemas gubernamentales distintos | **No escribir sin antes confirmar la relación exacta contra la fuente oficial** — esto es trabajo de investigación previo, no de redacción |
| Cómo organizar una mediación prejudicial | Sí — Ley 26.589, ya trabajada en este proyecto (Bloque 43, `docs/PLAZOS_LEGALES.md`) | Dar un plazo o requisito como si fuera igual en todo el país cuando varía por jurisdicción | Viable, citando la ley nacional y marcando explícitamente qué es solo de jurisdicción nacional |
| Documentación de una mediación | Sí — es funcionalidad real del producto (gestión documental) | Ninguno relevante, es más práctico que normativo | Viable, bajo riesgo |
| Mediación en CABA | Necesita fuente propia de CABA (normativa local), no la tengo verificada todavía | Afirmar un trámite o plazo porteño con la ley nacional | **No escribir sin investigar la normativa de CABA específicamente primero** |
| Mediación en PBA | Mismo caso, normativa de la provincia de Buenos Aires | Mismo riesgo | **No escribir sin investigar la normativa de PBA específicamente primero** |
| MEDIARE | No investigado en este proyecto todavía | Afirmar algo sobre un sistema que no se verificó | **No escribir sin investigar primero qué es MEDIARE exactamente** (ver Parte 5 — no apareció en mi investigación de competidores, habría que buscarlo específicamente) |
| Honorarios del mediador | Sí — Mediador ya tiene una Calculadora de Honorarios real (Bloque 42), con fuente normativa citada en el propio código | Mínimo, ya hay disciplina de citar fuente en este tema puntual | Viable, y conecta directo con una función real del producto — buena oportunidad de conversión |
| Gestión de expedientes para mediadores | Sí, es la propuesta de valor del producto | Bajo | Viable |
| Herramientas digitales para mediadores | Sí, es terreno propio | Bajo, mientras no se hable mal de competidores por nombre | Viable |

**Regla general para toda la sección, sin excepción**: cada artículo de contenido jurídico/normativo lleva **fuente oficial citada, jurisdicción indicada explícitamente, fecha de verificación visible**, y en ningún caso se presenta a Mediador como sistema oficial ni se afirma integración con SIGIM/MEPRE/MEDIARE si no existe — exactamente como ya se hizo con la Calculadora de Honorarios y el Motor de Plazos Legales en este mismo producto. No hay que inventar un criterio nuevo, hay que aplicar el que ya se usó ahí.

---

## PARTE 8 — SEO on-page (resumen de lo que falta implementar, detalle en diagnóstico final)

Cubierto en detalle en la Parte 2 y en el diagnóstico. Resumen: title único falta en todas (hoy son genéricos, no "únicos" en el sentido de diferenciar intención), meta description ausente en el 100%, H1 único ya está bien salvo `chat.html`, H2/H3 ya tienen jerarquía correcta en la landing, canonical ausente en el 100%, OG/Twitter ausente en el 100%, alt text ya está bien en lo poco que hay, enlaces internos son mínimos (va a crecer naturalmente con `/recursos`), breadcrumbs no aportan valor todavía (no hay profundidad de navegación — recién tendrían sentido dentro de `/recursos` si crece a varios niveles), Schema.org ausente en el 100%.

---

## PARTE 9 — SEO técnico (resumen, detalle en diagnóstico final)

Cubierto en Parte 2/3. Falta: `robots.txt`, `sitemap.xml`, canonical en todo, `noindex` en las rutas privadas identificadas en la Parte 3, revisión de JS/CSS/imágenes de la landing (socket.io innecesario, imagen sin optimizar, bundle único de 276KB). **No voy a sacrificar funcionalidad del producto por una mejora artificial de PageSpeed** — por ejemplo, no voy a tocar `mediador.js` en sí (es el bundle de todo el producto logueado), la mejora ahí es sacar lo que la landing no necesita (socket.io), no reescribir el bundle.

---

## PARTE 10 — Conversión (CTA)

Hoy la landing ya tiene UN mensaje de conversión consistente y no saturado: "Empezar gratis con Google" / "Ingresar", repetido 3 veces a lo largo de la página (header, mitad, footer) más un link secundario a "Ver cómo funciona" (ancla interna, no un CTA competidor). Esto ya cumple con "un CTA claro, sin llenar de botones" — no encontré sobre-saturación de botones ni mensajes contradictorios. La propuesta comercial ("El sistema operativo de tu mediación") es clara y no exagera (no dice "la mejor" ni hace afirmaciones no verificables). **Esto ya está bien hecho** — lo señalo porque no todo en esta auditoría es un problema; cuando se agreguen páginas nuevas (`/recursos`, futuras `/mediacion-caba` etc.), hay que mantener el mismo criterio: un CTA por página, no plagarlas de botones.

---

## PARTE 11 — Analítica

**Verificado por grep en todo el repo: no hay Google Analytics, Google Tag Manager, Search Console, ni ningún tracker de terceros instalado hoy.** Punto de partida limpio.

### Estructura propuesta (sin implementar todavía)
- **Search Console**: verificación por archivo HTML o meta tag (no requiere JS, no toca el producto) — paso obligatorio antes que cualquier otra cosa, porque es la única forma de ver impresiones/clicks reales de Google y, con el tiempo, reemplazar las hipótesis de la Parte 4 por datos medidos.
- **Analítica de eventos** (GA4 u otra, a decidir): los eventos que importan según el objetivo del usuario son exactamente los que pidió — visita a la landing, click en CTA, inicio de registro (redirect a `/auth/google`), vuelta exitosa del login (activación). **Nunca** un evento debería llevar texto de un expediente, nombre de una parte, contenido de un mensaje o cualquier dato que viva dentro de `/app` — la instrumentación tiene que vivir *solo* en las páginas públicas y en el momento de login/alta, nunca dentro de la SPA logueada. Esto es coherente con el pedido explícito de no tocar el dashboard ni mandar datos sensibles a analítica.
- **Qué falta decidir, no technical**: qué herramienta (GA4 es la más estándar, pero Plausible/Fathom son alternativas sin cookies de terceros si la privacidad es una prioridad del producto — dado que Mediador maneja datos sensibles de mediación, vale la pena que el usuario decida esto con ese criterio en mente, no por default).

---

## DIAGNÓSTICO FINAL — PROBLEMA → IMPACTO → RECOMENDACIÓN → ARCHIVO → PRIORIDAD

| # | Problema | Impacto | Recomendación | Archivo a modificar | Prioridad |
|---|---|---|---|---|---|
| 1 | `/portal.html` y `/lawyer-portal.html` (datos reales de una mediación) sin `noindex` ni ningún control | Datos privados de personas reales podrían quedar indexados si el link circula una sola vez por un canal alcanzable por un crawler | `<meta name="robots" content="noindex, nofollow">` en el HTML + header `X-Robots-Tag: noindex, nofollow` a nivel de servidor para esas rutas | `public/portal.html`, `public/lawyer-portal.html`, `server.js` (o `routes/party-portal.js`/`routes/lawyer-portal.js` si el header se setea por ruta) | **CRÍTICA** |
| 2 | El contenido de la landing depende de un fetch async (`/auth/me`) para mostrarse — `display:none` por defecto | El público menos exigente técnicamente pero más importante (WhatsApp, Facebook, Slack, la mayoría de los scrapers de preview) nunca ejecuta JS y ve una página vacía | Mover el contenido de la landing fuera del gate condicional — que el HTML visible no dependa de que un fetch falle | `public/index.html`, `public/mediador.js` (lógica de `boot()`) | **Alta** |
| 3 | No existe `robots.txt` | Cero control de crawling a nivel de protocolo — ninguna de las rutas privadas tiene ni siquiera esta primera barrera | Crear `robots.txt` con `Disallow` explícito para `/app`-equivalentes, portales, admin, chat y las páginas `-puente` | `public/robots.txt` (nuevo) | **Alta** |
| 4 | No existe `sitemap.xml` | Google no tiene una lista explícita de qué indexar — depende solo de rastreo/enlaces, más lento y menos confiable | Crear `sitemap.xml` con las páginas públicas reales (`/`, `/legal.html`, `/privacidad.html`, `/terminos.html`, y lo que se cree de `/recursos`) | `public/sitemap.xml` (nuevo) | **Alta** |
| 5 | `/admin.html` y `/chat.html` sin `noindex`, marca Puente Digital descontinuada | Confunde a quien llega buscando "Mediador" y encuentra "Puente Digital"; expone superficie de admin innecesariamente | `noindex` + evaluar sacarlas de circulación según la decisión de unificación ya tomada | `public/admin.html`, `public/chat.html` | Alta |
| 6 | `legal-puente.html`, `privacidad-puente.html`, `terminos-puente.html` indexables, contenido duplicado de marca descontinuada | Contenido duplicado + confusión de marca (ya resuelta la decisión: se unifica todo bajo Mediador) | `noindex` en las tres, evaluar canonical hacia su par Mediador si el contenido es sustancialmente igual | `public/legal-puente.html`, `public/privacidad-puente.html`, `public/terminos-puente.html` | Alta |
| 7 | Cero meta description en toda página pública | Google genera su propio snippet (a veces tomando texto irrelevante), peor CTR en resultados de búsqueda | Redactar una description única por página, en español rioplatense, orientada a la intención de esa página | `public/index.html`, `public/legal.html`, `public/privacidad.html`, `public/terminos.html` | Alta |
| 8 | Title genérico ("Mediador") sin keyword ni propuesta de valor | Peor posicionamiento para búsquedas de intención ("software para mediadores" etc.) y peor CTR | Title único por página con marca + propuesta ("Mediador — Software de gestión de mediaciones para Argentina", etc.) | Igual que arriba | Alta |
| 9 | Cero Open Graph / Twitter Cards | Vista previa rota al compartir por WhatsApp — el canal de difusión más probable para este público | Agregar `og:title`, `og:description`, `og:image` (falta crear la imagen, ver punto 15), `twitter:card` | `public/index.html` como mínimo, idealmente todas las públicas | Alta |
| 10 | Cero `canonical` en toda página pública | Riesgo de que Google indexe variantes (`http`/`https`, con/sin `www`, o el par `-puente`) sin saber cuál priorizar | `<link rel="canonical">` autorreferencial en cada página pública | Todas las públicas | Media-Alta |
| 11 | `chat.html` tiene 4 `<h1>` | Jerarquía de encabezados inválida (aunque la página de todas formas va a `noindex` por el punto 5, vale corregirlo si queda accesible por algún motivo) | Dejar un solo `<h1>` real por pantalla, el resto a `<h2>` | `public/chat.html` | Media (baja urgencia dado que ya se recomienda `noindex`) |
| 12 | Cero Schema.org | Sin rich results posibles (nombre de la organización, tipo de software) | `SoftwareApplication` + `Organization` en JSON-LD, solo con datos reales (sin inventar rating, sin inventar precio si no es público así) | `public/index.html` | Media |
| 13 | `socket.io` cargado en la landing pública | Peso y una petición de red externa innecesaria para un visitante anónimo que todavía no puede usar el chat | Cargar `socket.io` solo dentro de `#app` (ya logueado), nunca en `#login-gate` | `public/index.html` | Media |
| 14 | Imagen del hero sin optimizar (134 KB, sin `width`/`height`, sin WebP) | Candidata a mal LCP, riesgo de CLS | Comprimir, agregar `width`/`height`, considerar WebP con fallback | `public/images/bridge.jpeg`, `public/index.html` | Media |
| 15 | No existe una imagen pensada para compartir (1200×630) | El `og:image` del punto 9 no tiene qué imagen usar todavía | Crear una imagen de marca en ese formato | nueva, en `public/images/` | Media (depende del punto 9) |
| 16 | `/studio-invitation.html` sin `noindex` | Bajo riesgo de dato sensible, pero no es contenido de marketing y no debería estar en el índice | `noindex` | `public/studio-invitation.html` | Media |
| 17 | No hay `/recursos` ni contenido educativo | Oportunidad de posicionamiento desaprovechada — confirmado que ningún competidor directo tiene esto (Parte 5) | Evaluar y construir con las salvedades de la Parte 7 (fuente, jurisdicción, fecha, sin afirmar integración oficial) | nuevo, estructura a definir | Media (es oportunidad, no urgencia de seguridad) |
| 18 | Sin Search Console ni analítica | Sin visibilidad real de impresiones/clicks, sin forma de medir si algo de esto funciona, ni de reemplazar las hipótesis de keywords por datos reales | Verificar el sitio en Search Console (paso de cero riesgo, no requiere JS) antes que cualquier otra cosa de analítica | `public/index.html` (meta tag de verificación) o DNS, según el método elegido | Media-Alta (barato de hacer, alto valor para medir todo lo demás) |
| 19 | Sin header `X-Robots-Tag` como defensa adicional en rutas sensibles | El control de hoy depende 100% de que el HTML correcto se sirva siempre — un defensa en profundidad barata | Agregar el header a nivel de servidor para las rutas de portales/admin/chat, además de los `<meta>` | `server.js` o middlewares específicos de esas rutas | Media (complementa el punto 1, no lo reemplaza) |

---

## Qué no es parte de esta auditoría (ya resuelto o fuera de alcance)

- `admin-mediador.html` y `radar.html` ya tienen `noindex, nofollow` correcto — no se tocan.
- El dashboard, expedientes, partes, documentos, comunicaciones, timeline y notas internas no tienen URL propia fuera de la SPA logueada — no son indexables hoy por diseño, confirmado.
- La decisión de marca (unificar bajo Mediador) ya la tomó el usuario — esta auditoría la aplica (puntos 5 y 6 del diagnóstico) pero no la vuelve a plantear.

**No implementé nada de esto.** Queda esperando aprobación para pasar a la Parte 8 (implementación) del pedido original.
