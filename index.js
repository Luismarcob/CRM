// index.js
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'bot-simple' }),
  puppeteer: {
    headless: false, // ver la ventana ayuda a diagnosticar
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-features=site-per-process'
    ],
    // Usa tu Chrome (macOS). Si esta ruta no existe en tu Mac, borra esta línea.
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    timeout: 0 // sin límite de espera al abrir
  }
});

client.on('loading_screen', (percent, message) => {
  console.log(`⏳ Cargando WhatsApp Web: ${percent}% - ${message}`);
});
client.on('qr', (qr) => {
  console.log('\n📲 Escanea este QR en WhatsApp > Dispositivos vinculados > Vincular dispositivo:');
  qrcode.generate(qr, { small: true });
});
client.on('authenticated', () => console.log('🔐 Autenticado.'));
client.on('auth_failure', (m) => console.error('❌ Falló autenticación:', m));
client.on('ready', () => console.log('✅ Bot listo. Ya puede responder mensajes.'));
client.on('change_state', (s) => console.log('🔄 Estado del cliente:', s));
client.on('disconnected', (r) => console.log('⚠️ Desconectado:', r));

client.on('message', async (msg) => {
  try {
    await msg.reply('Hola, espere a ser atendido');
  } catch (e) {
    console.error('Error al responder:', e?.message || e);
  }
});

console.log('🚀 Inicializando cliente…');
client.initialize();
