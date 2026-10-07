const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const client = new Client({
  authStrategy: new LocalAuth({ clientId: "jm-cali" }),
  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']
  }
});
client.on('qr', qr => { qrcode.generate(qr,{small:true}); console.log(qr); });
client.on('ready', () => console.log('BOT JM CALI CONECTADO'));
client.initialize();
