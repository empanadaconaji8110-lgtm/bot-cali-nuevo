const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const P = require('pino');
const fs = require('fs');
const sharp = require('sharp');

let ACTIVO = true;
let INV = [];

if (!fs.existsSync('./auth/bodega')) fs.mkdirSync('./auth/bodega', {recursive:true});
try {
  if (fs.existsSync('./auth/inventario_fotos.json'))
    INV = JSON.parse(fs.readFileSync('./auth/inventario_fotos.json'));
} catch {}

function guardar(){ fs.writeFileSync('./auth/inventario_fotos.json', JSON.stringify(INV)); }
function tallas(t){ const m=t.match(/\b(2[8-9]|3[0-9]|4[0-4])\b/g); return m? [...new Set(m)] : []; }

async function hash(file){
  try{
    const b = await sharp(file).resize(8,8).grayscale().raw().toBuffer();
    return b;
  }catch{ return null }
}
function parecido(a,b){
  if(!a||!b) return 0;
  let d=0; for(let i=0;i<a.length;i++) d+=Math.abs(a[i]-b[i]);
  return 100 - (d / a.length / 255 * 100);
}

async function start(){
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const sock = makeWASocket({
    auth: state,
    logger: P({level:'silent'}),
    browser: ["JM","Chrome","1.0"],
    printQRInTerminal: false,
    shouldIgnoreJid: jid => false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', u=>{
    if (u.qr){
      qrcode.generate(u.qr, {small:true});
      console.log(`LINK QR RAILWAY: https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(u.qr)}`);
    }
    if (u.connection==='open') console.log('CONECTADO PRUEBA OK');
    if (u.connection==='close'){
      const c = u.lastDisconnect?.error?.output?.statusCode;
      if(c!== DisconnectReason.loggedOut) start();
    }
  });

  sock.ev.on('messages.upsert', async (m)=>{
   try{
    const msg = m.messages[0];
    if(!msg?.message) return;
    const from = msg.key.remoteJid;
    if(!from) return;

    // ignora errores de cifrado
    let gname = '';
    try{
      const meta = await sock.groupMetadata(from);
      gname = meta?.subject || '';
    }catch{}

    const txt = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').toLowerCase();

    if (gname === 'BODEGA JM'){
      const im = msg.message.imageMessage;
      if (im){
        const t = tallas((im.caption||'').toLowerCase());
        if (t.length>0){
          try{
            const buf = await downloadMediaMessage(msg, 'buffer', {}, {logger:P({level:'silent'}), reuploadRequest: sock.updateMediaMessage});
            const path = `./auth/bodega/${Date.now()}.jpg`;
            fs.writeFileSync(path, buf);
            const h = await hash(path);
            if(h){
              INV.push({tallas:t, file:path, h:Array.from(h)});
              guardar();
              await sock.sendMessage(from, {text:`Guardado ${t.join('-')} total ${INV.length}`});
            }
          }catch(e){ console.log('error guardando', e.message) }
        }
      }
      if (txt==='borrar todo'){ INV=[]; guardar(); await sock.sendMessage(from,{text:'Vaciado'}); }
      return;
    }

    if (!from.endsWith('@g.us')) return;
    if (!ACTIVO) return;
    if (gname!== 'CALI CARTEL4.0 PRUEBA') return;

    const im = msg.message.imageMessage; if(!im) return;
    const tPedido = tallas((im.caption||'').toLowerCase()); if(tPedido.length===0) return;

    try{
      const bufC = await downloadMediaMessage(msg, 'buffer', {}, {logger:P({level:'silent'}), reuploadRequest: sock.updateMediaMessage});
      const tmp = `./auth/bodega/tmp_${Date.now()}.jpg`;
      fs.writeFileSync(tmp, bufC);
      const hC = await hash(tmp);
      try{ fs.unlinkSync(tmp); }catch{}

      let best=null, bestS=0;
      for(const it of INV){
        if(!it.tallas.some(x=>tPedido.includes(x))) continue;
        const s = parecido(hC, Buffer.from(it.h));
        if(s>bestS){ bestS=s; best=it; }
      }
      console.log(`SIM ${bestS.toFixed(1)}% para ${tPedido}`);

      if(!best || bestS<70) return;

      await sock.sendMessage(msg.key.participant, {
        image: fs.readFileSync(best.file),
        caption: `Talla ${tPedido[0]} disponible - similar ${bestS.toFixed(0)}% - JM Cali`
      });
    }catch(e){
      console.log('skip decrypt message', e.message);
    }
   }catch(e){
     console.log('Error general ignorado:', e.message);
   }
  });
}
start();
