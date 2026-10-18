
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const P = require('pino');
const fs = require('fs');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');

let ACTIVO = true;
let INV = [];
let COLA = [];
let OCUPADO = false;

if (!fs.existsSync('./auth/bodega')) fs.mkdirSync('./auth/bodega', {recursive:true});
try { if (fs.existsSync('./auth/inventario_fotos.json')) INV = JSON.parse(fs.readFileSync('./auth/inventario_fotos.json')); } catch {}
function guardar(){ fs.writeFileSync('./auth/inventario_fotos.json', JSON.stringify(INV)); }

function tallas(texto){
  if(!texto) return [];
  // Busca 37, 38, etc y tambien Eu37, EU37, EUR37 pegado
  let s = texto.toString().toUpperCase();
  // Separa Eu37 -> Eu 37
  s = s.replace(/EU?R?\s*([2-4][0-9])/g, ' $1 ');
  s = s.replace(/[^0-9]/g,' ');
  const m = s.match(/\b(2[8-9]|3[0-9]|4[0-4])\b/g);
  return m? [...new Set(m)] : [];
}
async function hash(file){
  const b = await sharp(file).resize(32,32).grayscale().raw().toBuffer();
  return b;
}
function parecido(a,b){
  let d=0; for(let i=0;i<a.length;i++) d+=Math.abs(a[i]-b[i]);
  return 100 - (d / a.length / 255 * 100);
}

async function leerTextoFoto(path){
  let todo = '';
  try{
    const meta = await sharp(path).metadata();
    const W = meta.width || 800;
    const H = meta.height || 800;

    const intentos = [
      { name:'TOP_30', crop:{ left:0, top:0, width:W, height: Math.floor(H*0.35) }, resize: 1800 },
      { name:'TOP_55', crop:{ left:0, top:0, width:W, height: Math.floor(H*0.55) }, resize: 1800 },
      { name:'FULL', crop:null, resize: 1600 }
    ];

    for(const it of intentos){
      try{
        const pre = path + `_ocr_${it.name}.jpg`;
        let pipeline = sharp(path);
        if(it.crop) pipeline = pipeline.extract(it.crop);
        await pipeline.resize(it.resize).grayscale().normalize().sharpen().toFile(pre);
        const { data:{ text } } = await Tesseract.recognize(pre, 'eng', { tessedit_pageseg_mode: '6' });
        console.log(`OCR ${it.name}: [${text.trim().slice(0,80)}]`);
        todo += ' ' + text;
        try{ fs.unlinkSync(pre); }catch{}
        // Si ya encontró talla en este intento, no hace falta más
        if(tallas(text).length>0){
          // sigue acumulando pero ya tenemos algo
        }
      }catch(e){ console.log(`OCR fail ${it.name}`, e.message); }
    }

    // Intento extra con threshold para Eu37 negro sobre blanco
    try{
      const pre = path + `_ocr_thr.jpg`;
      const crop = { left:0, top:0, width:W, height: Math.floor(H*0.45) };
      await sharp(path).extract(crop).resize(2000).grayscale().threshold(140).toFile(pre);
      const { data:{ text } } = await Tesseract.recognize(pre, 'eng');
      console.log(`OCR THR: [${text.trim().slice(0,80)}]`);
      todo += ' ' + text;
      try{ fs.unlinkSync(pre); }catch{}
    }catch{}

    console.log(`OCR FINAL: [${todo.trim().replace(/\n/g,' ').slice(0,200)}] -> tallas ${tallas(todo)}`);
    return todo;
  }catch(e){ console.log('OCR error', e.message); return todo; }
}

async function procesarCola(sock){
  if(OCUPADO || COLA.length===0) return;
  OCUPADO = true;
  const { msg, tmp, captionOriginal } = COLA.shift();
  console.log('Analizando foto 10s...');
  await new Promise(r=>setTimeout(r, 10000));
  try{
    let textoFoto = await leerTextoFoto(tmp);
    let tPedido = tallas(textoFoto);
    // Fallback: si no lee de foto, intenta caption del cliente (por si acaso)
    if(tPedido.length===0 && captionOriginal) tPedido = tallas(captionOriginal);

    console.log(`Talla detectada EN LA FOTO: ${tPedido} de [${textoFoto.slice(0,100)}] + caption[${captionOriginal}]`);
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
    console.log(`Mejor para talla ${tPedido}: ${bestS.toFixed(1)}%`);
    if(!best || bestS<70){
      console.log('No parecido suficiente, callado');
      OCUPADO=false;
      setTimeout(()=>procesarCola(sock), 1000);
      return;
    }
    await sock.sendMessage(msg.key.participant, {
      image: fs.readFileSync(best.file),
      caption: `La tengo disponible asi como en la foto - Talla ${tPedido[0]} ✅`
    });
    console.log(`Enviado talla ${tPedido[0]} al privado`);
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
    if (u.connection==='open') console.log('CONECTADO INV:'+INV.length);
    if (u.connection==='close' && u.lastDisconnect?.error?.output?.statusCode!==DisconnectReason.loggedOut) start();
  });
  sock.ev.on('messages.upsert', async ({messages})=>{
   try{
    const msg=messages[0]; if(!msg?.message) return;
    const from=msg.key.remoteJid;
    let gname=''; try{ const m=await sock.groupMetadata(from); gname=m?.subject||''; }catch{}
    const txt=(msg.message.conversation||msg.message.extendedTextMessage?.text||'').toLowerCase().trim();
    console.log(`LLEGO [${gname}] txt=[${txt}]`);

    if (txt==='pausar' || txt==='pausa'){ ACTIVO=false; await sock.sendMessage(from,{text:'⏸️ Pausado'}); return; }
    if (txt==='comenzar' || txt==='reanudar' || txt==='play' || txt==='activar'){ ACTIVO=true; await sock.sendMessage(from,{text:'▶️ Activo'}); return; }
    if (txt==='borrar todo' || txt==='borrar inventario' || txt==='vaciar' || txt==='limpiar'){
      const c=INV.length; INV=[]; guardar();
      try{ const files=fs.readdirSync('./auth/bodega'); files.forEach(f=>{ try{ fs.unlinkSync('./auth/bodega/'+f); }catch{} }); }catch{}
      await sock.sendMessage(from,{text:`🗑️ Borrado ${c}`}); return;
    }
    if (txt==='inventario' || txt==='stock'){ await sock.sendMessage(from,{text:`📦 ${INV.length} fotos`}); return; }

    if (gname.toLowerCase().includes('bodega')){
      const im=msg.message.imageMessage;
      if(im){
        const buf=await downloadMediaMessage(msg,'buffer',{}, {logger:P({level:'silent'}), reuploadRequest:sock.updateMediaMessage});
        const path=`./auth/bodega/${Date.now()}.jpg`;
        fs.writeFileSync(path,buf);
        let texto = (im.caption||'') + ' ' + await leerTextoFoto(path);
        let t=tallas(texto);
        if(t.length===0) t = tallas(im.caption||'');
        if(t.length===0) t=['sin-talla'];
        const h=await hash(path);
        INV.push({tallas:t, file:path, h:Array.from(h)});
        guardar();
        await sock.sendMessage(from,{text:`✅ Guardado ${t.join('-')} total ${INV.length}`});
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
    COLA.push({ msg, tmp, captionOriginal: im.caption||'' });
    console.log(`En cola ${COLA.length}`);
    procesarCola(sock);

   }catch(e){ console.log('skip',e.message); }
  });
}
start();
