const { Client, LocalAuth, MessageMedia, Buttons } = require('whatsapp-web.js');
const express = require('express');
const fs = require('fs');
const QRCode = require('qrcode');
const axios = require('axios');
const mime = require('mime-types');

const app = express();
app.use(express.json());

const sessions = {};
const SESSION_FILE_PATH = './whatsapp-sessions.json';

// Load sessions from file
const loadSessions = () => {
    if (fs.existsSync(SESSION_FILE_PATH)) {
        const file = fs.readFileSync(SESSION_FILE_PATH);
        return JSON.parse(file);
    }
    return {};
};

// Save sessions to file
const saveSessions = (sessions) => {
    fs.writeFileSync(SESSION_FILE_PATH, JSON.stringify(sessions));
};

// Initialize sessions
const initializeSessions = async () => {
    const savedSessions = loadSessions();
    for (const id of Object.keys(savedSessions)) {
        await createSession(id, false);
    }
};

const createSession = (id, isNew = true) => {
    return new Promise((resolve, reject) => {
        const client = new Client({
            authStrategy: new LocalAuth({ clientId: id })
        });

        let qrCodeBase64 = null;

        client.on('qr', (qr) => {
            console.log(`QR for session ${id}:`);
            QRCode.toDataURL(qr, (err, url) => {
                if (err) {
                    console.error(`Failed to generate QR code for session ${id}`, err);
                    reject(err);
                } else {
                    qrCodeBase64 = url;
                    if (isNew) {
                        resolve({ qrCodeBase64, client });
                    }
                }
            });
        });

        client.on('ready', () => {
            console.log(`Client ${id} is ready!`);
            if (isNew && qrCodeBase64) {
                resolve({ qrCodeBase64, client });
            } else if (isNew) {
                resolve({ qrCodeBase64: null, client });
            }
            notifySessionReady(id);
        });

        client.on('authenticated', () => {
            console.log(`Client ${id} is authenticated!`);
            sessions[id] = client;
            saveSessions(Object.keys(sessions));
            if (!isNew) {
                resolve({ qrCodeBase64: null, client });
            }
        });

        client.on('auth_failure', () => {
            console.log(`Client ${id} authentication failure!`);
            delete sessions[id];
            saveSessions(Object.keys(sessions));
            reject(new Error('Authentication failure'));
        });

        client.on('disconnected', (reason) => {
            console.log(`Client ${id} disconnected: ${reason}`);
            delete sessions[id];
            saveSessions(Object.keys(sessions));
        });

        client.initialize();
    });
};

// Notify external callback URL when session is ready
const notifySessionReady = async (id) => {
    const callbackUrl = 'YOUR_CALLBACK_URL_HERE';  // Replace with your callback URL
    try {
        await axios.post(callbackUrl, { sessionId: id });
        console.log(`Notified session ready for session ${id}`);
    } catch (error) {
        console.error(`Failed to notify session ready for session ${id}`, error);
    }
};

// Create a new session
app.post('/create-session', async (req, res) => {
    const { id } = req.body;

    // Check if session exists and remove it if it does
    if (sessions[id]) {
        await sessions[id].destroy();
        delete sessions[id];
        saveSessions(Object.keys(sessions));
    }

    try {
        const { qrCodeBase64 } = await createSession(id);
        if (qrCodeBase64) {
            res.json({ message: `Session ${id} created`, qr: qrCodeBase64 });
        } else {
            res.json({ message: `Session ${id} created and authenticated` });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to create session', details: error.message });
    }
});

// Send a message with image and buttons
app.post('/send-message', async (req, res) => {
    const { id, number, message, imageUrl, buttons } = req.body;
    const client = sessions[id];
    if (!client) {
        return res.status(400).json({ error: 'Session not found' });
    }
    try {
        let mediaMessage;
        if (imageUrl) {
            const mimeType = mime.lookup(imageUrl);
            const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
            const media = new MessageMedia(mimeType, Buffer.from(response.data).toString('base64'));
            mediaMessage = media;
        }

        let buttonMessage;
        if (buttons && buttons.length > 0) {
            const formattedButtons = buttons.map(button => ({
                buttonId: button.buttonId,
                buttonText: { displayText: button.displayText },
                type: 1 // Type 1 for regular buttons
            }));
            buttonMessage = new Buttons(message, formattedButtons, 'Title', 'Footer');
        } else {
            buttonMessage = message;
        }

        if (mediaMessage) {
            await client.sendMessage(number + '@c.us', mediaMessage, { caption: message });
        } else {
            await client.sendMessage(number + '@c.us', buttonMessage);
        }

        res.json({ message: 'Message sent successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to send message', details: error.message });
    }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    initializeSessions();
});
