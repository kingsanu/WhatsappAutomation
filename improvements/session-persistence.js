// Enhanced Session Persistence Manager
const Redis = require("redis");
const fs = require("fs").promises;
const path = require("path");

class SessionPersistenceManager {
  constructor(config) {
    this.config = config;
    this.redis = config.redis ? Redis.createClient(config.redis) : null;
    this.sessionMetadataPath = path.join(config.sessionFolderPath, "metadata");
  }

  async initialize() {
    if (this.redis) {
      await this.redis.connect();
    }
    await this.ensureMetadataDirectory();
  }

  async ensureMetadataDirectory() {
    try {
      await fs.mkdir(this.sessionMetadataPath, { recursive: true });
    } catch (error) {
      console.error("Failed to create metadata directory:", error);
    }
  }

  // Store session metadata
  async saveSessionMetadata(sessionId, metadata) {
    const sessionData = {
      sessionId,
      status: metadata.status,
      lastActivity: new Date().toISOString(),
      createdAt: metadata.createdAt || new Date().toISOString(),
      connectionAttempts: metadata.connectionAttempts || 0,
      lastError: metadata.lastError || null,
      webhookUrl: metadata.webhookUrl,
      userAgent: metadata.userAgent,
      isActive: metadata.isActive || false,
    };

    try {
      // Store in Redis if available
      if (this.redis) {
        await this.redis.setEx(
          `session:${sessionId}`,
          3600, // 1 hour TTL
          JSON.stringify(sessionData)
        );
      }

      // Also store in file system as backup
      const metadataFile = path.join(
        this.sessionMetadataPath,
        `${sessionId}.json`
      );
      await fs.writeFile(metadataFile, JSON.stringify(sessionData, null, 2));

      return true;
    } catch (error) {
      console.error(`Failed to save session metadata for ${sessionId}:`, error);
      return false;
    }
  }

  // Retrieve session metadata
  async getSessionMetadata(sessionId) {
    try {
      // Try Redis first
      if (this.redis) {
        const redisData = await this.redis.get(`session:${sessionId}`);
        if (redisData) {
          return JSON.parse(redisData);
        }
      }

      // Fallback to file system
      const metadataFile = path.join(
        this.sessionMetadataPath,
        `${sessionId}.json`
      );
      const fileData = await fs.readFile(metadataFile, "utf-8");
      return JSON.parse(fileData);
    } catch (error) {
      console.error(`Failed to get session metadata for ${sessionId}:`, error);
      return null;
    }
  }

  // Get all active sessions
  async getAllActiveSessions() {
    try {
      const sessions = [];

      if (this.redis) {
        const keys = await this.redis.keys("session:*");
        for (const key of keys) {
          const data = await this.redis.get(key);
          if (data) {
            const sessionData = JSON.parse(data);
            if (sessionData.isActive) {
              sessions.push(sessionData);
            }
          }
        }
      } else {
        // Fallback to file system
        const files = await fs.readdir(this.sessionMetadataPath);
        for (const file of files) {
          if (file.endsWith(".json")) {
            const filePath = path.join(this.sessionMetadataPath, file);
            const data = await fs.readFile(filePath, "utf-8");
            const sessionData = JSON.parse(data);
            if (sessionData.isActive) {
              sessions.push(sessionData);
            }
          }
        }
      }

      return sessions;
    } catch (error) {
      console.error("Failed to get all active sessions:", error);
      return [];
    }
  }

  // Update session activity
  async updateSessionActivity(sessionId, status, error = null) {
    const metadata = await this.getSessionMetadata(sessionId);
    if (metadata) {
      metadata.lastActivity = new Date().toISOString();
      metadata.status = status;
      metadata.isActive = status === "CONNECTED";
      if (error) {
        metadata.lastError = error;
        metadata.connectionAttempts = (metadata.connectionAttempts || 0) + 1;
      }
      await this.saveSessionMetadata(sessionId, metadata);
    }
  }

  // Clean up inactive sessions
  async cleanupInactiveSessions(maxInactiveTime = 3600000) {
    // 1 hour
    const sessions = await this.getAllActiveSessions();
    const now = new Date();
    const inactiveSessions = [];

    for (const session of sessions) {
      const lastActivity = new Date(session.lastActivity);
      const timeDiff = now - lastActivity;

      if (timeDiff > maxInactiveTime) {
        inactiveSessions.push(session.sessionId);
      }
    }

    return inactiveSessions;
  }

  // Remove session metadata
  async removeSessionMetadata(sessionId) {
    try {
      if (this.redis) {
        await this.redis.del(`session:${sessionId}`);
      }

      const metadataFile = path.join(
        this.sessionMetadataPath,
        `${sessionId}.json`
      );
      await fs.unlink(metadataFile).catch(() => {}); // Ignore if file doesn't exist

      return true;
    } catch (error) {
      console.error(
        `Failed to remove session metadata for ${sessionId}:`,
        error
      );
      return false;
    }
  }
}

module.exports = SessionPersistenceManager;
