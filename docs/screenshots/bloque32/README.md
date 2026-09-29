# Bloque 32 — cierre de brechas, capturas

Pasada visual de las pantallas nuevas/tocadas por este bloque, en 1440x900
(desktop) y 390x844 (mobile). Datos de una mediación de prueba
("Conflicto por medianera", MED-2026-0001) creada a mano con
`ENABLE_FAKE_LOGIN=1` contra una base descartable — nunca contra
producción.

- `dashboard_*` — "Comunicaciones recientes" mostrando el aviso
  automático que no se pudo enviar a Jorge García (item 1), reusando el
  mismo `falloNotificacion` del centro de atención (Bloque 22), sin
  código nuevo.
- `expediente-documentos_*` — el documento de Lucía Pérez marcado
  "Observado" con el comentario obligatorio, y el aviso correspondiente
  en "Comunicaciones" (item 2).
- `expediente-timeline_*` — los eventos nuevos: "Documento revisado" con
  el motivo, y los pares "Invitación al portal" / "Aviso de invitación"
  para ambas partes, cada uno con su motivo real (sin teléfono / falló el
  envío — nunca "enviado" fantasma).
- `preparacion-audiencia_*` — pantalla nueva (item 3): estado + motivo,
  quién confirmó, documentos sin revisar, compromisos vencidos/por
  vencer, todo en un solo lugar antes de la audiencia.
- `portal-documento-observado_*` — el lado de la parte: ve el estado
  "Observado — requiere corrección" con el motivo, y el mismo aviso en
  "Mensajes con tu mediador/a".

Capturas sacadas con un script propio vía Chrome DevTools Protocol
(mismo motivo que en Bloque 28/31: el Browser pane de Claude Code da
negro sólido si el panel no está visible en pantalla).
