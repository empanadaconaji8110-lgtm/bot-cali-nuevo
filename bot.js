
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
  let t = texto.toString().toLowerCase()
    .replace(/o/g,'0').replace(/q/g,'0')
    .replace(/i/g,'1').replace(/l/g,'1')
    .replace(/[^0-9]/g,' ')
    .replace(/\s+/g,' ').trim();
  const m = t.match(/\b(2[8-9]|3[0-9]|4[0-4])\b/g);
  return m ? [...new Set(m)] : [];
}

// ================== OCR QUE LEE EN CUALQUIER PARTE: CENTRO, ESQUINAS, BORDES ==================
async function ocrSingle(filePath, psm=6){
  try{
    const { data: { text } } = await Tesseract.recognize(filePath, 'spa+eng', {
      tessedit_char_whitelist: '0123456789EUR Tallaeur',
      psm: psm
    });
    return text || '';
  }catch{ return ''; }
}

async function leerTextoFoto(pathOriginal){
  let textoAcumulado = '';
  const tempFiles = [];
  try{
    const meta = await sharp(pathOriginal).metadata();
    const W = meta.width, H = meta.height;

    // Definimos 9 zonas donde puede estar el sticker: 4 esquinas, 4 bordes, centro, + full
    // Cada zona con 60% del ancho/alto y con overlap para no perderlo si esta justo en el limite
    const zonas = [
      { name: 'FULL', left: 0, top: 0, w: W, h: H, resize: 1800, psm: 6 },
      { name: 'CENTRO', left: Math.floor(W*0.1), top: Math.floor(H*0.12), w: Math.floor(W*0.8), h: Math.floor(H*0.45), resize: W*2, psm: 7 },
      { name: 'SUP-IZQ', left: 0, top: 0, w: Math.floor(W*0.65), h: Math.floor(H*0.5), resize: W*2, psm: 7 },
      { name: 'SUP-DER', left: Math.floor(W*0.35), top: 0, w: Math.floor(W*0.65), h: Math.floor(H*0.5), resize: W*2, psm: 7 },
      { name: 'INF-IZQ', left: 0, top: Math.floor(H*0.35), w: Math.floor(W*0.65), h: Math.floor(H*0.65), resize: W*2, psm: 7 },
      { name: 'INF-DER', left: Math.floor(W*0.35), top: Math.floor(H*0.35), w: Math.floor(W*0.65), h: Math.floor(H*0.65), resize: W*2, psm: 7 },
      { name: 'CENTRO-ARRIBA', left: Math.floor(W*0.15), top: Math.floor(H*0.05), w: Math.floor(W*0.7), h: Math.floor(H*0.4), resize: W*2, psm: 6 },
      { name: 'CENTRO-ABAJO', left: Math.floor(W*0.15), top: Math.floor(H*0.5), w: Math.floor(W*0.7), h: Math.floor(H*0.45), resize: W*2, psm: 6 },
    ];

    for(const z of zonas){
      const tmp = `${pathOriginal}_ocr_${z.name}.jpg`;
      tempFiles.push(tmp);
      try{
        await sharp(pathOriginal)
          .extract({ left: Math.max(0,z.left), top: Math.max(0,z.top), width: Math.min(z.w, W-z.left), height: Math.min(z.h, H-z.top) })
          .resize({ width: z.resize })
          .grayscale().normalize().sharpen().threshold(145)
          .toFile(tmp);
        const txt = await ocrSingle(tmp, z.psm);
        if(txt.trim()){
          console.log(`OCR ${z.name}: [${txt.trim()}] -> tallas ${tallas(txt)}`);
          textoAcumulado += ' ' + txt;
        }
        // Si ya encontramos talla, no hace falta seguir con todo, pero seguimos 1 mas por si hay otra
        if(tallas(textoAcumulado).length>0 && zonas.indexOf(z) >= 3) break;
      }catch(e){
        // zona fuera de rango, skip
      }
    }

  }catch(e){ console.log('OCR error', e.message); }
  finally{
    for(const f of tempFiles){ try{ fs.unlinkSync(f); }catch{} }
  }
  console.log(`OCR TOTAL -> Tallas: ${tallas(textoAcumulado)} en texto [${textoAcumulado.trim().substring(0,100)}]`);
  return textoAcumulado;
}

// ================== SIMILITUD POR COLOR + FORMA ==================
async function getFingerprint(file, esPedido=false){
  try{
    let pipeline = sharp(file);
    const meta = await pipeline.metadata();
    if(esPedido && meta.height){
      const top = Math.floor(meta.height * 0.32);
      const height = Math.floor(meta.height * 0.68);
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
  const final = (cosFP*0.4 + cosHist*0.6) * 100;
  return final;
}

async function procesarCola(sock){
  if(OCUPADO || COLA.length===0) return;
  OCUPADO = true;
  const { msg, tmp, caption } = COLA.shift();
  console.log('Analizando 5s...');
  await new Promise(r=>setTimeout(r, 5000));
  try{
    let tallaCaption = tallas(caption);
    let textoFoto = await leerTextoFoto(tmp);
    let tallaFoto = tallas(textoFoto);
    let tPedido = [...new Set([...tallaCaption, ...tallaFoto])];
    console.log(`Talla caption: ${tallaCaption} | Talla foto: ${tallaFoto} | FINAL: ${tPedido}`);

    if(tPedido.length===0){
      console.log('Sin talla, no escribo');
      try{ fs.unlinkSync(tmp); }catch{}
      OCUPADO=false;
      setTimeout(()=>procesarCola(sock), 1000);
      return;
    }

    const fpPedido = await getFingerprint(tmp, true);
    try{ fs.unlinkSync(tmp); }catch{}

    if(!fpPedido){
      console.log('No se pudo sacar fingerprint');
      OCUPADO=false;
      setTimeout(()=>procesarCola(sock), 1000);
      return;
    }

    let best=null, bestS=0;
    for(const it of INV){
      if(!it.fp || !it.hist){
        const re = await getFingerprint(it.file, false);
        if(re){ it.fp = re.fp; it.hist = re.hist; }
        else continue;
      }
      if(!it.tallas.some(x=>tPedido.includes(x))) continue;
      const s = parecido(fpPedido, {fp: it.fp, hist: it.hist});
      console.log(`  vs ${it.file} tallas ${it.tallas} -> ${s.toFixed(1)}%`);
      if(s>bestS){ bestS=s; best=it; }
    }

    console.log(`Pedido ${tPedido} mejor match ${bestS.toFixed(1)}%`);
    if(!best || bestS<75){
      console.log('No hay match confiable');
      OCUPADO=false;
      setTimeout(()=>procesarCola(sock), 1000);
      return;
    }

    const destino = msg.key.participantAlt || msg.key.participant || msg.key.remoteJid;
    await sock.sendMessage(destino, {
      image: fs.readFileSync(best.file),
      caption: `La tengo disponible asi como en la foto - Talla ${tPedido[0]} ✅`
    });
    console.log('Enviado al privado');
    guardar();

  }catch(e){ console.log('Error procesarCola', e.message, e.stack); }
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
        const fp = await getFingerprint(path, false);
        if(!fp){
          await sock.sendMessage(from,{text:`Error fingerprint`});
          return;
        }
        INV.push({tallas:t, file:path, fp: fp.fp, hist: fp.hist});
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
    procesarCola(sock);
   }catch(e){ console.log('skip',e.message); }
  });
}
start();
