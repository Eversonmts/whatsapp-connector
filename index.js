const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');

const app = express();
const port = process.env.PORT || 3005;

// Configuração para recebimento de arquivos (Uploads temporários)
const upload = multer({ dest: 'uploads/' });
app.use(express.json());

let ultimoQrCode = '';
let sseClients = []; // Clientes conectados no painel para receber notificações em tempo real

// -----------------------------------------------------------------------------
// INFRAESTRUTURA DE TEMPO REAL (NOTIFICAÇÕES TOAST)
// -----------------------------------------------------------------------------
app.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    sseClients.push(res);
    req.on('close', () => {
        sseClients = sseClients.filter(client => client !== res);
    });
});

function enviarNotificacaoPainel(dados) {
    sseClients.forEach(client => client.write(`data: ${JSON.stringify(dados)}\n\n`));
}

// -----------------------------------------------------------------------------
// ROTAS DA WEB E PAINEL SAAS
// -----------------------------------------------------------------------------
app.get('/', (req, res) => res.redirect('/painel'));
app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/qr', (req, res) => {
    if (!ultimoQrCode) return res.send('<html><head><meta http-equiv="refresh" content="3"></head><body>Aguardando QR Code...</body></html>');
    res.send(`<html><body><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><div id="qrcode"></div><script>new QRCode(document.getElementById("qrcode"), "${ultimoQrCode}");</script></body></html>`);
});

