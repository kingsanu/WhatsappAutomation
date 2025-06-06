const EventEmitter = require('events');
const sessionMetadataManager = require('./sessionMetadata');
const { 
  sessionHealthCheckInterval, 
  maxSessionRetries, 
  sessionRetryDelay, 
  sessionTimeout 
} = require('./config');

class SessionHealthMonitor extends EventEmitter {
  constructor() {
    super();
    this.healthCheckTimer = null;
    this.isMonitoring = false;
    this.sessionManager = null; // Will be injected
  }

  setSessionManager(sessionManager) {
    this.sessionManager = sessionManager;
  }

  start() {
    if (this.isMonitoring) return;
    
    this.isMonitoring = true;
    console.log('Starting session health monitoring...');
    
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, sessionHealthCheckInterval);

    this.setupEventListeners();
  }

  stop() {
    if (!this.isMonitoring) return;
    
    this.isMonitoring = false;
    console.log('Stopping session health monitoring...');
    
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  setupEventListeners() {
    this.on('sessionDisconnected', async (sessionId, reason) => {
      console.log(`Session ${sessionId} disconnected: ${reason}`);
      await this.handleSessionDisconnection(sessionId, reason);
    });

    this.on('sessionError', async (sessionId, error) => {
      console.log(`Session ${sessionId} error: ${error.message}`);
      await this.handleSessionError(sessionId, error);
    });

    this.on('sessionRecovered', async (sessionId) => {
      console.log(`Session ${sessionId} recovered successfully`);
      await sessionMetadataManager.updateSessionActivity(sessionId, 'CONNECTED');
    });
  }

  async performHealthCheck() {
    if (!this.sessionManager) return;

    try {
      const activeSessions = await sessionMetadataManager.getAllActiveSessions();
      
      for (const sessionData of activeSessions) {
        await this.checkSessionHealth(sessionData.sessionId);
      }

      // Clean up inactive sessions
      const inactiveSessions = await sessionMetadataManager.getInactiveSessions(sessionTimeout);
      
      for (const sessionId of inactiveSessions) {
        console.log(`Cleaning up inactive session: ${sessionId}`);
        await this.sessionManager.terminateSession(sessionId);
      }

    } catch (error) {
      console.error('Health check failed:', error);
    }
  }

  async checkSessionHealth(sessionId) {
    if (!this.sessionManager) return;

    try {
      const session = this.sessionManager.getSession(sessionId);
      if (!session) {
        // Session not in memory, try to restore if it should be active
        const metadata = await sessionMetadataManager.getSessionMetadata(sessionId);
        if (metadata && metadata.isActive) {
          await this.attemptSessionRestore(sessionId);
        }
        return;
      }

      // Check if session is responsive
      const validation = await this.sessionManager.validateSession(sessionId);
      
      if (!validation.success) {
        if (validation.message === 'session_not_connected') {
          this.emit('sessionDisconnected', sessionId, validation.message);
        } else {
          this.emit('sessionError', sessionId, new Error(validation.message));
        }
      } else {
        // Update last activity
        await sessionMetadataManager.updateSessionActivity(sessionId, 'CONNECTED');
      }

    } catch (error) {
      this.emit('sessionError', sessionId, error);
    }
  }

  async handleSessionDisconnection(sessionId, reason) {
    const metadata = await sessionMetadataManager.getSessionMetadata(sessionId);
    if (!metadata) return;

    const attempts = metadata.connectionAttempts || 0;
    
    if (attempts < maxSessionRetries) {
      console.log(`Attempting to reconnect session ${sessionId} (attempt ${attempts + 1})`);
      
      setTimeout(async () => {
        try {
          await this.sessionManager.restartSession(sessionId);
          this.emit('sessionRecovered', sessionId);
        } catch (error) {
          await sessionMetadataManager.updateSessionActivity(
            sessionId, 
            'DISCONNECTED', 
            error.message
          );
        }
      }, sessionRetryDelay);
      
    } else {
      console.log(`Max reconnection attempts reached for session ${sessionId}`);
      await sessionMetadataManager.updateSessionActivity(sessionId, 'FAILED');
    }
  }

  async handleSessionError(sessionId, error) {
    await sessionMetadataManager.updateSessionActivity(
      sessionId, 
      'ERROR', 
      error.message
    );

    // Attempt recovery based on error type
    if (this.isRecoverableError(error)) {
      setTimeout(async () => {
        try {
          await this.sessionManager.reloadSession(sessionId);
          this.emit('sessionRecovered', sessionId);
        } catch (recoveryError) {
          console.error(`Failed to recover session ${sessionId}:`, recoveryError);
        }
      }, sessionRetryDelay);
    }
  }

  async attemptSessionRestore(sessionId) {
    if (!this.sessionManager) return;

    try {
      console.log(`Attempting to restore session ${sessionId}`);
      const result = await this.sessionManager.setupSession(sessionId);
      
      if (result.success) {
        await sessionMetadataManager.updateSessionActivity(sessionId, 'CONNECTING');
        this.emit('sessionRecovered', sessionId);
      }
    } catch (error) {
      console.error(`Failed to restore session ${sessionId}:`, error);
      await sessionMetadataManager.updateSessionActivity(sessionId, 'FAILED', error.message);
    }
  }

  isRecoverableError(error) {
    const recoverableErrors = [
      'browser tab closed',
      'session closed',
      'page crashed',
      'navigation timeout',
      'connection lost',
      'protocol error'
    ];
    
    return recoverableErrors.some(recoverable => 
      error.message.toLowerCase().includes(recoverable)
    );
  }

  async getHealthStats() {
    return await sessionMetadataManager.getSessionStats();
  }

  // Manual session recovery trigger
  async recoverSession(sessionId) {
    if (!this.sessionManager) return false;

    try {
      await this.sessionManager.reloadSession(sessionId);
      await sessionMetadataManager.updateSessionActivity(sessionId, 'CONNECTING');
      return true;
    } catch (error) {
      console.error(`Manual recovery failed for session ${sessionId}:`, error);
      await sessionMetadataManager.updateSessionActivity(sessionId, 'ERROR', error.message);
      return false;
    }
  }
}

// Create singleton instance
const sessionHealthMonitor = new SessionHealthMonitor();

module.exports = sessionHealthMonitor;
