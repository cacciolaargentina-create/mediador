# Auditoría técnica — Portal de Mediación (SIGIM)

Paso obligatorio previo a programar Puente Connect (ver spec del bloque).
Auditoría manual real contra `https://mediacion.jus.gob.ar`, con el usuario
logueado (Basilio Martin Seward, DNI 31102903) el 2026-09-29. Cubre
**Capítulo 1 del manual oficial** (ingreso del ciudadano) — el Capítulo 2
(Portal Mediador / MEPRE) queda pendiente, ver "Qué falta" al final.

## 1. URLs

| Qué | URL |
|---|---|
| Portal (raíz) | `https://mediacion.jus.gob.ar` — **sin `www`**, el manual oficial tiene un typo (`www.mediacion.jus.gov.ar`, con `.gov` en vez de `.gob` y con `www`) |
| Login | `https://mediacion.jus.gob.ar/login` |
| Dashboard tras login | `https://mediacion.jus.gob.ar/inicio` |
| Solicitar mediación | `https://mediacion.jus.gob.ar/solicitar-mediacion?tipoDesignacionId={1-4}` (1=Sorteo, 2=Propuesta de parte, 3=Acuerdo de partes, 4=Derivación judicial — inferido por orden en el DOM, no confirmado con los 4) |
| Backend API | `mediacion-backend.jus.gob.ar` (visto en el header `Content-Security-Policy`, no inspeccionado directo) |
| Proveedor de biometría | `irminjus.miaid.me` (visto en el mismo header) |

## 2. Login — reconocimiento facial biométrico

