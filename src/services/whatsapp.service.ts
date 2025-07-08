import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  BufferJSON,
  initAuthCreds,
  proto,
  WASocket,
  ConnectionState,
  AuthenticationCreds,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { AuthState, AuthStateDocument } from '../schemas/auth-state.schema';
import * as QRCode from 'qrcode';
import pino from 'pino';

interface SessionInfo {
  socket: WASocket;
  lastUsed: Date;
  isConnected: boolean;
  isReconnecting?: boolean;
  isInitialConnection?: boolean;
  qrRetryCount?: number;
}

@Injectable()
export class WhatsAppService implements OnModuleInit {
  private readonly logger = new Logger(WhatsAppService.name);
  // Use pino without external transport and suppress known Baileys decryption errors in logs
  private readonly pinoLogger = pino({
    level: process.env.NODE_ENV === 'development' ? 'debug' : 'warn',
    hooks: {
      logMethod(args, method, levelLabel) {
        try {
          const msg = args[0];
          const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
          // Suppress common decryption errors to reduce noise
          if (text.includes('Bad decrypt') || text.includes('EVP_DecryptFinal_ex') || text.toLowerCase().includes('token is not valid')) {
            return;
          }
        } catch (_) {
          // ignore hook errors
        }
        method.apply(this, args);
      }
    }
  });
  private activeSessions = new Map<string, SessionInfo>();
  private qrCodes = new Map<string, string>();
  private reconnectionAttempts = new Map<string, number>();
  private conflictAttempts = new Map<string, number>();
  private reconnectionInProgress = new Map<string, boolean>(); // Track ongoing reconnections
  private qrTimeouts = new Map<string, NodeJS.Timeout>();
  private readonly MAX_ACTIVE_SESSIONS = parseInt(process.env.MAX_ACTIVE_SESSIONS || '100'); // Increased default
  private readonly MAX_RAM_USAGE_MB = parseInt(process.env.MAX_RAM_USAGE_MB || '10240'); // 10GB default
  private readonly SESSION_CLEANUP_INTERVAL = parseInt(process.env.SESSION_CLEANUP_INTERVAL || '300000');
  // How long before an idle session is considered stale (default 1h)
  private readonly SESSION_IDLE_TIMEOUT_MS = parseInt(process.env.SESSION_IDLE_TIMEOUT_MS || '3600000');
  private readonly MAX_RECONNECTION_ATTEMPTS = 3;
  private readonly MAX_CONFLICT_ATTEMPTS = 2; // Stop conflicts early
  private readonly QR_CODE_TIMEOUT = parseInt(process.env.QR_CODE_TIMEOUT || '60000');
  // private readonly WEBHOOK_URL = 'https://adstudioserver.foodyqueen.com/api/whatsapp-webhook';
  // Webhook URL must be provided in environment; no default fallback
  private readonly WEBHOOK_URL = process.env.WEBHOOK_URL;

  constructor(
    @InjectModel(AuthState.name)
    private authStateModel: Model<AuthStateDocument>,
  ) {}

  async onModuleInit() {
    this.logger.log('WhatsApp Service initialized');
    // Start periodic cleanup
    setInterval(() => this.cleanupInactiveSessions(), this.SESSION_CLEANUP_INTERVAL);
    // Restore any sessions persisted in DB at startup
    this.logger.log('Restoring existing sessions from database...');
    this.restoreExistingSessions().catch(err => this.logger.error('Restore sessions error', err));
    // Don't restore sessions automatically on startup to prevent conflicts
    // Sessions will be activated on-demand when needed
    this.logger.log('Session restoration disabled - sessions will activate on-demand');
  }

  private async cleanupInactiveSessions(): Promise<void> {
    if (!this.shouldCleanupSessions()) {
      return;
    }

    const memoryMB = this.getMemoryUsageMB();
    this.logger.log(`Cleaning up sessions. RAM: ${memoryMB}MB/${this.MAX_RAM_USAGE_MB}MB, Active: ${this.activeSessions.size}`);
    
    const sessionEntries = Array.from(this.activeSessions.entries())
      .sort(([, a], [, b]) => a.lastUsed.getTime() - b.lastUsed.getTime());

    // Calculate how many sessions to remove (more aggressive if RAM is high)
    const ramUtilization = memoryMB / this.MAX_RAM_USAGE_MB;
    let sessionsToRemove = Math.max(1, Math.floor(this.activeSessions.size * 0.2)); // Remove 20% by default
    
    if (ramUtilization > 0.9) {
      sessionsToRemove = Math.floor(this.activeSessions.size * 0.5); // Remove 50% if RAM is critical
    }

    let removedCount = 0;
    for (const [userId, sessionInfo] of sessionEntries) {
      if (removedCount >= sessionsToRemove) break;
      
      const timeSinceLastUse = Date.now() - sessionInfo.lastUsed.getTime();
      const isOld = timeSinceLastUse > this.SESSION_IDLE_TIMEOUT_MS; // stale if idle beyond configured timeout
      const isInactive = !sessionInfo.isConnected;
      const isConflicted = (this.conflictAttempts.get(userId) || 0) > 0;
      
      // Only remove sessions that are old, inactive, or conflicted
      if (isOld || isInactive || isConflicted) {
        this.logger.log(`Cleaning up session for user: ${userId} (old: ${isOld}, inactive: ${isInactive}, conflicted: ${isConflicted})`);
        await this.clearSession(userId);
        removedCount++;
      }
    }
    
    this.logger.log(`Cleaned up ${removedCount} sessions. Remaining: ${this.activeSessions.size}`);
  }