// A Nova Interface do Painel SaaS
app.get('/painel', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
            <meta charset="UTF-8">
            <title>Painel SaaS - Atendimento</title>
            <style>
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #e5ddd5; margin: 0; display: flex; height: 100vh; }
                .chat-container { width: 100%; max-width: 800px; margin: 0 auto; background: white; display: flex; flex-direction: column; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
                .chat-header { background: #075e54; color: white; padding: 15px; font-size: 18px; font-weight: bold; }
                .chat-messages { flex: 1; padding: 20px; overflow-y: auto; background-color: #e5ddd5; }
                .message-box { background: white; padding: 10px; border-radius: 8px; margin-bottom: 10px; max-width: 70%; position: relative; }
                .chat-input-area { background: #f0f0f0; padding: 15px; display: flex; align-items: center; gap: 10px; }
                input[type="text"] { flex: 1; padding: 12px; border: none; border-radius: 20px; outline: none; font-size: 15px; }
                input[type="file"] { display: none; }
                .btn-icon { background: #075e54; color: white; border: none; border-radius: 50%; width: 45px; height: 45px; cursor: pointer; font-size: 20px; display: flex; align-items: center; justify-content: center; }
                
                /* Toast Notification - Canto Inferior Direito */
                #toast-container { position: fixed; bottom: 20px; right: 20px; display: flex; flex-direction: column; gap: 10px; z-index: 9999; }
                .toast { background: #333; color: white; padding: 15px 20px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); transform: translateX(120%); transition: transform 0.3s ease-in-out; min-width: 250px; }
                .toast.show { transform: translateX(0); }
                .toast strong { color: #25D366; display: block; margin-bottom: 5px; }
            </style>
        </head>
        <body>
            <div class="chat-container">
                <div class="chat-header">Conector WhatsApp Ativo 🚀</div>
                <div class="chat-messages" id="messages-container">
                    <div class="message-box">Bem-vindo ao Painel! As mensagens aparecerão aqui e no alerta.</div>
                </div>
                
                <div class="chat-input-area">
                    <label for="file-upload" class="btn-icon" title="Anexar Arquivo ou Áudio">📎</label>
                    <input type="file" id="file-upload">
                    
                    <input type="text" id="phone-number" placeholder="5541999999999" style="width: 130px; flex: none;">
                    <input type="text" id="message-text" placeholder="Digite sua mensagem...">
                    
                    <button class="btn-icon" onclick="sendMessage()">➤</button>
                </div>
            </div>

            <div id="toast-container"></div>

            <script>
                // 1. Escutador de Notificações em Tempo Real
                const evtSource = new EventSource('/stream');
                evtSource.onmessage = function(event) {
                    const data = JSON.parse(event.data);
                    mostrarToast(data.remetente, data.corpo);
                    adicionarMensagemTela(data);
                };

                // 2. Sistema do Toast (Alerta inferior direito)
                function mostrarToast(titulo, mensagem) {
                    const container = document.getElementById('toast-container');
                    const toast = document.createElement('div');
                    toast.className = 'toast';
                    
                    // Resumo da mensagem se for muito longa
                    let msgResumo = mensagem.length > 40 ? mensagem.substring(0, 40) + '...' : mensagem;
                    
                    toast.innerHTML = '<strong>📩 ' + titulo + '</strong>' + msgResumo;
                    container.appendChild(toast);
                    
                    // Animação de entrada
                    setTimeout(() => toast.classList.add('show'), 100);
                    
                    // Some e destrói após 5 segundos
                    setTimeout(() => {
                        toast.classList.remove('show');
                        setTimeout(() => toast.remove(), 300);
                    }, 5000);
                }

                // 3. Adiciona a mensagem recebida na tela e renderiza Áudio
                function adicionarMensagemTela(data) {
                    const box = document.createElement('div');
                    box.className = 'message-box';
                    
                    if (data.isAudio) {
                        box.innerHTML = '<strong>' + data.remetente + '</strong><br>' +
                                        '<audio controls style="margin-top:10px; max-width: 100%;"><source src="' + data.mediaData + '" type="audio/ogg"></audio>';
                    } else {
                        box.innerHTML = '<strong>' + data.remetente + '</strong><br>' + data.corpo;
                    }
                    
                    document.getElementById('messages-container').appendChild(box);
                }

                // 4. Envio de Mensagem + Arquivos para a API
                async function sendMessage() {
                    const numero = document.getElementById('phone-number').value;
                    const texto = document.getElementById('message-text').value;
                    const arquivo = document.getElementById('file-upload').files[0];

                    if (!numero) return alert("Digite o número do cliente (Ex: 5541999999999)");

                    const formData = new FormData();
                    formData.append('numero', numero);
                    formData.append('texto', texto);
                    if (arquivo) formData.append('arquivo', arquivo);

                    // Mostra visualmente que enviou
                    adicionarMensagemTela({ remetente: 'Você', corpo: arquivo ? 'Enviou um arquivo: ' + arquivo.name : texto, isAudio: false });

                    await fetch('/send-message', {
                        method: 'POST',
                        body: formData
                    });

                    // Limpa os campos
                    document.getElementById('message-text').value = '';
                    document.getElementById('file-upload').value = '';
                }
            </script>
        </body>
        </html>
    `);
});

// -----------------------------------------------------------------------------
// ENDPOINT PARA ENVIAR MENSAGENS E ARQUIVOS VIA PAINEL
// -----------------------------------------------------------------------------
app.post('/send-message', upload.single('arquivo'), async (req, res) => {
    try {
        const { numero, texto } = req.body;
        const chatId = numero + '@c.us';

        // Se tem arquivo anexado (áudio, imagem, pdf)
        if (req.file) {
            const media = MessageMedia.fromFilePath(req.file.path);
            await client.sendMessage(chatId, media, { caption: texto || '' });
            fs.unlinkSync(req.file.path); // Apaga o arquivo temporário do servidor
        } else if (texto) {
            await client.sendMessage(chatId, texto);
        }
        res.status(200).send({ status: 'Enviado' });
    } catch (error) {
        console.error('Erro ao enviar:', error);
        res.status(500).send({ error: 'Falha no envio' });
    }
});

app.listen(port, '0.0.0.0', () => console.log('Servidor HTTP ativo na porta ' + port));

// -----------------------------------------------------------------------------
// MOTOR DO WHATSAPP (A BASE INTACTA)
// -----------------------------------------------------------------------------
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    webVersionCache: { type: 'remote', remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html' },
    puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-extensions'],
        protocolTimeout: 180000,
    },
});

client.on('qr', (qr) => {
    ultimoQrCode = qr;
    qrcodeTerminal.generate(qr, { small: true });
});

client.on('ready', () => {
    ultimoQrCode = ''; 
    console.log('🚀 CONECTOR PRONTO: O WhatsApp está conectado e ativo!');
});

// ESCUTADOR DE MENSAGENS RECEBIDAS (O Gatilho da Notificação)
client.on('message', async (msg) => {
    const contato = await msg.getContact();
    let nomeContato = contato.pushname || contato.number;

    let dadosNotificacao = {
        remetente: nomeContato,
        corpo: msg.body,
        isAudio: false,
        mediaData: null
    };

    // Se for áudio, processamos para o painel renderizar o Player
    if (msg.hasMedia && (msg.type === 'audio' || msg.type === 'ptt')) {
        const media = await msg.downloadMedia();
        if (media) {
            dadosNotificacao.isAudio = true;
            dadosNotificacao.corpo = '🎵 Áudio recebido';
            dadosNotificacao.mediaData = `data:${media.mimetype};base64,${media.data}`; // Entrega o áudio pronto para tocar
        }
    }

    // Dispara para a tela do computador
    enviarNotificacaoPainel(dadosNotificacao);
});

client.initialize().catch(err => console.error('Erro ao inicializar:', err));
