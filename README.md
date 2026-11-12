# Ratbani · Panel de acceso

Servidor propio del panel de acceso de Ratbani, gratis en Render.
Sirve a la APK Ratbani (pantalla de acceso) y al panel web del administrador.

## Qué hace

- `POST /api/guest` — genera un perfil temporal distinto en cada petición. Devuelve `id`, `name` y `type`; no crea una cuenta, concede acceso ni modifica las aprobaciones.
- `GET /api/design` — diseño del panel que usa la app (marca, colores, textos).
- `POST /api/device/challenge` — reto de firma ECDSA P-256 del dispositivo.
- `POST /api/device/claim` — el dispositivo reclama su activación con la firma.
- `GET /api/device/status` — estado: pending / approved / active / revoked.
- `POST /api/registration/manual` — registro: nombre, correo y teléfono.
- Panel web en `/`: registro, consulta de estado y administración.
- `GET /api/admin/registrations` — lista de solicitudes (con la clave de admin).
- `PATCH /api/admin/registrations/:id` — `{action: "approve"|"reject"|"revoke"}`.

## Despliegue en Render (gratis)

1. Crea un repositorio en GitHub llamado `ratbani-panel` (privado, sin README).
2. Sube estos archivos a la rama `main`.
3. En Render: New → Web Service → elige `ratbani-panel`.
4. Name: `ratbani-panel`, Language: Node, Branch: `main`.
5. Build Command: `npm install`, Start Command: `npm start`, plan **Free**.
6. En Environment Variables, cambia `ADMIN_KEY` por una clave tuya.
7. Create Web Service, espera a **Live**. La URL será como
   `https://ratbani-panel-xxxx.onrender.com`.

## Planes de pago (único / mensual)

Cada solicitud tiene un plan. El registro nuevo entra como **mensual** (30 días).
El admin lo cambia en el panel con los botones **Mensual (30 días)** o
**Único (sin vencimiento)**, o con `PATCH /api/admin/registrations/:id`
`{action:"set-plan", plan:"mensual"|"unico"}`. Marcar el plan significa que
la persona pagó: se activa con su vigencia desde ese momento (`paidAt`).

- **Mensual**: la cuenta atrás corre 30 días (se ve en el panel como
  `29d 23h 58m` y va bajando cada segundo). Al llegar a cero el servidor
  devuelve `allowed:false` / `status:"expired"` y la APK ya no abre.
  Si paga otra vez, el admin vuelve a poner **Mensual** y los 30 días
  empiezan de nuevo.
- **Único**: pago único, sin vencimiento (se ve como `Sin vencimiento`).

## Admin

Abre la URL, baja a Administrador, pon tu `ADMIN_KEY` y toca
"Ver solicitudes". Ahí apruebas, rechazas o desvinculas.

## Notas

- Los datos se guardan en `data/store.json`. En el plan gratis de Render
  el disco es efímero: si el servicio se reinicia, las solicitudes se
  pierden. Para que sobrevivan gratis: crea una base Redis en Upstash
  (plan gratis), copia su `UPSTASH_REDIS_REST_URL` y
  `UPSTASH_REDIS_REST_TOKEN` en las Environment Variables de Render y
  redespliega. Con eso, al arrancar el servidor restaura las solicitudes
  y la llave de firma desde Upstash y respalda cada cambio ahí.
- El registro web no manda SMS en el plan gratis: el código de
  verificación se ve en el panel de admin.
- La APK Ratbani apunta hoy a otro origen (`ratbani-panel-nuevo-...`).
  Para que use este servidor hay que cambiar `acceso.API_ORIGIN` en su
  manifiesto, un paso aparte.
- Para generar un perfil cada vez que se abra la app, el cliente debe llamar
  `POST /api/guest` en su inicio y mantener la respuesta solo durante esa
  apertura. El APK existente no hace esta llamada automáticamente; requiere
  cambiar su código y probarlo. El perfil no sustituye la autorización web.
