const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const client = new Client({ authStrategy: new LocalAuth({ clientId: "jm-cali" }), puppeteer: { args: ['--no-sandbox','--disable-setuid-sandbox'] } });
client.on('qr', q => { qrcode.generate(q,{small:true}); console.log(q); });
client.on('ready', () => console.log('BOT LISTO'));
client.initialize();
