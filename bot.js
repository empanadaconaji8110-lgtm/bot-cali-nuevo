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

client.on('qr', qr => {
  console.log('Escanea este QR con tu 3005517791:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  console.log('✅ BOT CONECTADO');
  console.log('Escribe "pausar" o "comenzar" en privado para controlarlo');

  const chats = await client.getChats();
  const difusion = chats.find(c => c.name.toLowerCase().includes('jm sport shoes'));

  if (!difusion) {
    console.log('No encontré la difusión jm sport shoes');
    return;
  }

  const msgs = await difusion.fetchMessages({ limit: 8000 });
  msgs.forEach(m => {
    if (m.body && m.body.includes('$')) {
      BODEGA_JM.push({ original: m.body });
    }
  });

  console.log(`Bodega cargada: ${BODEGA_JM.length} productos`);
});

function getTallas(texto) {
  const t = texto.toLowerCase();
  if (t.includes('dama')) return '36 a la 39 EUR';
  if (t.includes('hombre') || t.includes('caballero')) return '40 a la 44 EUR';
  return '36 a la 39 EUR';
}

client.on('message', async msg => {
  try {
    const chat = await msg.getChat();
    const texto = msg.body.toLowerCase().trim();

    // COMANDO PAUSAR / COMENZAR - Solo en privado
    if (!chat.isGroup) {
      if (texto === 'pausar' || texto === 'pausa') {
        BOT_ACTIVO = false;
        await msg.reply('⏸️ Bot PAUSADO ✅\nYa no responderé en CALI CARTEL 4.0 hasta que escribas "comenzar"');
        return;
      }
      if (texto === 'comenzar' || texto === 'reanudar' || texto === 'activar') {
        BOT_ACTIVO = true;
        await msg.reply('▶️ Bot ACTIVADO ✅\nYa estoy respondiendo en privado en CALI CARTEL 4.0');
        return;
      }
    }

    if (!BOT_ACTIVO) return;
    if (!chat.isGroup || chat.name!== 'CALI CARTEL 4.0') return;
    if (!msg.hasMedia) return;
    if (BODEGA_JM.length === 0) return;

    // Usa el último producto que tengas en jm sport shoes
    const itemTexto = BODEGA_JM[0].original;
    const tallas = getTallas(itemTexto);
    const precios = itemTexto.match(/\$\s?[\d\.]+/g);
    const precioTexto = precios? precios.join(' / ') : '$95.000';
    const nombre = itemTexto.split('\n')[0];

    const respuesta = `Hola! Vi que pediste en CALI CARTEL 4.0 👟\n\n👟 ${nombre}\n👣 Tallas que TENGO: ${tallas}\n💰 Precio: ${precioTexto}\n\n¿Te lo separo? - JM Cali Sport Shoes`;

    const destinatario = msg.author || msg.from;
    await client.sendMessage(destinatario, respuesta);
    console.log('Privado enviado a:', destinatario);

  } catch (e) {
    console.log('Error:', e.message);
  }
});

client.initialize();
