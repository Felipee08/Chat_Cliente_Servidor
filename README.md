# Chat cliente-servidor — Proyecto 3, Protocolos de comunicación

Aplicación web donde varios clientes (navegadores), desde redes distintas, intercambian
mensajes y archivos a través de un servidor desplegado en Vercel.

Integrantes: Daniel Santiago Gómez Vargas (831892), Oward Smith Quintero Téllez (826071),
Diego Felipe Buitrago Rizo (829123).

## Protocolos que intervienen

| Capa | Protocolo | Para qué se usa en el proyecto |
|---|---|---|
| Aplicación | DNS | Traduce `nombre-del-proyecto.vercel.app` a la dirección IP del servidor |
| Aplicación | HTTP/HTTPS | Descarga de la página (HTML, CSS, JS) y consultas `GET /api/server?op=estado`, `op=historial`, `op=salas` |
| Aplicación | WebSocket (`wss://`) | Canal bidireccional permanente para mensajes y archivos; nace de una petición HTTP con cabecera `Upgrade` |
| Aplicación | Protocolo propio del chat (JSON) | Tramas `entrar`, `mensaje`, `cambiar_sala`, `archivo_inicio/parte/fin`, `archivo_ack`, `ping/pong` |
| Seguridad | TLS | Cifra HTTP (HTTPS) y WebSocket (WSS); el certificado lo entrega Vercel |
| Transporte | TCP | Conexión confiable y ordenada sobre la que viajan TLS, HTTP y WebSocket (puerto 443) |
| Red | IP | Direccionamiento y enrutamiento entre las redes de cada integrante y el servidor |

## Estructura

```
api/server.js      Servidor: Express (HTTP) + ws (WebSocket). En Vercel es la función /api/server
lib/almacen.js     Estado compartido: Redis (publicación/suscripción) o memoria
public/            Cliente: index.html, estilos.css, app.js
pruebas/prueba.js  Pruebas automáticas de funcionamiento
local.js           Arranque en el computador propio
vercel.json        Duración máxima de la función (300 s)
```

## Ejecutar en el computador

Requiere Node.js 20 o superior.

```
npm install
npm start          # abre http://localhost:3000 en dos o tres pestañas
npm test           # en otra terminal: 16 comprobaciones automáticas
```

## Desplegar en Vercel

1. Subir esta carpeta a un repositorio de GitHub (sin `node_modules`).
2. En vercel.com: **Add New → Project**, importar el repositorio. Framework Preset: **Other**.
   Dejar vacíos Build Command y Output Directory. **Deploy**.
3. En el proyecto: **Storage → Create Database → Redis (Upstash)**, plan gratuito, y conectarla
   al proyecto. Esto crea la variable de entorno `REDIS_URL` (si queda con otro nombre, crear
   `REDIS_URL` a mano en **Settings → Environment Variables** con la dirección `rediss://...`).
4. **Deployments → Redeploy** para que la función tome la variable.
5. Abrir `https://<proyecto>.vercel.app/api/server?op=estado`: debe decir `"almacen":"redis"`.
6. Cada integrante abre `https://<proyecto>.vercel.app` desde su casa y entra con su nombre.

Probar el despliegue desde la terminal:

```
# Linux / macOS
URL_A=https://<proyecto>.vercel.app npm test
# Windows PowerShell
$env:URL_A="https://<proyecto>.vercel.app"; npm test
```

### Por qué hace falta Redis

En Vercel cada conexión WebSocket queda atendida por una instancia de la función, y dos
usuarios pueden quedar en instancias diferentes. Si el estado estuviera solo en memoria,
un mensaje no llegaría a quien está en otra instancia. Con Redis, cada instancia publica
los mensajes en un canal y todas las instancias los entregan a sus propios clientes.

### Reconexión

Vercel cierra las conexiones al cumplir la duración máxima de la función (300 s en el plan
gratuito). El cliente se reconecta solo, vuelve a pedir el historial y el servidor no anuncia
"salió del chat" si el usuario regresa en menos de 6 segundos.

## Límites

- Archivos de máximo 5 MB, enviados en partes de 32 KB con confirmación de cada parte
  (parada y espera). Los archivos no se guardan en el servidor: solo los reciben quienes
  están en la sala en ese momento.
- Historial: últimos 50 mensajes por sala.
- No hay contraseñas: cada quien entra con el nombre que escriba.
