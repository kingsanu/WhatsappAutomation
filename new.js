const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const express = require("express");
const QRCode = require("qrcode");
const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");
const axios = require("axios");
const mime = require("mime-types");
const { body, param, validationResult } = require("express-validator");

const app = express();
app.use(express.json());

const sessions = {};

// Input validation middleware
const validateCreateSession = [
  body("userId").trim().notEmpty().withMessage("User ID is required"),
];

const validateSendMessage = [
  body("userId").trim().notEmpty().withMessage("User ID is required"),
  body("number").trim().notEmpty().withMessage("Phone number is required"),
  body("message").optional().trim(),
  body("fileUrl").optional().trim().isURL().withMessage("Invalid file URL"),
];

const validateReconnect = [
  param("userId").trim().notEmpty().withMessage("User ID is required"),
];

// Validation error handler middleware
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};
let db;

const MAX_RETRIES = 5;
const RETRY_INTERVAL = 5000;
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000; // Health check every 5 minutes
const MAX_CONCURRENT_SESSIONS = 100; // Maximum number of concurrent sessions
const SESSION_TIMEOUT = 30 * 60 * 1000; // Session timeout after 30 minutes of inactivity
const CONNECTION_POOL = new Map(); // Connection pool for managing active sessions
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

// Database utility functions
const updateLastActive = async (userId) => {
  try {
    await db.run(
      "UPDATE sessions SET lastActive = CURRENT_TIMESTAMP WHERE userId = ?",
      [userId]
    );
  } catch (error) {
    console.error(`Error updating last active for user ${userId}:`, error);
    throw error;
  }
};

const updateSessionError = async (userId, error) => {
  try {
    await db.run("UPDATE sessions SET lastError = ? WHERE userId = ?", [
      error.toString(),
      userId,
    ]);
  } catch (dbError) {
    console.error(`Error updating session error for user ${userId}:`, dbError);
    throw dbError;
  }
};

const saveSession = async (userId, sessionId, isAuthenticated) => {
  try {
    await db.run(
      "INSERT OR REPLACE INTO sessions (userId, sessionId, isAuthenticated, lastActive, lastError) VALUES (?, ?, ?, CURRENT_TIMESTAMP, NULL)",
      [userId, sessionId, isAuthenticated ? 1 : 0]
    );
  } catch (error) {
    console.error(`Error saving session for user ${userId}:`, error);
    throw error;
  }
};

// Enhanced session cleanup
const cleanupInactiveSessions = async () => {
  const currentTime = Date.now();
  const sessions = await db.all("SELECT * FROM sessions");

  for (const session of sessions) {
    const lastActive = new Date(session.lastActive).getTime();
    if (currentTime - lastActive > SESSION_TIMEOUT) {
      const client = sessions[session.sessionId];
      if (client) {
        try {
          await client.saveState();
          delete sessions[session.sessionId];
          CONNECTION_POOL.delete(session.userId);
          await db.run("DELETE FROM sessions WHERE userId = ?", [
            session.userId,
          ]);
          console.log(`Cleaned up inactive session for user ${session.userId}`);
        } catch (error) {
          console.error(
            `Error cleaning up session for user ${session.userId}:`,
            error
          );
        }
      }
    }
  }
};

