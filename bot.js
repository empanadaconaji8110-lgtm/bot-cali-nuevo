const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const P = require('pino');
const fs = require('fs');
const sharp = require('sharp');

let ACTIVO = true;
let INV = [];

if (!fs.existsSync('./auth/bodega')) fs.mkdirSync('./auth/bodega', {recursive:true});
try { if (fs.existsSync('./auth/inventario_fotos.json')) INV = JSON.parse(fs.readFileSync('./auth/inventario_fotos.json')); } catch {}

function guardar(){ fs.writeFileSync('./auth/inventario_fotos.json', JSON.stringify(INV)); }
function tallas(t){ const m=t.match(/\b(2[8-9]|3[0-9]|4[0-4])\b/g); return m? [...new Set(m)] : []; }
async function hash(file){ const b = await sharp(file).resize(8,8).grayscale().raw().toBuffer(); return b; }
function parecido(a,b){ let d=0; for(let i=0;i<a.length;i++) d+=Math.abs(a[i]-b[i]); return 100 - (d / a.length / 255 * 100); }

async function start(){
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const sock = makeWASocket({ auth: state, logger: P({level:'silent'}), browser: ["JM","Chrome","1.0"] });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', u=>{
    if (u.qr){
      qrcode.generate(u.qr, {small:true});
      console.log(`LINK QR: https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(u.qr)}`);
    }
    if (u.connection==='open') console.log('CONECTADO PRUEBA');
    if (u.connection==='close' && u.lastDisconnect?.error?.output?.statusCode!== DisconnectReason.loggedOut) start();
  });

  sock.ev.on('messages.upsert', async ({messages})=>{
   try{
    const msg = messages[0]; if(!msg?.message) return;
    const from = msg.key.remoteJid;
    let gname = '';
    try{ const meta = await sock.groupMetadata(from); gname = meta?.subject || ''; }catch{ gname = 'SIN-NOMBRE'; }

    const txt = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').toLowerCase().trim();

    console.log(`LLEGO: grupo=[${gname}] jid=${from} texto=[${txt}] activo=${ACTIVO} tieneImg=${!!msg.message.imageMessage}`);

    // COMANDOS - AHORA FUNCIONA AUNQUE EL NOMBRE VENGA RARO
    if (txt === 'pausar' || txt === 'pausa'){
      ACTIVO = false;
      await sock.sendMessage(from, {text:'⏸️ Bot pausado'});
      console.log('PAUSADO');
      return;
    }
    if (txt === 'comenzar' || txt === 'reanudar' || txt === 'play'){
      ACTIVO = true;
      await sock.sendMessage(from, {text:'▶️ Bot activo - ya respondo en PRUEBA'});
      console.log('ACTIVADO');
      return;
    }

    // BODEGA JM
    if (gname.toLowerCase().includes('bodega')){
      const im = msg.message.imageMessage;
      if (im){
        const t = tallas((im.caption||'').toLowerCase());
        if (t.length>0){
          const buf = await downloadMediaMessage(msg, 'buffer', {}, {logger:P({level:'silent'}), reuploadRequest: sock.updateMediaMessage});
          const path = `./auth/bodega/${Date.now()}.jpg`;
          fs.writeFileSync(path, buf);
          const h = await hash(path);
          INV.push({tallas:t, file:path, h:Array.from(h)});
          guardar();
          await sock.sendMessage(from, {text:`Guardado ${t.join('-')} total ${INV.length}`});
        }
      }
      if (txt==='borrar todo'){ INV=[]; guardar(); await sock.sendMessage(from,{text:'Vaciado'}); }
      return;
    }

    if (!from.endsWith('@g.us')) return;
    if (!ACTIVO){ console.log('IGNORADO POR PAUSA'); return; }
    if (!gname.toLowerCase().includes('prueba') &&!gname.includes('SIN-NOMBRE')){
      console.log('NO ES GRUPO PRUEBA');
      return;
    }

    const im = msg.message.imageMessage; if(!im){ console.log('SIN IMAGEN'); return; }
    const tPedido = tallas((im.caption||'').toLowerCase());
    if(tPedido.length===0){ console.log('SIN TALLA EN CAPTION'); return; }

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
    console.log(`SIM ${bestS.toFixed(1)}% para ${tPedido} inventario=${INV.length}`);

    if(!best || bestS<70){ await sock.sendMessage(from, {text:`No tengo ${tPedido.join('-')} parecido (${bestS.toFixed(0)}%)`}); return; }

    await sock.sendMessage(msg.key.participant, {
      image: fs.readFileSync(best.file),
      caption: `Talla ${tPedido[0]} disponible - similar ${bestS.toFixed(0)}% - JM Cali`
    });
    await sock.sendMessage(from, {text:`Enviado al privado ${tPedido[0]} ${bestS.toFixed(0)}%`});
   }catch(e){ console.log('skip', e.message); }
  });
}
start();
