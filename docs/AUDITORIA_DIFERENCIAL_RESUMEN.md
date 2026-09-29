# Auditoría de diferencial competitivo — Resumen

Versión corta, sin tablas, para leer en el celular. El informe completo con la auditoría punto por punto (Paso 1) y el detalle de cada oportunidad (Paso 2-4) está en `docs/AUDITORIA_DIFERENCIAL.md`.

**Fecha**: 2026-09-29. Auditoría de solo lectura, verificada contra el código real (no contra `IMPLEMENTATION_PLAN.md` ni comentarios). Contexto: app en `puentedigital.app`, Mercado Pago implementado pero no conectado todavía. Planes: FREE (3 mediaciones, sin videollamadas de proveedor real), PROFESIONAL 15.000 ARS/mes, ESTUDIO 35.000 ARS/mes.

---

## A. Qué ya tenemos (sólido, verificado)

- Centro de atención cross-expediente con severidad y responsable.
- Timeline automático con filtro por categoría.
- Compromisos y tareas con vencimiento detectado en vivo, vista global, observaciones y evidencia.
- Portal de partes completo: audiencias, documentos, mensajes, compromisos, tareas, info del mediador.
- Videoconferencia real con Google Meet y Zoom (no simulada — pega de verdad a las APIs).
- Exportación certificada en PDF con firma electrónica y página pública de verificación.
- Asistente de IA real (Claude), con degradación honesta si falta la API key.
- Aislamiento de datos verificado entre mediadores, estudios, partes y abogados.
- Multiusuario por estudio, con facturación propia del estudio.
- Jobs de recordatorio realmente programados y corriendo solos.

## B. Qué está incompleto

- Portal de Abogados no tiene paridad con el de Partes: no completa tareas, no responde en el hilo con su cliente.
- La firma electrónica del PDF se omite en silencio si no están configuradas las claves — nadie se entera.
- Revisar un documento es solo cambiar un estado (dropdown) — no hay forma de anotar por qué se observó algo.
- La cuota de uso de IA no cubre el producto de Mediador (B2B) — solo cubre el otro producto (coparentalidad).
- Dos cosas que el plan pago promete (agenda avanzada, límite de miembros de estudio) están definidas en el código pero **ningún endpoint las aplica** — hoy no diferencian nada de verdad.
- La impersonación de admin ("ver como usuario") y los feature flags existen como pantalla, pero no tienen ningún mecanismo real que haga cumplir lo que prometen.

## C. Las 10 oportunidades (resumen — detalle completo con impacto/esfuerzo en el informe grande)

1. Aviso automático al invitar a una parte/abogado (hoy no existe ninguno).
2. Corregir la integridad del paywall (cuota de IA + límites de plan sin aplicar).
3. Revisión de documentos con comentario real, no solo un estado.
4. Pantalla de preparación de audiencia (el cálculo ya existe, falta la pantalla).
5. Borrador de acta asistido por IA al cerrar una audiencia.
6. Sugerir horarios libres al agendar (hoy solo rechaza conflictos).
7. Cerrar la paridad del Portal de Abogados.
8. Dar visibilidad a la página de verificación pública como argumento de venta.
9. Impersonación y feature flags con enforcement real (deuda técnica, no venta).
10. WhatsApp de ida y vuelta para Mediador (hoy solo manda avisos salientes).

## D. Las 3 que deberían desarrollarse primero

1. **Aviso automático al invitar** — cierra el agujero de trazabilidad más visible, esfuerzo bajo (reusa infraestructura de WhatsApp que ya existe).
2. **Revisión de documentos con sustancia** — toca todas las mediaciones todo el tiempo, mismo patrón que ya se usó hoy para compromisos.
3. **Pantalla de preparación de audiencia** — el cálculo más difícil ya está hecho hace bloques, falta solo la pantalla. Mejor relación esfuerzo/impacto de toda la lista.

## E. Qué NO desarrollar por ahora

- WhatsApp de ida y vuelta apurado, sin resolver antes costo por conversación y aprobación de Meta.
- Integración con SIGIM (sigue sin existir una vía oficial).
- Marketplace, directorio público de mediadores, matching — fuera de alcance, ya decidido.
- Video conferencing propio — no tiene sentido, Google Meet y Zoom ya funcionan de verdad.
- Más funciones de admin console antes de que las que existen (impersonación, feature flags) tengan enforcement real.
- **Cobrar por diferenciadores de plan que hoy no existen en el código** (agenda avanzada, límite de miembros) — es el riesgo más inmediato de toda la lista.
