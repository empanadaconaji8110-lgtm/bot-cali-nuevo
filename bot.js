const { Client, LocalAuth } = require('whatsapp-web.js');

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

let BODEGA_JM = [];
let BOT_ACTIVO = true;
let CODIGO_PEDIDO = false;

client.on('ready', async () => {
  console.log('✅ BOT CONECTADO - JM Cali Sport Shoes');
  CODIGO_PEDIDO = true;
  try {
    const chats = await client.getChats();
    const difusion = chats.find(c => c.name.toLowerCase().includes('jm sport shoes'));
    if (difusion) {
      const msgs = await difusion.fetchMessages({ limit: 8000 });
      msgs.forEach(m => { if (m.body && m.body.includes('$')) BODEGA_JM.push({ original: m.body }); });
      console.log(`Bodega cargada: ${BODEGA_JM.length} productos | ACTIVO: ${BOT_ACTIVO}`);
    }
  } catch(e){}
});

function getTallas(t){ t=t.toLowerCase(); if(t.includes('dama')) return '36 a la 39 EUR'; if(t.includes('hombre')||t.includes('caballero')) return '40 a la 44 EUR'; return '36 a la 39 EUR'; }

client.on('message', async msg => {
  try{
    const chat = await msg.getChat();
    const texto = msg.body.toLowerCase().trim();
    if(!chat.isGroup){
      if(texto==='pausar'||texto==='pausa'){ BOT_ACTIVO=false; await msg.reply('⏸️ Bot PAUSADO ✅\nEscribe "comenzar" para activarlo'); return; }
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
  }catch(e){ console.log(e.message); }
});

(async () => {
  await client.initialize();
  
  setInterval(async () => {
    if (client.info || CODIGO_PEDIDO) return;
    try {
      console.log('Pidiendo codigo...');
      const code = await client.requestPairingCode('573005517791');
      console.log(`\n\n============================\nTU CODIGO: ${code}\nPonlo en WhatsApp > Dispositivos vinculados > Vincular con numero de telefono\n============================\n\n`);
    } catch (e) {
      console.log('Esperando para pedir codigo de nuevo...', e.message);
    }
  }, 20000);
})();
