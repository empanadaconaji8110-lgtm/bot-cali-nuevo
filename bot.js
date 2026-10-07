const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const P = require('pino');

let BOT_ACTIVO = true;
let BODEGA = [{ nombre: "Zapatilla JM Sport", tallas: "36 a la 39 y 40 a la 44", precio: "$95.000" }];

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ["JM Cali", "Chrome", "1.0"]
  });

  sock.ev.on('creds.update', saveCreds);

  if (!state.creds.registered) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const code = await sock.requestPairingCode('573005517791');
      console.log(`\n\n============================\nTU CODIGO ES: ${code}\nVe a WhatsApp > Dispositivos vinculados > Vincular con numero de telefono > pega ese codigo\n============================\n\n`);
    } catch(e){ console.log('Error pidiendo codigo', e.message); }
  }

  sock.ev.on('connection.update', (u) => {
    if (u.connection === 'open') console.log('✅ BOT CONECTADO - JM Cali Sport Shoes ACTIVO');
    if (u.connection === 'close') {
      const reason = u.lastDisconnect?.error?.output?.statusCode;
      if (reason!== DisconnectReason.loggedOut) start();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;
    const from = msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us');
    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').toLowerCase().trim();
    const hasImage =!!msg.message.imageMessage;

    // Comandos privados para pausar
    if (!isGroup) {
      if (text === 'pausar' || text === 'pausa') { BOT_ACTIVO = false; await sock.sendMessage(from, { text: '⏸️ Bot PAUSADO. Escribe "comenzar" para activar' }); return; }
      if (text === 'comenzar' || text === 'activar') { BOT_ACTIVO = true; await sock.sendMessage(from, { text: '▶️ Bot ACTIVADO ✅' }); return; }
    }

    if (!BOT_ACTIVO) return;

    try {
      const groupInfo = isGroup? await sock.groupMetadata(from).catch(()=>null) : null;
      const groupName = groupInfo?.subject || '';
      if (groupName!== 'CALI CARTEL 4.0') return;
      if (!hasImage) return;

      const participante = msg.key.participant;
      if (!participante) return;

      const item = BODEGA[0];
      const respuesta = `Hola! Vi que pediste en CALI CARTEL 4.0 👟\n\n👟 ${item.nombre}\n👣 Tallas que TENGO: ${item.tallas}\n💰 Precio: ${item.precio}\n\n¿Te lo separo? - JM Cali Sport Shoes`;

      await sock.sendMessage(participante, { text: respuesta });
      console.log(`Respondido a ${participante}`);
    } catch(e){ console.log(e.message); }
  });
}

start();
