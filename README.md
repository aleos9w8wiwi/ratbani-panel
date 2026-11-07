# Ratbani · Panel de acceso

Servidor propio del panel de acceso de Ratbani, gratis en Render.
Sirve a la APK Ratbani (pantalla de acceso) y al panel web del administrador.

## Qué hace

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

## Admin

Abre la URL, baja a Administrador, pon tu `ADMIN_KEY` y toca
"Ver solicitudes". Ahí apruebas, rechazas o desvinculas.

## Notas

- Los datos se guardan en `data/store.json`. En el plan gratis de Render
  el disco es efímero: si el servicio se reinicia, las solicitudes se
  pierden. Para uso serio, pon una base de datos.
- El registro web no manda SMS en el plan gratis: el código de
  verificación se ve en el panel de admin.
- La APK Ratbani apunta hoy a otro origen (`ratbani-panel-nuevo-...`).
  Para que use este servidor hay que cambiar `acceso.API_ORIGIN` en su
  manifiesto, un paso aparte.
