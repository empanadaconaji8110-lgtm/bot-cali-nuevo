const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const P = require('pino');
const fs = require('fs');

let BOT_ACTIVO = true;
let INVENTARIO = [];

if (!fs.existsSync('./auth/bodega')) fs.mkdirSync('./auth/bodega', { recursive: true });
try {
  if (fs.existsSync('./auth/inventario_fotos.json')) {
    INVENTARIO = JSON.parse(fs.readFileSync('./auth/inventario_fotos.json'));
  }
} catch {}
function guardar() { fs.writeFileSync('./auth/inventario_fotos.json', JSON.stringify(INVENTARIO)); }

function extraerTallas(texto) {
  const m = texto.match(/\b(2[8-9]|3[0-9]|4[0-4])\b/g);
  return m? [...new Set(m)] : [];
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const sock = makeWASocket({ auth: state, logger: P({ level: 'silent' }), browser: ["JM Cali", "Chrome", "1.0"] });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (u) => {
    if (u.qr) {
      qrcode.generate(u.qr, { small: true });
      console.log(`LINK QR: https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(u.qr)}`);
    }
    if (u.connection === 'open') console.log('✅ CONECTADO - MANDA FOTO PARECIDA AL PRIVADO');
    if (u.connection === 'close' && u.lastDisconnect?.error?.output?.statusCode!== DisconnectReason.loggedOut) start();
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]; if (!msg?.message) return;
    const from = msg.key.remoteJid;
    const group = await sock.groupMetadata(from).catch(()=>null);
    const groupName = group?.subject || '';
    const textRaw = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const text = textRaw.toLowerCase().trim();

    // === BODEGA JM ===
    if (groupName === 'BODEGA JM') {
      const img = msg.message.imageMessage;
      if (img) {
        const caption = (img.caption || '').toLowerCase();
        const tallas = extraerTallas(caption);
        if (tallas.length > 0) {
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
          const fileName = `./auth/bodega/${Date.now()}.jpg`;
          fs.writeFileSync(fileName, buffer);
          INVENTARIO.push({ tallas, file: fileName });
          guardar();
          await sock.sendMessage(from, { text: `✅ Guardé ${tallas.join('-')}. Total: ${INVENTARIO.length}` });
        }
      }
      if (text === 'pausar') { BOT_ACTIVO = false; await sock.sendMessage(from, { text: '⏸️ PAUSADO' }); return; }
      if (text === 'comenzar') { BOT_ACTIVO = true; await sock.sendMessage(from, { text: '▶️ ACTIVADO' }); return; }
      if (text === 'inventario') { await sock.sendMessage(from, { text: `📦 ${INVENTARIO.length} fotos` }); return; }
      if (text === 'borrar todo') { INVENTARIO = []; guardar(); await sock.sendMessage(from, { text: '🗑️ Vaciado' }); return; }
      return;
    }

    if (!from.endsWith('@g.us')) {
      if (text === 'pausar') { BOT_ACTIVO = false; await sock.sendMessage(from, { text: '⏸️ Pausado' }); return; }
      if (text === 'comenzar') { BOT_ACTIVO = true; await sock.sendMessage(from, { text: '▶️ Activado' }); return; }
      return;
    }

    // === CALI CARTEL 4.0 ===
    if (!BOT_ACTIVO) return;
    if (groupName!== 'CALI CARTEL 4.0') return;
    const img = msg.message.imageMessage;
    if (!img) return;
    const tallasPedido = extraerTallas((img.caption || '').toLowerCase());
    if (tallasPedido.length === 0) return;

    const coincidencia = INVENTARIO.find(item => item.tallas.some(t => tallasPedido.includes(t)));
    if (!coincidencia) return;

    const tallaQuePidioCliente = tallasPedido[0]; // VARIA: 42, 38, 31 etc
    const participante = msg.key.participant;

    // MANDA LA PARECIDA AL PRIVADO PARA QUE SEPAS CUAL PIDIO
    await sock.sendMessage(participante, {
      image: fs.readFileSync(coincidencia.file),
      caption: `Hola! Tengo disponible la talla ${tallaQuePidioCliente} 👟\n\nEsta es la referencia parecida que tengo ✅\n💰 $95.000\n\n¿Te la separo? - JM Cali`
    });
  });
}
start();
