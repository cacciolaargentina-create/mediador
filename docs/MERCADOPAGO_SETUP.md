# Billing + Mercado Pago (Bloque 29)

Mercado Pago es **solo el proveedor de cobro**. Mediador es dueño del
estado comercial real (`billing_accounts.status`) — nunca se activa un
plan porque el usuario volvió del checkout: solo el webhook (o la
reconciliación) confirma el estado real vía `syncSubscription()`.

## Qué modelo de Mercado Pago se usa

**Suscripciones con plan asociado** (`/preapproval_plan` + `/preapproval`),
documentación oficial: https://www.mercadopago.com.ar/developers/es/docs/subscriptions/integration-configuration/subscription-associated-plan

- Se crea UN plan de Mercado Pago por cada plan de Mediador (PROFESIONAL,
  ESTUDIO) — una sola vez, se reusa después (`billing_plans.providerPlanId`).
- Cada suscripción se crea **sin `card_token_id`** y **sin
  `status:"authorized"`** — Mercado Pago devuelve `status:"pending"` +
  `init_point`, y el pagador completa el medio de pago en la página
  **hosteada por Mercado Pago**. Mediador nunca ve ni toca datos de
  tarjeta.

## Variables de entorno

Ver `.env.example` — resumen:

| Variable | Para qué |
|---|---|
| `MERCADOPAGO_ACCESS_TOKEN` | Autenticar cada request a la API. Nunca el Public Key. |
| `MERCADOPAGO_WEBHOOK_SECRET` | Validar la firma `x-signature` de cada notificación. |
| `MERCADOPAGO_ENVIRONMENT` | `test` o `production` — nunca mezclar credenciales de una con la otra. |
| `MERCADOPAGO_RETURN_URL` | A dónde vuelve el pagador después de autorizar. |
| `BILLING_PRICE_PROFESIONAL` / `BILLING_PRICE_ESTUDIO` | Precios en ARS/mes — se siembran en `billing_plans` al arrancar, editables después solo tocando la fila (no hay UI de edición de precios en este bloque). |
| `BILLING_GRACE_PERIOD_DAYS` | Días entre un pago rechazado y la suspensión real (default 7). |

**El plan FREE funciona sin ninguna de estas variables configuradas.**

## Configurar el webhook

1. En el panel de Mercado Pago Developers → tu aplicación → Notificaciones
   → Webhooks, configurar la URL: `https://TU-DOMINIO/api/webhooks/mercadopago`.
2. Suscribirse a los tópicos `subscription_preapproval` y `payment` (los
   nombres exactos pueden variar según la versión del panel — verificar
   contra lo que el panel realmente ofrece).
3. Copiar el **secret** que el panel genera para esa URL a
   `MERCADOPAGO_WEBHOOK_SECRET`.

## Credenciales de prueba

1. Crear una aplicación de prueba en el panel de Mercado Pago Developers.
2. Usar las credenciales de **test** (Access Token que empieza con `TEST-`).
3. Crear cuentas de prueba (comprador y vendedor) desde el panel — nunca
   probar con una cuenta real.
4. Setear `MERCADOPAGO_ENVIRONMENT=test`.

## ⚠️ Riesgo externo conocido — verificar antes de depender de esto en producción

Al momento de escribir esto (2026-09-18) hay un **issue abierto en el SDK
oficial de Mercado Pago** (`mercadopago/sdk-nodejs#480`, reportado
2026-09-02): el `init_point` que devuelve `/preapproval` para una
suscripción sin plan/pago pendiente agrega `&activation=true` y rompe con
"Esta página no existe" en el sitio de Mercado Pago. Esto es un problema
**del lado de Mercado Pago**, no de este código — pero significa que el
flujo de checkout puede estar roto ahora mismo dependiendo de cuándo se
lea esto.

**Antes de depender de este flujo en producción: probar `POST
/api/billing/subscribe` con credenciales de test reales y confirmar que el
`init_point` devuelto abre correctamente la página de autorización.** Si
sigue roto, revisar el issue de GitHub por una solución o workaround
oficial antes de anunciar billing a usuarios reales.

## Salir a producción

1. Crear una aplicación de producción en el panel (o promover la de test).
2. Reemplazar `MERCADOPAGO_ACCESS_TOKEN`/`MERCADOPAGO_WEBHOOK_SECRET` por
   las credenciales de producción — nunca las de test.
3. `MERCADOPAGO_ENVIRONMENT=production`.
4. Volver a configurar el webhook apuntando al dominio de producción (el
   secret es distinto al de test).
5. Confirmar `MERCADOPAGO_RETURN_URL` apunta al dominio real.
6. Hacer una suscripción real de prueba con un monto bajo antes de anunciar
   el lanzamiento.

## Qué NO hace este bloque (a propósito)

Facturación AFIP/factura electrónica, Mercado Pago Point, marketplace,
comisión a mediadores, pagos entre partes/de acuerdos, escrow, pagos a
abogados — ver la spec completa del bloque para la lista.
