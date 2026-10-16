const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const P = require('pino');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const sharp = require('sharp');
const 【entity-Tesseract¦canonical_name=Tesseract】 = require('【entity-tesseract¦canonical_name=Tesseract】.js');

let ACTIVO = true;
let INV = [];
let COLA = [];
let OCUPADO = false;

const BODEGA_DIR = './auth/bodega';
const INV_FILE = './auth/inventario_fotos.json';

if (!fs.existsSync(BODEGA_DIR)) fs.mkdirSync(BODEGA_DIR, { recursive: true });
try {
  if (fs.existsSync(INV_FILE)) INV = JSON.parse(fs.readFileSync(INV_FILE, 'utf8'));
} catch {}
async function guardar() {
  await fsp.writeFile(INV_FILE, JSON.stringify(INV, null, 2));
}

// --- FIX 1: TALLAS ROBUSTA Y SIN DESTRUIR TEXTO ---
function tallas(texto) {
  if (!texto) return [];
  let t = texto.toString().toLowerCase();
  // Normaliza solo lo relevante
  t = t.replace(/eur|talla|tall|size/gi, ' ');
  // Busca 28 a 44, permitiendo que OCR ponga o/q por 0
  // Ej: "38", "3 8", "Eur 38"
  const candidatos = t.match(/\b[2-4]\s*[0-9]\b/g) || [];
  const limpios = candidatos.map(c =>
    c.replace(/\s/g,'')
    .replace(/[oq]/g,'0')
    .replace(/[il]/g,'1')
  ).filter(n => {
    const num = parseInt(n);
    return num >= 28 && num <= 44;
  });
  return [...new Set(limpios)];
}

// --- FIX 2: OCR TRIPLE CON LIMPIEZA REAL ---
async function leerTextoFoto(pathOriginal) {
  let textoAcumulado = '';
  const tempFiles = [];

  const crearTemp = (sufijo) => path.join(BODEGA_DIR, `tmp_${Date.now()}_${sufijo}.jpg`);

  try {
    // A: Foto completa binarizada
    const p1 = crearTemp('a');
    tempFiles.push(p1);
    await sharp(pathOriginal).resize({ width: 2000 }).grayscale().normalize().sharpen().threshold(140).toFile(p1);
    const r1 = await Tesseract.recognize(p1, 'spa+eng', { psm: 6 });
    textoAcumulado += ' ' + r1.data.text;
    console.log(`OCR Full: [${r1.data.text.trim()}]`);

    // B: Crop central - sticker Eur 38 (15% a 55% altura)
    const meta = await sharp(pathOriginal).metadata();
    const p2 = crearTemp('b');
    tempFiles.push(p2);
    const cropHeight = Math.floor(meta.height * 0.45);
    const cropTop = Math.floor(meta.height * 0.10);
    await sharp(pathOriginal)
     .extract({ left: 0, top: cropTop, width: meta.width, height: cropHeight })
     .resize({ width: meta.width * 2 })
     .grayscale().normalize().sharpen().threshold(150)
     .toFile(p2);
    const r2 = await 【entity-Tesseract¦canonical_name=Tesseract】.recognize(p2, 'spa+eng', { psm: 7 });
    textoAcumulado += ' ' + r2.data.text;
    console.log(`OCR Crop Centro: [${r2.data.text.trim()}]`);

    // C: Crop inferior - a veces ponen talla abajo
    const p3 = crearTemp('c');
    tempFiles.push(p3);
    const bottomTop = Math.floor(meta.height * 0.65);
    await sharp(pathOriginal)
     .extract({ left: 0, top: bottomTop, width: meta.width, height: meta.height - bottomTop })
     .resize({ width: meta.width * 2 })
     .grayscale().normalize().sharpen()
     .toFile(p3);
    const r3 = await Tesseract.recognize(p3, 'spa+eng', { psm: 6 });
    textoAcumulado += ' ' + r3.data.text;
    console.log(`OCR Crop Abajo: [${r3.data.text.trim()}]`);

  } catch (e) {
    console.log('OCR error', e.message);
  } finally {
    for (const f of tempFiles) { try { await fsp.unlink(f); } catch {} }
  }
  console.log(`OCR TOTAL -> Tallas: ${tallas(textoAcumulado)}`);
  return textoAcumulado;
}

async function hash(file) {
  // Hash más estable: 8x8 binarizado
  const b = await sharp(file).resize(8, 8).grayscale().threshold(128).raw().toBuffer();
  return b;
}

function parecido(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return 100 - (d / a.length / 255 * 100);
}

