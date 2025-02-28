const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const express = require("express");
const QRCode = require("qrcode");
const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");
const axios = require("axios");
const mime = require("mime-types");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const sessions = new Map();
let db;

const MAX_RETRIES = 3;
const RETRY_INTERVAL = 5000;

// Enhanced database schema with encryption
const initializeDatabase = async () => {
  db = await open({
    filename: "./whatsapp_sessions.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      userId TEXT PRIMARY KEY,
      sessionId TEXT,
      sessionData TEXT,
      isAuthenticated INTEGER,
      lastActive TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      lastError TEXT,
      retryCount INTEGER DEFAULT 0,
      encryptionKey TEXT
    )
  `);
};

// Encryption utilities
const generateEncryptionKey = () => crypto.randomBytes(32).toString("hex");

const encrypt = (text, key) => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    Buffer.from(key, "hex"),
    iv
  );
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return `${iv.toString("hex")}:${encrypted}`;
};

const decrypt = (text, key) => {
  const [ivHex, encrypted] = text.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const decipher = crypto.createDecipheriv(
    "aes-256-cbc",
    Buffer.from(key, "hex"),
    iv
  );
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
};

// Enhanced session management
const updateSession = async (userId, updates) => {
  const updateFields = Object.entries(updates)
    .map(([key, value]) => `${key} = ?`)
    .join(", ");
  const values = [...Object.values(updates), userId];

  await db.run(
    `UPDATE sessions SET ${updateFields}, lastActive = CURRENT_TIMESTAMP WHERE userId = ?`,
    values
  );
};

const saveSession = async (userId, sessionId, sessionData) => {
  const existingSession = await db.get(
    "SELECT encryptionKey FROM sessions WHERE userId = ?",
    [userId]
  );
  const encryptionKey =
    existingSession?.encryptionKey || generateEncryptionKey();
  const encryptedData = encrypt(JSON.stringify(sessionData), encryptionKey);

  await db.run(
    `INSERT OR REPLACE INTO sessions 
    (userId, sessionId, sessionData, isAuthenticated, lastActive, lastError, retryCount, encryptionKey) 
    VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, NULL, 0, ?)`,
    [userId, sessionId, encryptedData, encryptionKey]
  );
};

const handleClientError = async (error, userId, client) => {
  console.error(`Error for user ${userId}:`, error);

  const session = await db.get(
    "SELECT retryCount FROM sessions WHERE userId = ?",
    [userId]
  );
  const retryCount = (session?.retryCount || 0) + 1;

  await updateSession(userId, {
    retryCount,
    lastError: error.toString(),
  });

  if (retryCount <= MAX_RETRIES) {
    await new Promise((resolve) =>
      setTimeout(resolve, RETRY_INTERVAL * Math.pow(2, retryCount - 1))
    );
    return initializeClient(userId, client);
  }

  throw new Error("Max retry attempts reached");
};

const initializeClient = async (userId, client) => {
  try {
    if (!client.isConnected) {
      await client.initialize();
      console.log(`Client initialized for user ${userId}`);
    }
    return true;
  } catch (error) {
    return handleClientError(error, userId, client);
  }
};

const loadSessions = async () => {
  return await db.all("SELECT * FROM sessions WHERE isAuthenticated = 1");
};

const createSession = (userId, sessionId) => {
  return new Promise((resolve, reject) => {
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: sessionId,
        dataPath: path.join(process.cwd(), "sessions"),
      }),
      puppeteer: {
        executablePath: "/usr/bin/google-chrome",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-gpu",
          "--headless",
        ],
        headless: true,
      },
      webVersionCache: {
        type: "local",
        path: path.join(process.cwd(), "sessions", "webCache"),
        ttl: 7 * 24 * 60 * 60 * 1000,
      },
      qrMaxRetries: 3,
      takeoverOnConflict: true,
      takeoverTimeoutMs: 0,
    });

    client.on("qr", async (qr) => {
      try {
        const qrCodeBase64 = await QRCode.toDataURL(qr);
        resolve({ qrCodeBase64, client });
      } catch (err) {
        reject(err);
      }
    });

    client.on("authenticated", async (session) => {
      try {
        await saveSession(userId, sessionId, session);
        sessions.set(userId, client);
        console.log(`Client authenticated for user ${userId}`);
        await client.saveState();
      } catch (err) {
        console.error(`Authentication error for user ${userId}:`, err);
      }
    });

    client.on("ready", () => {
      console.log(`Client ready for user ${userId}`);
      updateSession(userId, { lastError: null, retryCount: 0 });
    });

    client.on("disconnected", async (reason) => {
      console.log(`Client disconnected for user ${userId}:`, reason);
      await handleClientError(new Error(reason), userId, client);
    });

    initializeClient(userId, client).catch(reject);
  });
};

// Restore all sessions on startup
const initializeSessions = async () => {
  const savedSessions = await loadSessions();
  for (const session of savedSessions) {
    try {
      const { client } = await createSession(session.userId, session.sessionId);
      sessions.set(session.userId, client);
      console.log(`Restored session for user ${session.userId}`);
    } catch (error) {
      console.error(
        `Failed to restore session for user ${session.userId}:`,
        error
      );
      // Don't remove the session, just log the error
      await updateSession(session.userId, {
        lastError: error.toString(),
        retryCount: (session.retryCount || 0) + 1,
      });
    }
  }
};

// API endpoints
app.get("/", (req, res) => {
  res.json({ message: "WhatsApp Automation API is running!" });
});

app.get("/session-status/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    const session = await db.get("SELECT * FROM sessions WHERE userId = ?", [
      userId,
    ]);
    if (!session) {
      return res.status(404).json({ status: "No session found" });
    }

    const client = sessions.get(userId);
    const isConnected = client?.isConnected || false;

    res.json({
      userId,
      sessionId: session.sessionId,
      isAuthenticated: Boolean(session.isAuthenticated),
      isConnected,
      lastActive: session.lastActive,
      lastError: session.lastError,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/create-session", async (req, res) => {
  const { userId } = req.body;

  try {
    const existingSession = await db.get(
      "SELECT * FROM sessions WHERE userId = ?",
      [userId]
    );
    if (existingSession && existingSession.isAuthenticated) {
      const client = sessions.get(userId);
      if (client?.isConnected) {
        return res.status(400).json({ error: "Active session exists" });
      }
    }

    const sessionId = `user_${userId}_${Date.now()}`;
    const { qrCodeBase64 } = await createSession(userId, sessionId);

    res.json({
      message: "Scan QR to link WhatsApp",
      qr: qrCodeBase64,
      sessionId,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/send-message", async (req, res) => {
  const { userId, number, message, fileUrl } = req.body;

  try {
    const session = await db.get("SELECT * FROM sessions WHERE userId = ?", [
      userId,
    ]);
    if (!session?.isAuthenticated) {
      return res.status(403).json({ error: "Not authenticated" });
    }

    let client = sessions.get(userId);
    if (!client || !client.isConnected) {
      // Attempt to restore session
      const { sessionId } = session;
      const result = await createSession(userId, sessionId);
      client = result.client;
      sessions.set(userId, client);
    }

    try {
      const chat = await client.getChatById(number + "@c.us");

      if (fileUrl) {
        const response = await axios.get(fileUrl, {
          responseType: "arraybuffer",
        });
        const mimeType = response.headers["content-type"];
        const extension =
          mime.extension(mimeType) || path.extname(fileUrl).slice(1);
        const media = new MessageMedia(
          mimeType,
          Buffer.from(response.data).toString("base64"),
          `file.${extension}`
        );
        await chat.sendMessage(media, { caption: message });
      } else if (message) {
        await chat.sendMessage(message);
      } else {
        return res.status(400).json({ error: "No content provided" });
      }

      res.json({ success: true });
    } catch (error) {
      if (error.message.includes("protocol")) {
        await initializeClient(userId, client);
        // Retry sending the message
        const chat = await client.getChatById(number + "@c.us");
        if (fileUrl) {
          const response = await axios.get(fileUrl, {
            responseType: "arraybuffer",
          });
          const mimeType = response.headers["content-type"];
          const extension =
            mime.extension(mimeType) || path.extname(fileUrl).slice(1);
          const media = new MessageMedia(
            mimeType,
            Buffer.from(response.data).toString("base64"),
            `file.${extension}`
          );
          await chat.sendMessage(media, { caption: message });
        } else if (message) {
          await chat.sendMessage(message);
        }
        res.json({ success: true });
      } else {
        throw error;
      }
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Initialize server
const PORT = process.env.PORT || 8080;

(async () => {
  await initializeDatabase();
  await initializeSessions();

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
})();

// Modified shutdown handler to preserve sessions
process.on("SIGINT", async () => {
  console.log("Graceful shutdown initiated...");
  for (const [userId, client] of sessions.entries()) {
    try {
      await client.saveState();
      console.log(`Session state saved for user ${userId}`);
    } catch (error) {
      console.error(`Error saving session state for user ${userId}:`, error);
    }
  }
  await db.close();
  process.exit(0);
});
