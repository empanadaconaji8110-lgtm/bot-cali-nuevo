const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

let BODEGA_JM = [];
let BOT_ACTIVO = true;

client.on('qr', qr => qrcode.generate(qr, { small: true }));

client.on('ready', async () => {
  console.log('✅ BOT CONECTADO - BOT ACTIVO');
  try {
    const chats = await client.getChats();
    const difusion = chats.find(c => c.name.toLowerCase().includes('jm sport shoes'));
    if (difusion) {
      const msgs = await difusion.fetchMessages({ limit: 8000 });
      msgs.forEach(m => { if (m.body && m.body.includes('$')) BODEGA_JM.push({ original: m.body }); });
      console.log(`Bodega cargada: ${BODEGA_JM.length}`);
    }
  } catch(e){}
});

function getTallas(t){ t=t.toLowerCase(); if(t.includes('dama')) return '36 a la 39 EUR'; if(t.includes('hombre')||t.includes('caballero')) return '40 a la 44 EUR'; return '36 a la 39 EUR'; }

client.on('message', async msg => {
  try{
    const chat = await msg.getChat();
    const texto = msg.body.toLowerCase().trim();
    if(!chat.isGroup){
      if(texto==='pausar'||texto==='pausa'){ BOT_ACTIVO=false; await msg.reply('⏸️ Bot PAUSADO ✅'); return; }
      if(texto==='comenzar'||texto==='reanudar'||texto==='activar'){ BOT_ACTIVO=true; await msg.reply('▶️ Bot ACTIVADO ✅'); return; }
    }
    if(!BOT_ACTIVO) return;
    if(!chat.isGroup || chat.name!=='CALI CARTEL 4.0') return;
    if(!msg.hasMedia) return;
    if(BODEGA_JM.length===0) return;
    const itemTexto=BODEGA_JM[0].original;
    const tallas=getTallas(itemTexto);
    const precios=itemTexto.match(/\$\s?[\d\.]+/g);
    const precioTexto=precios?precios.join(' / '):'$95.000';
    const nombre=itemTexto.split('\n')[0];
    const respuesta=`Hola! Vi que pediste en CALI CARTEL 4.0 👟\n\n👟 ${nombre}\n👣 Tallas que TENGO: ${tallas}\n💰 Precio: ${precioTexto}\n\n¿Te lo separo? - JM Cali Sport Shoes`;
    await client.sendMessage(msg.author || msg.from, respuesta);
  }catch(e){}
});

(async () => {
  await client.initialize();
  // Bucle que te da codigo nuevo cada 25 seg hasta que conectes
  setInterval(async () => {
    if (client.info) return; // ya esta conectado
    try {
      const code = await client.requestPairingCode('573005517791');
      console.log(`\n\n\n============================\nTU NUEVO CODIGO ES: ${code}\nESCRIBELO EN WHATSAPP -> VINCULAR CON NUMERO\n============================\n\n\n`);
    } catch (e) {}
  }, 25000);
})();
