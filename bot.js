
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

// LEE TALLA DE LA FOTO - Eur 38, EU 38, 38, 40, etc - solo numeros 28-44
function tallas(texto){
  if(!texto) return [];
  let t = texto.toString().toLowerCase().replace(/[^0-9]/g,' ');
  const m = t.match(/\b(2[8-9]|3[0-9]|4[0-4])\b/g);
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
// Lee la talla impresa en la foto del zapato
async function leerTextoFoto(path){
  try{
    const pre = path + '_ocr.jpg';
    await sharp(path).resize(1500).grayscale().normalize().sharpen().toFile(pre);
    const { data: { text } } = await Tesseract.recognize(pre, 'eng');
    try{ fs.unlinkSync(pre); }catch{}
    console.log(`OCR FOTO: [${text.trim().replace(/\n/g,' ')}] -> tallas ${tallas(text)}`);
    return text;
  }catch(e){ console.log('OCR error', e.message); return ''; }
}
async function procesarCola(sock){
  if(OCUPADO || COLA.length===0) return;
  OCUPADO = true;
  const { msg, tmp } = COLA.shift();
  console.log('Analizando foto 10s...');
  await new Promise(r=>setTimeout(r, 10000));
  try{
    // SOLO LEE DE LA FOTO, NO DE LA DESCRIPCION
    let textoFoto = await leerTextoFoto(tmp);
    let tPedido = tallas(textoFoto);
    console.log(`Talla detectada EN LA FOTO: ${tPedido}`);
    if(tPedido.length===0){
      console.log('Sin talla en la foto, callado - no escribo nada');
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
      console.log(`Comparando con bodega ${it.tallas} sim ${s.toFixed(1)}%`);
      if(s>bestS){ bestS=s; best=it; }
    }
    console.log(`Mejor para talla ${tPedido}: ${bestS.toFixed(1)}%`);
    if(!best || bestS<75){
      console.log('No tengo esa talla o no es parecido, callado');
      OCUPADO=false;
      setTimeout(()=>procesarCola(sock), 1000);
      return;
    }
    // Manda la parecida y dice la talla que LEYO DE LA FOTO
    await sock.sendMessage(msg.key.participant, {
      image: fs.readFileSync(best.file),
      caption: `La tengo disponible asi como en la foto - Talla ${tPedido[0]} ✅`
    });
    console.log(`Enviado talla ${tPedido[0]} al privado`);
  }catch(e){ console.log('Error', e.message); }
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
    console.log(`LLEGO [${gname}] txt=[${txt}]`);

    // COMANDOS - funcionan en BODEGA y en PRUEBA
    if (txt==='pausar' || txt==='pausa'){
      ACTIVO=false;
      await sock.sendMessage(from,{text:'⏸️ Pausado'});
      return;
    }
    if (txt==='comenzar' || txt==='reanudar' || txt==='play' || txt==='activar'){
      ACTIVO=true;
      await sock.sendMessage(from,{text:'▶️ Activo'});
      return;
    }
    if (txt==='borrar todo' || txt==='borrar inventario' || txt==='vaciar' || txt==='limpiar'){
      const c=INV.length;
      INV=[]; guardar();
      try{
        const files=fs.readdirSync('./auth/bodega');
        files.forEach(f=>{ if(!f.startsWith('tmp_') && !f.startsWith('pre')){ try{ fs.unlinkSync('./auth/bodega/'+f); }catch{} } });
      }catch{}
      await sock.sendMessage(from,{text:`🗑️ Borrado ${c} fotos`});
      return;
    }
    if (txt==='inventario' || txt==='stock'){
      await sock.sendMessage(from,{text:`📦 ${INV.length} fotos - Tallas: ${[...new Set(INV.flatMap(i=>i.tallas))].join(', ')}`});
      return;
    }

    if (gname.toLowerCase().includes('bodega')){
      const im=msg.message.imageMessage;
      if(im){
        const buf=await downloadMediaMessage(msg,'buffer',{}, {logger:P({level:'silent'}), reuploadRequest:sock.updateMediaMessage});
        const path=`./auth/bodega/${Date.now()}.jpg`;
        fs.writeFileSync(path,buf);
        let texto = (im.caption||'') + ' ' + await leerTextoFoto(path);
        let t=tallas(texto);
        if(t.length===0){
          await sock.sendMessage(from,{text:`⚠️ No detecte talla en la foto, pon en caption ej: 38`});
          try{ fs.unlinkSync(path); }catch{}
          return;
        }
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
    COLA.push({ msg, tmp });
    console.log(`En cola ${COLA.length} - 10s pensando`);
    procesarCola(sock);

   }catch(e){ console.log('skip',e.message); }
  });
}
start();
