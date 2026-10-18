const {
  default: makeWASocket, useMultiFileAuthState, DisconnectReason,
  downloadMediaMessage, normalizeMessageContent
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const P = require('pino');
const fs = require('fs');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');
let Anthropic = null;
try { const mod = require('@anthropic-ai/sdk'); Anthropic = mod.default || mod.Anthropic || mod; } catch {}

/* ================= CONFIG ================= */
const GRUPO_BODEGA = 'bodega';                        // el grupo de inventario es cualquiera cuyo nombre CONTENGA esto
const GRUPOS_CLIENTES = ['cali cartel 4.0 prueba'];   // nombres EXACTOS (en minúsculas) de los grupos donde piden
const ADMINS = [];                                    // opcional: ['573001234567'] números que pueden usar comandos (tú mismo ya puedes)
const UMBRAL = 60;                                    // % mínimo de parecido para responder (mira los logs y ajústalo)
const PAUSA_MIN = 4000;                               // espera aleatoria antes de enviar al privado (ms)
const PAUSA_MAX = 10000;
const RESPONDER_A_MIS_FOTOS = false;                  // true = también responde a fotos que mandes tú en el grupo de clientes (para pruebas)
const EDAD_MAX_SEG = 90;                              // ignora mensajes más viejos que esto (evita procesar historial al conectar)

// IA de visión (opcional). Se activa sola si existe la variable de entorno ANTHROPIC_API_KEY
const MODELO_IA = 'claude-haiku-5-5';                 // rápido y barato. Si lee mal, prueba 'claude-sonnet-5-5' (más preciso, más caro)
const MAX_CAND_IA = 6;                                // máximo de fotos del inventario que se le muestran a la IA por pedido
const IA = (Anthropic && process.env.ANTHROPIC_API_KEY) ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
console.log(IA ? `IA de visión ACTIVA (${MODELO_IA})` : 'IA de visión APAGADA (usando OCR + huella). Falta ANTHROPIC_API_KEY o el paquete @anthropic-ai/sdk');

const BODEGA_DIR = './auth/bodega';
const INV_FILE = './auth/inventario_fotos.json';

/* ================= ESTADO ================= */
let ACTIVO = true;
let INV = [];
const COLA = [];
let OCUPADO = false;
const CACHE_GRUPOS = new Map();

if (!fs.existsSync(BODEGA_DIR)) fs.mkdirSync(BODEGA_DIR, { recursive: true });
try {
  if (fs.existsSync(INV_FILE)) INV = JSON.parse(fs.readFileSync(INV_FILE, 'utf8'));
} catch (e) { console.log('No pude leer el inventario:', e.message); }

function guardar() {
  const tmp = INV_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(INV));
  fs.renameSync(tmp, INV_FILE);   // escritura atómica: no se corrompe si se cae el bot
}
const esperar = ms => new Promise(r => setTimeout(r, ms));

process.on('unhandledRejection', e => console.log('unhandledRejection:', e?.message || e));

/* ================= TALLAS ================= */
const enRango = n => n >= 28 && n <= 44;

