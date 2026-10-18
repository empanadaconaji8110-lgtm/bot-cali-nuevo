
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
try { 
  if (fs.existsSync('./auth/inventario_fotos.json')) {
    INV = JSON.parse(fs.readFileSync('./auth/inventario_fotos.json'));
    console.log(`Inventario cargado: ${INV.length}`);
    // Limpieza solo de archivos que no existen
    const antes = INV.length;
    INV = INV.filter(it => it && it.file && fs.existsSync(it.file));
    if(antes !== INV.length){
      console.log(`Limpieza: ${antes} -> ${INV.length}`);
      fs.writeFileSync('./auth/inventario_fotos.json', JSON.stringify(INV));
    }
  }
} catch(e){ console.log('Error inventario', e.message); INV=[]; }

function guardar(){ fs.writeFileSync('./auth/inventario_fotos.json', JSON.stringify(INV)); }

function tallas(texto){
  if(!texto) return [];
  let t = texto.toString().toLowerCase()
    .replace(/o/g,'0').replace(/q/g,'0')
    .replace(/i/g,'1').replace(/l/g,'1');
  // Separa Eu37 -> Eu 37
  t = t.replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2');
  t = t.replace(/[^0-9]/g,' ').replace(/\s+/g,' ').trim();
  const m = t.match(/\b(2[8-9]|3[0-9]|4[0-4])\b/g);
  return m ? [...new Set(m)] : [];
}

// OCR RAPIDO para BODEGA: solo usa caption, no hace OCR pesado
function tallasDeCaption(caption){
  if(!caption) return [];
  // Acepta formatos: 36-37-38-39, 36,37,38, 36 37 38, Eu37
  const txt = caption.toString();
  return tallas(txt);
}

// OCR para PEDIDOS: busca en cualquier esquina, rapido
async function leerTextoFotoPedido(pathOriginal){
  let textoAcumulado = '';
  try{
    const meta = await sharp(pathOriginal).metadata();
    const W = meta.width, H = meta.height;

    const intentos = [
      { left: 0, top: 0, w: W, h: H, psm: 6, name: 'FULL' },
      { left: 0, top: 0, w: Math.floor(W*0.7), h: Math.floor(H*0.45), psm: 8, name: 'SUP-IZQ' },
      { left: Math.floor(W*0.3), top: 0, w: Math.floor(W*0.7), h: Math.floor(H*0.45), psm: 8, name: 'SUP-DER' },
      { left: Math.floor(W*0.1), top: Math.floor(H*0.05), w: Math.floor(W*0.8), h: Math.floor(H*0.5), psm: 7, name: 'CENTRO' },
    ];

    for(const it of intentos){
      const tmp = `${pathOriginal}_ocr_${it.name}.jpg`;
      try{
        await sharp(pathOriginal)
          .extract({ left: it.left, top: it.top, width: Math.min(it.w, W-it.left), height: Math.min(it.h, H-it.top) })
          .resize({ width: 1200 })
          .grayscale().normalize().sharpen().threshold(150)
          .toFile(tmp);
        const { data: { text } } = await Tesseract.recognize(tmp, 'spa+eng', {
          tessedit_char_whitelist: '0123456789EUR Tallaeur',
          psm: it.psm
        });
        try{ fs.unlinkSync(tmp); }catch{}
        if(tallas(text).length>0){
          console.log(`OCR ${it.name} PSM${it.psm}: [${text.trim()}] -> ${tallas(text)}`);
          textoAcumulado += ' ' + text;
          break; // ya encontramos
        }
      }catch(e){
        try{ fs.unlinkSync(tmp); }catch{}
      }
    }
  }catch(e){ console.log('OCR error', e.message); }
  return textoAcumulado;
}

