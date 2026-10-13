const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const P = require('pino');
const fs = require('fs');
const { pipeline } = require('@xenova/transformers');

let BOT_ACTIVO = true;
let INVENTARIO = [];
let extractor = null;

if (!fs.existsSync('./auth/bodega')) fs.mkdirSync('./auth/bodega', { recursive: true });
try { if (fs.existsSync('./auth/inventario_ia.json')) INVENTARIO = JSON.parse(fs.readFileSync('./auth/inventario_ia.json')); } catch {}
function guardar() { fs.writeFileSync('./auth/inventario_ia.json', JSON.stringify(INVENTARIO)); }
function extraerTallas(t) { const m = t.match(/\b(2[8-9]|3[0-9]|4[0-4])\b/g); return m? [...new Set(m)] : []; }

async function getEmbedding(filePath) {
  if (!extractor) extractor = await pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32');
  const output = await extractor(filePath);
  return Array.from(output.data);
}
function cosine(a,b){
  let dot=0, na=0, nb=0;
  for(let i=0;i<a.length;i++){ dot+=a[i]*b[i]; na+=a[i]*a[i]; nb+=b[i]*b[i]; }
  return dot/(Math.sqrt(na)*Math.sqrt(nb));
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const sock = makeWASocket({ auth: state, logger: P({ level: 'silent' }), browser: ["JM Cali", "Chrome", "1.0"] });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (u) => {
    if (u.qr) {
      // ESTE ES EL LINK QUE ABRES EN RAILWAY
      const qrLink = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(u.qr)}`;
      console.log('========================================');
      console.log('🔗 ABRE ESTE LINK PARA VER EL QR:');
      console.log(qrLink);
      console.log('========================================');
      qrcode.generate(u.qr, { small: true });
    }
    if (u.connection === 'open') console.log('✅ CONECTADO CON IA + QR LINK ACTIVO');
    if (u.connection === 'close' && u.lastDisconnect?.error?.output?.statusCode!== DisconnectReason.loggedOut) start();
  });
