// Almacen de estado compartido del chat.
//
// En Vercel cada conexion WebSocket queda fija en UNA instancia de la funcion,
// pero dos clientes pueden caer en instancias distintas. Por eso el estado
// (historial, presencia) y la difusion de mensajes no pueden vivir solo en
// variables de memoria: se usa Redis (publicacion/suscripcion) cuando existe
// la variable de entorno REDIS_URL. Sin ella se usa memoria, que sirve para
// ejecutar el proyecto en un solo computador.

import Redis from 'ioredis';

const MAX_HISTORIAL = 50;
const VIDA_PRESENCIA_MS = 90_000;

function almacenMemoria() {
  const historiales = new Map();
  const presencias = new Map();
  const suscriptores = new Set();

  return {
    tipo: 'memoria',
    async guardarMensaje(sala, mensaje) {
      const lista = historiales.get(sala) ?? [];
      lista.push(mensaje);
      if (lista.length > MAX_HISTORIAL) lista.shift();
      historiales.set(sala, lista);
    },
    async historial(sala) {
      return historiales.get(sala) ?? [];
    },
    async ponerPresencia(clienteId, datos) {
      presencias.set(clienteId, { ...datos, ts: Date.now() });
    },
    async leerPresencia(clienteId) {
      return presencias.get(clienteId) ?? null;
    },
    async quitarPresencia(clienteId) {
      presencias.delete(clienteId);
    },
    async presencia() {
      const limite = Date.now() - VIDA_PRESENCIA_MS;
      return [...presencias.values()].filter((p) => p.ts > limite);
    },
    async publicar(evento) {
      for (const fn of suscriptores) fn(evento);
    },
    suscribir(fn) {
      suscriptores.add(fn);
    },
  };
}

function almacenRedis(url) {
  const opciones = { maxRetriesPerRequest: 3, lazyConnect: false };
  const redis = new Redis(url, opciones);
  const suscriptor = new Redis(url, opciones);
  const CANAL = 'chat:eventos';
  const suscriptores = new Set();

  redis.on('error', (e) => console.error('[redis]', e.message));
  suscriptor.on('error', (e) => console.error('[redis-sub]', e.message));

  suscriptor.subscribe(CANAL).catch((e) => console.error('[redis-sub]', e.message));
  suscriptor.on('message', (_canal, texto) => {
    let evento;
    try {
      evento = JSON.parse(texto);
    } catch {
      return;
    }
    for (const fn of suscriptores) fn(evento);
  });

  return {
    tipo: 'redis',
    async guardarMensaje(sala, mensaje) {
      const clave = `chat:historial:${sala}`;
      await redis.rpush(clave, JSON.stringify(mensaje));
      await redis.ltrim(clave, -MAX_HISTORIAL, -1);
    },
    async historial(sala) {
      const filas = await redis.lrange(`chat:historial:${sala}`, 0, -1);
      return filas.map((f) => JSON.parse(f));
    },
    async ponerPresencia(clienteId, datos) {
      await redis.hset('chat:presencia', clienteId, JSON.stringify({ ...datos, ts: Date.now() }));
    },
    async leerPresencia(clienteId) {
      const fila = await redis.hget('chat:presencia', clienteId);
      return fila ? JSON.parse(fila) : null;
    },
    async quitarPresencia(clienteId) {
      await redis.hdel('chat:presencia', clienteId);
    },
    async presencia() {
      const todo = await redis.hgetall('chat:presencia');
      const limite = Date.now() - VIDA_PRESENCIA_MS;
      const vivos = [];
      for (const [clienteId, fila] of Object.entries(todo)) {
        const p = JSON.parse(fila);
        if (p.ts > limite) vivos.push(p);
        else await redis.hdel('chat:presencia', clienteId);
      }
      return vivos;
    },
    async publicar(evento) {
      await redis.publish(CANAL, JSON.stringify(evento));
    },
    suscribir(fn) {
      suscriptores.add(fn);
    },
  };
}

export function crearAlmacen() {
  const url = process.env.REDIS_URL || process.env.KV_URL;
  return url ? almacenRedis(url) : almacenMemoria();
}
