// Pruebas automáticas de funcionamiento del chat.
//
//   npm start                      (en una terminal)
//   npm test                       (en otra)        -> prueba http://localhost:3000
//   URL_A=https://mi-chat.vercel.app npm test       -> prueba el despliegue en Vercel
//
// URL_B permite conectar el segundo cliente a otra instancia del servidor.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const URL_A = (process.env.URL_A || 'http://localhost:3000').replace(/\/$/, '');
const URL_B = (process.env.URL_B || URL_A).replace(/\/$/, '');
const RUTA = '/api/server';
let fallos = 0;

function comprobar(nombre, condicion, detalle = '') {
  if (!condicion) fallos += 1;
  console.log(`${condicion ? '  OK   ' : '  FALLA'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
}

function cliente(base, nombre, sala) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + RUTA);
  const recibidas = [];
  const esperas = [];
  ws.on('message', (bruto) => {
    const m = JSON.parse(bruto.toString());
    recibidas.push(m);
    for (const e of [...esperas]) {
      if (e.filtro(m)) {
        esperas.splice(esperas.indexOf(e), 1);
        clearTimeout(e.limite);
        e.resolver(m);
      }
    }
  });
  const c = {
    nombre,
    recibidas,
    enviar: (d) => ws.send(JSON.stringify(d)),
    cerrar: () => ws.close(),
    esperar(filtro, ms = 8000) {
      const ya = recibidas.find(filtro);
      if (ya) return Promise.resolve(ya);
      return new Promise((resolver, rechazar) => {
        const e = { filtro, resolver };
        e.limite = setTimeout(() => rechazar(new Error(`${nombre}: no llegó la trama esperada`)), ms);
        esperas.push(e);
      });
    },
  };
  c.listo = new Promise((resolver, rechazar) => {
    ws.on('error', rechazar);
    ws.on('open', async () => {
      c.enviar({ tipo: 'entrar', nombre, sala, clienteId: randomUUID() });
      resolver(await c.esperar((m) => m.tipo === 'bienvenida'));
    });
  });
  return c;
}

const sha = (b) => createHash('sha256').update(b).digest('hex');

async function principal() {
  console.log(`Servidor A: ${URL_A}\nServidor B: ${URL_B}\n`);

  console.log('1. HTTP');
  const r = await fetch(`${URL_A}${RUTA}?op=estado`);
  const estado = await r.json();
  comprobar('GET ?op=estado responde 200 con JSON', r.status === 200 && estado.servicio === 'chat-redes',
    `instancia ${estado.instancia}, almacén ${estado.almacen}`);
  const r404 = await fetch(`${URL_A}${RUTA}?op=inexistente`);
  comprobar('Operación desconocida responde 404', r404.status === 404);
  const pagina = await fetch(`${URL_A}/`);
  comprobar('GET / entrega la página del cliente', pagina.status === 200 && (await pagina.text()).includes('Chat cliente-servidor'));

  console.log('2. Conexión WebSocket y presencia');
  const marca = Date.now().toString(36).slice(-4);
  const ana = cliente(URL_A, `Ana-${marca}`, 'General');
  const luis = cliente(URL_B, `Luis-${marca}`, 'General');
  const eva = cliente(URL_A, `Eva-${marca}`, 'Redes');
  const [ba, bl] = await Promise.all([ana.listo, luis.listo, eva.listo]);
  comprobar('Tres clientes completan el ingreso', true, `Ana en instancia ${ba.instancia}, Luis en ${bl.instancia}`);
  const lista = await ana.esperar((m) => m.tipo === 'usuarios' &&
    [ana, luis, eva].every((c) => m.usuarios.some((u) => u.nombre === c.nombre)));
  comprobar('La lista de conectados incluye a los tres', Boolean(lista));

  console.log('3. Mensajes por sala');
  const texto = `hola ${randomUUID()}`;
  ana.enviar({ tipo: 'mensaje', texto });
  const enLuis = await luis.esperar((m) => m.tipo === 'mensaje' && m.texto === texto);
  comprobar('Luis (misma sala) recibe el mensaje de Ana', enLuis.de === ana.nombre);
  await ana.esperar((m) => m.tipo === 'mensaje' && m.texto === texto);
  comprobar('Ana recibe el eco de su propio mensaje', true);
  await new Promise((s) => setTimeout(s, 700));
  comprobar('Eva (otra sala) NO recibe el mensaje', !eva.recibidas.some((m) => m.texto === texto));

  console.log('4. Cambio de sala e historial');
  eva.enviar({ tipo: 'cambiar_sala', sala: 'General' });
  const hist = await eva.esperar((m) => m.tipo === 'historial' && m.sala === 'General');
  comprobar('Al entrar a General, Eva recibe el historial con el mensaje', hist.mensajes.some((m) => m.texto === texto));
  const porHttp = await (await fetch(`${URL_B}${RUTA}?op=historial&sala=General`)).json();
  comprobar('El historial también se obtiene por HTTP', porHttp.mensajes.some((m) => m.texto === texto));

  console.log('5. Transferencia de archivo (parada y espera)');
  const datos = randomBytes(150_000);
  const TAM = 32 * 1024;
  const partes = Math.ceil(datos.length / TAM);
  const id = randomUUID();
  const acuse = (n) => ana.esperar((m) => m.tipo === 'archivo_ack' && m.id === id && m.n === n);
  ana.enviar({ tipo: 'archivo_inicio', id, nombre: 'prueba.bin', mime: 'application/octet-stream', tamano: datos.length, partes });
  await acuse(-1);
  for (let n = 0; n < partes; n++) {
    ana.enviar({ tipo: 'archivo_parte', id, n, datos: datos.subarray(n * TAM, (n + 1) * TAM).toString('base64') });
    await acuse(n);
  }
  ana.enviar({ tipo: 'archivo_fin', id });
  await acuse(partes);
  comprobar(`El servidor confirma las ${partes} partes`, true);
  await luis.esperar((m) => m.tipo === 'archivo_fin' && m.id === id);
  const armado = Buffer.concat(
    luis.recibidas.filter((m) => m.tipo === 'archivo_parte' && m.id === id)
      .sort((a, b) => a.n - b.n).map((m) => Buffer.from(m.datos, 'base64')),
  );
  comprobar('Luis reconstruye el archivo idéntico (SHA-256)', sha(armado) === sha(datos), `${armado.length} bytes`);

  console.log('6. Validaciones del servidor');
  const id2 = randomUUID();
  ana.enviar({ tipo: 'archivo_inicio', id: id2, nombre: 'grande.bin', mime: 'x', tamano: 6 * 1024 * 1024, partes: 200 });
  const rechazo = await ana.esperar((m) => m.tipo === 'error' && m.id === id2);
  comprobar('Rechaza archivos de más de 5 MB', /5 MB/.test(rechazo.texto));
  ana.enviar({ tipo: 'inventado' });
  await ana.esperar((m) => m.tipo === 'error' && /desconocido/.test(m.texto));
  comprobar('Rechaza tipos de trama desconocidos', true);

  console.log('7. Latencia y desconexión');
  const t = Date.now();
  ana.enviar({ tipo: 'ping', t });
  await ana.esperar((m) => m.tipo === 'pong' && m.t === t);
  comprobar('ping/pong', true, `${Date.now() - t} ms`);
  luis.cerrar();
  const salida = await ana.esperar((m) => m.tipo === 'sistema' && m.texto === `${luis.nombre} salió del chat`, 12000);
  comprobar('Se anuncia la salida de Luis', Boolean(salida));

  ana.cerrar();
  eva.cerrar();
  console.log(fallos ? `\n${fallos} prueba(s) fallaron.` : '\nTodas las pruebas pasaron.');
  setTimeout(() => process.exit(fallos ? 1 : 0), 300);
}

principal().catch((e) => {
  console.error('\nError en las pruebas:', e.message);
  process.exit(1);
});
