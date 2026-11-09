// API de la app "Control de equipos" de HONOR.
// Corre en Netlify Functions y guarda todo en Netlify Blobs (almacenamiento interno de Netlify).
//
// Almacenes:
//   equipos      clave = código QR (EQ-XXXXXX)          → datos del equipo y su dueño
//   movimientos  clave = AAAA-MM-DD/id (fecha de ingreso) → cada ingreso/salida
//   abiertos     clave = id                              → equipos que están dentro ahora
//   usuarios     clave = usuario (cédula)                → usuarios y contraseñas cifradas
//   fotos        clave = id                              → fotos de los equipos
//   config       clave = secret                          → clave interna para firmar sesiones

import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

const ADMIN_INICIAL = { usuario: '1095841966', password: '123456', nombre: 'Administrador' };
const SESION_HORAS = 12;
const ZONA_MS = -5 * 3600e3; // Colombia (UTC-5, sin horario de verano)
const MAX_INTENTOS = 5, BLOQUEO_MIN = 15;

const TEST_URL = process.env.BLOBS_TEST_URL; // solo para pruebas locales
const st = name => getStore(TEST_URL ? { name, siteID: 'local', token: 'local', apiURL: TEST_URL } : { name, consistency: 'strong' });

class HttpError extends Error { constructor(status, msg){ super(msg); this.status = status; } }
const fail = (s, m) => { throw new HttpError(s, m); };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

/* ---------- utilidades ---------- */
const norm = s => String(s || '').trim().toUpperCase().replace(/\s+/g, '');
const txt = (v, max = 300) => (v == null ? '' : String(v)).trim().slice(0, max);
const dia = ms => new Date(ms + ZONA_MS).toISOString().slice(0, 10);
const rid = (p = '') => p + Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

async function keys(store, prefix){
  if (TEST_URL){ const { blobs } = await store.list(); return blobs.map(b => b.key).filter(k => !prefix || k.startsWith(prefix)); } // el emulador local no filtra por prefijo
  const { blobs } = await store.list(prefix ? { prefix } : {});
  return blobs.map(b => b.key);
}
async function getMany(store, ks){
  const out = [];
  for (let i = 0; i < ks.length; i += 40){
    const r = await Promise.all(ks.slice(i, i + 40).map(k => store.get(k, { type: 'json' })));
    out.push(...r.filter(Boolean));
  }
  return out;
}
async function body(req){ try { return await req.json(); } catch { fail(400, 'Datos inválidos.'); } }

