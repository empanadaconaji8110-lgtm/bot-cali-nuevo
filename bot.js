
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
    console.log(`Inventario cargado: ${INV.length} items`);
    // Limpieza automática: quitar entradas sin archivo o sin talla válida
    const antes = INV.length;
    INV = INV.filter(it => it && it.file && fs.existsSync(it.file) && it.tallas && it.tallas.length>0 && !it.tallas.includes('sin-talla'));
    if(INV.length != antes){
      console.log(`Limpieza: se quitaron ${antes-INV.length} entradas viejas sin talla o sin archivo`);
      fs.writeFileSync('./auth/inventario_fotos.json', JSON.stringify(INV));
    }
  }
} catch(e){ console.log('Error cargando inventario', e.message); INV=[]; }

function guardar(){ fs.writeFileSync('./auth/inventario_fotos.json', JSON.stringify(INV)); }

function tallas(texto){
  if(!texto) return [];
  let t = texto.toString().toLowerCase()
    .replace(/o/g,'0').replace(/q/g,'0')
    .replace(/i/g,'1').replace(/l/g,'1')
    .replace(/[^a-z0-9]/g,' ') // deja letras para luego filtrar
    .replace(/\s+/g,' ').trim();
  // Busca números 28-44 incluso pegados a letras tipo "eu37" -> primero separa
  t = t.replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2');
  const m = t.match(/\b(2[8-9]|3[0-9]|4[0-4])\b/g);
  return m ? [...new Set(m)] : [];
}

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

    // 9 zonas + múltiples PSM para cazar el sticker donde sea
    const zonas = [
      { name: 'FULL', left: 0, top: 0, w: W, h: H, resize: 1800 },
      { name: 'CENTRO', left: Math.floor(W*0.1), top: Math.floor(H*0.08), w: Math.floor(W*0.8), h: Math.floor(H*0.5) },
      { name: 'SUP', left: 0, top: 0, w: W, h: Math.floor(H*0.45) },
      { name: 'SUP-IZQ', left: 0, top: 0, w: Math.floor(W*0.65), h: Math.floor(H*0.5) },
      { name: 'SUP-DER', left: Math.floor(W*0.35), top: 0, w: Math.floor(W*0.65), h: Math.floor(H*0.5) },
      { name: 'INF', left: 0, top: Math.floor(H*0.35), w: W, h: Math.floor(H*0.65) },
      { name: 'INF-IZQ', left: 0, top: Math.floor(H*0.35), w: Math.floor(W*0.65), h: Math.floor(H*0.65) },
      { name: 'INF-DER', left: Math.floor(W*0.35), top: Math.floor(H*0.35), w: Math.floor(W*0.65), h: Math.floor(H*0.65) },
    ];

    const psmList = [6,7,8,13]; // 8 y 13 son claves para Eu37 pegado

    for(const z of zonas){
      for(const psm of psmList){
        const tmp = `${pathOriginal}_ocr_${z.name}_${psm}.jpg`;
        tempFiles.push(tmp);
        try{
          await sharp(pathOriginal)
            .extract({ left: Math.max(0,z.left), top: Math.max(0,z.top), width: Math.min(z.w, W-z.left), height: Math.min(z.h, H-z.top) })
            .resize({ width: z.resize || W*2 })
            .grayscale().normalize().sharpen().threshold(145)
            .toFile(tmp);
          const txt = await ocrSingle(tmp, psm);
          const t = tallas(txt);
          if(t.length>0){
            console.log(`OCR ${z.name} PSM${psm}: [${txt.trim()}] -> ${t}`);
            textoAcumulado += ' ' + txt;
            // Si ya tenemos talla, no hace falta probar más PSM en esa zona
            break;
          }
        }catch{}
      }
      if(tallas(textoAcumulado).length>0){
        // Si ya encontramos, paramos de escanear zonas (para velocidad)
        // pero dejamos que siga 1 zona más por si hay otra talla
        if(zonas.indexOf(z) >= 2) break;
      }
    }

  }catch(e){ console.log('OCR error', e.message); }
  finally{
    for(const f of tempFiles){ try{ fs.unlinkSync(f); }catch{} }
  }
  console.log(`OCR TOTAL -> Tallas: ${tallas(textoAcumulado)} texto:[${textoAcumulado.trim().substring(0,120)}]`);
  return textoAcumulado;
}

