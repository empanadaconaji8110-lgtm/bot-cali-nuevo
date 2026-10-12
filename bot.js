const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const P = require('pino');

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    browser: ["JM Cali", "Chrome", "1.0"]
  });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      console.log('\n\n======== ESCANEA ESTE QR =========\n');
      qrcode.generate(qr, { small: true });
      console.log('\nWhatsApp > Dispositivos vinculados > Vincular dispositivo > Escanea el QR\n');
    }
    if (connection === 'open') {
      console.log('✅ CONECTADO A WHATSAPP - BOT JM CALI ACTIVO ✅');
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode!== DisconnectReason.loggedOut;
      if (shouldReconnect) start();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]; if (!msg?.message) return;
    const from = msg.key.remoteJid; if (!from.endsWith('@g.us')) return;
    const group = await sock.groupMetadata(from).catch(()=>null);
    if (group?.subject!== 'CALI CARTEL 4.0') return;
    if (!msg.message.imageMessage) return;
    const participante = msg.key.participant;
    const texto = `Hola! Vi que pediste en CALI CARTEL 4.0 👟\n\n👟 Talla que TENGO: 36 a la 39 y 40 a la 44\n💰 Precio: $95.000\n\n¿Te lo separo? - JM Cali Sport Shoes`;
    await sock.sendMessage(participante, { text: texto });
    console.log('Respondido a ' + participante);
  });
}
start();
