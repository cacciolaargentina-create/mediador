# Capturas — Bloque 28 (videoconferencias)

Pasada visual responsive (390×844 y 1440×900, spec §27) contra datos de
prueba reales (fake-login, sin credenciales de Google/Zoom/Teams reales).
Generadas con Chrome headless vía CDP — ver el hallazgo y el fix
correspondiente en el commit `d0ad4a6` y en
[docs/VIDEO_CONFERENCING.md](../../VIDEO_CONFERENCING.md).

| Archivo | Qué muestra |
|---|---|
| `audiencia_390x844.png` / `audiencia_1440x900.png` | Detalle de audiencia, sección "Audiencias" con varias tarjetas de videoconferencia (enlace manual creado, sin configurar) |
| `tarjeta-videoconferencia_390x844.png` / `_1440x900.png` | Zoom sobre la primera tarjeta "Videoconferencia" de esa misma sección |
| `agenda_390x844.png` / `_1440x900.png` | Vista de Agenda (semana), con audiencias virtuales/híbridas/presenciales mezcladas |
| `config-videoconferencias_390x844.png` / `_1440x900.png` | Configuración → Videoconferencias (estado de Google Meet/Zoom/Teams) |
| `party-portal_390x844.png` / `_1440x900.png` | Portal de partes — audiencias con el nombre del proveedor, nunca hostUrl/tokens |
| `lawyer-portal_390x844.png` / `_1440x900.png` | Portal de abogados — mismo criterio que el portal de partes |
| `propose-form-provider.png` | Formulario "Proponer varios horarios" con un proveedor real elegido (Google Meet) |
| `propose-form-manual.png` | Mismo formulario con "Cargar enlace manualmente" |

**Nota sobre los nombres con `�`** (ej. "Laura G�mez"): es un artefacto de
codificación de los datos de prueba cargados por `curl` en Git Bash sobre
Windows (acentos mal codificados al armar el JSON de prueba), no un bug
de la aplicación — el frontend renderiza tal cual lo que la base
devuelve.

**Re-verificado el 2026-09-28** (pedido explícito: cargar una parte real
con acentos/ñ y confirmar expediente + portal + PDF exportado), con un
escenario nuevo armado por `fetch` desde el propio navegador (nunca
`curl`), sin tocar nada de la app:
- Expediente (`GET /api/mediations/:id/parties`): `firstName`/`lastName`
  vuelven exactos — "José", "Muñoz" — y lo mismo se confirmó para
  "Laura Gómez", "Marcos Díaz" y "Dra. Fernández" en las pantallas de
  Partes, Abogados, Audiencias, Comunicaciones y Timeline del expediente
  completo (texto de la página, sin un solo `�`).
- Portal de partes (`GET /api/party-portal/:token`): `partyName` vuelve
  "José Muñoz" correcto.
- PDF exportado (`GET /api/mediations/:id/export`): se infló el content
  stream (FlateDecode) y se reconstruyó el texto de los glyphs — contiene
  "José" y "Muñoz" bien codificados (pdfkit usa WinAnsiEncoding en las
  fuentes estándar, que cubre acentos y ñ).

Conclusión confirmada de nuevo: **no hay bug de codificación en la
aplicación**, en ningún punto del recorrido (API, portal, PDF).

**Sobre las imágenes de este directorio**: no se regeneraron. El
entorno usado en esta verificación no tiene una forma de guardar a disco
una captura tomada desde el navegador embebido (a diferencia del proceso
"Chrome headless vía CDP" que sí tenía la sesión que generó estas
capturas originalmente) — son puramente cosméticas, de documentación
interna, y no afectan nada de lo que ve un usuario real. Si se quiere
prolijidad visual acá, hace falta rehacer la pasada de capturas con una
herramienta que sí pueda escribir el PNG a disco (por ejemplo, Chrome
DevTools/Puppeteer corrido localmente).
