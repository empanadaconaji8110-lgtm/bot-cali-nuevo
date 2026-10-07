const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const client = new Client({
  authStrategy: new LocalAuth({ clientId: "jm-cali-final" }),
  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--single-process']
  }
});
client.on('qr', q => { qrcode.generate(q,{small:true}); console.log('QR CODE:', q); });
client.on('ready', () => console.log('BOT JM CALI CONECTADO'));
client.on('message', async msg => { if(msg.body.toLowerCase()==='hola'){ msg.reply('Hola! Soy el bot de JM Cali Sport Shoes 👟'); }});
client.initialize();