// Talla con prefijo: Eu37, EUR 37, Talla 38, T:39, #40 (corrige confusiones típicas del OCR: O->0, I/L->1, S->5)
function tallasExplicitas(texto) {
  if (!texto) return [];
  const s = texto.toString().toUpperCase().replace(/\s+/g, ' ');
  const re = /(?:\b(?:EU(?:RO?)?|TALLA|TAL|T)|#)\s*[:.\-]?\s*([2-4][0-9OILS])(?!\d)/g;
  const out = new Set();
  let m;
  while ((m = re.exec(s))) {
    const n = parseInt(m[1].replace(/O/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5'), 10);
    if (enRango(n)) out.add(String(n));
  }
  return [...out];
}

// Cualquier número de 28 a 44 que no sea parte de un número más largo
function tallasSueltas(texto) {
  if (!texto) return [];
  const m = texto.toString().match(/(?<!\d)(2[89]|3\d|4[0-4])(?!\d)/g);
  return m ? [...new Set(m)] : [];
}

// Para textos escritos por personas (captions): primero con prefijo, si no, sueltas
function tallas(texto) {
  const e = tallasExplicitas(texto);
  return e.length ? e : tallasSueltas(texto);
}

/* ================= OCR ================= */
let worker = null;
async function getWorker() {
  if (!worker) worker = await Tesseract.createWorker('eng');   // se crea UNA vez y se reutiliza (antes se recreaba en cada lectura)
  return worker;
}
async function ocr(buffer) {
  const w = await getWorker();
  await w.setParameters({ tessedit_pageseg_mode: '6' });
  const { data: { text } } = await w.recognize(buffer);
  return text || '';
}

// Lee la talla escrita DENTRO de la foto. Devuelve un arreglo, ej: ['37']
async function detectarTallas(file) {
  let textoTop = '';
  try {
    const norm = await sharp(file).rotate().toBuffer();   // respeta la rotación EXIF
    const { width: W, height: H } = await sharp(norm).metadata();
    const pasadas = [
      { n: 'TOP35', h: 0.35, w: 1800 },
      { n: 'TOP55', h: 0.55, w: 1800 },
      { n: 'TOP45_BN', h: 0.45, w: 2000, thr: 140 },   // blanco y negro puro
      { n: 'TOP45_NEG', h: 0.45, w: 2000, neg: true },  // letras claras sobre fondo oscuro
      { n: 'FULL', h: 1, w: 1600 }
    ];
    for (const p of pasadas) {
      try {
        let img = sharp(norm);
        if (p.h < 1) img = img.extract({ left: 0, top: 0, width: W, height: Math.floor(H * p.h) });
        img = img.resize({ width: p.w }).grayscale();
        img = p.thr ? img.threshold(p.thr) : img.normalize().sharpen();
        if (p.neg) img = img.negate();
        const txt = await ocr(await img.png().toBuffer());
        console.log(`OCR ${p.n}: [${txt.trim().replace(/\n/g, ' ').slice(0, 80)}]`);
        const exp = tallasExplicitas(txt);
        if (exp.length) { console.log(`Talla (con prefijo) en ${p.n}: ${exp}`); return exp; }  // ya la encontró, no sigue
        if (p.h < 1) textoTop += ' ' + txt;
      } catch (e) { console.log(`OCR fallo ${p.n}:`, e.message); }
    }
    // Sin prefijo: solo se acepta si en la parte de arriba hay 1 o 2 números candidatos (más que eso es ruido)
    const sueltas = tallasSueltas(textoTop);
    if (sueltas.length && sueltas.length <= 2) { console.log(`Talla (suelta) en zona superior: ${sueltas}`); return sueltas; }
    return [];
  } catch (e) { console.log('OCR error', e.message); return []; }
}

/* ================= IA DE VISIÓN ================= */
async function paraIA(file, ancho = 1280) {   // se reduce la foto para gastar menos
  const buf = await sharp(file).rotate().resize({ width: ancho, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } };
}
const textoDe = r => (r.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
function jsonDe(texto) {
  const m = texto.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

// Devuelve un arreglo (puede ser vacío si la IA no ve talla) o null si la IA falló
async function tallasConIA(file) {
  if (!IA) return null;
  try {
    const r = await IA.messages.create({
      model: MODELO_IA, max_tokens: 100,
      messages: [{ role: 'user', content: [
        await paraIA(file),
        { type: 'text', text: 'Esta es una foto de un calzado. En algún lugar de la imagen hay una talla escrita (por ejemplo "Eu37", "37", "Talla 38"); puede estar en cualquier posición, tamaño, color o inclinación. Devuelve SOLO JSON con este formato: {"tallas":["37"]}. Solo tallas entre 28 y 44. Si no ves ninguna talla escrita en la imagen, devuelve {"tallas":[]}. No adivines la talla por la forma del zapato.' }
      ] }]
    });
    const j = jsonDe(textoDe(r));
    const t = (j?.tallas || []).map(x => String(x).replace(/\D/g, '')).filter(x => enRango(parseInt(x, 10)));
    return [...new Set(t)];
  } catch (e) { console.log('IA tallas error:', e.message); return null; }
}

// Primero IA; si no hay IA o falla, OCR
async function detectarTallasPro(file) {
  const ia = await tallasConIA(file);
  if (ia) { console.log(`IA leyó talla: [${ia}]`); return ia; }
  return detectarTallas(file);
}

// Le muestra a la IA la foto del cliente y las candidatas de esa talla. Devuelve 0 (ninguna), 1..N (cuál), o null si falló
async function elegirConIA(fileCliente, cands) {
  try {
    const content = [{ type: 'text', text: 'FOTO DEL CLIENTE:' }, await paraIA(fileCliente, 900)];
    for (let i = 0; i < cands.length; i++) {
      content.push({ type: 'text', text: `OPCION ${i + 1}:` });
      content.push(await paraIA(cands[i].it.file, 900));
    }
    content.push({ type: 'text', text: 'Dime cuál OPCION es exactamente el mismo modelo de calzado de la foto del cliente (mismo diseño, colores, suela y detalles). Ignora el texto o la talla escritos en las fotos y el fondo. Si ninguna es el mismo modelo, responde 0. Devuelve SOLO JSON: {"opcion":N,"confianza":"alta"|"media"|"baja"}' });
    const r = await IA.messages.create({ model: MODELO_IA, max_tokens: 100, messages: [{ role: 'user', content }] });
    const j = jsonDe(textoDe(r));
    const n = parseInt(j?.opcion, 10);
    console.log(`IA comparó ${cands.length} opciones -> ${JSON.stringify(j)}`);
    if (Number.isNaN(n) || n < 0 || n > cands.length) return null;
    if (n > 0 && j.confianza === 'baja') return 0;
    return n;
  } catch (e) { console.log('IA elegir error:', e.message); return null; }
}

/* ================= COMPARAR FOTOS ================= */
// Huella: gris 32x32 (forma) + color 8x8 (para no confundir negro con blanco)
async function huella(file) {
  const base = sharp(file).rotate();
  const g = await base.clone().resize(32, 32, { fit: 'fill' }).grayscale().raw().toBuffer();
  const c = await base.clone().resize(8, 8, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  return { g: Array.from(g), c: Array.from(c) };
}
function ncc(a, b) {   // correlación normalizada: ignora diferencias de brillo/contraste
  const n = Math.min(a.length, b.length);
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  const den = Math.sqrt(da * db);
  return den ? num / den : 0;
}
function colorSim(a, b) {
  const n = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < n; i++) d += Math.abs(a[i] - b[i]);
  return 100 - (d / n / 255 * 100);
}
function parecido(hc, it) {
  const forma = Math.max(0, ncc(hc.g, it.h)) * 100;
  if (!it.c) return forma;                       // items viejos sin color
  return forma * 0.6 + colorSim(hc.c, it.c) * 0.4;
}

/* ================= COLA (un trabajo a la vez) ================= */
function encolar(sock, job) { COLA.push(job); correrCola(sock); }

async function correrCola(sock) {
  if (OCUPADO) return;
  OCUPADO = true;
  while (COLA.length) {
    const job = COLA.shift();
    try {
      if (job.tipo === 'bodega') await procesarBodega(sock, job);
      else await procesarCliente(sock, job);
    } catch (e) { console.log('Error en cola:', e.message); }
  }
  OCUPADO = false;
}

async function procesarBodega(sock, { msg, file, caption, from }) {
  let t = tallas(caption);                         // lo que escribió una persona manda sobre el OCR
  let origen = 'texto del mensaje';
  if (!t.length) { t = await detectarTallasPro(file); origen = 'la foto'; }
  const sinTalla = t.length === 0;
  if (sinTalla) t = ['sin-talla'];
  const h = await huella(file);
  INV.push({ id: msg.key.id, tallas: t, file, h: h.g, c: h.c });
  guardar();
  const aviso = sinTalla
    ? `⚠️ Guardada SIN talla (no la pude leer). Responde a esa foto con "talla 38" para corregirla. Total ${INV.length}`
    : `✅ Guardado talla ${t.join('-')} (leída de ${origen}) · total ${INV.length}`;
  await sock.sendMessage(from, { text: aviso });
}

async function procesarCliente(sock, { tmp, caption, cliente }) {
  try {
    let tPedido = await detectarTallasPro(tmp);
    if (!tPedido.length && caption) tPedido = tallas(caption);
    console.log(`Talla pedida: [${tPedido}] caption[${caption}]`);
    if (!tPedido.length) { console.log('Sin talla en la foto, callado'); return; }

    const hc = await huella(tmp);
    const cand = INV
      .filter(it => it.tallas.some(x => tPedido.includes(x)) && fs.existsSync(it.file))
      .map(it => ({ it, s: parecido(hc, it) }))
      .sort((a, b) => b.s - a.s);
    console.log(`Candidatos talla ${tPedido}: ${cand.length} | top3: ${cand.slice(0, 3).map(c => c.s.toFixed(1) + '%').join(', ')}`);
    if (!cand.length) { console.log('No hay fotos de esa talla en el inventario, callado'); return; }

    let best;
    const eleccion = IA ? await elegirConIA(tmp, cand.slice(0, MAX_CAND_IA)) : null;   // la huella solo ordena; la IA decide
    if (eleccion !== null) {
      if (eleccion === 0) { console.log('IA: ninguna es el mismo modelo, callado'); return; }
      best = cand[eleccion - 1];
    } else {                                   // sin IA (o falló): se usa solo la huella con el umbral
      best = cand[0];
      if (best.s < UMBRAL) { console.log('No parecido suficiente, callado'); return; }
    }

    const talla = best.it.tallas.find(x => tPedido.includes(x));
    await esperar(PAUSA_MIN + Math.random() * (PAUSA_MAX - PAUSA_MIN));
    await sock.sendMessage(cliente, {
      image: fs.readFileSync(best.it.file),
      caption: `La tengo disponible asi como en la foto - Talla ${talla} ✅`
    });
    console.log(`Enviado talla ${talla} a ${cliente} (${best.s.toFixed(1)}%)`);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/* ================= UTILIDADES WHATSAPP ================= */
async function nombreGrupo(sock, jid) {
  const c = CACHE_GRUPOS.get(jid);
  if (c && Date.now() - c.t < 10 * 60 * 1000) return c.n;   // cache 10 min (antes consultaba en CADA mensaje)
  try {
    const md = await sock.groupMetadata(jid);
    const n = md?.subject || '';
    CACHE_GRUPOS.set(jid, { n, t: Date.now() });
    return n;
  } catch { return c?.n || ''; }
}
const descargar = (sock, msg) =>
  downloadMediaMessage(msg, 'buffer', {}, { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });

/* ================= MENSAJES ================= */
async function manejar(sock, msg) {
  if (!msg?.message) return;
  const from = msg.key.remoteJid;
  if (!from || from === 'status@broadcast') return;

  const ts = Number(msg.messageTimestamp?.toString() || 0);
  if (ts && Date.now() / 1000 - ts > EDAD_MAX_SEG) return;

  const esGrupo = from.endsWith('@g.us');
  const m = normalizeMessageContent(msg.message) || msg.message;   // abre mensajes temporales / ver una vez
  const txt = (m.conversation || m.extendedTextMessage?.text || '').toLowerCase().trim();
  const sender = (msg.key.participant || from).split('@')[0].split(':')[0];
  const esAdmin = !!msg.key.fromMe || ADMINS.includes(sender);
  const gname = esGrupo ? await nombreGrupo(sock, from) : '';
  console.log(`LLEGO [${gname || 'privado'}] de ${sender}${esAdmin ? ' (admin)' : ''} txt=[${txt}]${m.imageMessage ? ' +imagen' : ''}`);

  /* ---- Comandos (solo admins) ---- */
  if (esAdmin && txt) {
    if (['pausar', 'pausa'].includes(txt)) { ACTIVO = false; await sock.sendMessage(from, { text: '⏸️ Pausado' }); return; }
    if (['comenzar', 'reanudar', 'play', 'activar'].includes(txt)) { ACTIVO = true; await sock.sendMessage(from, { text: '▶️ Activo' }); return; }
    if (['borrar todo', 'borrar inventario', 'vaciar', 'limpiar'].includes(txt)) {
      const c = INV.length; INV = []; guardar();
      try { fs.readdirSync(BODEGA_DIR).forEach(f => { try { fs.unlinkSync(`${BODEGA_DIR}/${f}`); } catch {} }); } catch {}
      await sock.sendMessage(from, { text: `🗑️ Borrado ${c}` }); return;
    }
    if (['inventario', 'stock'].includes(txt)) {
      const por = {};
      INV.forEach(i => i.tallas.forEach(t => { por[t] = (por[t] || 0) + 1; }));
      const detalle = Object.keys(por).sort().map(t => `${t}: ${por[t]}`).join(' · ');
      await sock.sendMessage(from, { text: `📦 ${INV.length} fotos\n${detalle}` }); return;
    }
  }

  /* ---- Grupo de inventario (bodega) ---- */
  if (esGrupo && gname.toLowerCase().includes(GRUPO_BODEGA)) {
    const im = m.imageMessage;
    if (im) {
      const buf = await descargar(sock, msg);
      const file = `${BODEGA_DIR}/${Date.now()}_${Math.floor(Math.random() * 1000)}.jpg`;
      fs.writeFileSync(file, buf);
      encolar(sock, { tipo: 'bodega', msg, file, caption: im.caption || '', from });
      return;
    }
    // Responder a una foto del inventario: "vendido" la quita, "talla 38" corrige la talla
    const quotedId = m.extendedTextMessage?.contextInfo?.stanzaId;
    if (esAdmin && quotedId && txt) {
      const idx = INV.findIndex(x => x.id === quotedId);
      if (['vendido', 'vendida', 'agotado', 'agotada'].includes(txt)) {
        if (idx < 0) { await sock.sendMessage(from, { text: 'No encontré esa foto en el inventario' }); return; }
        const [it] = INV.splice(idx, 1);
        try { fs.unlinkSync(it.file); } catch {}
        guardar();
        await sock.sendMessage(from, { text: `🗑️ Quitada (talla ${it.tallas.join('-')}) · total ${INV.length}` }); return;
      }
      const mt = txt.match(/^talla\s+(.+)$/);
      if (mt) {
        const t = tallas(mt[1]);
        if (idx < 0 || !t.length) { await sock.sendMessage(from, { text: 'No pude corregir: revisa que respondas a la foto y escribas ej. "talla 38"' }); return; }
        INV[idx].tallas = t; guardar();
        await sock.sendMessage(from, { text: `✏️ Talla corregida a ${t.join('-')}` }); return;
      }
    }
    return;
  }

  /* ---- Grupo de clientes ---- */
  if (!esGrupo || !ACTIVO) return;
  if (!GRUPOS_CLIENTES.includes(gname.trim().toLowerCase())) return;
  if (msg.key.fromMe && !RESPONDER_A_MIS_FOTOS) return;
  const im = m.imageMessage;
  if (!im) return;

  const cliente = msg.key.participant;
  if (!cliente) { console.log('No pude saber quién envió la foto (sin participant)'); return; }

  const buf = await descargar(sock, msg);
  const tmp = `${BODEGA_DIR}/tmp_${Date.now()}_${Math.floor(Math.random() * 1000)}.jpg`;
  fs.writeFileSync(tmp, buf);
  encolar(sock, { tipo: 'cliente', tmp, caption: im.caption || '', cliente });
  console.log(`En cola ${COLA.length}`);
}

/* ================= CONEXIÓN ================= */
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const sock = makeWASocket({ auth: state, logger: P({ level: 'silent' }), browser: ['JM', 'Chrome', '1.0'] });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', u => {
    if (u.qr) {
      qrcode.generate(u.qr, { small: true });
      console.log(`LINK QR: https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(u.qr)}`);
    }
    if (u.connection === 'open') console.log('CONECTADO INV:' + INV.length);
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) setTimeout(start, 3000);
      else console.log('Sesión cerrada desde el celular. Borra SOLO los archivos creds/app-state de ./auth (no inventario_fotos.json ni bodega/) y vuelve a escanear el QR.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {     // antes solo se leía messages[0] y se perdían mensajes en ráfaga
      try { await manejar(sock, msg); }
      catch (e) { console.log('skip', e.message); }
    }
  });
}
start();
