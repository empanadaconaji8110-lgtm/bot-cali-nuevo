const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const P = require('pino');

let BOT_ACTIVO = true; // true = responde, false = pausado

let BODEGA = [{ nombre: "Zapatilla JM Sport", tallas: "36 a la 39 y 40 a la 44", precio: "$95.000" }];

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const sock = makeWASocket({ auth: state, logger: P({ level: 'silent' }), browser: ["JM Cali", "Chrome", "1.0"] });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (u) => {
    const { connection, qr, lastDisconnect } = u;
    if (qr) {
      qrcode.generate(qr, { small: true });
      console.log(`LINK QR GRANDE: https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(qr)}`);
    }
    if (connection === 'open') console.log('✅ CONECTADO - BOT JM CALI ACTIVO');
    if (connection === 'close' && lastDisconnect?.error?.output?.statusCode!== DisconnectReason.loggedOut) start();
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]; if (!msg?.message) return;
    const from = msg.key.remoteJid;
    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').toLowerCase().trim();
    const isGroup = from.endsWith('@g.us');

    // COMANDOS PRIVADOS PARA TI
    if (!isGroup) {
      if (text === 'pausar' || text === 'pausa' || text === 'stop') {
        BOT_ACTIVO = false;
        await sock.sendMessage(from, { text: '⏸️ Bot PAUSADO. No responderá en CALI CARTEL. Escribe *comenzar* para activarlo.' });
        return;
      }
      if (text === 'comenzar' || text === 'activar' || text === 'reanudar') {
        BOT_ACTIVO = true;
        await sock.sendMessage(from, { text: '▶️ Bot ACTIVADO ✅ Ya responde en CALI CARTEL.' });
        return;
      }
      if (text.startsWith('bodega ')) {
        // Ej: bodega 36 a la 39 y 40 a la 44
        BODEGA[0].tallas = text.replace('bodega ', '');
        await sock.sendMessage(from, { text: `✅ Bodega actualizada: ${BODEGA[0].tallas}` });
        return;
      }
    }

    if (!BOT_ACTIVO) return; // Si está pausado no hace nada

    if (isGroup) {
      const group = await sock.groupMetadata(from).catch(()=>null);
      if (group?.subject!== 'CALI CARTEL 4.0') return;
      if (!msg.message.imageMessage) return;
      const participante = msg.key.participant;
      const item = BODEGA[0];
      const respuesta = `Hola! Vi que pediste en CALI CARTEL 4.0 👟\n\n👟 ${item.nombre}\n👣 Tallas que TENGO: ${item.tallas}\n💰 Precio: ${item.precio}\n\n¿Te lo separo? - JM Cali Sport Shoes`;
      await sock.sendMessage(participante, { text: respuesta });
    }
  });
}
start();
