import pkg from "whatsapp-web.js";
import QRCode from "qrcode";
import sessionHandler from "./sessions.js";
const { Client, LocalAuth } = pkg;

export const createSession = async (userId) => {
  return new Promise((resolve, reject) => {
    const sessionId = `session_${userId}_${Date.now()}`;

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: sessionId }),
      puppeteer: {
        headless: "new",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      },
    });

    let qrCodeBase64;

    client.on("qr", async (qr) => {
      try {
        qrCodeBase64 = await QRCode.toDataURL(qr);
        resolve({ qrCode: qrCodeBase64, sessionId });
      } catch (error) {
        reject(error);
      }
    });

    client.on("authenticated", async () => {
      await sessionHandler.store(sessionId, client.info);
    });

    client.on("ready", () => {
      console.log(`Session ${sessionId} is ready`);
    });

    client.on("auth_failure", (msg) => {
      reject(new Error(`Authentication failed: ${msg}`));
    });

    client.initialize().catch(reject);
  });
};
