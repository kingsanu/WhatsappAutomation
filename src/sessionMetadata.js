const fs = require('fs').promises;
const path = require('path');
const { sessionMetadataPath, enableSessionPersistence } = require('./config');

class SessionMetadataManager {
  constructor() {
    this.metadataCache = new Map();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    
    if (enableSessionPersistence) {
      try {
        await fs.mkdir(sessionMetadataPath, { recursive: true });
        await this.loadExistingMetadata();
        console.log('Session metadata manager initialized');
      } catch (error) {
        console.error('Failed to initialize session metadata manager:', error);
      }
    }
    this.initialized = true;
  }

  async loadExistingMetadata() {
    try {
      const files = await fs.readdir(sessionMetadataPath);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const sessionId = file.replace('.json', '');
          const metadata = await this.getSessionMetadata(sessionId);
          if (metadata) {
            this.metadataCache.set(sessionId, metadata);
          }
        }
      }
      console.log(`Loaded metadata for ${this.metadataCache.size} sessions`);
    } catch (error) {
      console.error('Failed to load existing metadata:', error);
    }
  }

  async saveSessionMetadata(sessionId, metadata) {
    if (!enableSessionPersistence) return true;

    const sessionData = {
      sessionId,
      status: metadata.status || 'UNKNOWN',
      lastActivity: new Date().toISOString(),
      createdAt: metadata.createdAt || new Date().toISOString(),
      connectionAttempts: metadata.connectionAttempts || 0,
      lastError: metadata.lastError || null,
      webhookUrl: metadata.webhookUrl || null,
      isActive: metadata.isActive || false,
      lastQrGenerated: metadata.lastQrGenerated || null,
      browserInfo: metadata.browserInfo || null
    };

    try {
      // Update cache
      this.metadataCache.set(sessionId, sessionData);

      // Save to file
      const metadataFile = path.join(sessionMetadataPath, `${sessionId}.json`);
      await fs.writeFile(metadataFile, JSON.stringify(sessionData, null, 2));
      
      return true;
    } catch (error) {
      console.error(`Failed to save session metadata for ${sessionId}:`, error);
      return false;
    }
  }

  async getSessionMetadata(sessionId) {
    // Try cache first
    if (this.metadataCache.has(sessionId)) {
      return this.metadataCache.get(sessionId);
    }

    if (!enableSessionPersistence) return null;

    try {
      const metadataFile = path.join(sessionMetadataPath, `${sessionId}.json`);
      const fileData = await fs.readFile(metadataFile, 'utf-8');
      const metadata = JSON.parse(fileData);
      
      // Update cache
      this.metadataCache.set(sessionId, metadata);
      return metadata;
    } catch (error) {
      // File doesn't exist or is corrupted
      return null;
    }
  }

  async getAllActiveSessions() {
    const sessions = [];
    
    // Check cache first
    for (const [sessionId, metadata] of this.metadataCache) {
      if (metadata.isActive) {
        sessions.push(metadata);
      }
    }

    // If cache is empty and persistence is enabled, load from files
    if (sessions.length === 0 && enableSessionPersistence) {
      try {
        const files = await fs.readdir(sessionMetadataPath);
        for (const file of files) {
          if (file.endsWith('.json')) {
            const sessionId = file.replace('.json', '');
            const metadata = await this.getSessionMetadata(sessionId);
            if (metadata && metadata.isActive) {
              sessions.push(metadata);
            }
          }
        }
      } catch (error) {
        console.error('Failed to get all active sessions:', error);
      }
    }
    
    return sessions;
  }

  async updateSessionActivity(sessionId, status, error = null) {
    const metadata = await this.getSessionMetadata(sessionId) || {};
    
    metadata.lastActivity = new Date().toISOString();
    metadata.status = status;
    metadata.isActive = ['CONNECTED', 'CONNECTING'].includes(status);
    
    if (error) {
      metadata.lastError = error;
      metadata.connectionAttempts = (metadata.connectionAttempts || 0) + 1;
    } else if (status === 'CONNECTED') {
      metadata.connectionAttempts = 0;
      metadata.lastError = null;
    }

    await this.saveSessionMetadata(sessionId, metadata);
  }

  async getInactiveSessions(maxInactiveTime = 300000) { // 5 minutes
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

  async removeSessionMetadata(sessionId) {
    try {
      // Remove from cache
      this.metadataCache.delete(sessionId);
      
      if (enableSessionPersistence) {
        const metadataFile = path.join(sessionMetadataPath, `${sessionId}.json`);
        await fs.unlink(metadataFile).catch(() => {}); // Ignore if file doesn't exist
      }
      
      return true;
    } catch (error) {
      console.error(`Failed to remove session metadata for ${sessionId}:`, error);
      return false;
    }
  }

  getSessionCount() {
    return this.metadataCache.size;
  }

  getActiveSessionCount() {
    let count = 0;
    for (const metadata of this.metadataCache.values()) {
      if (metadata.isActive) count++;
    }
    return count;
  }

  async getSessionStats() {
    const sessions = await this.getAllActiveSessions();
    const stats = {
      total: this.metadataCache.size,
      active: 0,
      connected: 0,
      connecting: 0,
      disconnected: 0,
      error: 0
    };

    for (const metadata of this.metadataCache.values()) {
      if (metadata.isActive) stats.active++;
      
      switch (metadata.status) {
        case 'CONNECTED':
          stats.connected++;
          break;
        case 'CONNECTING':
          stats.connecting++;
          break;
        case 'DISCONNECTED':
          stats.disconnected++;
          break;
        case 'ERROR':
        case 'FAILED':
          stats.error++;
          break;
      }
    }

    return stats;
  }
}

// Create singleton instance
const sessionMetadataManager = new SessionMetadataManager();

module.exports = sessionMetadataManager;
