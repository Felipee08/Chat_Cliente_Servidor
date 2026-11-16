// Servidor del chat: un mismo servidor HTTP atiende
//   - peticiones HTTP (estado del servidor, historial, salas)
//   - conexiones WebSocket (mensajes y archivos en tiempo real)
//
// En Vercel este archivo se despliega como una Vercel Function en /api/server.
// En local lo arranca local.js con "npm start".

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { crearAlmacen } from '../lib/almacen.js';

const SALAS = ['General', 'Redes', 'Proyecto'];
const MAX_TEXTO = 1000;
const MAX_ARCHIVO = 5 * 1024 * 1024; // 5 MB
const MAX_TRAMA = 256 * 1024; // tamano maximo de una trama WebSocket
const ESPERA_SALIDA_MS = 6000; // margen para reconectar sin anunciar "salio"

const INSTANCIA = randomUUID().slice(0, 8);
const INICIO = Date.now();
const almacen = crearAlmacen();

// ---------------------------------------------------------------- HTTP ----

const app = express();
const dirPublico = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
app.use(express.static(dirPublico));

app.get('*', async (req, res) => {
  // La operacion llega como /api/server?op=estado (o como ultimo tramo de la ruta).
  const op = req.query.op || req.path.split('/').filter(Boolean).pop();
  res.set('Cache-Control', 'no-store');
  try {
    if (op === 'estado') {
      const usuarios = await almacen.presencia();
      return res.json({
        servicio: 'chat-redes',
        instancia: INSTANCIA,
        activoSegundos: Math.round((Date.now() - INICIO) / 1000),
        almacen: almacen.tipo,
        conexionesEnEstaInstancia: clientes.size,
        usuariosConectados: usuarios.length,
        porSala: Object.fromEntries(
          SALAS.map((s) => [s, usuarios.filter((u) => u.sala === s).map((u) => u.nombre)]),
        ),
        hora: new Date().toISOString(),
      });
    }
    if (op === 'salas') return res.json({ salas: SALAS });
    if (op === 'historial') {
      const sala = SALAS.includes(req.query.sala) ? req.query.sala : SALAS[0];
      return res.json({ sala, mensajes: await almacen.historial(sala) });
    }
    return res.status(404).json({ error: 'Operacion no encontrada', operaciones: ['estado', 'salas', 'historial'] });
  } catch (e) {
    console.error('[http]', e);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

const server = createServer(app);

// ----------------------------------------------------------- WebSocket ----

const wss = new WebSocketServer({ server, maxPayload: MAX_TRAMA });
const clientes = new Map(); // ws -> { clienteId, conexionId, nombre, sala, envios }

function enviar(ws, datos) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(datos));
}

// Cada instancia entrega a SUS conexiones lo que se publica en el almacen.
almacen.suscribir((evento) => {
  const texto = JSON.stringify(evento.datos);
  for (const [ws, c] of clientes) {
    if (!c.nombre || c.conexionId === evento.excepto) continue;
    if (evento.sala !== '*' && c.sala !== evento.sala) continue;
    if (ws.readyState === ws.OPEN) ws.send(texto);
  }
});

function difundir(sala, datos, excepto) {
  return almacen.publicar({ sala, datos, excepto });
}

function avisoSistema(sala, texto) {
  return difundir(sala, { tipo: 'sistema', sala, texto, hora: Date.now() });
}

async function difundirUsuarios() {
  const usuarios = (await almacen.presencia()).map((p) => ({ nombre: p.nombre, sala: p.sala }));
  await difundir('*', { tipo: 'usuarios', usuarios });
}

function limpiarTexto(valor, max) {
  return String(valor ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

const manejadores = {
  async entrar(ws, c, m) {
    const nombre = limpiarTexto(m.nombre, 20);
    if (!nombre) return enviar(ws, { tipo: 'error', texto: 'Escribe un nombre para entrar.' });
    c.nombre = nombre;
    c.sala = SALAS.includes(m.sala) ? m.sala : SALAS[0];
    c.clienteId = limpiarTexto(m.clienteId, 40) || c.conexionId;
    await registrarPresencia(c);
    enviar(ws, {
      tipo: 'bienvenida',
      nombre: c.nombre,
      sala: c.sala,
      salas: SALAS,
      instancia: INSTANCIA,
      almacen: almacen.tipo,
      maxArchivo: MAX_ARCHIVO,
    });
    enviar(ws, { tipo: 'historial', sala: c.sala, mensajes: await almacen.historial(c.sala) });
    if (!m.reconexion) await avisoSistema(c.sala, `${c.nombre} entró a la sala`);
    await difundirUsuarios();
  },

  async mensaje(ws, c, m) {
    const texto = limpiarTexto(m.texto, MAX_TEXTO);
    if (!texto) return;
    const mensaje = { tipo: 'mensaje', id: randomUUID(), de: c.nombre, sala: c.sala, texto, hora: Date.now() };
    await almacen.guardarMensaje(c.sala, mensaje);
    await difundir(c.sala, mensaje);
  },

  async cambiar_sala(ws, c, m) {
    if (!SALAS.includes(m.sala) || m.sala === c.sala) return;
    const anterior = c.sala;
    c.sala = m.sala;
    await registrarPresencia(c);
    await avisoSistema(anterior, `${c.nombre} salió de la sala`);
    enviar(ws, { tipo: 'sala', sala: c.sala });
    enviar(ws, { tipo: 'historial', sala: c.sala, mensajes: await almacen.historial(c.sala) });
    await avisoSistema(c.sala, `${c.nombre} entró a la sala`);
    await difundirUsuarios();
  },

  async escribiendo(ws, c) {
    await difundir(c.sala, { tipo: 'escribiendo', de: c.nombre }, c.conexionId);
  },

  // Transferencia de archivos: inicio -> N partes (cada una con acuse) -> fin.
  async archivo_inicio(ws, c, m) {
    const id = limpiarTexto(m.id, 40);
    const tamano = Number(m.tamano);
    const partes = Number(m.partes);
    if (!id || !Number.isInteger(tamano) || !Number.isInteger(partes) || tamano <= 0 || partes <= 0) {
      return enviar(ws, { tipo: 'error', texto: 'Solicitud de archivo no válida.' });
    }
    if (tamano > MAX_ARCHIVO) {
      return enviar(ws, { tipo: 'error', id, texto: 'El archivo supera el máximo de 5 MB.' });
    }
    const info = {
      id,
      nombre: limpiarTexto(m.nombre, 120) || 'archivo',
      mime: limpiarTexto(m.mime, 80) || 'application/octet-stream',
      tamano,
      partes,
      siguiente: 0,
    };
    c.envios.set(id, info);
    await difundir(c.sala, { tipo: 'archivo_inicio', de: c.nombre, ...info, siguiente: undefined }, c.conexionId);
    enviar(ws, { tipo: 'archivo_ack', id, n: -1 });
  },

  async archivo_parte(ws, c, m) {
    const info = c.envios.get(m.id);
    if (!info || m.n !== info.siguiente || typeof m.datos !== 'string') {
      return enviar(ws, { tipo: 'error', id: m.id, texto: 'Parte de archivo fuera de orden.' });
    }
    info.siguiente += 1;
    await difundir(c.sala, { tipo: 'archivo_parte', id: info.id, n: m.n, datos: m.datos }, c.conexionId);
    enviar(ws, { tipo: 'archivo_ack', id: info.id, n: m.n });
  },

  async archivo_fin(ws, c, m) {
    const info = c.envios.get(m.id);
    if (!info) return;
    c.envios.delete(m.id);
    if (info.siguiente !== info.partes) {
      return enviar(ws, { tipo: 'error', id: info.id, texto: 'El archivo llegó incompleto.' });
    }
    await difundir(c.sala, { tipo: 'archivo_fin', id: info.id }, c.conexionId);
    const registro = {
      tipo: 'sistema',
      sala: c.sala,
      texto: `${c.nombre} envió el archivo ${info.nombre} (${Math.ceil(info.tamano / 1024)} KB)`,
      hora: Date.now(),
    };
    await almacen.guardarMensaje(c.sala, registro);
    enviar(ws, { tipo: 'archivo_ack', id: info.id, n: info.partes, fin: true });
  },

  async ping(ws, c, m) {
    if (c.nombre) await registrarPresencia(c);
    enviar(ws, { tipo: 'pong', t: m.t });
  },
};

function registrarPresencia(c) {
  return almacen.ponerPresencia(c.clienteId, {
    clienteId: c.clienteId,
    conexionId: c.conexionId,
    nombre: c.nombre,
    sala: c.sala,
  });
}

wss.on('connection', (ws) => {
  const c = { conexionId: randomUUID(), clienteId: null, nombre: null, sala: null, envios: new Map() };
  clientes.set(ws, c);

  // Las tramas de un mismo cliente se procesan en orden, una tras otra.
  let cola = Promise.resolve();
  ws.on('message', (bruto) => {
    cola = cola.then(async () => {
      let m;
      try {
        m = JSON.parse(bruto.toString());
      } catch {
        return enviar(ws, { tipo: 'error', texto: 'Trama no válida: se esperaba JSON.' });
      }
      const manejador = Object.hasOwn(manejadores, m?.tipo) ? manejadores[m.tipo] : null;
      if (!manejador) return enviar(ws, { tipo: 'error', texto: 'Tipo de trama desconocido.' });
      if (!c.nombre && m.tipo !== 'entrar' && m.tipo !== 'ping') {
        return enviar(ws, { tipo: 'error', texto: 'Primero debes entrar con un nombre.' });
      }
      try {
        await manejador(ws, c, m);
      } catch (e) {
        console.error('[ws]', e);
        enviar(ws, { tipo: 'error', texto: 'Error interno del servidor.' });
      }
    });
  });

  ws.on('close', () => {
    clientes.delete(ws);
    if (!c.nombre) return;
    // Vercel cierra la conexion al cumplir la duracion maxima de la funcion y
    // el cliente se reconecta solo: se espera un momento antes de anunciar la salida.
    setTimeout(async () => {
      try {
        const actual = await almacen.leerPresencia(c.clienteId);
        if (!actual || actual.conexionId !== c.conexionId) return; // ya se reconecto
        await almacen.quitarPresencia(c.clienteId);
        await avisoSistema(c.sala, `${c.nombre} salió del chat`);
        await difundirUsuarios();
      } catch (e) {
        console.error('[ws-cierre]', e);
      }
    }, ESPERA_SALIDA_MS);
  });

  ws.on('error', (e) => console.error('[ws]', e.message));
});

export default server;
