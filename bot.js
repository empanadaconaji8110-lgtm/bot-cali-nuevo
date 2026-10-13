const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const P = require('pino');
const fs = require('fs');
const sharp = require('sharp');
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
    if (u.qr) qrcode.generate(u.qr, { small: true });
    if (u.connection === 'open') console.log('✅ CONECTADO CON IA DE FOTOS');
    if (u.connection === 'close' && u.lastDisconnect?.error?.output?.statusCode!== DisconnectReason.loggedOut) start();
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]; if (!msg?.message) return;
    const from = msg.key.remoteJid;
    const group = await sock.groupMetadata(from).catch(()=>null);
    const groupName = group?.subject || '';
    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').toLowerCase().trim();

    if (groupName === 'BODEGA JM') {
      const img = msg.message.imageMessage;
      if (img) {
        const caption = (img.caption || '').toLowerCase();
        const tallas = extraerTallas(caption);
        if (tallas.length>0) {
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
          const fileName = `./auth/bodega/${Date.now()}.jpg`;
          fs.writeFileSync(fileName, buffer);
          console.log('Calculando IA de foto...');
          const embedding = await getEmbedding(fileName);
          INVENTARIO.push({ tallas, file: fileName, embedding });
          guardar();
          await sock.sendMessage(from, { text: `✅ Guardé modelo ${tallas.join('-')} con IA. Total: ${INVENTARIO.length}` });
        }
      }
      if (text === 'pausar') { BOT_ACTIVO = false; await sock.sendMessage(from, { text: '⏸️ PAUSADO' }); return; }
      if (text === 'comenzar') { BOT_ACTIVO = true; await sock.sendMessage(from, { text: '▶️ ACTIVADO' }); return; }
      if (text === 'borrar todo') { INVENTARIO=[]; guardar(); await sock.sendMessage(from, { text: '🗑️ Vaciado' }); return; }
      return;
    }

    if (!from.endsWith('@g.us')) {
      if (text === 'pausar') { BOT_ACTIVO=false; await sock.sendMessage(from,{text:'⏸️ Pausado'}); return; }
      if (text === 'comenzar') { BOT_ACTIVO=true; await sock.sendMessage(from,{text:'▶️ Activado'}); return; }
      return;
    }

    if (!BOT_ACTIVO) return;
    if (groupName!== 'CALI CARTEL 4.0') return;
    const img = msg.message.imageMessage;
    if (!img) return;
    const tallasPedido = extraerTallas((img.caption || '').toLowerCase());
    if (tallasPedido.length===0) return;

    // Descarga foto del cliente y saca su IA
    const bufferCliente = await downloadMediaMessage(msg, 'buffer', {}, { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
    const tempFile = `./auth/bodega/temp_${Date.now()}.jpg`;
    fs.writeFileSync(tempFile, bufferCliente);
    const embCliente = await getEmbedding(tempFile);
    fs.unlinkSync(tempFile);

    // Busca la más parecida VISUALMENTE que además tenga la talla
    let mejor = null, mejorScore = 0;
    for (const item of INVENTARIO) {
      if (!item.tallas.some(t=> tallasPedido.includes(t))) continue; // debe tener la talla
      const score = cosine(embCliente, item.embedding);
      if (score > mejorScore) { mejorScore = score; mejor = item; }
    }

    console.log(`Mejor similitud: ${mejorScore}`);

    if (!mejor || mejorScore < 0.80) { // si no es 80% parecida, no responde
      console.log('No hay foto suficientemente parecida');
      return;
    }

    const tallaCliente = tallasPedido[0];
    await sock.sendMessage(msg.key.participant, {
      image: fs.readFileSync(mejor.file),
      caption: `Hola! Tengo disponible la talla ${tallaCliente} 👟\n\nEsta es la referencia parecida que tengo ✅\n💰 $95.000\n¿Te la separo? - JM Cali`
    });
  });
}
start();
