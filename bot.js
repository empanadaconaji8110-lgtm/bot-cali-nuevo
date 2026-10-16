const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const P = require('pino');
const fs = require('fs');
const sharp = require('sharp');
const 【entity-Tesseract¦canonical_name=Tesseract】 = require('【entity-tesseract¦canonical_name=Tesseract】.js');

let ACTIVO = true;
let INV = [];
let COLA = [];
let OCUPADO = false;

if (!fs.existsSync('./auth/bodega')) fs.mkdirSync('./auth/bodega', {recursive:true});
try { if (fs.existsSync('./auth/inventario_fotos.json')) INV = JSON.parse(fs.readFileSync('./auth/inventario_fotos.json')); } catch {}
function guardar(){ fs.writeFileSync('./auth/inventario_fotos.json', JSON.stringify(INV)); }

// ARREGLADO: lee 38 aunque diga Eur 3B, Eur 38, 38.5, etc
function tallas(texto){
  if(!texto) return [];
  let t = texto.toString().toLowerCase()
   .replace(/eur/g,' ')
   .replace(/[^a-z0-9]/g,' ')
   .replace(/o/g,'0')
   .replace(/b/g,'8');
  const m = t.match(/\b(2[8-9]|3[0-9]|4[0-4])\b/g);
  return m? [...new Set(m)] : [];
}

async function hash(file){
  const b = await sharp(file).resize(8,8).grayscale().raw().toBuffer();
  return b;
}
function parecido(a,b){
  let d=0; for(let i=0;i<a.length;i++) d+=Math.abs(a[i]-b[i]);
  return 100 - (d / a.length / 255 * 100);
}

// ARREGLADO: ahora hace zoom al centro donde está la talla Eur
async function leerTextoFoto(path){
  try{
    const pre1 = `./auth/bodega/pre1_${Date.now()}.jpg`;
    const pre2 = `./auth/bodega/pre2_${Date.now()}.jpg`;

    // intento 1: foto completa mejorada
    await sharp(path).grayscale().normalize().sharpen().resize(2000).toFile(pre1);
    let r1 = await 【entity-Tesseract¦canonical_name=Tesseract】.recognize(pre1, 'eng');

    // intento 2: zoom al centro donde normalmente está el Eur 38
    await sharp(path).extract({ left: 0, top: 0, width: 1000, height: 1000 }).resize(2000).grayscale().normalize().sharpen().toFile(pre2).catch(async ()=>{
      await sharp(path).resize(2000).grayscale().toFile(pre2);
    });
    let r2 = await Tesseract.recognize(pre2, 'eng');

    try{ fs.unlinkSync(pre1); fs.unlinkSync(pre2); }catch{}

    let texto = (r1.data.text + ' ' + r2.data.text);
    console.log(`OCR FOTO: [${texto.replace(/\n/g,' ')}] -> tallas ${tallas(texto)}`);
    return texto;
  }catch(e){ console.log('OCR error', e.message); return ''; }
}

async function procesarCola(sock){
  if(OCUPADO || COLA.length===0) return;
  OCUPADO = true;
  const { msg, tmp, caption } = COLA.shift();
  console.log('Analizando zapato 10 segundos...');
  await new Promise(r=>setTimeout(r, 10000));
  try{
    let textoTotal = caption + ' ' + await leerTextoFoto(tmp);
    let tPedido = tallas(textoTotal);
    if(tPedido.length===0){
      console.log('Sin talla en la foto, callado');
      try{ fs.unlinkSync(tmp); }catch{}
      OCUPADO=false;
      setTimeout(()=>procesarCola(sock), 1000);
      return;
    }
    const hC = await hash(tmp);
    try{ fs.unlinkSync(tmp); }catch{}
    let best=null, bestS=0;
    for(const it of INV){
      if(!it.tallas.some(x=>tPedido.includes(x))) continue;
      const s = parecido(hC, Buffer.from(it.h));
      if(s>bestS){ bestS=s; best=it; }
    }
    console.log(`Pedido ${tPedido} mejor sim ${bestS.toFixed(1)}%`);
    if(!best || bestS<70){
      console.log('No tengo esa talla, callado');
      OCUPADO=false;
      setTimeout(()=>procesarCola(sock), 1000);
      return;
    }
    await sock.sendMessage(msg.key.participant, {
      image: fs.readFileSync(best.file),
      caption: `La tengo disponible asi como en la foto - Talla ${tPedido[0]} ✅`
    });
    console.log('Enviado al privado');
  }catch(e){ console.log('Error cola', e.message); }
  OCUPADO=false;
  setTimeout(()=>procesarCola(sock), 1000);
}

async function start(){
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const sock = makeWASocket({ auth: state, logger: P({level:'silent'}), browser: ["JM","Chrome","1.0"] });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', u=>{
    if (u.qr){
      qrcode.generate(u.qr, {small:true});
      console.log(`LINK QR: https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(u.qr)}`);
    }
    if (u.connection==='open') console.log('CONECTADO SOLO CALI CARTEL 4.0 PRUEBA INV:'+INV.length);
    if (u.connection==='close' && u.lastDisconnect?.error?.output?.statusCode!==DisconnectReason.loggedOut) start();
  });
  sock.ev.on('messages.upsert', async ({messages})=>{
   try{
    const msg=messages[0]; if(!msg?.message) return;
    const from=msg.key.remoteJid;
    let gname=''; try{ const m=await sock.groupMetadata(from); gname=m?.subject||''; }catch{}
    const txt=(msg.message.conversation||msg.message.extendedTextMessage?.text||'').toLowerCase().trim();
    if (txt==='pausar'||txt==='pausa'){ ACTIVO=false; await sock.sendMessage(from,{text:'⏸️ Pausado'}); return; }
    if (txt==='comenzar'||txt==='reanudar'||txt==='play'){ ACTIVO=true; await sock.sendMessage(from,{text:'▶️ Activo'}); return; }
    if (gname.toLowerCase().includes('bodega')){
      const im=msg.message.imageMessage;
      if(im){
        const buf=await downloadMediaMessage(msg,'buffer',{}, {logger:P({level:'silent'}), reuploadRequest:sock.updateMediaMessage});
        const path=`./auth/bodega/${Date.now()}.jpg`;
        fs.writeFileSync(path,buf);
        let texto = (im.caption||'') + ' ' + await leerTextoFoto(path);
        let t=tallas(texto);
        if(t.length===0) t=['sin-talla'];
        const h=await hash(path);
        INV.push({tallas:t, file:path, h:Array.from(h)});
        guardar();
        await sock.sendMessage(from,{text:`Guardado ${t.join('-')} total ${INV.length}`});
      }
      return;
    }
    if(!from.endsWith('@g.us')) return;
    if(!ACTIVO) return;
    if(gname.trim().toLowerCase()!=='cali cartel 4.0 prueba') return;
    const im=msg.message.imageMessage; if(!im) return;
    const bufC=await downloadMediaMessage(msg,'buffer',{}, {logger:P({level:'silent'}), reuploadRequest:sock.updateMediaMessage});
    const tmp=`./auth/bodega/tmp_${Date.now()}.jpg`;
    fs.writeFileSync(tmp,bufC);
    COLA.push({ msg, tmp, caption: im.caption||'' });
    console.log(`En cola ${COLA.length} - 10s`);
    procesarCola(sock);
   }catch(e){ console.log('skip',e.message); }
  });
}
start();