  private async clearSession(userId: string): Promise<void> {
    try {
      const sessionInfo = this.activeSessions.get(userId);
      if (sessionInfo?.socket) {
        try {
          sessionInfo.socket.ws?.close();
          // Remove all event listeners
          sessionInfo.socket.ev.removeAllListeners('connection.update');
          sessionInfo.socket.ev.removeAllListeners('creds.update');
          sessionInfo.socket.ev.removeAllListeners('messages.upsert');
        } catch (error) {
          this.logger.warn(`Error closing socket for user ${userId}:`, error);
        }
      }
      
      this.activeSessions.delete(userId);
      this.qrCodes.delete(userId);
      // Don't clear reconnection attempts or conflict attempts - preserve for tracking
      // Don't clear reconnectionInProgress here - it's managed by the calling methods
      this.clearQRTimeout(userId);
      this.logger.log(`Session cleared for user: ${userId}`);
    } catch (error) {
      this.logger.error(`Error clearing session for user ${userId}:`, error);
    }
  }

  private clearQRTimeout(userId: string): void {
    const timeout = this.qrTimeouts.get(userId);
    if (timeout) {
      clearTimeout(timeout);
      this.qrTimeouts.delete(userId);
    }
  }

  private updateSessionUsage(userId: string): void {
    const sessionInfo = this.activeSessions.get(userId);
    if (sessionInfo) {
      sessionInfo.lastUsed = new Date();
    }
  }

  async loadAuthState(userId: string) {
    try {
      this.logger.log(`[${userId}] Loading auth state from database...`);
      
      const savedData = await this.authStateModel.findOne({ userId });
      
      let state;
      if (savedData?.credentials) {
        this.logger.log(`[${userId}] Found existing auth state in database`);
        
        const credentials = this.convertBinaryToBuffer(savedData.credentials);
        const savedKeys = this.convertBinaryToBuffer(savedData.keys || {});
        
        // Create a proper auth state with Map-based keys storage
        const keys = new Map();
        
        // Restore keys from saved data
        if (savedKeys && typeof savedKeys === 'object') {
          for (const [keyId, keyData] of Object.entries(savedKeys)) {
            keys.set(keyId, keyData);
          }
        }
        
        this.logger.log(`[${userId}] Auth state details:`, {
          hasCredentials: !!credentials,
          credentialsKeys: credentials ? Object.keys(credentials) : [],
          keysCount: keys.size,
          lastUpdated: savedData.lastUpdated,
          connectionStatus: savedData.connectionStatus
        });
        
        state = {
          creds: credentials,
          keys: keys,
        };
        
        this.logger.log(`[${userId}] Auth state loaded successfully from database`);
      } else {
        this.logger.log(`[${userId}] No existing auth state found, creating new credentials`);
        state = {
          creds: initAuthCreds(),
          keys: new Map(),
        };
      }

      const saveCreds = async () => {
        try {
          this.logger.log(`[${userId}] Saving credentials update...`);
          
          // Log what's being saved for debugging
          this.logger.log(`[${userId}] Credentials keys:`, Object.keys(state.creds));
          this.logger.log(`[${userId}] Keys count:`, state.keys.size);
          
          const credsToSave = this.convertBufferForStorage(state.creds);
          
          // Convert Map to plain object for storage
          const keysToSave = {};
          for (const [key, value] of state.keys.entries()) {
            keysToSave[key] = this.convertBufferForStorage(value);
          }
          
          const result = await this.authStateModel.findOneAndUpdate(
            { userId },
            {
              userId,
              credentials: credsToSave,
              keys: keysToSave,
              lastUpdated: new Date(),
            },
            { upsert: true, new: true }
          );
          
          this.logger.log(`[${userId}] Auth state saved successfully. Document ID: ${result._id}`);
        } catch (error) {
          this.logger.error(`[${userId}] Error saving auth state:`, {
            error: error.message,
            stack: error.stack
          });
          throw error;
        }
      };

      return { state, saveCreds };
    } catch (error) {
      this.logger.error(`Error loading auth state for user ${userId}:`, error);
      throw error;
    }
  }

  private convertBinaryToBuffer(obj: any): any {
    if (!obj) return obj;
    
    if (Buffer.isBuffer(obj)) return obj;
    
    if (obj._bsontype === 'Binary') {
      return Buffer.from(obj.buffer);
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.convertBinaryToBuffer(item));
    }
    
    if (typeof obj === 'object' && obj !== null) {
      const converted: any = {};
      for (const [key, value] of Object.entries(obj)) {
        converted[key] = this.convertBinaryToBuffer(value);
      }
      return converted;
    }
    
