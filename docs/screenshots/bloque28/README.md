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
devuelve. Verificado por separado que texto con acentos ingresado desde
la propia UI (`fetch` del navegador) se guarda y muestra correctamente.
