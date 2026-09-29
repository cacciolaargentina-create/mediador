# Bloque 31 — Diferencial competitivo (Fase 1), capturas

Pasada visual de las pantallas nuevas/tocadas por este bloque, en 1440x900
(desktop) y 390x844 (mobile). Datos de una mediación de prueba
("Conflicto por medianera", MED-2026-0001) creada a mano con
`ENABLE_FAKE_LOGIN=1` contra una base descartable — nunca contra
producción.

- `dashboard_*` — Centro de control (Bloque 22, ya existente) con el
  campo **Responsable** nuevo en cada ítem de "¿Qué requiere tu atención?".
- `compromisos_*` — Pantalla nueva "Compromisos", cross-expediente, con
  filtros (estado/responsable) y la etiqueta de urgencia nueva ("vencido
  — fecha" / "faltan N días").
- `expediente-compromisos_*` — Dentro del expediente: la sección
  Compromisos con observaciones, y el Timeline con el selector de
  categoría nuevo ("Todos los tipos" agrupados).
- `portal-partes_*` — Portal de la parte: bloque "Tu mediador/a" y
  "Tareas para vos" (con "Marcar realizada"), ambos nuevos.

Nota técnica: el Browser pane de Claude Code devolvía capturas en negro
sólido mientras el panel no estaba visible en pantalla (limitación ya
conocida, ver Bloque 28) — estas capturas se sacaron con un script propio
vía Chrome DevTools Protocol (Chrome headless local, nunca expuesto a
internet), por eso están en resolución real y no el tamaño reducido que
devuelve ese tool.
