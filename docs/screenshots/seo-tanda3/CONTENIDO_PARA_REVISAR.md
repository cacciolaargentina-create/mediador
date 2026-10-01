# Tanda 3 — Contenido para revisar (nada está publicado ni indexado)

Todo lo de acá está en el código, commiteado localmente, **sin push y sin
desplegar**. Las 6 páginas nuevas tienen `noindex` (meta + header HTTP) y
están bloqueadas en `robots.txt`, y no están en `sitemap.xml`. No se
publica nada hasta que apruebes los textos.

## 1. Qué páginas se descartaron, y por qué

De las 8 propuestas originales (`/software-para-mediadores`,
`/gestion-de-mediaciones`, `/sistema-para-mediadores`, `/mediacion-caba`,
`/mediacion-pba`, `/sigim`, `/mediare`, `/recursos`):

- **`/software-para-mediadores`, `/sistema-para-mediadores`,
  `/gestion-de-mediaciones` — NO se crean como páginas aparte.** Las tres
  apuntan, en el fondo, a la misma búsqueda que ya responde la home
  ("quiero un software/sistema para gestionar mediaciones"). Crear 3
  páginas más con el mismo producto y la misma propuesta hubiera sido
  canibalización — Google no sabría cuál posicionar, y el contenido
  habría sido necesariamente repetido. La home ya tiene esa intención
  cubierta en su title/description ("software de gestión de mediaciones
  para mediadores en Argentina").
- **`/mediare` — no es una página aparte.** Investigando, MEDIARE resultó
  ser el sistema informático oficial de la Provincia de Buenos Aires para
  la etapa de mediación — es decir, es exactamente el mismo tema que
  "mediación en PBA". Separarlo hubiera sido crear dos páginas casi
  idénticas. Quedó como una sección dentro de `/recursos/mediacion-pba.html`.
- **`/mediacion-caba` y `/mediacion-pba` — sí se crearon**, pero como
  `/recursos/mediacion-caba.html` y `/recursos/mediacion-pba.html` (no
  como rutas de primer nivel), para que vivan ordenadas dentro del centro
  de recursos en vez de sueltas.
- **`/sigim` — sí se creó**, como `/recursos/que-es-sigim.html`, por el
  mismo motivo de organización.
- **`/recursos` — sí se creó**, como hub (`/recursos.html`) que enlaza a
  las 5 guías.

**Resultado: 6 páginas nuevas, no 8** — 1 hub + 5 guías, todas con
intención de búsqueda real y distinta entre sí.

---

## 2. Las 6 páginas, con resumen de contenido

| Página | Contenido normativo — revisar sí o sí | Resumen |
|---|---|---|
| `/recursos.html` | No (solo organiza) | Hub con tarjetas a las 5 guías de abajo. Un párrafo de intro, un callout aclarando que Mediador no es SIGIM/MEDIARE. |
| `/recursos/mediacion-prejudicial.html` | **Sí** | Qué es la mediación prejudicial obligatoria (Ley 26.589): cuándo es obligatoria, el plazo de 60 días hábiles, el aviso de audiencia de 3 días, el cierre y la prescripción. |
| `/recursos/que-es-sigim.html` | **Sí** | Qué es el Portal de Mediación nacional (SIGIM) y MEPRE, cómo se ingresa, y la aclaración explícita de que Mediador no es ninguno de los dos. |
| `/recursos/honorarios-del-mediador.html` | **Sí** | La base normativa (Decreto 1.467/2011), la unidad UHOM, los tramos — sin inventar una tabla completa de montos. Enlaza a la Calculadora de Honorarios real del producto. |
| `/recursos/mediacion-caba.html` | **Sí** | Por qué la mediación civil/comercial en CABA usa el régimen nacional (no tiene ley propia) — con la fuente exacta que lo dice. |
| `/recursos/mediacion-pba.html` | **Sí** | La Ley 13.951 de PBA, sus plazos, y el sistema MEDIARE — con la aclaración de que Mediador no es MEDIARE. |

**5 de las 6 tienen contenido normativo marcado como BORRADOR** — las que
dicen "Sí" en la columna de arriba. La única sin normativa es el hub.

---

## 3. Los textos completos, para leer sin abrir código

### 3.1 `/recursos.html` (hub — sin normativa)

**Title**: Recursos para mediadores — Mediador
**Description**: Guías y referencias para mediadores en Argentina: mediación prejudicial, qué es SIGIM, honorarios del mediador, y las normativas de CABA y la Provincia de Buenos Aires.

> # Recursos para mediadores
>
> Guías de referencia sobre mediación prejudicial en Argentina — qué dice
> la normativa, qué sistemas existen y cómo se calculan los honorarios.
> Pensadas para mediadores y estudios jurídicos, no para reemplazar el
> asesoramiento legal sobre un caso puntual.
>
> [5 tarjetas, una por guía — título y una línea de descripción cada una,
> ver la tabla de arriba]
>
> **Sobre estas guías** — Son material de referencia general, no
> asesoramiento legal sobre un caso particular. Mediador no es SIGIM,
> MEDIARE ni ningún sistema oficial de mediación — es una herramienta de
> gestión para el trabajo diario del mediador. Cada guía cita su fuente
> oficial y la fecha en que se verificó.

---

### 3.2 `/recursos/mediacion-prejudicial.html` — ⚠️ NORMATIVO

**Title**: Mediación prejudicial obligatoria en Argentina: cómo funciona — Mediador
**Description**: Qué es la mediación prejudicial obligatoria según la Ley 26.589: cuándo se exige, los plazos principales y qué pasa si no se cumplen. Guía con fuente oficial citada.

> # Mediación prejudicial obligatoria: cómo funciona
>
> **[BORRADOR PENDIENTE DE REVISIÓN]** Este contenido todavía no fue
> aprobado para publicarse ni indexarse. Es información general sobre la
> normativa, no asesoramiento legal sobre un caso puntual.
>
> ## Qué es
> La mediación prejudicial obligatoria es un paso previo exigido antes de
> iniciar determinados juicios en el ámbito de la Justicia Nacional
> (Capital Federal y fuero federal). La regula la Ley 26.589, reglamentada
> por el Decreto 1.467/2011.
>
> *Fuente: Ley 26.589, texto actualizado — argentina.gob.ar/normativa/nacional/ley-26589-166999. Consultado el 1/10/2026.*
>
> El objetivo declarado de la ley es promover la comunicación directa
> entre las partes para que puedan resolver el conflicto sin necesidad de
> un juicio. Antes de poder presentar una demanda, en la mayoría de los
> casos hay que acreditar que se intentó este proceso.
>
> ## Cuándo NO es obligatoria
> La ley exceptúa expresamente algunas materias — entre ellas, causas
> penales, y las acciones de separación personal, divorcio, nulidad de
> matrimonio, filiación, patria potestad y adopción (salvo las cuestiones
> patrimoniales derivadas de esos procesos, que sí quedan incluidas).
>
> *Pendiente de confirmación: la ley tiene una lista más larga de
> excepciones (art. 5°) que no reproducimos acá completa.*
>
> ## El plazo: 60 días hábiles
> El plazo de la mediación es de hasta 60 días hábiles judiciales,
> contados desde la última notificación fehaciente al requerido. Es
> prorrogable si las partes están de acuerdo.
>
> ## El aviso de audiencia: mínimo 3 días hábiles
> La audiencia tiene que notificarse con una anticipación no menor a 3
> días hábiles.
>
> ## El cierre y la prescripción
> Cuando la mediación termina, se labra un acta de cierre. La
> prescripción se reanuda 20 días después de que esa acta queda a
> disposición de las partes.
>
> **¿Y en las provincias?** Esto describe el régimen nacional. Las
> provincias tienen sus propias leyes — ver las guías de CABA y PBA.

---

### 3.3 `/recursos/que-es-sigim.html` — ⚠️ NORMATIVO/FACTUAL

**Title**: ¿Qué es el Portal de Mediación (SIGIM)? — Mediador
**Description**: Qué es el Portal de Mediación de la Nación (conocido como SIGIM), para qué sirve y en qué se diferencia de una herramienta de gestión como Mediador.

> # ¿Qué es el Portal de Mediación (SIGIM)?
>
> **[BORRADOR PENDIENTE DE REVISIÓN]**
>
> ## Qué es
> El Portal de Mediación (al que en la práctica profesional se suele
> llamar por el nombre de su sistema, SIGIM) es la plataforma oficial del
> Ministerio de Justicia de la Nación para gestionar la mediación
> prejudicial obligatoria en el ámbito nacional: sorteo y designación del
> mediador, carga de los datos de las partes, y seguimiento del trámite.
>
> *Fuente: argentina.gob.ar/justicia/mediacion, y mediacion.jus.gob.ar. Consultado el 1/10/2026.*
>
> El ingreso al portal se hace con reconocimiento facial biométrico, sin
> usuario y contraseña tradicionales.
>
> ## MEPRE
> Junto al Portal de Mediación conviven las siglas MEPRE (Sistema de
> Mediación Prejudicial), administrado por la Dirección Nacional de
> Mediación — el sistema que usan los mediadores matriculados para la
> parte del trámite que les corresponde.
>
> **[Recuadro rojo] Importante**: Mediador no es SIGIM, no es MEPRE, y no
> tramita ni reemplaza ningún paso ante esos sistemas. Es una herramienta
> de gestión aparte, en paralelo a los trámites oficiales.
>
> **¿Y la Provincia de Buenos Aires?** PBA tiene su propio sistema,
> MEDIARE — ver la guía de PBA.

---

### 3.4 `/recursos/honorarios-del-mediador.html` — ⚠️ NORMATIVO

**Title**: Cómo se calculan los honorarios del mediador — Mediador
**Description**: La escala oficial de honorarios de mediación prejudicial nacional: la unidad de medida, los tramos y la fuente normativa de cada número.

> # Cómo se calculan los honorarios del mediador
>
> **[BORRADOR PENDIENTE DE REVISIÓN]** Los montos en pesos cambian
> periódicamente — este artículo describe la estructura de cálculo, no un
> monto fijo.
>
> ## La base normativa
> En la mediación prejudicial nacional, los honorarios del mediador se
> calculan según el Decreto Nacional 1.467/2011 (reglamentario de la Ley
> 26.589), Anexo I art. 28 y Anexo III arts. 1 a 4. Este régimen también
> aplica a la mediación civil y comercial en CABA.
>
> *Fuente: Decreto 1.467/2011, texto publicado por la CSJN — csjn.gov.ar/archivos/notificaciones/dec14672011.pdf. Consultado el 1/10/2026.*
>
> ## La unidad: UHOM
> El honorario no se fija en un monto fijo de pesos, sino en una cantidad
> de unidades (UHOM) según el tramo que corresponda al caso.
>
> *Fuente del valor de la unidad: la última tabla verificada en este
> proyecto es la que reproduce la Unión de Mediadores Prejudiciales,
> publicada por el CPACF para el período enero-mayo 2026.*
>
> ## Los tramos
> La cantidad de unidades depende del tipo de mediación: hay un honorario
> base para la mediación general, un adicional por audiencia, y un tramo
> distinto para la mediación familiar.
>
> *Pendiente de detallar: no reproducimos acá la tabla completa de tramos
> y montos — preferimos no transcribirla mal. El decreto citado tiene el
> detalle completo.*
>
> **[Callout verde con botón] Si ya tenés el caso cargado en Mediador**:
> La Calculadora de Honorarios aplica esta misma escala automáticamente,
> con la fuente normativa citada en cada resultado. [Empezar gratis]

---

### 3.5 `/recursos/mediacion-caba.html` — ⚠️ NORMATIVO

**Title**: Mediación en CABA: qué ley aplica — Mediador
**Description**: Por qué la mediación civil y comercial en la Ciudad de Buenos Aires sigue el régimen de la Ley 26.589 nacional, y qué fuero la regula.

> # Mediación en CABA: qué ley aplica
>
> **[BORRADOR PENDIENTE DE REVISIÓN]**
>
> ## El régimen es el nacional
> A diferencia de otras provincias, la Ciudad de Buenos Aires no tiene su
> propia ley de mediación prejudicial para los fueros civil y comercial.
> Eso es porque la Justicia en lo Civil y Comercial que funciona en CABA
> sigue siendo Justicia Nacional — no se transfirió todavía a la órbita
> de la Ciudad. Por eso rige la misma Ley 26.589 y el Decreto 1.467/2011
> que en el resto del ámbito nacional.
>
> *Fuente: Decreto 1.467/2011, Anexo I art. 28 — csjn.gov.ar/archivos/notificaciones/dec14672011.pdf. Consultado el 1/10/2026.*
>
> En la práctica, el plazo de 60 días, el aviso de 3 días y el acta de
> cierre aplican igual en CABA para esos fueros.
>
> *Pendiente de confirmación: este artículo cubre específicamente los
> fueros civil y comercial. Para contravencional, de faltas, y
> contencioso administrativo y tributario (que sí tramitan en la Justicia
> propia de la Ciudad), no verificamos si existe un régimen de mediación
> distinto.*
>
> **¿Y la Provincia de Buenos Aires?** PBA sí tiene su propia ley — ver la
> guía de PBA.

---

### 3.6 `/recursos/mediacion-pba.html` — ⚠️ NORMATIVO

**Title**: Mediación en la Provincia de Buenos Aires: Ley 13.951 y MEDIARE — Mediador
**Description**: La Ley 13.951 de mediación prejudicial en la Provincia de Buenos Aires, el sistema MEDIARE y en qué se diferencia del régimen nacional.

> # Mediación en la Provincia de Buenos Aires
>
> **[BORRADOR PENDIENTE DE REVISIÓN]**
>
> ## Un régimen propio, distinto del nacional
> A diferencia de CABA, PBA tiene su propia ley de mediación: la Ley
> 13.951, modificada por la Ley 15.182, reglamentada por el Decreto
> 600/2021.
>
> *Fuente: argentina.gob.ar/normativa/provincial/ley-13951, y
> normas.gba.gob.ar. Consultado el 1/10/2026.*
>
> Es obligatoria para las causas del fuero Civil y Comercial, con
> excepciones (art. 4°) y modalidades optativas (art. 5°). La designación
> del mediador se hace por sorteo ante la Receptoría de Expedientes.
>
> ## El plazo
> La mediación dura hasta 60 días desde la última notificación al
> requerido. El mediador tiene 5 días desde la notificación para fijar la
> audiencia, que no puede exceder los 45 días.
>
> *Pendiente de confirmación: no verificamos si el plazo de 60 días se
> cuenta en días hábiles o corridos en el régimen provincial, ni el
> detalle completo de las excepciones de los arts. 4° y 5°.*
>
> ## El sistema: MEDIARE
> MEDIARE es el sistema informático oficial de uso obligatorio para la
> etapa de mediación en la Provincia. Los mediadores cargan ahí los datos
> de las causas y el trámite hasta el acta de cierre.
>
> *Fuente: mediaciones.mjus.gba.gob.ar, gba.gob.ar/justicia_y_ddhh/mediacion. Consultado el 1/10/2026.*
>
> **[Recuadro rojo] Importante**: Mediador no es MEDIARE ni ningún sistema
> oficial de la Provincia, y no tramita ni reemplaza la carga que exige
> MEDIARE.
>
> **¿Y en CABA?** No tiene ley propia — rige el régimen nacional.

---

## 4. Todas las fuentes citadas, en un solo lugar

| Fuente | URL | Usada en |
|---|---|---|
| Ley 26.589 (texto actualizado) | argentina.gob.ar/normativa/nacional/ley-26589-166999/actualizacion | mediación prejudicial, CABA |
| Decreto 1.467/2011 (CSJN) | csjn.gov.ar/archivos/notificaciones/dec14672011.pdf | mediación prejudicial, honorarios, CABA |
| Portal de Mediación / Ministerio de Justicia | argentina.gob.ar/justicia/mediacion, mediacion.jus.gob.ar | qué es SIGIM |
| Tabla de honorarios (UHOM), vía CPACF | cpacf.org.ar/.../HONORARIOS MEDIACION PREJUDICIAL ENERO A MAYO 2026.pdf | honorarios |
| Ley 13.951 (texto actualizado) | argentina.gob.ar/normativa/provincial/ley-13951, normas.gba.gob.ar | PBA |
| MEDIARE (sistema oficial PBA) | mediaciones.mjus.gba.gob.ar, gba.gob.ar/justicia_y_ddhh/mediacion | PBA |

---

## 5. Cómo activar una página cuando la apruebes

**Un solo lugar reúne los 3 pasos** (están comentados en el propio código,
en cada uno de estos 3 archivos, buscá "Tanda 3"):

1. **El archivo HTML de la página**: sacar la línea
   `<meta name="robots" content="noindex, nofollow">`.
2. **`server.js`**: sacar la entrada correspondiente del array
   `NOINDEX_STATIC_PATHS` (sección comentada "Tanda 3 — TEMPORAL").
3. **`public/robots.txt`**: sacar la línea `Disallow:` correspondiente de
   la sección comentada "Tanda 3 — TEMPORAL" (si se aprueban TODAS las de
   `/recursos/`, se puede sacar directamente la línea `Disallow: /recursos/`).
4. **`public/sitemap.xml`**: agregar la URL aprobada.

Se puede activar página por página (por ejemplo, aprobar primero
`/recursos.html` y `/recursos/mediacion-prejudicial.html`, dejar el resto
en borrador) — cada paso de arriba es por archivo, no todo o nada.