    return obj;
  }

  private convertBufferForStorage(obj: any): any {
    if (!obj) return obj;
    
    if (Buffer.isBuffer(obj)) {
      return obj;
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.convertBufferForStorage(item));
    }
    
    if (typeof obj === 'object' && obj !== null) {
      const converted: any = {};
      for (const [key, value] of Object.entries(obj)) {
        converted[key] = this.convertBufferForStorage(value);
      }
      return converted;
    }
    
    return obj;
  }

  async createSession(userId: string): Promise<string> {
    try {
      // Check if session already exists and is stable
      const sessionInfo = this.activeSessions.get(userId);
      if (this.isSessionStable(userId)) {
        const existingQR = this.qrCodes.get(userId);
        if (existingQR) {
          this.logger.log(`[${userId}] Reusing existing stable session with QR`);
          return existingQR;
        }
        this.logger.log(`[${userId}] Session already stable and connected, no QR needed`);
        throw new Error('Session already exists and is connected');
      }

      // Prevent creating multiple sessions simultaneously
      if (this.reconnectionInProgress.get(userId)) {
        this.logger.log(`[${userId}] Session creation already in progress, cannot create new session`);
        throw new Error('Session creation in progress, please wait');
      }

      // Mark creation as in progress
      this.reconnectionInProgress.set(userId, true);

      try {
        // Don't clear existing session if it's just conflicted - try to reuse it
        if (sessionInfo && !sessionInfo.isConnected) {
          const conflictCount = this.conflictAttempts.get(userId) || 0;
          if (conflictCount >= this.MAX_CONFLICT_ATTEMPTS) {
            this.logger.log(`[${userId}] Too many conflicts (${conflictCount}), avoiding reconnection`);
            throw new Error('Session has too many conflicts, please wait before retrying');
          }
        }

        // Only clear session if it's truly problematic
        if (sessionInfo && sessionInfo.isReconnecting) {
          this.logger.log(`[${userId}] Session is reconnecting, clearing to start fresh`);
          await this.clearSession(userId);
        }

      // Check cleanup only when creating new sessions
      if (this.shouldCleanupSessions()) {
        await this.cleanupInactiveSessions();
      }

      const { state, saveCreds } = await this.loadAuthState(userId);

      // Get latest Baileys version
      const { version, isLatest } = await fetchLatestBaileysVersion();
      if (!isLatest) {
        this.logger.warn(`Using outdated Baileys version: ${version}`);
      }

      this.logger.log(`[${userId}] Creating WhatsApp socket with auth state...`);
      
      const socket = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: this.pinoLogger,
        browser: ['WhatsApp API', 'Chrome', '4.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        defaultQueryTimeoutMs: 30000, // 30 seconds for better reliability
        connectTimeoutMs: 30000, // 30 seconds connection timeout
        keepAliveIntervalMs: 45000, // Keep-alive every 45 seconds
        retryRequestDelayMs: 2000, // Shorter delay between retries
        maxMsgRetryCount: 1, // Minimal retry count to avoid conflicts
        emitOwnEvents: false,
        shouldSyncHistoryMessage: () => false,
        shouldIgnoreJid: () => false,
        linkPreviewImageThumbnailWidth: 192,
        transactionOpts: { 
          maxCommitRetries: 3, // Reduced retries to avoid timeout issues
          delayBetweenTriesMs: 3000 // Shorter delay between transaction retries
        },
        // Disable some features that can cause conflicts
        cachedGroupMetadata: () => undefined,
        patchMessageBeforeSending: (msg) => {
          // Don't patch messages to avoid conflicts
          return msg;
        },
        getMessage: async (key) => {
          this.logger.debug(`[${userId}] getMessage called with key:`, key);
          return { conversation: '' };
        }
      });

      this.logger.log(`[${userId}] WhatsApp socket created successfully`);

      const newSessionInfo: SessionInfo = {
        socket,
        lastUsed: new Date(),
        isConnected: false,
        isInitialConnection: true,
        qrRetryCount: 0,
      };

      this.activeSessions.set(userId, newSessionInfo);

      return new Promise((resolve, reject) => {
        let qrResolved = false;
        let connectionResolved = false;

        // Set up QR timeout
        const qrTimeout = setTimeout(() => {
          if (!qrResolved && !connectionResolved) {
            this.logger.error(`QR code generation timeout for user ${userId}`);
            this.clearSession(userId);
            reject(new Error('QR code generation timeout'));
          }
        }, this.QR_CODE_TIMEOUT);

        this.qrTimeouts.set(userId, qrTimeout);

        socket.ev.on('creds.update', saveCreds);

        // Add error handling for various events
        socket.ev.on('messages.upsert', (messageUpdate) => {
          this.logger.debug(`[${userId}] Messages upsert:`, {
            messageCount: messageUpdate.messages.length,
            type: messageUpdate.type
          });
        });

        socket.ev.on('presence.update', (presence) => {
          this.logger.debug(`[${userId}] Presence update:`, presence);
        });

        // Handle signal errors without crashing
        socket.ev.on('creds.update', (update) => {
          try {
            saveCreds();
            this.logger.debug(`[${userId}] Credentials updated successfully`);
          } catch (error) {
            this.logger.error(`[${userId}] Error saving credentials:`, error);
          }
        });

        // Handle any other potential errors
        process.on('uncaughtException', (error) => {
          if (error.message.includes('Timed Out')) {
            this.logger.warn(`[${userId}] Timeout error detected:`, error.message);
          } else {
            this.logger.error(`[${userId}] Uncaught exception:`, error);
          }
        });

        process.on('unhandledRejection', (reason, promise) => {
          if (reason && typeof reason === 'object' && 'message' in reason && 
              (reason as Error).message.includes('Timed Out')) {
            this.logger.warn(`[${userId}] Timeout rejection:`, (reason as Error).message);
          } else {
            this.logger.error(`[${userId}] Unhandled rejection at:`, promise, 'reason:', reason);
          }
        });

        socket.ev.on('connection.update', async (update) => {
          const { connection, lastDisconnect, qr, isNewLogin, isOnline, receivedPendingNotifications } = update;
          
          // Log FULL connection update payload for debugging
          this.logger.log(`[${userId}] Connection update - Full payload:`, JSON.stringify({
            connection,
            isNewLogin,
            isOnline,
            receivedPendingNotifications,
            qrPresent: !!qr,
            lastDisconnectError: lastDisconnect?.error ? {
              name: lastDisconnect.error.name,
              message: lastDisconnect.error.message,
              stack: lastDisconnect.error.stack,
              statusCode: (lastDisconnect.error as any)?.output?.statusCode,
            } : null,
            timestamp: new Date().toISOString()
          }, null, 2));

          if (qr && !qrResolved && !connectionResolved) {
            try {
              this.logger.log(`[${userId}] Generating QR code...`);
              const qrCodeData = await QRCode.toDataURL(qr);
              this.qrCodes.set(userId, qrCodeData);
              this.logger.log(`[${userId}] QR code generated successfully`);
              qrResolved = true;
              this.clearQRTimeout(userId);
              resolve(qrCodeData);
            } catch (error) {
              this.logger.error(`[${userId}] QR code generation error:`, {
                error: error.message,
                stack: error.stack
              });
              this.clearSession(userId);
              reject(error);
            }
          }

          if (connection === 'connecting') {
            this.logger.log(`[${userId}] WhatsApp is connecting...`);
            newSessionInfo.isConnected = false;
          }

          if (connection === 'open') {
            this.logger.log(`[${userId}] WhatsApp connection opened successfully`);
            this.markSessionAsStable(userId);
            connectionResolved = true;
            
            // Reset all counters on successful connection
            this.reconnectionAttempts.delete(userId);
            this.conflictAttempts.delete(userId);
            this.qrCodes.delete(userId);
            this.clearQRTimeout(userId);
            this.logger.log(`[${userId}] Reconnection successful for user ${userId}`);
            
            // Send webhook notification for successful connection
            await this.sendWebhook(userId, 'connected', true, socket.user);
            
            try {
              await this.authStateModel.findOneAndUpdate(
                { userId },
                { 
                  connectionStatus: 'connected', 
                  lastUpdated: new Date(),
                  user: socket.user ? JSON.stringify(socket.user) : null
                },
                { upsert: true }
              );
              this.logger.log(`[${userId}] Auth state updated with connected status`);
            } catch (dbError) {
              this.logger.error(`[${userId}] Error updating auth state:`, dbError);
            }

            // Send webhook notification
            this.sendWebhook(userId, 'connected', true, socket.user);
          } else if (connection === 'close') {
            this.logger.log(`[${userId}] Connection closed`);
            newSessionInfo.isConnected = false;
            
            const errorStatusCode = (lastDisconnect?.error as any)?.output?.statusCode;
            const shouldReconnect = errorStatusCode !== DisconnectReason.loggedOut;
            const isRestartRequired = errorStatusCode === 515; // DisconnectReason.restartRequired
            const isConflict = errorStatusCode === 440; // Session conflict (logged in elsewhere)

            this.logger.log(`[${userId}] Disconnect analysis:`, {
              errorStatusCode,
              shouldReconnect,
              isRestartRequired,
              isConflict,
              isInitialConnection: newSessionInfo.isInitialConnection,
              wasConnected: newSessionInfo.isConnected,
              errorMessage: lastDisconnect?.error?.message,
              errorName: lastDisconnect?.error?.name
            });

            if (isRestartRequired) {
              // This is the expected "restart required" after successful pairing
              this.logger.log(`[${userId}] Restart required after pairing - restarting connection...`);
              newSessionInfo.isReconnecting = true;
              
              // Set a flag to indicate this is a post-pairing restart
              newSessionInfo.isInitialConnection = false;
              
              // Update connection status and attempt immediate restart
              await this.authStateModel.findOneAndUpdate(
                { userId },
                { connectionStatus: 'restarting_after_pairing', lastUpdated: new Date() }
              );
              
              // Restart the connection without clearing the session
              setTimeout(() => {
                this.logger.log(`[${userId}] Attempting restart after pairing...`);
                this.attemptReconnection(userId, true); // true = isPostPairingRestart
              }, 1000); // Small delay before restart

            } else if (isConflict) {
              // Session conflict - same account logged in elsewhere
              this.logger.warn(`[${userId}] Session conflict detected - account logged in elsewhere (status 440)`);
              
              // IMMEDIATELY stop all reconnection attempts for conflicts
              // Conflicts mean the same WhatsApp account is active elsewhere
              // Any reconnection will immediately conflict again
              this.logger.warn(`[${userId}] Stream conflict - stopping all reconnection attempts and clearing session`);
              
              // Mark session as conflicted and stop all reconnection attempts
              newSessionInfo.isConnected = false;
              newSessionInfo.isReconnecting = false;
              this.reconnectionInProgress.delete(userId);
              this.conflictAttempts.set(userId, 999); // Mark as permanently conflicted
              
              // Update database to reflect conflict state
              await this.authStateModel.findOneAndUpdate(
                { userId },
                { connectionStatus: 'stream_conflict', lastUpdated: new Date() }
              );
              
              // Clear the session completely to stop all activity
              await this.clearSession(userId);
              this.logger.log(`[${userId}] Session terminated due to stream conflict - user needs to logout from other device first`);
              return;
              
            } else if (!shouldReconnect) {
              // User logged out
              this.logger.log(`[${userId}] User logged out, cleaning up session`);
              await this.authStateModel.deleteOne({ userId });
              this.clearSession(userId);
            } else if (newSessionInfo.isInitialConnection && !connectionResolved) {
              // Initial connection failed (but not due to restart requirement or conflict)
              this.logger.error(`[${userId}] Initial connection failed - rejecting QR promise`);
              this.clearSession(userId);
              if (!qrResolved) {
                reject(new Error(`Initial connection failed: ${lastDisconnect?.error?.message || 'Unknown error'}`));
              }
            } else {
              // Connection lost, attempt reconnection
              await this.authStateModel.findOneAndUpdate(
                { userId },
                { connectionStatus: 'disconnected', lastUpdated: new Date() }
              );
              
              // Only attempt reconnection if not already in progress and not already reconnecting
              if (!newSessionInfo.isReconnecting && !this.reconnectionInProgress.get(userId)) {
                this.attemptReconnection(userId);
              } else {
                this.logger.log(`[${userId}] Reconnection skipped - already in progress or session is reconnecting`);
              }
            }
          } else if (connection === 'connecting') {
            this.logger.log(`WhatsApp connecting for user ${userId}`);
          }
        });

        socket.ev.on('creds.update', (update) => {
          this.logger.log(`Credentials updated for user ${userId}`);
        });

        socket.ev.on('messages.upsert', (m) => {
          this.logger.debug(`Received ${m.messages.length} messages for user ${userId}`);
        });
      }); // end of new Promise
    } catch (innerError) {
      this.logger.error(`Error in session creation inner try block for user ${userId}:`, innerError);
      throw innerError;
    } finally {
      // Always clear the progress flag
      this.reconnectionInProgress.delete(userId);
    }
  } catch (error) {
    this.logger.error(`Error creating session for user ${userId}:`, error);
    this.reconnectionInProgress.delete(userId);
    await this.clearSession(userId);
    throw error;
  }
  }

  private async attemptReconnection(userId: string, isPostPairingRestart = false, isConflictReconnect = false): Promise<void> {
    const sessionInfo = this.activeSessions.get(userId);
    if (!sessionInfo) {
      this.logger.log(`[${userId}] No session info found, skipping reconnection`);
      return;
    }

    // Check if reconnection is already in progress for this user
    if (this.reconnectionInProgress.get(userId)) {
      this.logger.log(`[${userId}] Reconnection already in progress, skipping duplicate attempt`);
      return;
    }

    // Check if session is already connected (prevent unnecessary reconnections)
    if (sessionInfo.isConnected && !isPostPairingRestart) {
      this.logger.log(`[${userId}] Session already connected, skipping reconnection`);
      return;
    }

    // Check for conflicts before attempting any reconnection
    const conflictCount = this.conflictAttempts.get(userId) || 0;
    if (conflictCount >= this.MAX_CONFLICT_ATTEMPTS || conflictCount >= 999) {
      this.logger.log(`[${userId}] Session marked as conflicted (${conflictCount}), refusing reconnection attempt`);
      return;
    }

    // Mark reconnection as in progress
    this.reconnectionInProgress.set(userId, true);

    // Determine reconnection parameters based on type
    let attempts: number;
    let delay: number;
    let maxAttempts: number;
    
    if (isPostPairingRestart) {
      // Post-pairing restart should be immediate and not count as retry
      attempts = 0;
      delay = 500;
      maxAttempts = 1;
    } else if (isConflictReconnect) {
      // Conflict reconnects are handled differently - they don't use this method's retry logic
      // The conflict delay and attempts are managed in the connection.update handler
      attempts = 0;
      delay = 1000; // Minimal delay since timing is managed by the caller
      maxAttempts = 1;
    } else {
      // Normal reconnection with exponential backoff
      attempts = this.reconnectionAttempts.get(userId) || 0;
      delay = 3000 * Math.pow(2, attempts);
      maxAttempts = this.MAX_RECONNECTION_ATTEMPTS;
    }

    if (attempts >= maxAttempts) {
      this.logger.error(`Max reconnection attempts reached for user ${userId} (${attempts}/${maxAttempts})`);
      this.reconnectionInProgress.delete(userId); // Clear the progress flag
      this.clearSession(userId);
      return;
    }

    sessionInfo.isReconnecting = true;
    
    if (!isPostPairingRestart) {
      this.reconnectionAttempts.set(userId, attempts + 1);
    }

    const reconnectionType = isPostPairingRestart ? 'post-pairing restart' : 
                            isConflictReconnect ? 'conflict reconnection' : 'reconnection';
    
    this.logger.log(`Scheduling ${reconnectionType} for user ${userId} in ${delay}ms ${isPostPairingRestart ? '' : `(attempt ${attempts + 1})`}`);
    
    setTimeout(async () => {
      try {
        await this.reconnectSession(userId);
      } catch (error) {
        this.logger.error(`${reconnectionType} failed for user ${userId}:`, error);
        sessionInfo.isReconnecting = false;
      } finally {
        // Always clear the progress flag when done
        this.reconnectionInProgress.delete(userId);
      }
    }, delay);
  }

  private async reconnectSession(userId: string): Promise<void> {
    try {
      this.logger.log(`Reconnecting session for user ${userId}`);
      
      const sessionInfo = this.activeSessions.get(userId);
      if (!sessionInfo) return;

      // Clear existing socket
      if (sessionInfo.socket) {
        try {
          sessionInfo.socket.ws?.close();
          // Remove all event listeners
          sessionInfo.socket.ev.removeAllListeners('connection.update');
          sessionInfo.socket.ev.removeAllListeners('creds.update');
          sessionInfo.socket.ev.removeAllListeners('messages.upsert');
        } catch (error) {
          this.logger.warn(`Error closing old socket for user ${userId}:`, error);
        }
      }

      // Create new socket
      const { state, saveCreds } = await this.loadAuthState(userId);
      const { version } = await fetchLatestBaileysVersion();

      const socket = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: this.pinoLogger,
        browser: ['WhatsApp API', 'Chrome', '4.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        defaultQueryTimeoutMs: 30000,
        connectTimeoutMs: 30000,
        keepAliveIntervalMs: 10000,
        retryRequestDelayMs: 1000,
        maxMsgRetryCount: 3,
        emitOwnEvents: false,
        getMessage: async (key) => {
          return { conversation: '' };
        }
      });

      sessionInfo.socket = socket;
      sessionInfo.lastUsed = new Date();

      socket.ev.on('creds.update', saveCreds);
      socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
          this.logger.log(`Reconnection successful for user ${userId}`);
          sessionInfo.isConnected = true;
          sessionInfo.isReconnecting = false;
          this.reconnectionAttempts.delete(userId);
          this.conflictAttempts.delete(userId); // Reset conflict attempts on successful connection
          this.reconnectionInProgress.delete(userId); // Clear reconnection progress flag
          
          // Send webhook notification for successful reconnection
          await this.sendWebhook(userId, 'connected', true, socket.user);
          
          await this.authStateModel.findOneAndUpdate(
            { userId },
            { 
              connectionStatus: 'connected', 
              lastUpdated: new Date(),
              user: socket.user 
            },
            { upsert: true }
          );

          // Send webhook notification
          this.sendWebhook(userId, 'connected', true, socket.user);
        } else if (connection === 'close') {
          sessionInfo.isConnected = false;
          const errorStatusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const shouldReconnect = errorStatusCode !== DisconnectReason.loggedOut;
          const isRestartRequired = errorStatusCode === 515; // DisconnectReason.restartRequired
          const isConflict = errorStatusCode === 440; // Session conflict (logged in elsewhere)

          this.logger.log(`[${userId}] Reconnection handler - Disconnect analysis:`, {
            errorStatusCode,
            shouldReconnect,
            isRestartRequired,
            isConflict,
            errorMessage: lastDisconnect?.error?.message
          });

          if (isRestartRequired) {
            // This is the expected "restart required" during reconnection
            this.logger.log(`[${userId}] Restart required during reconnection - attempting immediate restart...`);
            if (!sessionInfo.isReconnecting) {
              this.attemptReconnection(userId, true); // true = isPostPairingRestart
            }
          } else if (isConflict) {
            // Stream conflict during reconnection - stop immediately
            this.logger.warn(`[${userId}] Stream conflict during reconnection - stopping all attempts`);
            sessionInfo.isConnected = false;
            sessionInfo.isReconnecting = false;
            this.reconnectionInProgress.delete(userId);
            this.conflictAttempts.set(userId, 999); // Mark as permanently conflicted
            
            await this.authStateModel.findOneAndUpdate(
              { userId },
              { connectionStatus: 'stream_conflict', lastUpdated: new Date() }
            );
            
            await this.clearSession(userId);
            this.logger.log(`[${userId}] Reconnection stopped due to stream conflict`);
            return;
          } else if (!shouldReconnect) {
            await this.authStateModel.deleteOne({ userId });
            this.clearSession(userId);
          } else if (!sessionInfo.isReconnecting) {
            this.attemptReconnection(userId);
          }
        }
      });

    } catch (error) {
      this.logger.error(`Error during reconnection for user ${userId}:`, error);
      const sessionInfo = this.activeSessions.get(userId);
      if (sessionInfo) {
        sessionInfo.isReconnecting = false;
      }
    }
  }

  async getQRCode(userId: string): Promise<string> {
    const qrCode = this.qrCodes.get(userId);
    if (!qrCode) {
      throw new Error('QR code not found. Please create a new session.');
    }
    return qrCode;
  }

  async terminateSession(userId: string): Promise<void> {
    try {
      const sessionInfo = this.activeSessions.get(userId);
      if (sessionInfo?.socket) {
        try {
          await sessionInfo.socket.logout();
        } catch (error) {
          this.logger.warn(`Error during logout for user ${userId}:`, error);
        }
      }
      
      await this.clearSession(userId);
      this.reconnectionAttempts.delete(userId);
      await this.authStateModel.deleteOne({ userId });
      
      this.logger.log(`Session terminated for user ${userId}`);
    } catch (error) {
      this.logger.error(`Error terminating session for user ${userId}:`, error);
      throw error;
    }
  }

  async getSessionStatus(userId: string): Promise<any> {
    try {
      const authState = await this.authStateModel.findOne({ userId });
      const sessionInfo = this.activeSessions.get(userId);
      
      return {
        exists: !!authState,
        connected: sessionInfo?.isConnected || false,
        connectionStatus: sessionInfo?.isConnected ? 'connected' : (authState?.connectionStatus || 'disconnected'),
        lastUpdated: authState?.lastUpdated,
        user: authState?.user || sessionInfo?.socket?.user || null,
        isSessionActive: !!sessionInfo,
        isReconnecting: sessionInfo?.isReconnecting || false,
        reconnectionAttempts: this.reconnectionAttempts.get(userId) || 0,
      };
    } catch (error) {
      this.logger.error(`Error getting session status for user ${userId}:`, error);
      throw error;
    }
  }

  async sendMessage(userId: string, to: string, message?: string, documentUrl?: string): Promise<any> {
    try {
      // Check if session is marked as conflicted
      const conflictCount = this.conflictAttempts.get(userId) || 0;
      if (conflictCount >= 999) {
        throw new Error('Session is in conflict state. User must logout from other devices first before sending messages.');
      }
      
      let sessionInfo = this.activeSessions.get(userId);
      
      // If no session at all, try to activate
      if (!sessionInfo) {
        this.logger.log(`[${userId}] No session found, activating from database...`);
        await this.activateSession(userId);
        sessionInfo = this.activeSessions.get(userId);
        
        // Wait for session to establish
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      // If session exists but not connected, check if it's reconnecting
      if (sessionInfo && !sessionInfo.isConnected && !sessionInfo.isReconnecting && !this.reconnectionInProgress.get(userId)) {
        this.logger.log(`[${userId}] Session exists but not connected, attempting reconnection...`);
        await this.activateSession(userId);
        await new Promise(resolve => setTimeout(resolve, 3000));
        sessionInfo = this.activeSessions.get(userId);
      }

      if (!sessionInfo?.socket) {
        throw new Error('WhatsApp session could not be established');
      }

      // For connected sessions, try sending immediately without stability checks
      if (sessionInfo.isConnected) {
        this.updateSessionUsage(userId);

        // Format phone number
        let jid = to;
        if (!to.includes('@')) {
          jid = `${to}@s.whatsapp.net`;
        }

        let result;

        try {
          if (documentUrl) {
            const response = await fetch(documentUrl);
            if (!response.ok) {
              throw new Error(`Failed to fetch document: ${response.statusText}`);
            }
            
            const buffer = await response.arrayBuffer();
            const mimeType = response.headers.get('content-type') || 'application/octet-stream';
            
            if (mimeType.startsWith('image/')) {
              result = await sessionInfo.socket.sendMessage(jid, {
                image: Buffer.from(buffer),
                caption: message || '',
              });
            } else if (mimeType.startsWith('audio/')) {
              result = await sessionInfo.socket.sendMessage(jid, {
                audio: Buffer.from(buffer),
                mimetype: mimeType,
              });
            } else if (mimeType.startsWith('video/')) {
              result = await sessionInfo.socket.sendMessage(jid, {
                video: Buffer.from(buffer),
                caption: message || '',
              });
            } else {
              result = await sessionInfo.socket.sendMessage(jid, {
                document: Buffer.from(buffer),
                mimetype: mimeType,
                fileName: documentUrl.split('/').pop() || 'document',
              });
            }
          } else if (message) {
            result = await sessionInfo.socket.sendMessage(jid, { text: message });
          } else {
            throw new Error('Either message or document URL is required');
          }

          this.logger.log(`[${userId}] Message sent successfully to ${jid}`);
          return {
            success: true,
            messageId: result.key.id,
            timestamp: result.messageTimestamp,
            to: jid,
          };

        } catch (sendError) {
          this.logger.error(`[${userId}] Send failed with connected session:`, sendError);
          throw sendError;
        }
      } else {
        throw new Error('Session is not connected and could not be established');
      }

    } catch (error) {
      this.logger.error(`Error sending message for user ${userId}:`, error);
      throw error;
    }
  }

  async restoreExistingSessions(): Promise<void> {
    try {
      this.logger.log('Restoring existing sessions...');
      const existingSessions = await this.authStateModel.find({
        connectionStatus: 'connected'
      });

      this.logger.log(`Found ${existingSessions.length} existing sessions to restore`);

      for (const session of existingSessions) {
        try {
          this.logger.log(`Restoring session for user ${session.userId}`);
          await this.activateExistingSession(session.userId);
        } catch (error) {
          this.logger.error(`Failed to restore session for ${session.userId}:`, error);
          await this.authStateModel.findOneAndUpdate(
            { userId: session.userId },
            { connectionStatus: 'disconnected', lastUpdated: new Date() }
          );
        }
      }
    } catch (error) {
      this.logger.error('Error restoring existing sessions:', error);
    }
  }

  private async activateExistingSession(userId: string): Promise<void> {
    try {
      const authState = await this.authStateModel.findOne({ userId });
      if (!authState || !authState.credentials) {
        return;
      }

      const { state, saveCreds } = await this.loadAuthState(userId);
      const { version } = await fetchLatestBaileysVersion();

      const socket = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: this.pinoLogger,
        browser: ['WhatsApp API', 'Chrome', '4.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        defaultQueryTimeoutMs: 30000,
        connectTimeoutMs: 30000,
        keepAliveIntervalMs: 10000,
        retryRequestDelayMs: 1000,
        maxMsgRetryCount: 3,
        emitOwnEvents: false,
        getMessage: async (key) => {
          return { conversation: '' };
        }
      });

      const sessionInfo: SessionInfo = {
        socket,
        lastUsed: new Date(),
        isConnected: false,
        isInitialConnection: false,
      };

      this.activeSessions.set(userId, sessionInfo);

      socket.ev.on('creds.update', saveCreds);
      socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
          this.logger.log(`Existing session restored for user: ${userId}`);
          sessionInfo.isConnected = true;
          sessionInfo.isReconnecting = false;
          this.reconnectionAttempts.delete(userId);
          
          // Send webhook notification for existing session restoration
          await this.sendWebhook(userId, 'connected', true, socket.user);
          
          await this.authStateModel.findOneAndUpdate(
            { userId },
            { 
              connectionStatus: 'connected', 
              lastUpdated: new Date(),
              user: socket.user 
            },
            { upsert: true }
          );

          // Send webhook notification
          this.sendWebhook(userId, 'connected', true, socket.user);
        } else if (connection === 'close') {
          sessionInfo.isConnected = false;
          const errorStatusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const shouldReconnect = errorStatusCode !== DisconnectReason.loggedOut;
          const isConflict = errorStatusCode === 440; // Session conflict (logged in elsewhere)

          if (isConflict) {
            // Stream conflict during activation - stop immediately
            this.logger.warn(`[${userId}] Stream conflict during activation - stopping all attempts`);
            sessionInfo.isConnected = false;
            sessionInfo.isReconnecting = false;
            this.reconnectionInProgress.delete(userId);
            this.conflictAttempts.set(userId, 999); // Mark as permanently conflicted
            
            await this.authStateModel.findOneAndUpdate(
              { userId },
              { connectionStatus: 'stream_conflict', lastUpdated: new Date() }
            );
            
            await this.clearSession(userId);
            this.logger.log(`[${userId}] Activation stopped due to stream conflict`);
            return;
          } else if (!shouldReconnect) {
            await this.authStateModel.deleteOne({ userId });
            this.clearSession(userId);
          } else {
            await this.authStateModel.findOneAndUpdate(
              { userId },
              { connectionStatus: 'disconnected', lastUpdated: new Date() }
            );
            
            if (!sessionInfo.isReconnecting) {
              this.attemptReconnection(userId);
            }
          }
        }
      });

    } catch (error) {
      this.logger.error(`Error activating existing session for user ${userId}:`, error);
      throw error;
    }
  }

  async activateSession(userId: string): Promise<void> {
    try {
      this.logger.log(`[${userId}] Activating session from database...`);
      
      // Check if session is marked as conflicted
      const conflictCount = this.conflictAttempts.get(userId) || 0;
      if (conflictCount >= 999) {
        throw new Error('Session is marked as conflicted. User must logout from other devices first.');
      }
      
      // Check if session is already active and stable
      if (this.isSessionStable(userId)) {
        this.logger.log(`[${userId}] Session already active and stable`);
        return;
      }

      // Check if activation is already in progress
      if (this.reconnectionInProgress.get(userId)) {
        this.logger.log(`[${userId}] Session activation already in progress, waiting...`);
        // Wait for completion with longer timeout
        let attempts = 0;
        while (this.reconnectionInProgress.get(userId) && attempts < 60) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          attempts++;
        }
        this.logger.log(`[${userId}] Finished waiting for activation (${attempts}s)`);
        return;
      }

      const authState = await this.authStateModel.findOne({ userId });
      if (!authState || !authState.credentials) {
        throw new Error('No authentication state found for user');
      }

      // Check if we already have a session - don't recreate unnecessarily
      const existingSession = this.activeSessions.get(userId);
      if (existingSession?.socket && !existingSession.isReconnecting) {
        this.logger.log(`[${userId}] Existing session found, marking as active instead of recreating`);
        existingSession.isConnected = true;
        existingSession.lastUsed = new Date();
        return;
      }

      // Mark as in progress BEFORE clearing session
      this.reconnectionInProgress.set(userId, true);

      try {
        // Clear any existing session first
        await this.clearSession(userId);

        // Create new session
        await this.reconnectSession(userId);
        
        this.logger.log(`[${userId}] Session activated successfully`);
      } finally {
        // Always clear the progress flag
        this.reconnectionInProgress.delete(userId);
      }
    } catch (error) {
      this.logger.error(`[${userId}] Error activating session:`, error);
      this.reconnectionInProgress.delete(userId);
      throw error;
    }
  }

  getSocket(userId: string): WASocket | undefined {
    const sessionInfo = this.activeSessions.get(userId);
    return sessionInfo?.socket;
  }

  getSessionInfo(userId: string): SessionInfo | undefined {
    return this.activeSessions.get(userId);
  }

  async clearUserSession(userId: string): Promise<void> {
    await this.clearSession(userId);
    this.reconnectionAttempts.delete(userId);
  }

  // Additional utility methods
  getAllActiveSessions(): Map<string, SessionInfo> {
    return new Map(this.activeSessions);
  }

  getActiveSessionCount(): number {
    return this.activeSessions.size;
  }

  getConnectedSessionCount(): number {
    return Array.from(this.activeSessions.values()).filter(s => s.isConnected).length;
  }

  async clearAllSessions(): Promise<void> {
    this.logger.log('Clearing all active sessions for recovery...');
    
    const userIds = Array.from(this.activeSessions.keys());
    for (const userId of userIds) {
      await this.clearSession(userId);
    }
    
    // Clear all tracking maps
    this.reconnectionAttempts.clear();
    this.conflictAttempts.clear();
    this.reconnectionInProgress.clear();
    this.qrCodes.clear();
    
    this.logger.log(`Cleared ${userIds.length} sessions`);
  }

  getSessionStats(): any {
    const memoryMB = this.getMemoryUsageMB();
    const activeCount = this.activeSessions.size;
    const reconnectingCount = Array.from(this.activeSessions.values())
      .filter(session => session.isReconnecting).length;
    const connectedCount = Array.from(this.activeSessions.values())
      .filter(session => session.isConnected).length;
    
    return {
      activeSessions: activeCount,
      connectedSessions: connectedCount,
      reconnectingSessions: reconnectingCount,
      memoryUsageMB: memoryMB,
      maxMemoryMB: this.MAX_RAM_USAGE_MB,
      memoryUtilization: `${((memoryMB / this.MAX_RAM_USAGE_MB) * 100).toFixed(1)}%`,
      conflictedSessions: this.conflictAttempts.size,
      reconnectionsInProgress: this.reconnectionInProgress.size,
      shouldCleanup: this.shouldCleanupSessions()
    };
  }

  private getMemoryUsageMB(): number {
    const memUsage = process.memoryUsage();
    return Math.round(memUsage.rss / 1024 / 1024); // Convert to MB
  }

  private shouldCleanupSessions(): boolean {
    const memoryMB = this.getMemoryUsageMB();
    const sessionCount = this.activeSessions.size;
    
    // Log memory stats periodically
    if (sessionCount % 10 === 0 || memoryMB > this.MAX_RAM_USAGE_MB * 0.8) {
      this.logger.log(`Memory usage: ${memoryMB}MB / ${this.MAX_RAM_USAGE_MB}MB, Sessions: ${sessionCount}`);
    }
    
    // Clean up only when RAM limit exceeded
    return memoryMB > this.MAX_RAM_USAGE_MB;
  }

  private isSessionStable(userId: string): boolean {
    const sessionInfo = this.activeSessions.get(userId);
    if (!sessionInfo) return false;
    
    // Session is stable if it's connected, not reconnecting, and not in progress
    return sessionInfo.isConnected && 
           !sessionInfo.isReconnecting && 
           !this.reconnectionInProgress.get(userId);
  }

  private markSessionAsStable(userId: string): void {
    const sessionInfo = this.activeSessions.get(userId);
    if (sessionInfo) {
      sessionInfo.isConnected = true;
      sessionInfo.isReconnecting = false;
      sessionInfo.lastUsed = new Date();
      this.reconnectionInProgress.delete(userId);
      this.logger.log(`[${userId}] Session marked as stable`);
    }
  }

  private async sendWebhook(userId: string, status: string, connected: boolean, user?: any): Promise<void> {
    try {
      if (!this.WEBHOOK_URL) {
        this.logger.warn('WEBHOOK_URL not set; skipping webhook call');
        return;
      }
      const sessionInfo = this.activeSessions.get(userId);
      const payload = {
        sessionId: `session_${userId}`,
        status,
        connected,
        connectionStatus: status,
        user: user ? {
          name: user.name || user.id || 'Unknown',
          number: user.id || 'Unknown'
        } : null,
        data: {
          isSessionActive: !!sessionInfo,
          isReconnecting: sessionInfo?.isReconnecting || false,
          reconnectionAttempts: this.reconnectionAttempts.get(userId) || 0
        }
      };

      const response = await fetch(this.WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        this.logger.warn(`[${userId}] Webhook failed: ${response.status} ${response.statusText}`);
      } else {
        this.logger.log(`[${userId}] Webhook sent successfully for status: ${status}`);
      }
    } catch (error) {
      this.logger.error(`[${userId}] Error sending webhook:`, error);
    }
  }
}