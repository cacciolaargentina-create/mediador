# Billing + Mercado Pago (Bloque 29)

Mercado Pago es **solo el proveedor de cobro**. Mediador es dueño del
estado comercial real (`billing_accounts.status`) — nunca se activa un
plan porque el usuario volvió del checkout: solo el webhook (o la
reconciliación) confirma el estado real vía `syncSubscription()`.

## Qué modelo de Mercado Pago se usa

**Suscripción SIN plan asociado, con pago pendiente** (`/preapproval`,
sin `preapproval_plan_id`), documentación oficial:
https://www.mercadopago.com.ar/developers/es/docs/subscriptions/integration-configuration/subscription-no-associated-plan/pending-payments

- Cada suscripción manda su propio `auto_recurring` completo inline
  (`frequency`, `frequency_type`, `transaction_amount`, `currency_id`,
  `free_trial` si corresponde) — no existe ningún plan del lado de
  Mercado Pago, ni se crea ni se reusa. `billing_plans` sigue siendo
  **solo el catálogo interno** de Mediador (precios/entitlements),
  totalmente independiente de la API de Mercado Pago.
- La suscripción se crea **sin `card_token_id`** y **con
  `status:"pending"`** — Mercado Pago devuelve `init_point`, y el pagador
  completa el medio de pago en la página **hosteada por Mercado Pago**.
  Mediador nunca ve ni toca datos de tarjeta.

### Por qué no "con plan asociado" (corrección del diseño original)

La primera versión de este bloque creaba un plan por API
(`/preapproval_plan`) y una suscripción que lo referenciaba
(`preapproval_plan_id`) sin `card_token_id` y con `status:"pending"` —
ese es el modelo **"CON plan asociado"**, y la documentación oficial de
esa modalidad específica es explícita:

> "Una Suscripción con plan asociado siempre deberá ser creada con su
> `card_token_id` y en status `Authorized`."

Eso implica tokenizar la tarjeta del lado del cliente (con Checkout
Bricks/MP.js) — exactamente lo opuesto al checkout 100% hosteado que
busca este bloque (nunca tocar datos de tarjeta, §24). La combinación que
se estaba usando (`preapproval_plan_id` + `status:"pending"` sin
`card_token_id`) no es ninguno de los dos flujos que Mercado Pago
documenta — es la explicación más probable del bug externo que estaba
anotado más abajo en esta misma página (ver el historial del archivo si
hace falta el detalle completo), y que con el modelo actual deja de
aplicar por completo: al no mandar nunca `preapproval_plan_id`, esa
combinación de parámetros simplemente no se da.

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

## Verificar antes de depender de esto en producción

El bug externo que estaba documentado acá (`mercadopago/sdk-nodejs#480`,
`init_point` con `&activation=true` roto) era específico del modelo "con
plan asociado" que ya no se usa — con `/preapproval` sin
`preapproval_plan_id` esa combinación de parámetros no se da. Aun así,
**nunca asumir que un flujo de pago externo funciona sin probarlo**:
antes de anunciar billing a usuarios reales, probar `POST
/api/billing/subscribe` con credenciales de **test** reales y confirmar
que el `init_point` devuelto abre correctamente la página de autorización
de Mercado Pago, que el pago de prueba completa, y que el webhook (o la
reconciliación horaria) efectivamente pasa la cuenta a `active`.

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