**No tiene alternativa de usuario/contraseña.** Única opción: botón
"Iniciar Reconocimiento Facial" → flujo con cámara del dispositivo. Esto
es una restricción dura para Puente Connect: la extensión **nunca** puede
automatizar el login (coincide con la spec, §6 — "no almacenar
credenciales del portal"). El mediador siempre tiene que loguearse a mano
en su propio navegador antes de usar Puente Connect.

## 3. Arquitectura del frontend (hallazgo clave para los adapters)

- **Angular (Material) con Reactive Forms.** Confirmado por las clases
  `mat-mdc-*`, `ng-star-inserted`, y el atributo `formcontrolname` presente
  en todos los campos de formulario.
- El flujo "Solicitar Mediación" es un **mat-stepper de una sola página**
  (`/solicitar-mediacion?tipoDesignacionId=N`) — los 6 pasos del manual
  (Designación, Datos del Caso, Requirentes, Letrados, Requeridos,
  Confirmación) **no cambian de URL**, son estados internos del componente.
  Un adapter no puede detectar el paso actual por URL — tiene que leer el
  stepper (`.mat-step` activo) o el conjunto de campos visibles.
- **Selector recomendado: `[formcontrolname="X"]`, confianza HIGH.** Los
  nombres son estables y semánticos (`caracterActuacion`, `fueroId`,
  `cuitCuil`, `nombre`, `apellido`, `domicilio`, `email`, `genero`...).
- **Nunca usar `id` como selector — confianza LOW.** Los ids
  (`mat-select-8`, `mat-input-0`) son contadores globales de Angular:
  cambian según cuántos `mat-select`/`mat-input` se hayan renderizado antes
  en la página, no son estables entre cargas ni entre pasos del stepper.
- Los `<mat-select>` no son `<select>` nativos — abren un overlay
  (`.cdk-overlay-container`) con `<mat-option>`/`[role="option"]`. Un
  adapter tiene que simular click + esperar el overlay + click en la
  opción, no puede asignar `.value` directo como en un input de texto.
- Los inputs de texto normales (`cuitCuil`, `domicilio`, `email`) sí
  aceptan la estrategia estándar: setear `.value` vía el descriptor nativo
  del prototipo + disparar `input`/`change`/`blur` (Angular no detecta un
  cambio de `.value` sin esos eventos — coincide con la spec §10).

## 4. Paso 1 — Designación del Mediador

| Campo | `formcontrolname` | Tipo | Obligatorio | Confianza | Notas |
|---|---|---|---|---|---|
| Buscar y seleccionar mediador | `mediadorTemp` | mat-select (búsqueda) | Depende — con "Por Sorteo" seguramente no aplica; con "Por Propuesta de Parte" sí, aunque el atributo HTML decía `required=false` (la validación real es de Angular, no del HTML) | HIGH | Lista de mediadores reales del Registro Nacional — buscador por texto |
| ¿En qué carácter actuás? | `caracterActuacion` | mat-select | Sí | HIGH | Opciones: "Actúo en nombre propio" / "Actúo por autorización" |

## 5. Paso 2 — Datos del Caso

| Campo | `formcontrolname` | Tipo | Obligatorio | Confianza | Notas |
|---|---|---|---|---|---|
| Fuero | `fueroId` | mat-select | Sí | HIGH | Comercial / Civil / Civil y Comercial Federal (según manual) |
| Objeto | `objetoId` | mat-select (búsqueda) | Sí | HIGH | Lista larga (50+), depende del Fuero elegido — para Comercial incluye ORDINARIO, SUMARIO, MEDIDA PRECAUTORIA, y decenas de tipos de contrato |
| Detalle del objeto | `detalleObjeto` | textarea | No visto — apareció en el DOM pero no en pantalla en mi recorrido | MEDIUM | Verificar en qué condición aparece |
| Monto del reclamo | `tipoMonto` | mat-select | Sí | HIGH | Indeterminado/ble, Determinado, Cuidado personal/Régimen de comunicación |
| Información adicional | `infoAdicional` | textarea | No | HIGH | Libre, con ayuda contextual sobre daños/aseguradoras |

## 6. Paso 3 — Requirentes (modal "Agregar Requirente")

| Campo | `formcontrolname` | Tipo | Obligatorio | Confianza | Notas |
|---|---|---|---|---|---|
| Tipo de persona | `tipoPersona` | mat-select | Sí | HIGH | "Humana" / "Juridica" — condiciona qué campos siguientes aparecen |
| CUIL/CUIT | `cuitCuil` | input texto | Sí | HIGH | **Dispara una validación real contra RENAPER** — no se debe probar con datos inventados (ver "Qué NO se probó") |
| Género | `genero` | mat-select | Solo si Humana | HIGH | Aparece después de elegir "Humana" |
| Nombre | `nombre` | input texto | Solo si Humana | HIGH | Según el manual, se autocompleta con la respuesta de RENAPER tras cargar el CUIL — no confirmado en esta auditoría |
| Apellido | `apellido` | input texto | Solo si Humana | HIGH | Idem |
| Domicilio real | `domicilio` | input texto | Sí | HIGH | Manual explícito remarca que NO lo completa RENAPER, lo carga el usuario |
| Correo electrónico | `email` | input (type=email) | Sí | HIGH | Idem |

Pasos 4 (Letrados) y 5 (Requeridos) no se auditaron en el mismo detalle,
pero por el patrón visto y lo que describe el manual siguen la misma
estructura Angular Reactive Forms con `formcontrolname` estable — misma
estrategia de selectores aplica. Letrados agrega además matrícula/tomo/
folio/carácter de intervención (§4 de la spec original de Puente Connect).

## 7. Qué NO se probó (a propósito)

- **RENAPER (autocompletar nombre/apellido desde el CUIL).** El intento de
  escribir un CUIL de prueba en el campo `cuitCuil` fue bloqueado
  automáticamente por el propio entorno de Claude Code ("Real-World
  Transactions") — con razón: ese campo dispara una consulta real contra
  el RENAPER con el gobierno argentino, y no corresponde simularla con un
  CUIL inventado. **Esto lo tiene que probar el mediador con un caso real
  suyo**, y avisarme qué campos aparecen/se completan solos para terminar
  de documentar esta parte.
- No se llegó a "Confirmar y Pagar" ni se envió ninguna solicitud real —
  toda la auditoría se canceló antes de persistir nada.
- No se probaron los pasos 4 (Letrados) y 5 (Requeridos) en el mismo
  detalle que Requirentes, por ser estructuralmente análogos.
- No se probó ninguna de las otras 3 modalidades de designación (Sorteo,
  Acuerdo de partes, Derivación judicial) — la spec original de Puente
  Connect indica que probablemente compartan el mismo flujo de 6 pasos
  (así lo dice también el manual oficial).

## 8. Qué falta para completar la auditoría

1. **Portal Mediador / MEPRE (Capítulo 2 del manual)** — esta cuenta
   (Basilio, rol ciudadano) no mostró ninguna opción de "Portal Mediador"
   en el menú de usuario. Hace falta confirmar si esta cuenta tiene
   matrícula de mediador registrada, o loguearse con una cuenta que sí la
   tenga, para auditar: gestión de solicitud, notificaciones, carga de la
   mediación (las 6 pantallas del MEPRE), firma de audiencias/actas — que
   es justo la parte de re-carga repetitiva que Puente Connect quiere
   resolver.
2. **MEDIARE PBA** — todavía no auditado (URL, login, formularios).
3. Confirmar comportamiento real de RENAPER con un caso real (punto 7).
4. Confirmar los otros 3 `tipoDesignacionId` (1, 3, 4).

## 9. Próximo paso sugerido

Con esto ya se puede escribir un primer borrador de `SigimAdapter` para
el flujo de **solicitud** (Capítulo 1) con confianza razonable en los
selectores. Pero el corazón de Puente Connect — evitar la carga repetida
del mediador — vive en el **Portal Mediador/MEPRE** (Capítulo 2), que
todavía no se pudo auditar. Antes de escribir código, conviene resolver el
punto 8.1 (acceso a una cuenta con matrícula de mediador).