async function procesarCola(sock) {
  if (OCUPADO || COLA.length === 0) return;
  OCUPADO = true;
  const { msg, tmp, caption } = COLA.shift();
  console.log(`Procesando cola, quedan: ${COLA.length}`);

  try {
    await new Promise(r => setTimeout(r, 5000)); // anti-spam

    const tallaDeCaption = tallas(caption);
    console.log(`Talla en caption: ${tallaDeCaption}`);

    const textoDeFoto = await leerTextoFoto(tmp);
    const tallaDeFoto = tallas(textoDeFoto);
    console.log(`Talla quemada en imagen: ${tallaDeFoto}`);

    let tPedido = [...new Set([...tallaDeCaption,...tallaDeFoto])];
    console.log(`Talla FINAL: ${tPedido}`);

    if (tPedido.length === 0) {
      console.log('Sin talla, skip');
      try { await fsp.unlink(tmp); } catch {}
      return;
    }

    const hC = await hash(tmp);
    try { await fsp.unlink(tmp); } catch {}

    let best = null, bestS = 0;
    for (const it of INV) {
      if (!it.tallas.some(x => tPedido.includes(x))) continue;
      if (!fs.existsSync(it.file)) continue; // archivo borrado
      try {
        const hItem = Buffer.from(it.h);
        const s = parecido(hC, hItem);
        if (s > bestS) { bestS = s; best = it; }
      } catch {}
    }

    console.log(`Pedido ${tPedido} mejor ${bestS.toFixed(1)}%`);

    if (!best || bestS < 75) { // subí a 75 para evitar falsos positivos
      console.log('No tengo esa talla/modelo con confianza');
      return;
    }

    const destino = msg.key.participantAlt || msg.key.participant || msg.pushName;
    if (!destino) {
      console.log('No se pudo resolver destino');
      return;
    }

    await sock.sendMessage(destino, {
      image: fs.readFileSync(best.file),
      caption: `La tengo disponible así como en la foto - Talla ${tPedido[0]} ✅`
    });
    console.log('Enviado al privado a', destino);

  } catch (e) {
    console.log('Error en cola', e.message);
    try { await fsp.unlink(tmp); } catch {}
  } finally {
    OCUPADO = false;
    if (COLA.length > 0) setTimeout(() => procesarCola(sock), 1000);
  }
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    browser: ["JM", "Chrome", "1.0"],
    markOnlineOnConnect: false
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', u => {
    if (u.qr) {
      qrcode.generate(u.qr, { small: true });
      console.log('Escanea el QR en terminal');
    }
    if (u.connection === 'open') console.log('CONECTADO INV:', INV.length);
    if (u.connection === 'close' && u.lastDisconnect?.error?.output?.statusCode!== DisconnectReason.loggedOut) start();
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg?.message) return;
      const from = msg.key.remoteJid;
      let gname = '';
      try { const m = await sock.groupMetadata(from); gname = m?.subject || ''; } catch {}

      const txt = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').toLowerCase().trim();

      if (txt === 'pausar' || txt === 'pausa') { ACTIVO = false; await sock.sendMessage(from, { text: '⏸️ Pausado' }); return; }
      if (txt === 'comenzar' || txt === 'reanudar' || txt === 'play') { ACTIVO = true; await sock.sendMessage(from, { text: '▶️ Activo' }); return; }

      const im = msg.message.imageMessage;
      if (!im) return;

      // GRUPO BODEGA - GUARDAR
      if (gname.toLowerCase().includes('bodega')) {
        const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        const filePath = path.join(BODEGA_DIR, `${Date.now()}.jpg`);
        await fsp.writeFile(filePath, buf);

        let texto = (im.caption || '') + ' ' + await leerTextoFoto(filePath);
        let t = tallas(texto);
        if (t.length === 0) t = ['sin-talla'];

        const h = await hash(filePath);
        INV.push({ tallas: t, file: filePath, h: Array.from(h), fecha: Date.now() });
        await guardar();
        await sock.sendMessage(from, { text: `Guardado ${t.join('-')} total ${INV.length}` });
        return;
      }

      // GRUPO PEDIDOS
      if (!from.endsWith('@g.us')) return;
      if (!ACTIVO) return;
      if (gname.trim().toLowerCase()!== 'cali cartel 4.0 prueba') return;

      const bufC = await downloadMediaMessage(msg, 'buffer', {}, { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
      const tmp = path.join(BODEGA_DIR, `tmp_${Date.now()}.jpg`);
      await fsp.writeFile(tmp, bufC);
      COLA.push({ msg, tmp, caption: im.caption || '' });
      procesarCola(sock);

    } catch (e) { console.log('skip', e.message); }
  });
}

start();