async function getFingerprint(file, esPedido=false){
  try{
    let pipeline = sharp(file);
    const meta = await pipeline.metadata();
    if(esPedido && meta.height){
      const top = Math.floor(meta.height * 0.28);
      const height = Math.floor(meta.height * 0.72);
      pipeline = pipeline.extract({ left: 0, top: top, width: meta.width, height: height });
    }
    const { data } = await pipeline.resize(32, 32, {fit: 'cover'}).removeAlpha().raw().toBuffer({resolveWithObject: true});
    const dataArray = Array.from(data);
    const bins = 16;
    const hist = new Array(bins*3).fill(0);
    for(let i=0;i<data.length;i+=3){
      const r = data[i], g = data[i+1], b = data[i+2];
      hist[Math.floor(r/256*bins)]++;
      hist[bins + Math.floor(g/256*bins)]++;
      hist[bins*2 + Math.floor(b/256*bins)]++;
    }
    const total = data.length/3;
    const histNorm = hist.map(v => v/total);
    return { fp: dataArray, hist: histNorm };
  }catch(e){
    console.log('Fingerprint error', e.message);
    return null;
  }
}

function parecido(a, b){
  if(!a || !b) return 0;
  let dot=0, normA=0, normB=0;
  for(let i=0;i<a.fp.length;i++){
    dot += a.fp[i]*b.fp[i];
    normA += a.fp[i]*a.fp[i];
    normB += b.fp[i]*b.fp[i];
  }
  const cosFP = normA && normB ? dot / (Math.sqrt(normA)*Math.sqrt(normB)) : 0;
  let dotH=0, normHA=0, normHB=0;
  for(let i=0;i<a.hist.length;i++){
    dotH += a.hist[i]*b.hist[i];
    normHA += a.hist[i]*a.hist[i];
    normHB += b.hist[i]*b.hist[i];
  }
  const cosHist = normHA && normHB ? dotH / (Math.sqrt(normHA)*Math.sqrt(normHB)) : 0;
  return (cosFP*0.25 + cosHist*0.75) * 100; // 75% color para no confundir Puma blanco con Puma azul
}

