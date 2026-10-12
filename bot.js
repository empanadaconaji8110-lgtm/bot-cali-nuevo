const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const P = require('pino');

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const sock = makeWASocket({ 
    auth: state, 
    logger: P({ level: 'silent' }), 
    printQRInTerminal: true, // Ahora imprime QR
    browser: ["JM Cali", "Chrome", "1.0"] 
  });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (u) => {
    if (u.qr) console.log('Escanea el QR de arriba en WhatsApp > Dispositivos vinculados');
    if (u.connection === 'open') console.log('✅ CONECTADO');
  });
}
start();