/* ---------- sesiones y contraseñas ---------- */
let secretCache = null;
async function secret(){
  if (secretCache) return secretCache;
  const c = st('config');
  let s = await c.get('secret');
  if (!s){ await c.set('secret', crypto.randomBytes(32).toString('hex'), { onlyIfNew: true }); s = await c.get('secret'); }
  return (secretCache = s);
}
async function firmar(u){
  const b = Buffer.from(JSON.stringify({ u: u.usuario, v: u.ver || 0, exp: Date.now() + SESION_HORAS * 36e5 })).toString('base64url');
  return b + '.' + crypto.createHmac('sha256', await secret()).update(b).digest('base64url');
}
async function leerToken(tok){
  if (!tok || !tok.includes('.')) return null;
  const [b, sig] = tok.split('.');
  const ok = crypto.createHmac('sha256', await secret()).update(b).digest('base64url');
  if (!safeEq(sig, ok)) return null;
  try { const p = JSON.parse(Buffer.from(b, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
const scrypt = (p, salt) => new Promise((res, rej) => crypto.scrypt(p, salt, 32, (e, k) => e ? rej(e) : res(k.toString('hex'))));
async function hashNuevo(p){ const salt = crypto.randomBytes(16).toString('hex'); return { alg: 'scrypt', salt, hash: await scrypt(p, salt) }; }
async function claveOk(u, p){
  if (u.alg === 'scrypt') return safeEq(await scrypt(p, u.salt), u.hash);
  // usuarios traídos de la versión anterior (solo celular)
  return safeEq(crypto.createHash('sha256').update(u.salt + ':' + p).digest('hex'), u.hash);
}
const publico = u => ({ usuario: u.usuario, nombre: u.nombre, rol: u.rol, activo: !!u.activo, cambiarClave: !!u.cambiarClave });

async function sembrarAdmin(){
  const us = st('usuarios');
  if ((await keys(us)).length) return;
  const a = { usuario: ADMIN_INICIAL.usuario, nombre: ADMIN_INICIAL.nombre, rol: 'admin', activo: true, cambiarClave: true, ver: 0, creadoMs: Date.now(), ...(await hashNuevo(ADMIN_INICIAL.password)) };
  await us.setJSON(a.usuario, a, { onlyIfNew: true });
}

async function sesion(req, url){
  const h = req.headers.get('authorization') || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('t');
  const p = await leerToken(tok);
  if (!p) fail(401, 'Tu sesión venció. Ingresa de nuevo.');
  const u = await st('usuarios').get(p.u, { type: 'json' });
  if (!u || !u.activo || (u.ver || 0) !== p.v) fail(401, 'Tu sesión venció. Ingresa de nuevo.');
  return u;
}
const soloAdmin = u => { if (u.rol !== 'admin') fail(403, 'Solo el administrador puede hacer esto.'); };

/* ---------- equipos ---------- */
const EQ_TXT = ['nombre', 'cedula', 'telefono', 'area', 'empresa', 'visitaA', 'tipoEquipo', 'propiedad', 'marca', 'modelo', 'serial', 'senas'];
function limpiarEquipo(e){
  const o = {};
  EQ_TXT.forEach(k => o[k] = txt(e[k]));
  o.tipoPersona = e.tipoPersona === 'Visitante' ? 'Visitante' : 'Empleado';
  o.fotoId = /^f-[\w-]{6,80}$/.test(e.fotoId || '') ? e.fotoId : null;
  o.frecuente = !!e.frecuente;
  if (!o.nombre || !o.cedula || !o.marca || !o.serial) fail(400, 'Faltan datos obligatorios: nombre, cédula, marca y serial.');
  return o;
}
const codigoValido = c => /^EQ-[A-Z0-9]{6}$/.test(c || '');
async function nuevoCodigo(store){
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;){
    let c = 'EQ-'; crypto.randomBytes(6).forEach(n => c += a[n % a.length]);
    if (!(await store.get(c))) return c;
  }
}
async function guardarEquipo(e, porSerial){
  const store = st('equipos');
  const o = limpiarEquipo(e);
  let actual = codigoValido(e.codigo) ? await store.get(e.codigo, { type: 'json' }) : null;
  if (!actual && porSerial) actual = porSerial.get(norm(o.serial)) || null;
  if (!actual && !porSerial){
    const todos = await getMany(store, await keys(store));
    actual = todos.find(x => norm(x.serial) === norm(o.serial)) || null;
  }
  const codigo = actual?.codigo || (codigoValido(e.codigo) ? e.codigo : await nuevoCodigo(store));
  const eq = { ...(actual || {}), ...o, codigo, fotoId: o.fotoId || actual?.fotoId || null, actualizadoMs: Date.now() };
  await store.setJSON(codigo, eq);
  return eq;
}

/* ---------- movimientos ---------- */
const MOV_TXT = ['obsEntrada', 'obsSalida', 'guardaEntrada', 'guardaSalida', 'serialVerificado'];
async function abiertos(){ const s = st('abiertos'); return getMany(s, await keys(s)); }
async function ingresosHoy(){ return (await keys(st('movimientos'), dia(Date.now()) + '/')).length; }

async function registrarEntrada(u, b){
  const eq = await guardarEquipo(b.equipo || {});
  const dentro = await abiertos();
  const ya = dentro.find(m => m.codigo === eq.codigo || norm(m.serial) === norm(eq.serial));
  if (ya) fail(409, `Este equipo ya figura dentro (ingresó a las ${new Date(ya.entradaMs).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: 'numeric', minute: '2-digit' })}). Registra primero su salida.`);
  const ahora = Date.now();
  const id = rid('m-');
  const mov = { ...eq, id, key: dia(ahora) + '/' + id, entradaMs: ahora, salidaMs: null, estado: 'dentro', guardaEntrada: `${u.nombre} (${u.usuario})`, guardaSalida: '', obsEntrada: txt(b.obsEntrada, 500), obsSalida: '', novedad: false };
  await st('movimientos').setJSON(mov.key, mov);
  await st('abiertos').setJSON(id, mov);
  return { equipo: eq, mov };
}
async function registrarSalida(u, id, b){
  const ab = st('abiertos');
  const m = await ab.get(id, { type: 'json' });
  if (!m) fail(404, 'Este equipo ya no figura dentro. Actualiza la pantalla.');
  const sv = norm(b.serialVerificado);
  const ok = !sv || sv === norm(m.serial) || sv === norm(m.codigo);
  const obs = txt(b.obsSalida, 500);
  if (!ok && !obs) fail(400, 'El serial no coincide. Describe la novedad en observaciones.');
  const upd = { ...m, estado: 'salió', salidaMs: Date.now(), guardaSalida: `${u.nombre} (${u.usuario})`, obsSalida: obs, novedad: !ok, serialVerificado: sv };
  await st('movimientos').setJSON(m.key, upd);
  await ab.delete(id);
  return upd;
}
async function movimientosRango(desde, hasta){
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(desde) || !re.test(hasta) || desde > hasta) fail(400, 'Rango de fechas inválido.');
  const dias = [];
  for (let d = new Date(desde + 'T00:00:00Z'); d <= new Date(hasta + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)){
    dias.push(d.toISOString().slice(0, 10));
    if (dias.length > 93) fail(400, 'El rango máximo es de 3 meses.');
  }
  const s = st('movimientos');
  const ks = (await Promise.all(dias.map(x => keys(s, x + '/')))).flat();
  return (await getMany(s, ks)).sort((a, b) => b.entradaMs - a.entradaMs);
}

/* ---------- importación (copias de seguridad y migración) ---------- */
async function importar(b){
  const r = { equipos: 0, movimientos: 0, usuarios: 0 };
  const eqs = Array.isArray(b.equipos) ? b.equipos.slice(0, 300) : [];
  for (const e of eqs){
    if (!codigoValido(e.codigo)) continue;
    try { const o = limpiarEquipo(e); await st('equipos').setJSON(e.codigo, { ...o, codigo: e.codigo, actualizadoMs: e.actualizadoMs || Date.now() }); r.equipos++; } catch {}
  }
  const movs = Array.isArray(b.movimientos) ? b.movimientos.slice(0, 300) : [];
  for (const m of movs){
    if (!m || !m.id || !Number.isFinite(m.entradaMs)) continue;
    let base; try { base = limpiarEquipo(m); } catch { continue; }
    const id = txt(m.id, 100).replace(/[^\w-]/g, '');
    const mov = { ...base, codigo: codigoValido(m.codigo) ? m.codigo : '', id, key: dia(m.entradaMs) + '/' + id, entradaMs: m.entradaMs, salidaMs: Number.isFinite(m.salidaMs) ? m.salidaMs : null, estado: m.salidaMs ? 'salió' : 'dentro', novedad: !!m.novedad };
    MOV_TXT.forEach(k => mov[k] = txt(m[k], 500));
    await st('movimientos').setJSON(mov.key, mov);
    if (mov.estado === 'dentro') await st('abiertos').setJSON(id, mov); else await st('abiertos').delete(id);
    r.movimientos++;
  }
  const us = Array.isArray(b.usuarios) ? b.usuarios.slice(0, 200) : [];
  for (const x of us){
    if (!x || !x.usuario || !x.hash || !x.salt) continue;
    const usuario = txt(x.usuario, 40);
    const res = await st('usuarios').setJSON(usuario, { usuario, nombre: txt(x.nombre, 100), rol: x.rol === 'admin' ? 'admin' : 'guarda', activo: !!x.activo, ver: 0, alg: x.alg === 'scrypt' ? 'scrypt' : 'sha256', salt: String(x.salt), hash: String(x.hash), creadoMs: x.creadoMs || Date.now() }, { onlyIfNew: true });
    if (res?.modified) r.usuarios++;
  }
  return r;
}

/* ---------- rutas ---------- */
export default async (req) => {
  try {
    const url = new URL(req.url);
    const p = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const M = req.method;

    if (M === 'POST' && p[0] === 'login'){
      await sembrarAdmin();
      const b = await body(req);
      const us = st('usuarios');
      const usuario = txt(b.usuario, 40);
      const u = usuario ? await us.get(usuario, { type: 'json' }) : null;
      if (!u) fail(401, 'Usuario o contraseña incorrectos.');
      if (u.bloqueadoHasta && u.bloqueadoHasta > Date.now()) fail(429, `Usuario bloqueado por intentos fallidos. Intenta de nuevo en ${Math.ceil((u.bloqueadoHasta - Date.now()) / 60000)} minutos.`);
      if (!(await claveOk(u, String(b.password || '')))){
        const fallos = (u.fallos || 0) + 1;
        await us.setJSON(u.usuario, { ...u, fallos: fallos >= MAX_INTENTOS ? 0 : fallos, bloqueadoHasta: fallos >= MAX_INTENTOS ? Date.now() + BLOQUEO_MIN * 60000 : 0 });
        fail(401, fallos >= MAX_INTENTOS ? `Demasiados intentos. El usuario quedó bloqueado ${BLOQUEO_MIN} minutos.` : 'Usuario o contraseña incorrectos.');
      }
      if (!u.activo) fail(403, 'Este usuario está desactivado. Habla con el administrador.');
      let nu = { ...u, fallos: 0, bloqueadoHasta: 0 };
      if (u.alg !== 'scrypt') nu = { ...nu, ...(await hashNuevo(String(b.password))) };
      await us.setJSON(u.usuario, nu);
      return json({ token: await firmar(nu), user: publico(nu) });
    }

    const u = await sesion(req, url);

    // Fotos (la etiqueta <img> envía la sesión en la dirección)
    if (p[0] === 'fotos'){
      const fs = st('fotos');
      if (M === 'GET' && p[1]){
        const r = await fs.getWithMetadata(p[1], { type: 'arrayBuffer' });
        if (!r) fail(404, 'Foto no encontrada.');
        return new Response(r.data, { headers: { 'content-type': r.metadata?.type || 'image/jpeg', 'cache-control': 'private, max-age=86400' } });
      }
      if (M === 'POST' || (M === 'PUT' && p[1])){
        if (M === 'PUT') soloAdmin(u);
        const type = (req.headers.get('content-type') || '').split(';')[0];
        if (!/^image\/(jpeg|png|webp)$/.test(type)) fail(400, 'La foto debe ser JPG, PNG o WEBP.');
        const buf = await req.arrayBuffer();
        if (buf.byteLength > 4 * 1024 * 1024) fail(413, 'La foto es demasiado grande.');
        const id = M === 'PUT' ? txt(p[1], 100).replace(/[^\w-]/g, '') : rid('f-');
        if (!/^f-[\w-]{6,80}$/.test(id)) fail(400, 'Identificador de foto inválido.');
        await fs.set(id, buf, { metadata: { type } });
        return json({ id });
      }
    }

    if (M === 'GET' && p[0] === 'bootstrap'){
      const es = st('equipos');
      const [equipos, dentro, hoy] = await Promise.all([getMany(es, await keys(es)), abiertos(), ingresosHoy()]);
      const out = { user: publico(u), equipos, dentro, ingresosHoy: hoy };
      if (u.rol === 'admin'){ const us = st('usuarios'); out.usuarios = (await getMany(us, await keys(us))).map(publico); }
      return json(out);
    }
    if (M === 'GET' && p[0] === 'dentro') return json({ dentro: await abiertos(), ingresosHoy: await ingresosHoy() });
    if (M === 'GET' && p[0] === 'movimientos') return json({ movimientos: await movimientosRango(url.searchParams.get('desde') || '', url.searchParams.get('hasta') || '') });

    if (M === 'PUT' && p[0] === 'equipos') return json({ equipo: await guardarEquipo((await body(req)).equipo || {}) });
    if (M === 'POST' && p[0] === 'equipos' && p[1] === 'lote'){
      soloAdmin(u);
      const lista = (await body(req)).equipos;
      if (!Array.isArray(lista) || !lista.length || lista.length > 300) fail(400, 'Envía entre 1 y 300 equipos por lote.');
      const es = st('equipos');
      const porSerial = new Map((await getMany(es, await keys(es))).map(e => [norm(e.serial), e]));
      const out = [];
      for (const e of lista){ const eq = await guardarEquipo({ ...e, tipoPersona: 'Empleado', frecuente: true }, porSerial); porSerial.set(norm(eq.serial), eq); out.push(eq); }
      return json({ equipos: out });
    }
    if (M === 'POST' && p[0] === 'entradas') return json(await registrarEntrada(u, await body(req)));
    if (M === 'POST' && p[0] === 'salidas' && p[1]) return json({ mov: await registrarSalida(u, p[1], await body(req)) });

    if (p[0] === 'usuarios'){
      soloAdmin(u);
      const us = st('usuarios');
      if (M === 'POST'){
        const b = await body(req);
        const usuario = txt(b.usuario, 40).replace(/\s+/g, ''), nombre = txt(b.nombre, 100), pass = String(b.password || '');
        if (!usuario || !nombre || pass.length < 6) fail(400, 'Llena nombre, usuario y una contraseña de al menos 6 caracteres.');
        const nu = { usuario, nombre, rol: 'guarda', activo: true, ver: 0, creadoMs: Date.now(), ...(await hashNuevo(pass)) };
        const r = await us.setJSON(usuario, nu, { onlyIfNew: true });
        if (r && r.modified === false) fail(409, 'Ya existe un usuario con esa cédula.');
        return json({ user: publico(nu) });
      }
      if (M === 'PATCH' && p[1]){
        const x = await us.get(p[1], { type: 'json' });
        if (!x) fail(404, 'Usuario no encontrado.');
        if (x.rol === 'admin') fail(400, 'El administrador se gestiona desde Cambiar mi contraseña.');
        const b = await body(req);
        let nx = { ...x };
        if (typeof b.activo === 'boolean'){ nx.activo = b.activo; nx.ver = (x.ver || 0) + 1; }
        if (b.password != null){
          if (String(b.password).length < 6) fail(400, 'La contraseña debe tener al menos 6 caracteres.');
          nx = { ...nx, ...(await hashNuevo(String(b.password))), ver: (x.ver || 0) + 1, fallos: 0, bloqueadoHasta: 0 };
        }
        await us.setJSON(x.usuario, nx);
        return json({ user: publico(nx) });
      }
    }
    if (M === 'POST' && p[0] === 'password'){
      const b = await body(req);
      if (!(await claveOk(u, String(b.actual || '')))) fail(400, 'La contraseña actual no es correcta.');
      if (String(b.nueva || '').length < 6) fail(400, 'La nueva contraseña debe tener al menos 6 caracteres.');
      const nu = { ...u, ...(await hashNuevo(String(b.nueva))), ver: (u.ver || 0) + 1 };
      delete nu.cambiarClave;
      await st('usuarios').setJSON(u.usuario, nu);
      return json({ token: await firmar(nu), user: publico(nu) });
    }
    if (M === 'GET' && p[0] === 'export'){
      soloAdmin(u);
      const es = st('equipos'), ms = st('movimientos');
      const [equipos, movimientos] = await Promise.all([getMany(es, await keys(es)), getMany(ms, await keys(ms))]);
      return json({ app: 'control-equipos', version: 2, origen: 'nube', exportadoMs: Date.now(), equipos, movimientos });
    }
    if (M === 'POST' && p[0] === 'import'){ soloAdmin(u); return json(await importar(await body(req))); }

    fail(404, 'Ruta no encontrada.');
  } catch (e){
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'Error interno del servidor. Inténtalo de nuevo.' }, 500);
  }
};

export const config = { path: '/api/*' };