async function procesarCola(sock){
  if(OCUPADO || COLA.length===0) return;
  OCUPADO = true;
  const { msg, tmp, caption, from } = COLA.shift();
  console.log('--- Nuevo pedido --- caption:', caption);
  try{
    let tallaCaption = tallasDeCaption(caption);
    console.log('Talla caption:', tallaCaption);
    let textoFoto = await leerTextoFotoPedido(tmp);
    let tallaFoto = tallas(textoFoto);
    console.log('Talla foto:', tallaFoto);
    let tPedido = [...new Set([...tallaCaption, ...tallaFoto])];
    console.log('FINAL:', tPedido);

    if(tPedido.length===0){
      console.log('Sin talla, aviso en grupo');
      try{ await sock.sendMessage(from, {text: `⚠️ No detecté talla en la foto. Escribe la talla en el mensaje ej: 37`}); }catch{}
      try{ fs.unlinkSync(tmp); }catch{}
      OCUPADO=false;
      setTimeout(()=>procesarCola(sock), 1000);
      return;
    }

    const fpPedido = await getFingerprint(tmp, true);
    try{ fs.unlinkSync(tmp); }catch{}

    if(!fpPedido){
      console.log('No fingerprint');
      OCUPADO=false;
      setTimeout(()=>procesarCola(sock), 1000);
      return;
    }

    let best=null, bestS=0, candidatos=0;
    for(const it of INV){
      if(!it.fp || !it.hist){
        const re = await getFingerprint(it.file, false);
        if(re){ it.fp = re.fp; it.hist = re.hist; }
        else continue;
      }
      if(!it.tallas.some(x=>tPedido.includes(x))) continue;
      candidatos++;
      const s = parecido(fpPedido, {fp: it.fp, hist: it.hist});
      console.log(`  vs ${it.file.split('/').pop()} ${it.tallas} -> ${s.toFixed(1)}%`);
      if(s>bestS){ bestS=s; best=it; }
    }

    console.log(`Candidatos: ${candidatos} mejor ${bestS.toFixed(1)}%`);

    if(!best || bestS<72){
      console.log('Sin match confiable');
      try{ await sock.sendMessage(from, {text: `❌ No tengo ${tPedido.join('/')} con ese modelo (mejor ${bestS.toFixed(0)}% <72%). Candidatos: ${candidatos}`}); }catch{}
      OCUPADO=false;
      setTimeout(()=>procesarCola(sock), 1000);
      return;
    }

    const destino = msg.key.participantAlt || msg.key.participant;
    console.log('Enviando a:', destino);
    if(!destino){
      await sock.sendMessage(from, {
        image: fs.readFileSync(best.file),
        caption: `La tengo disponible asi como en la foto - Talla ${tPedido[0]} ✅ (match ${bestS.toFixed(0)}%)`
      });
    }else{
      await sock.sendMessage(destino, {
        image: fs.readFileSync(best.file),
        caption: `La tengo disponible asi como en la foto - Talla ${tPedido[0]} ✅`
      });
      await sock.sendMessage(from, {text: `✅ ${tPedido[0]} enviado al privado (match ${bestS.toFixed(0)}%)`});
    }
    guardar();

  }catch(e){ console.log('Error cola', e.message, e.stack); }
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

    if (txt==='pausar'||txt==='pausa'){ ACTIVO=false; await sock.sendMessage(from,{text:'⏸️ Pausado'}); return; }
    if (txt==='comenzar'||txt==='reanudar'||txt==='play'){ ACTIVO=true; await sock.sendMessage(from,{text:'▶️ Activo - INV:'+INV.length}); return; }
    if (txt==='ver inventario' || txt==='inventario'){
      const resumen = INV.slice(0,15).map((it,i)=>`${i+1}. ${it.tallas.join('-')} ${it.file.split('/').pop()}`).join('\n');
      await sock.sendMessage(from,{text:`Inventario ${INV.length}:\n${resumen}`});
      return;
    }
    if (txt==='reset inventario' || txt==='limpiar inventario'){
      // Borra archivos también
      for(const it of INV){ try{ fs.unlinkSync(it.file); }catch{} }
      INV=[]; guardar();
      await sock.sendMessage(from,{text:`Inventario borrado`});
      return;
    }

    // BODEGA: GUARDAR - SIN OCR PESADO, SOLO CAPTION
    if (gname.toLowerCase().includes('bodega')){
      const im=msg.message.imageMessage;
      if(im){
        console.log('BODEGA imagen recibida caption:', im.caption);
        try{
          const buf=await downloadMediaMessage(msg,'buffer',{}, {logger:P({level:'silent'}), reuploadRequest:sock.updateMediaMessage});
          const path=`./auth/bodega/${Date.now()}_${Math.floor(Math.random()*10000)}.jpg`;
          fs.writeFileSync(path,buf);
          let t = tallasDeCaption(im.caption||'');
          console.log('Tallas caption bodega:', t);
          if(t.length===0){
            await sock.sendMessage(from,{text:`⚠️ No detecté talla. Escribe en el caption: 36-37-38-39`});
            try{ fs.unlinkSync(path); }catch{}
            return;
          }
          const fp = await getFingerprint(path, false);
          if(!fp){
            await sock.sendMessage(from,{text:`Error fingerprint`});
            try{ fs.unlinkSync(path); }catch{}
            return;
          }
          INV.push({tallas:t, file:path, fp: fp.fp, hist: fp.hist});
          guardar();
          await sock.sendMessage(from,{text:`✅ Guardado ${t.join('-')} total ${INV.length}`});
          console.log(`Guardado ${t} total ${INV.length}`);
        }catch(e){
          console.log('Error bodega', e.message);
          await sock.sendMessage(from,{text:`Error guardando: ${e.message}`});
        }
      }
      return;
    }

    if(!from.endsWith('@g.us')) return;
    if(!ACTIVO) return;
    if(gname.trim().toLowerCase()!=='cali cartel 4.0 prueba') return;
    const im=msg.message.imageMessage; if(!im) return;
    console.log('PEDIDO recibido en cartel');
    const bufC=await downloadMediaMessage(msg,'buffer',{}, {logger:P({level:'silent'}), reuploadRequest:sock.updateMediaMessage});
    const tmp=`./auth/bodega/tmp_${Date.now()}_${Math.floor(Math.random()*10000)}.jpg`;
    fs.writeFileSync(tmp,bufC);
    COLA.push({ msg, tmp, caption: im.caption||'', from });
    procesarCola(sock);
   }catch(e){ console.log('skip',e.message, e.stack); }
  });
}
start();