// ================== SIMILITUD POR COLOR + FORMA ==================
async function getFingerprint(file, esPedido=false){
  try{
    let pipeline = sharp(file);
    const meta = await pipeline.metadata();
    if(esPedido && meta.height){
      const top = Math.floor(meta.height * 0.30);
      const height = Math.floor(meta.height * 0.70);
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
  // 30% forma + 70% color: el color de suela y rayas es clave
  const final = (cosFP*0.3 + cosHist*0.7) * 100;
  return final;
}

async function procesarCola(sock){
  if(OCUPADO || COLA.length===0) return;
  OCUPADO = true;
  const { msg, tmp, caption, from } = COLA.shift();
  console.log('--- Nuevo pedido ---');
  await new Promise(r=>setTimeout(r, 4000));
  try{
    let tallaCaption = tallas(caption);
    let textoFoto = await leerTextoFoto(tmp);
    let tallaFoto = tallas(textoFoto);
    let tPedido = [...new Set([...tallaCaption, ...tallaFoto])];
    console.log(`Talla caption: ${tallaCaption} | Talla foto: ${tallaFoto} | FINAL: ${tPedido} | from ${from}`);

    if(tPedido.length===0){
      console.log('Sin talla ni en caption ni en foto, no escribo');
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
    let candidatos=0;
    for(const it of INV){
      if(!it.fp || !it.hist){
        const re = await getFingerprint(it.file, false);
        if(re){ it.fp = re.fp; it.hist = re.hist; }
        else continue;
      }
      // FILTRO ESTRICTO: solo si la talla pedida está en el inventario
      if(!it.tallas.some(x=>tPedido.includes(x))) continue;
      candidatos++;
      const s = parecido(fpPedido, {fp: it.fp, hist: it.hist});
      console.log(`  Candidato ${it.file.split('/').pop()} tallas ${it.tallas} -> ${s.toFixed(1)}%`);
      if(s>bestS){ bestS=s; best=it; }
    }

    console.log(`Candidatos con talla ${tPedido}: ${candidatos} | Mejor ${bestS.toFixed(1)}%`);

    if(!best || bestS<75){
      console.log('No hay match confiable >=75%, no escribo');
      // Aviso en grupo para debug
      try{
        await sock.sendMessage(from, {text: `⚠️ Pedido ${tPedido} sin match confiable (mejor ${bestS.toFixed(1)}%). Revisar inventario.`});
      }catch{}
      OCUPADO=false;
      setTimeout(()=>procesarCola(sock), 1000);
      return;
    }

    // Enviar al privado: usar participantAlt (nuevo LID) o participant
    const destino = msg.key.participantAlt || msg.key.participant;
    if(!destino){
      console.log('No se pudo obtener participante para privado, enviando al grupo como fallback');
      await sock.sendMessage(from, {
        image: fs.readFileSync(best.file),
        caption: `La tengo disponible asi como en la foto - Talla ${tPedido[0]} ✅ (match ${bestS.toFixed(0)}%)`
      });
    }else{
      await sock.sendMessage(destino, {
        image: fs.readFileSync(best.file),
        caption: `La tengo disponible asi como en la foto - Talla ${tPedido[0]} ✅`
      });
      console.log(`Enviado al privado ${destino}`);
      // Confirmación en grupo
      await sock.sendMessage(from, {text: `✅ Pedido ${tPedido} -> enviado al privado (match ${bestS.toFixed(0)}%)`});
    }
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

    // Comandos útiles
    if (txt==='pausar'||txt==='pausa'){ ACTIVO=false; await sock.sendMessage(from,{text:'⏸️ Pausado'}); return; }
    if (txt==='comenzar'||txt==='reanudar'||txt==='play'){ ACTIVO=true; await sock.sendMessage(from,{text:'▶️ Activo'}); return; }
    if (txt==='ver inventario' || txt==='inventario'){
      const resumen = INV.slice(0,20).map((it,i)=>`${i+1}. ${it.tallas.join('-')} - ${it.file.split('/').pop()}`).join('\n');
      await sock.sendMessage(from,{text:`Inventario ${INV.length}:\n${resumen}\n${INV.length>20?'...y más':''}`});
      return;
    }
    if (txt==='limpiar inventario'){
      const antes=INV.length;
      INV = INV.filter(it=>it.file && fs.existsSync(it.file));
      guardar();
      await sock.sendMessage(from,{text:`Inventario limpiado ${antes} -> ${INV.length}`});
      return;
    }
    if (txt==='reset inventario'){
      INV=[]; guardar();
      await sock.sendMessage(from,{text:`Inventario borrado`});
      return;
    }

    if (gname.toLowerCase().includes('bodega')){
      const im=msg.message.imageMessage;
      if(im){
        const buf=await downloadMediaMessage(msg,'buffer',{}, {logger:P({level:'silent'}), reuploadRequest:sock.updateMediaMessage});
        const path=`./auth/bodega/${Date.now()}_${Math.floor(Math.random()*1000)}.jpg`;
        fs.writeFileSync(path,buf);
        let texto = (im.caption||'') + ' ' + await leerTextoFoto(path);
        let t=tallas(texto);
        if(t.length===0){
          // Si no detecta talla en bodega, usa caption directo si tiene números
          const t2 = tallas(im.caption||'');
          if(t2.length>0) t=t2;
        }
        if(t.length===0) t=['sin-talla'];
        const fp = await getFingerprint(path, false);
        if(!fp){
          await sock.sendMessage(from,{text:`Error fingerprint`});
          try{ fs.unlinkSync(path); }catch{}
          return;
        }
        // Si es sin-talla, no guardar para evitar falsos positivos
        if(t.includes('sin-talla')){
          await sock.sendMessage(from,{text:`⚠️ No detecté talla en ${im.caption||''} - NO guardado. Escribe la talla en el caption ej: 36-37-38`});
          try{ fs.unlinkSync(path); }catch{}
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
    const tmp=`./auth/bodega/tmp_${Date.now()}_${Math.floor(Math.random()*1000)}.jpg`;
    fs.writeFileSync(tmp,bufC);
    COLA.push({ msg, tmp, caption: im.caption||'', from });
    procesarCola(sock);
   }catch(e){ console.log('skip',e.message, e.stack); }
  });
}
start();
