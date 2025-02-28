const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const express = require("express");
const QRCode = require("qrcode");
const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");
const axios = require("axios");
const mime = require("mime-types");

const app = express();
app.use(express.json());

const sessions = {};
let db;

const MAX_RETRIES = 5;
const RETRY_INTERVAL = 5000;

const initializeDatabase = async () => {
  db = await open({
    filename: "./whatsapp_sessions.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      userId TEXT PRIMARY KEY,
      sessionId TEXT,
      isAuthenticated INTEGER,
      lastActive TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      lastError TEXT
    )
  `);
};

// Session management functions
const updateLastActive = async (userId) => {
  await db.run(
    "UPDATE sessions SET lastActive = CURRENT_TIMESTAMP WHERE userId = ?",
    [userId]
  );
};

const updateSessionError = async (userId, error) => {
  await db.run("UPDATE sessions SET lastError = ? WHERE userId = ?", [
    error.toString(),
    userId,
  ]);
};

const saveSession = async (userId, sessionId, isAuthenticated) => {
  await db.run(
    "INSERT OR REPLACE INTO sessions (userId, sessionId, isAuthenticated, lastActive, lastError) VALUES (?, ?, ?, CURRENT_TIMESTAMP, NULL)",
    [userId, sessionId, isAuthenticated ? 1 : 0]
  );
};

const loadSessions = async () => {
  return await db.all("SELECT * FROM sessions");
};
// Reconnection handling
const handleReconnection = async (
  client,
  userId,
  sessionId,
  retryCount = 0
) => {
  try {
    if (client.isConnected) {
      console.log(`Client ${userId} is already connected`);
      return true;
    }

    await client.initialize();
    console.log(`Reconnected client for user ${userId}`);
    await updateLastActive(userId);
    return true;
  } catch (error) {
    console.error(
      `Reconnection attempt ${retryCount + 1} failed for user ${userId}:`,
      error
    );
    await updateSessionError(userId, error);

    if (retryCount < MAX_RETRIES) {
      const waitTime = RETRY_INTERVAL * Math.pow(2, retryCount); // Exponential backoff
      console.log(`Retrying in ${waitTime / 1000} seconds...`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      return handleReconnection(client, userId, sessionId, retryCount + 1);
    }

    console.error(`Max retries reached for user ${userId}`);
    return false;
  }
};

const createSession = (userId, sessionId) => {
  return new Promise((resolve, reject) => {
    const client = new Client({
      authStrategy: new LocalAuth({ clientId: sessionId }),
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
      backupSyncIntervalMs: 300000, // Backup auth state every 5 minutes
      // Very important settings for session persistence
      restartOnAuthFail: true,
      takeoverOnConflict: true,
      takeoverTimeoutMs: 0,
      // Use a mobile user agent to mimic phone app
      webVersionCache: {
        type: "local",
        path: "./sessions/webCache",
        // Set a longer TTL for web version cache
        ttl: 7 * 24 * 60 * 60 * 1000, // 7 days
      },
      // Keep alive settings
      qrMaxRetries: 3,
      connectDelay: 5000,
      authTimeoutMs: 0,
    });

    let qrCodeBase64 = null;

    // Add these event listeners
    client.on("auth_failure", async () => {
      await client.initialize(); // Try to reinitialize immediately
    });

    client.on("disconnected", async (reason) => {
      // Wait a bit before trying to reconnect
      setTimeout(async () => {
        await client.initialize();
      }, 3000);
    });

    client.on("qr", (qr) => {
      QRCode.toDataURL(qr, (err, url) => {
        if (err) reject(err);
        qrCodeBase64 = url;
        resolve({ qrCodeBase64, client });
      });
    });

    client.on("authenticated", async () => {
      await saveSession(userId, sessionId, true);
      sessions[sessionId] = client;
      console.log(`Client for user ${userId} authenticated`);
      await updateLastActive(userId);

      // Save auth state immediately after authentication
      await client.saveState().catch((err) => {
        console.error(`Failed to save state for user ${userId}:`, err);
      });
    });

    client.on("ready", async () => {
      console.log(`Client for user ${userId} is ready`);
      await updateLastActive(userId);
    });

    client.on("disconnected", async (reason) => {
      console.log(`Client for user ${userId} was disconnected:`, reason);
      await updateSessionError(userId, `Disconnected: ${reason}`);

      console.log(`Attempting to reconnect client for user ${userId}...`);
      const reconnected = await handleReconnection(client, userId, sessionId);

      if (!reconnected) {
        await saveSession(userId, sessionId, false);
        delete sessions[sessionId];
      }
    });

    client.on("auth_failure", async (error) => {
      console.log(`Auth failure for user ${userId}:`, error);
      await updateSessionError(userId, `Authentication failed: ${error}`);
      await saveSession(userId, sessionId, false);
      delete sessions[sessionId];
    });

    client.on("change_state", async (state) => {
      console.log(`State changed to ${state} for user ${userId}`);
      if (state === "CONNECTED") {
        await updateLastActive(userId);
      }
    });

    client.initialize().catch(async (err) => {
      console.error(`Failed to initialize client for user ${userId}:`, err);
      await updateSessionError(userId, err);
      reject(err);
    });
    // Add this to your createSession function
    setInterval(async () => {
      try {
        await client.saveState();
      } catch (error) {
        console.error("Failed to backup auth state:", error);
      }
    }, 300000); // Every 5 minutes
  });
};

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

    res.json({
      userId,
      sessionId: session.sessionId,
      isAuthenticated: Boolean(session.isAuthenticated),
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
    if (existingSession) {
      return res
        .status(400)
        .json({ error: "Session already exists for this user" });
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
    if (!session || !session.isAuthenticated) {
      return res.status(403).json({ error: "WhatsApp not authenticated" });
    }

    const client = sessions[session.sessionId];
    if (!client) {
      return res.status(400).json({ error: "Session not found" });
    }

    const chat = await client.getChatById(number + "@c.us");

    if (fileUrl) {
      try {
        const response = await axios.get(fileUrl, {
          responseType: "arraybuffer",
        });

        // Get original filename from URL
        const parsedUrl = new URL(fileUrl);
        const originalFileName = parsedUrl.pathname.split("/").pop() || "file";

        // Detect MIME type properly
        let mimeType = response.headers["content-type"];
        const data = Buffer.from(response.data);

        // Check for PDF magic number
        const isPDF = data.slice(0, 4).toString() === "%PDF";
        if (isPDF) mimeType = "application/pdf";

        // Get extension from original filename or MIME type
        const extension =
          mime.extension(mimeType) ||
          path.extname(originalFileName).slice(1) ||
          "bin";

        // Preserve original filename but ensure correct extension
        const fileName = originalFileName.includes(".")
          ? originalFileName
          : `${originalFileName}.${extension}`;

        console.log(`Sending file: ${fileName} (${mimeType})`);

        const media = new MessageMedia(
          mimeType,
          data.toString("base64"),
          fileName
        );

        // Send as document if it's not an image/audio/video
        const options = {
          caption: message,
          sendMediaAsDocument:
            !mimeType.startsWith("image/") &&
            !mimeType.startsWith("audio/") &&
            !mimeType.startsWith("video/"),
        };

        await chat.sendMessage(media, options);
        console.log("File sent successfully");
      } catch (error) {
        console.error("Error fetching or sending file:", error);
        return res
          .status(400)
          .json({ error: "Failed to fetch or send file from URL" });
      }
    } else if (message) {
      await chat.sendMessage(message);
      console.log("Text message sent successfully");
    } else {
      return res.status(400).json({ error: "No message or file URL provided" });
    }

    res.json({ message: "Message sent successfully" });
  } catch (error) {
    console.error("Error in send-message:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/reconnect/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    const session = await db.get("SELECT * FROM sessions WHERE userId = ?", [
      userId,
    ]);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const client = sessions[session.sessionId];
    if (!client) {
      return res.status(400).json({ error: "Client not found" });
    }

    const reconnected = await handleReconnection(
      client,
      userId,
      session.sessionId
    );
    if (reconnected) {
      res.json({ message: "Successfully reconnected" });
    } else {
      res
        .status(500)
        .json({ error: "Failed to reconnect after multiple attempts" });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
const initializeSessions = async () => {
  const savedSessions = await loadSessions();
  for (const session of savedSessions) {
    try {
      await createSession(session.userId, session.sessionId);
      console.log(`Restored session for user ${session.userId}`);
    } catch (error) {
      console.error(
        `Failed to restore session for user ${session.userId}:`,
        error
      );
    }
  }
};

const PORT = process.env.PORT || 8008;

(async () => {
  await initializeDatabase();
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    initializeSessions();
  });
})();

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down gracefully...");
  await db.close();
  process.exit(0);
});
