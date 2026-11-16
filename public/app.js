// Cliente del chat (navegador).
//  - HTTP(S): carga la página y consulta el estado del servidor con fetch().
//  - WebSocket (wss): mensajes y archivos en tiempo real, con tramas JSON.

(() => {
  const $ = (id) => document.getElementById(id);
  const RUTA_API = '/api/server';
  const TAM_PARTE = 32 * 1024; // bytes por parte de archivo
  const URL_WS = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${RUTA_API}`;

  const yo = { nombre: '', sala: 'General', clienteId: idCliente() };
  let socket = null;
  let espera = 1000; // retardo de reconexión (crece hasta 30 s)
  let yaEntre = false;
  let maxArchivo = 5 * 1024 * 1024;
  let usuarios = [];
  let salas = ['General', 'Redes', 'Proyecto'];
  const recibiendo = new Map(); // id -> { info, partes[], barra, caja }
  const acuses = new Map(); // id -> función que resuelve el acuse esperado
  let temporizadorEscribiendo = null;
  let ultimoAvisoEscribiendo = 0;

  function idCliente() {
    try {
      let id = sessionStorage.getItem('clienteId');
      if (!id) {
        id = crypto.randomUUID();
        sessionStorage.setItem('clienteId', id);
      }
      return id;
    } catch {
      return crypto.randomUUID();
    }
  }

  // ------------------------------------------------------------ conexión --

  function conectar() {
    socket = new WebSocket(URL_WS);

    socket.addEventListener('open', () => {
      espera = 1000;
      ponerEstado(true);
      enviar({ tipo: 'entrar', nombre: yo.nombre, sala: yo.sala, clienteId: yo.clienteId, reconexion: yaEntre });
    });

    socket.addEventListener('message', (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      registrarTrama('entra', m);
      (alRecibir[m.tipo] || (() => {}))(m);
    });

    socket.addEventListener('close', () => {
      ponerEstado(false);
      // El servidor cierra la conexión cada cierto tiempo: se reconecta solo.
      setTimeout(conectar, espera + Math.random() * 400);
      espera = Math.min(espera * 2, 30000);
    });
  }

  function enviar(datos) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(datos));
    registrarTrama('sale', datos);
    return true;
  }

  setInterval(() => enviar({ tipo: 'ping', t: Date.now() }), 25000);

  // ------------------------------------------------- tramas del servidor --

  const alRecibir = {
    bienvenida(m) {
      yaEntre = true;
      yo.nombre = m.nombre;
      yo.sala = m.sala;
      salas = m.salas;
      maxArchivo = m.maxArchivo;
      $('ingreso').hidden = true;
      $('app').hidden = false;
      $('miNombre').textContent = yo.nombre;
      pintarSalas();
      consultarEstado();
      $('texto').focus();
      enviar({ tipo: 'ping', t: Date.now() });
    },
    sala(m) {
      yo.sala = m.sala;
      pintarSalas();
    },
    historial(m) {
      $('mensajes').replaceChildren();
      for (const x of m.mensajes) (x.tipo === 'mensaje' ? pintarMensaje : pintarSistema)(x);
    },
    mensaje: pintarMensaje,
    sistema: pintarSistema,
    usuarios(m) {
      usuarios = m.usuarios;
      pintarUsuarios();
      pintarSalas();
    },
    escribiendo(m) {
      $('escribiendo').textContent = `${m.de} está escribiendo…`;
      clearTimeout(temporizadorEscribiendo);
      temporizadorEscribiendo = setTimeout(() => ($('escribiendo').textContent = ''), 2500);
    },
    pong(m) {
      $('latencia').textContent = `latencia ${Date.now() - m.t} ms`;
    },
    error(m) {
      if (!yaEntre) $('errorIngreso').textContent = m.texto;
      else pintarSistema({ texto: `Error: ${m.texto}`, hora: Date.now() });
      if (m.id && acuses.has(m.id)) acuses.get(m.id)(new Error(m.texto));
    },
    archivo_ack(m) {
      if (acuses.has(m.id)) acuses.get(m.id)(m);
    },
    archivo_inicio(m) {
      const { caja, barra } = pintarArchivoEnCurso(m.de, m.nombre, m.tamano, false);
      barra.max = m.partes;
      recibiendo.set(m.id, { info: m, partes: [], barra, caja });
    },
    archivo_parte(m) {
      const r = recibiendo.get(m.id);
      if (!r) return;
      r.partes[m.n] = base64ABytes(m.datos);
      r.barra.value = m.n + 1;
    },
    archivo_fin(m) {
      const r = recibiendo.get(m.id);
      if (!r) return;
      recibiendo.delete(m.id);
      const blob = new Blob(r.partes, { type: r.info.mime });
      terminarArchivo(r.caja, blob, r.info.nombre);
    },
  };

  // ------------------------------------------------------- envío archivo --

  function esperarAcuse(id) {
    return new Promise((resolver, rechazar) => {
      const limite = setTimeout(() => {
        acuses.delete(id);
        rechazar(new Error('El servidor no confirmó a tiempo.'));
      }, 15000);
      acuses.set(id, (r) => {
        clearTimeout(limite);
        acuses.delete(id);
        r instanceof Error ? rechazar(r) : resolver(r);
      });
    });
  }

  // Parada y espera: cada parte se envía solo cuando el servidor confirmó la anterior.
  async function enviarArchivo(archivo) {
    if (archivo.size === 0) return pintarSistema({ texto: 'El archivo está vacío.', hora: Date.now() });
    if (archivo.size > maxArchivo) {
      return pintarSistema({ texto: 'El archivo supera el máximo de 5 MB.', hora: Date.now() });
    }
    const id = crypto.randomUUID();
    const bytes = new Uint8Array(await archivo.arrayBuffer());
    const partes = Math.ceil(bytes.length / TAM_PARTE);
    const mime = archivo.type || 'application/octet-stream';
    const { caja, barra } = pintarArchivoEnCurso(yo.nombre, archivo.name, archivo.size, true);
    barra.max = partes;
    $('btnArchivo').disabled = true;
    try {
      const pedir = async (trama) => {
        const acuse = esperarAcuse(id);
        if (!enviar(trama)) throw new Error('Sin conexión con el servidor.');
        return acuse;
      };
      await pedir({ tipo: 'archivo_inicio', id, nombre: archivo.name, mime, tamano: bytes.length, partes });
      for (let n = 0; n < partes; n++) {
        const trozo = bytes.subarray(n * TAM_PARTE, (n + 1) * TAM_PARTE);
        await pedir({ tipo: 'archivo_parte', id, n, datos: bytesABase64(trozo) });
        barra.value = n + 1;
      }
      await pedir({ tipo: 'archivo_fin', id });
      terminarArchivo(caja, new Blob([bytes], { type: mime }), archivo.name);
    } catch (e) {
      caja.querySelector('progress')?.remove();
      caja.append(` — no se pudo enviar: ${e.message}`);
    } finally {
      $('btnArchivo').disabled = false;
    }
  }

  function bytesABase64(bytes) {
    let binario = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binario += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return btoa(binario);
  }

  function base64ABytes(texto) {
    const binario = atob(texto);
    const bytes = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
    return bytes;
  }

  // -------------------------------------------------------------- pintar --

  function hora(ms) {
    return new Date(ms).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
  }

  function agregar(nodo) {
    const caja = $('mensajes');
    const abajo = caja.scrollHeight - caja.scrollTop - caja.clientHeight < 80;
    caja.append(nodo);
    if (abajo || nodo.classList.contains('mio')) caja.scrollTop = caja.scrollHeight;
  }

  function burbuja(de, ms) {
    const div = document.createElement('div');
    div.className = 'msj' + (de === yo.nombre ? ' mio' : '');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const b = document.createElement('b');
    b.textContent = de;
    const t = document.createElement('span');
    t.textContent = hora(ms);
    meta.append(b, t);
    div.append(meta);
    return div;
  }

  function pintarMensaje(m) {
    const div = burbuja(m.de, m.hora);
    const p = document.createElement('div');
    p.textContent = m.texto;
    div.append(p);
    agregar(div);
  }

  function pintarSistema(m) {
    const div = document.createElement('div');
    div.className = 'sistema';
    div.textContent = `${m.texto} · ${hora(m.hora)}`;
    agregar(div);
  }

  function pintarArchivoEnCurso(de, nombre, tamano, mio) {
    const caja = burbuja(de, Date.now());
    const texto = document.createElement('div');
    texto.textContent = `${mio ? 'Enviando' : 'Recibiendo'} ${nombre} (${Math.ceil(tamano / 1024)} KB)`;
    const barra = document.createElement('progress');
    barra.value = 0;
    caja.append(texto, barra);
    agregar(caja);
    return { caja, barra };
  }

  function terminarArchivo(caja, blob, nombre) {
    const url = URL.createObjectURL(blob);
    while (caja.childNodes.length > 1) caja.lastChild.remove(); // deja solo la cabecera
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = nombre;
    enlace.textContent = `Descargar ${nombre}`;
    const peso = document.createElement('span');
    peso.textContent = ` (${Math.ceil(blob.size / 1024)} KB)`;
    caja.append(enlace, peso);
    if (/^image\/(png|jpeg|gif|webp)$/.test(blob.type)) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = nombre;
      caja.append(img);
    }
    $('mensajes').scrollTop = $('mensajes').scrollHeight;
  }

  function pintarSalas() {
    $('tituloSala').textContent = `Sala ${yo.sala}`;
    $('listaSalas').replaceChildren(
      ...salas.map((s) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = s === yo.sala ? 'activa' : '';
        const n = document.createElement('span');
        n.className = 'n';
        n.textContent = usuarios.filter((u) => u.sala === s).length;
        b.append(s, n);
        b.addEventListener('click', () => enviar({ tipo: 'cambiar_sala', sala: s }));
        li.append(b);
        return li;
      }),
    );
  }

  function pintarUsuarios() {
    $('totalUsuarios').textContent = `(${usuarios.length})`;
    $('listaUsuarios').replaceChildren(
      ...usuarios.map((u) => {
        const li = document.createElement('li');
        const s = document.createElement('small');
        s.textContent = u.sala;
        li.append(u.nombre + (u.nombre === yo.nombre ? ' (tú)' : ''), s);
        return li;
      }),
    );
  }

  function ponerEstado(conectado) {
    const e = $('estadoConexion');
    e.textContent = conectado ? 'Conectado' : 'Reconectando…';
    e.className = 'estado ' + (conectado ? 'conectado' : 'desconectado');
  }

  // ------------------------------------------------ estado por HTTP (GET) --

  async function consultarEstado() {
    const ruta = `${RUTA_API}?op=estado`;
    const dl = $('estadoServidor');
    try {
      const inicio = performance.now();
      const r = await fetch(ruta, { cache: 'no-store' });
      const d = await r.json();
      registrarTrama('http', `GET ${ruta} → ${r.status} (${Math.round(performance.now() - inicio)} ms)`);
      const filas = {
        Protocolo: `${location.protocol.replace(':', '').toUpperCase()} / ${URL_WS.split(':')[0].toUpperCase()}`,
        Host: location.host,
        Instancia: d.instancia,
        Almacén: d.almacen,
        Activo: `${d.activoSegundos} s`,
        Usuarios: d.usuariosConectados,
      };
      dl.replaceChildren();
      for (const [k, v] of Object.entries(filas)) {
        const dt = document.createElement('dt');
        dt.textContent = k;
        const dd = document.createElement('dd');
        dd.textContent = v;
        dl.append(dt, dd);
      }
    } catch {
      dl.textContent = 'No se pudo consultar el servidor.';
    }
  }

  // ------------------------------------------------- monitor de protocolo --

  function registrarTrama(clase, datos) {
    const lista = $('tramas');
    const li = document.createElement('li');
    li.className = clase;
    const t = document.createElement('time');
    t.textContent = new Date().toLocaleTimeString('es-CO', { hour12: false });
    let texto;
    if (typeof datos === 'string') texto = datos;
    else {
      const copia = { ...datos };
      if (typeof copia.datos === 'string') copia.datos = `<${copia.datos.length} caracteres base64>`;
      if (Array.isArray(copia.mensajes)) copia.mensajes = `<${copia.mensajes.length} mensajes>`;
      texto = (clase === 'sale' ? '↑ ' : '↓ ') + JSON.stringify(copia);
    }
    li.append(t, texto);
    lista.append(li);
    while (lista.children.length > 200) lista.firstChild.remove();
    lista.scrollTop = lista.scrollHeight;
  }

  // -------------------------------------------------------------- eventos --

  $('formIngreso').addEventListener('submit', (ev) => {
    ev.preventDefault();
    yo.nombre = $('nombre').value.trim();
    yo.sala = $('salaInicial').value;
    if (!yo.nombre) return;
    $('errorIngreso').textContent = '';
    if (socket && socket.readyState === WebSocket.OPEN) {
      enviar({ tipo: 'entrar', nombre: yo.nombre, sala: yo.sala, clienteId: yo.clienteId });
    } else if (!socket) {
      conectar();
    }
  });

  $('formMensaje').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const texto = $('texto').value.trim();
    if (!texto) return;
    if (enviar({ tipo: 'mensaje', texto })) $('texto').value = '';
  });

  $('texto').addEventListener('input', () => {
    if (Date.now() - ultimoAvisoEscribiendo > 2000) {
      ultimoAvisoEscribiendo = Date.now();
      enviar({ tipo: 'escribiendo' });
    }
  });

  $('btnArchivo').addEventListener('click', () => $('archivo').click());
  $('archivo').addEventListener('change', () => {
    const archivo = $('archivo').files[0];
    $('archivo').value = '';
    if (archivo) enviarArchivo(archivo);
  });

  $('btnEstado').addEventListener('click', consultarEstado);
  $('btnMonitor').addEventListener('click', () => ($('monitor').hidden = !$('monitor').hidden));
  $('btnLimpiar').addEventListener('click', () => $('tramas').replaceChildren());
})();
