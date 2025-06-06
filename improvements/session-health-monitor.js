/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-var-requires */
// Session Health Monitoring System
const EventEmitter = require("events");

class SessionHealthMonitor extends EventEmitter {
  constructor(sessionManager, persistenceManager, config = {}) {
    super();
    this.sessionManager = sessionManager;
    this.persistenceManager = persistenceManager;
    this.config = {
      healthCheckInterval: config.healthCheckInterval || 30000, // 30 seconds
      maxConnectionAttempts: config.maxConnectionAttempts || 3,
      reconnectDelay: config.reconnectDelay || 5000, // 5 seconds
      sessionTimeout: config.sessionTimeout || 300000, // 5 minutes
      ...config,
    };
    this.healthCheckTimer = null;
    this.isMonitoring = false;
  }

  start() {
    if (this.isMonitoring) return;

    this.isMonitoring = true;
    console.log("Starting session health monitoring...");

    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.config.healthCheckInterval);

    // Monitor for session events
    this.setupEventListeners();
  }

  stop() {
    if (!this.isMonitoring) return;

    this.isMonitoring = false;
    console.log("Stopping session health monitoring...");

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  setupEventListeners() {
    // Listen for session disconnections
    this.on("sessionDisconnected", async (sessionId, reason) => {
      console.log(`Session ${sessionId} disconnected: ${reason}`);
      await this.handleSessionDisconnection(sessionId, reason);
    });

    // Listen for session errors
    this.on("sessionError", async (sessionId, error) => {
      console.log(`Session ${sessionId} error: ${error.message}`);
      await this.handleSessionError(sessionId, error);
    });

    // Listen for session recovery
    this.on("sessionRecovered", async (sessionId) => {
      console.log(`Session ${sessionId} recovered successfully`);
      await this.persistenceManager.updateSessionActivity(
        sessionId,
        "CONNECTED"
      );
    });
  }

  async performHealthCheck() {
    try {
      const activeSessions =
        await this.persistenceManager.getAllActiveSessions();

      for (const sessionData of activeSessions) {
        await this.checkSessionHealth(sessionData.sessionId);
      }

      // Clean up inactive sessions
      const inactiveSessions =
        await this.persistenceManager.cleanupInactiveSessions(
          this.config.sessionTimeout
        );

      for (const sessionId of inactiveSessions) {
        console.log(`Cleaning up inactive session: ${sessionId}`);
        await this.sessionManager.terminateSession(sessionId);
      }
    } catch (error) {
      console.error("Health check failed:", error);
    }
  }

  async checkSessionHealth(sessionId) {
    try {
      const session = this.sessionManager.getSession(sessionId);
      if (!session) {
        // Session not in memory, try to restore
        await this.attemptSessionRestore(sessionId);
        return;
      }

      // Check if session is responsive
      const validation = await this.sessionManager.validateSession(sessionId);

      if (!validation.success) {
        if (validation.message === "session_not_connected") {
          this.emit("sessionDisconnected", sessionId, validation.message);
        } else {
          this.emit("sessionError", sessionId, new Error(validation.message));
        }
      } else {
        // Update last activity
        await this.persistenceManager.updateSessionActivity(
          sessionId,
          "CONNECTED"
        );
      }
    } catch (error) {
      this.emit("sessionError", sessionId, error);
    }
  }

  async handleSessionDisconnection(sessionId, reason) {
    const metadata = await this.persistenceManager.getSessionMetadata(
      sessionId
    );
    if (!metadata) return;

    const attempts = metadata.connectionAttempts || 0;

    if (attempts < this.config.maxConnectionAttempts) {
      console.log(
        `Attempting to reconnect session ${sessionId} (attempt ${attempts + 1})`
      );

      setTimeout(async () => {
        try {
          await this.sessionManager.restartSession(sessionId);
          this.emit("sessionRecovered", sessionId);
        } catch (error) {
          await this.persistenceManager.updateSessionActivity(
            sessionId,
            "DISCONNECTED",
            error.message
          );
        }
      }, this.config.reconnectDelay);
    } else {
      console.log(`Max reconnection attempts reached for session ${sessionId}`);
      await this.persistenceManager.updateSessionActivity(sessionId, "FAILED");
    }
  }

  async handleSessionError(sessionId, error) {
    await this.persistenceManager.updateSessionActivity(
      sessionId,
      "ERROR",
      error.message
    );

    // Attempt recovery based on error type
    if (this.isRecoverableError(error)) {
      setTimeout(async () => {
        try {
          await this.sessionManager.reloadSession(sessionId);
          this.emit("sessionRecovered", sessionId);
        } catch (recoveryError) {
          console.error(
            `Failed to recover session ${sessionId}:`,
            recoveryError
          );
        }
      }, this.config.reconnectDelay);
    }
  }

  async attemptSessionRestore(sessionId) {
    try {
      console.log(`Attempting to restore session ${sessionId}`);
      const result = await this.sessionManager.setupSession(sessionId);

      if (result.success) {
        await this.persistenceManager.updateSessionActivity(
          sessionId,
          "CONNECTING"
        );
        this.emit("sessionRecovered", sessionId);
      }
    } catch (error) {
      console.error(`Failed to restore session ${sessionId}:`, error);
      await this.persistenceManager.updateSessionActivity(
        sessionId,
        "FAILED",
        error.message
      );
    }
  }

  isRecoverableError(error) {
    const recoverableErrors = [
      "browser tab closed",
      "session closed",
      "page crashed",
      "navigation timeout",
      "connection lost",
    ];

    return recoverableErrors.some((recoverable) =>
      error.message.toLowerCase().includes(recoverable)
    );
  }

  // Get health statistics
  async getHealthStats() {
    const sessions = await this.persistenceManager.getAllActiveSessions();
    const stats = {
      total: sessions.length,
      connected: 0,
      disconnected: 0,
      error: 0,
      connecting: 0,
    };

    sessions.forEach((session) => {
      switch (session.status) {
        case "CONNECTED":
          stats.connected++;
          break;
        case "DISCONNECTED":
          stats.disconnected++;
          break;
        case "ERROR":
        case "FAILED":
          stats.error++;
          break;
        case "CONNECTING":
          stats.connecting++;
          break;
      }
    });

    return stats;
  }
}

module.exports = SessionHealthMonitor;