// Enhanced session management
const getAvailableConnection = async () => {
  if (CONNECTION_POOL.size >= MAX_CONCURRENT_SESSIONS) {
    await cleanupInactiveSessions();
    if (CONNECTION_POOL.size >= MAX_CONCURRENT_SESSIONS) {
      throw new Error("Maximum concurrent sessions reached");
    }
  }
  return true;
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
// Modify createSession function to use connection pooling
const createSession = async (userId, sessionId) => {
  await getAvailableConnection();
  CONNECTION_POOL.set(userId, true);

  return new Promise((resolve, reject) => {
    const client = new Client({
      authStrategy: new LocalAuth({ clientId: sessionId }),
      puppeteer: {
        executablePath: "/usr/bin/google-chrome",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
          "--headless",
        ],
        defaultViewport: null,
      },
      webVersionCache: {
        type: "local",
        path: "./sessions/webCache",
        ttl: 7 * 24 * 60 * 60 * 1000, // 7 days
      },
      restartOnAuthFail: true,
      takeoverOnConflict: true,
      takeoverTimeoutMs: 0,
      qrMaxRetries: 3,
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
  res.json({ message: "WhatsApp Automation API Testing is running!" });
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
    console.error(`Error creating session for user ${userId}:`, error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post(
  "/create-session",
  validateCreateSession,
  handleValidationErrors,
  async (req, res) => {
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
      console.error(`Error creating session for user ${userId}:`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

app.post(
  "/send-message",
  validateSendMessage,
  handleValidationErrors,
  async (req, res) => {
    const { userId, number, message, fileUrl } = req.body;

    try {
      const session = await db.get("SELECT * FROM sessions WHERE userId = ?", [
        userId,
      ]);
      if (!session || !session.isAuthenticated) {
        return res.status(403).json({ error: "WhatsApp not authenticated" });
      }

      let client = sessions[session.sessionId];
      if (!client) {
        // Try to restore the session
        try {
          const { client: newClient } = await createSession(
            userId,
            session.sessionId
          );
          client = newClient;
          sessions[session.sessionId] = client;
        } catch (error) {
          return res.status(400).json({ error: "Failed to restore session" });
        }
      }

      // Ensure connection is healthy before proceeding
      const isConnected = await checkConnection(
        client,
        userId,
        session.sessionId
      );
      if (!isConnected) {
        return res
          .status(503)
          .json({ error: "Failed to establish connection" });
      }

      const chat = await client.getChatById(number + "@c.us");

      if (fileUrl) {
        try {
          const response = await axios.get(fileUrl, {
            responseType: "arraybuffer",
            timeout: 10000, // 10 second timeout
          });

          const mimeType = response.headers["content-type"];
          const media = new MessageMedia(
            mimeType,
            Buffer.from(response.data).toString("base64"),
            "file." + (mime.extension(mimeType) || "bin")
          );

          await chat.sendMessage(media, { caption: message });
        } catch (error) {
          console.error("Error sending file:", error);
          return res.status(400).json({ error: "Failed to send file" });
        }
      } else if (message) {
        await chat.sendMessage(message);
      } else {
        return res
          .status(400)
          .json({ error: "No message or file URL provided" });
      }

      await updateLastActive(userId);
      res.json({ message: "Message sent successfully" });
    } catch (error) {
      console.error("Error in send-message:", error);
      await updateSessionError(userId, error);
      console.error(`Error creating session for user ${userId}:`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

app.post(
  "/reconnect/:userId",
  validateReconnect,
  handleValidationErrors,
  async (req, res) => {
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
      console.error(`Error creating session for user ${userId}:`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);
const checkConnection = async (client, userId, sessionId, maxRetries = 3) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (!client.isConnected) {
        await client.initialize();
        await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait for connection
      }
      return client.isConnected;
    } catch (error) {
      console.error(
        `Connection check attempt ${i + 1} failed for user ${userId}:`,
        error
      );
      if (i === maxRetries - 1) return false;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (i + 1))); // Exponential backoff
    }
  }
  return false;
};

const initializeSessions = async () => {
  const savedSessions = await db.all("SELECT * FROM sessions");
  for (const session of savedSessions) {
    try {
      const { client } = await createSession(session.userId, session.sessionId);
      sessions[session.sessionId] = client;

      // Set up periodic health checks for this session
      // Set up periodic health and connection checks for this session
      setInterval(async () => {
        try {
          const isConnected = await checkConnection(
            client,
            session.userId,
            session.sessionId
          );
          if (!isConnected) {
            console.error(`Connection check failed for user ${session.userId}`);
          }
        } catch (error) {
          console.error(
            `Health check failed for user ${session.userId}:`,
            error
          );
        }
      }, HEALTH_CHECK_INTERVAL);

      console.log(`Restored session for user ${session.userId}`);
    } catch (error) {
      console.error(
        `Failed to restore session for user ${session.userId}:`,
        error
      );
    }
  }
};

const PORT = process.env.PORT || 8080;

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
