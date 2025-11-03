import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
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
} from "@whiskeysockets/baileys";
import {
  AuthState,
  AuthStateDocument,
  SessionStatus,
  PersistencePolicy,
} from "../schemas/auth-state.schema";
import { PersistentAuthStateService } from "./persistent-auth-state.service";
import * as QRCode from "qrcode";
import pino from "pino";

// Enhanced connection state tracking
enum SessionConnectionState {
  DISCONNECTED = "disconnected",
  CONNECTING = "connecting",
  CONNECTED = "connected",
  RECONNECTING = "reconnecting",
  FAILED = "failed",
  TIMEOUT = "timeout",
}

interface ConnectionAttemptInfo {
  startTime: Date;
  state: SessionConnectionState;
  attempt: number;
  lastError?: string;
  timeoutId?: NodeJS.Timeout;
}

interface SessionInfo {
  socket: WASocket;
  lastUsed: Date;
  isConnected: boolean;
  isReconnecting?: boolean;
  isInitialConnection?: boolean;
  qrRetryCount?: number;
  lastError?: string;
  errorCount?: number;
  circuitBreakerState?: "closed" | "open" | "half-open";
  lastCircuitBreakerReset?: Date;
  connectionState?: SessionConnectionState;
  connectionAttempt?: ConnectionAttemptInfo;
  lastConnectionAttempt?: Date;
  connectionFailureCount?: number;
}

@Injectable()
export class WhatsAppService implements OnModuleInit {
  private readonly logger = new Logger(WhatsAppService.name);
  // Use pino with enhanced logging for connection debugging
  private readonly pinoLogger = pino({
    level: process.env.NODE_ENV === "development" ? "debug" : "info",
    hooks: {
      logMethod(args, method, levelLabel) {
        try {
          const msg = args[0];
          const text = typeof msg === "string" ? msg : JSON.stringify(msg);

          // Log connection-related events with enhanced detail
          if (
            text.includes("connection") ||
            text.includes("socket") ||
            text.includes("websocket") ||
            text.includes("connect") ||
            text.includes("disconnect") ||
            text.includes("auth")
          ) {
            console.log(
              `[BAILEYS-${String(levelLabel).toUpperCase()}] ${text}`
            );
          }

          // Suppress common decryption errors to reduce noise but keep connection errors
          if (
            text.includes("Bad decrypt") ||
            text.includes("EVP_DecryptFinal_ex") ||
            (text.toLowerCase().includes("token is not valid") &&
              !text.includes("connection"))
          ) {
            return;
          }
        } catch (_) {
          // ignore hook errors
        }
        method.apply(this, args);
      },
    },
  });
  private activeSessions = new Map<string, SessionInfo>();
  private qrCodes = new Map<string, string>();
  private reconnectionAttempts = new Map<string, number>();
  private conflictAttempts = new Map<string, number>();
  private reconnectionInProgress = new Map<string, boolean>(); // Track ongoing reconnections
  private qrTimeouts = new Map<string, NodeJS.Timeout>();

  // Enhanced connection tracking for indefinite session persistence
  private connectionAttempts = new Map<string, ConnectionAttemptInfo>();
  private lastConnectionAttempt = new Map<string, Date>();
  private connectionFailureCount = new Map<string, number>();
  private sessionPersistencePolicy = new Map<
    string,
    "indefinite" | "memory-managed"
  >();

  // Track sessions that were disconnected due to memory constraints for automatic reconnection
  private memoryDisconnectedSessions = new Set<string>();
  private lastMemoryCheck = 0;

  private readonly MAX_ACTIVE_SESSIONS = parseInt(
    process.env.MAX_ACTIVE_SESSIONS || "1000"
  ); // Increased for persistence
  private readonly MAX_RAM_USAGE_MB = parseInt(
    process.env.MAX_RAM_USAGE_MB || "20480"
  ); // 20GB default for persistence
  // Cleanup interval increased to reduce aggressive cleanup (only for emergency cleanup)
  private readonly SESSION_CLEANUP_INTERVAL = parseInt(
    process.env.SESSION_CLEANUP_INTERVAL || "3600000"
  ); // 1 hour
  // Session idle timeout disabled by default for persistence (0 = never timeout)
  private readonly SESSION_IDLE_TIMEOUT_MS = parseInt(
    process.env.SESSION_IDLE_TIMEOUT_MS || "0"
  ); // 0 = never timeout
  private readonly MAX_RECONNECTION_ATTEMPTS = 3;
  private readonly MAX_CONFLICT_ATTEMPTS = 2; // Stop conflicts early
  private readonly QR_CODE_TIMEOUT = parseInt(
    process.env.QR_CODE_TIMEOUT || "60000"
  );
  // Browser configuration for WhatsApp linked devices
  private readonly DEVICE_NAME =
    process.env.WHATSAPP_DEVICE_NAME || "WhatsApp API";
  private readonly BROWSER_NAME = process.env.WHATSAPP_BROWSER || "Chrome";
  private readonly BROWSER_VERSION = process.env.WHATSAPP_VERSION || "4.0.0";
  // private readonly WEBHOOK_URL = 'https://adstudioserver.foodyqueen.com/api/whatsapp-webhook';
  // Webhook URL must be provided in environment; no default fallback
  private readonly WEBHOOK_URL = process.env.WEBHOOK_URL;

  // Enhanced error handling constants
  private readonly CIRCUIT_BREAKER_THRESHOLD = parseInt(
    process.env.CIRCUIT_BREAKER_THRESHOLD || "5"
  );
  private readonly CIRCUIT_BREAKER_TIMEOUT = parseInt(
    process.env.CIRCUIT_BREAKER_TIMEOUT || "300000"
  ); // 5 minutes
  private readonly MAX_ERROR_COUNT = parseInt(
    process.env.MAX_ERROR_COUNT || "10"
  );
  private readonly ERROR_RESET_INTERVAL = parseInt(
    process.env.ERROR_RESET_INTERVAL || "3600000"
  ); // 1 hour

  // Instance tracking for smart conflict resolution
  private readonly SERVER_INSTANCE_ID =
    process.env.SERVER_INSTANCE_ID ||
    require("os").hostname() + "_" + Date.now();
  private readonly SERVER_START_TIME = new Date();

  constructor(
    @InjectModel(AuthState.name)
    private authStateModel: Model<AuthStateDocument>,
    private persistentAuthStateService: PersistentAuthStateService
  ) {}

  /**
   * Handle decryption errors with automatic key refresh
   */
  private async handleDecryptionError(
    userId: string,
    error: any
  ): Promise<void> {
    try {
      // Check if this is a decryption-related error that can be fixed with key refresh
      if (this.persistentAuthStateService.shouldRefreshKeys(error)) {
        this.logger.warn(
          `[${userId}] Decryption error detected, attempting key refresh:`,
          error.message
        );

        // Refresh the encryption keys
        await this.persistentAuthStateService.refreshEncryptionKeys(userId);

        // Clear the current session to force reconnection with fresh keys
        const sessionInfo = this.activeSessions.get(userId);
        if (sessionInfo && sessionInfo.socket) {
          try {
            sessionInfo.socket.end(undefined);
          } catch (endError) {
            this.logger.debug(
              `[${userId}] Error ending socket during key refresh:`,
              endError.message
            );
          }
        }
        this.activeSessions.delete(userId);

        // Update database to reflect key refresh
        await this.authStateModel.findOneAndUpdate(
          { userId },
          {
            connectionStatus: SessionStatus.DISCONNECTED,
            lastUpdated: new Date(),
            lastDisconnected: new Date(),
            lastDisconnectReason: "Key refresh due to decryption error",
            lastDisconnectType: "key_refresh",
          }
        );

        this.logger.log(
          `[${userId}] Session cleared for key refresh, will reconnect with fresh keys`
        );
      }
    } catch (refreshError) {
      this.logger.error(
        `[${userId}] Error handling decryption error:`,
        refreshError
      );
    }
  }

  async onModuleInit() {
    this.logger.log("WhatsApp Service initialized with enhanced persistence");

    // Start periodic cleanup (only for emergency situations when memory is critically low)
    setInterval(
      () => this.emergencyCleanupSessions(),
      this.SESSION_CLEANUP_INTERVAL
    );

    // Start periodic memory recovery check for automatic reconnection
    setInterval(() => this.checkMemoryRecoveryAndReconnect(), 60000); // Check every minute

    // Enable automatic session restoration for persistent sessions
    this.logger.log("Restoring persistent sessions from database...");
    try {
      await this.restoreExistingSessions();
      this.logger.log("Session restoration completed successfully");
    } catch (err) {
      this.logger.error("Session restoration failed:", err);
      // Don't fail startup if session restoration fails
    }
  }

  /**
   * Emergency cleanup only when memory is critically low (>95% RAM usage)
   * Implements LRU strategy while respecting indefinite session persistence policy
   * Only removes sessions when absolutely necessary for system stability
   */
  private async emergencyCleanupSessions(): Promise<void> {
    const memoryMB = this.getMemoryUsageMB();
    const ramUtilization = memoryMB / this.MAX_RAM_USAGE_MB;

    // Only cleanup in emergency situations (>95% RAM usage)
    if (ramUtilization < 0.95) {
      return;
    }

    this.logger.warn(
      `🚨 EMERGENCY CLEANUP TRIGGERED - CRITICAL MEMORY SITUATION`
    );
    this.logger.warn(
      `Memory: ${memoryMB}MB/${this.MAX_RAM_USAGE_MB}MB (${(ramUtilization * 100).toFixed(1)}%)`
    );
    this.logger.warn(`Active Sessions: ${this.activeSessions.size}`);
    this.logger.warn(
      `Persistence Policy: Indefinite sessions will be preserved when possible`
    );

    // Implement sophisticated LRU strategy with persistence awareness
    const sessionEntries = Array.from(this.activeSessions.entries());

    // Sort by priority: conflicted sessions first, then temporary sessions, then by last used (LRU)
    sessionEntries.sort(([userIdA, sessionA], [userIdB, sessionB]) => {
      const conflictedA =
        (this.conflictAttempts.get(userIdA) || 0) >= this.MAX_CONFLICT_ATTEMPTS;
      const conflictedB =
        (this.conflictAttempts.get(userIdB) || 0) >= this.MAX_CONFLICT_ATTEMPTS;

      // Conflicted sessions have highest priority for removal
      if (conflictedA && !conflictedB) return -1;
      if (!conflictedA && conflictedB) return 1;

      // Then by persistence policy (temporary sessions removed before indefinite)
      const policyA =
        this.sessionPersistencePolicy.get(userIdA) || "indefinite";
      const policyB =
        this.sessionPersistencePolicy.get(userIdB) || "indefinite";

      if (policyA === "memory-managed" && policyB === "indefinite") return -1;
      if (policyA === "indefinite" && policyB === "memory-managed") return 1;

      // Finally by last used time (LRU - oldest first)
      return sessionA.lastUsed.getTime() - sessionB.lastUsed.getTime();
    });

    let removedCount = 0;

    for (const [userId, sessionInfo] of sessionEntries) {
      // Check if this session is marked as persistent in database
      try {
        const authState = await this.authStateModel.findOne({ userId });

        // Respect indefinite session persistence policy - NEVER remove persistent/permanent sessions
        const persistencePolicy =
          this.sessionPersistencePolicy.get(userId) || "indefinite";
        const isDbPersistent =
          authState?.persistencePolicy === PersistencePolicy.PERSISTENT ||
          authState?.persistencePolicy === PersistencePolicy.PERMANENT;

        if (isDbPersistent || persistencePolicy === "indefinite") {
          this.logger.log(
            `🔒 Preserving indefinite session ${userId} (policy: ${persistencePolicy}, db: ${authState?.persistencePolicy})`
          );
          continue;
        }

        // Enhanced removal criteria with connection failure tracking
        const isConflicted =
          (this.conflictAttempts.get(userId) || 0) >=
          this.MAX_CONFLICT_ATTEMPTS;
        const isTemporary =
          authState?.persistencePolicy === PersistencePolicy.TEMPORARY;
        const isInactive = !sessionInfo.isConnected;
        const connectionFailures = this.connectionFailureCount.get(userId) || 0;
        const hasRepeatedFailures = connectionFailures > 5;

        // Only remove sessions that are safe to remove
        const shouldRemove =
          isConflicted ||
          (isTemporary && isInactive) ||
          (hasRepeatedFailures && isInactive);

        if (shouldRemove) {
          const reason = isConflicted
            ? "conflicted"
            : isTemporary
              ? "temporary policy"
              : hasRepeatedFailures
                ? "repeated connection failures"
                : "inactive";

          this.logger.warn(
            `🗑️ Emergency cleanup: removing session ${userId} (${reason}, failures: ${connectionFailures})`
          );
          await this.clearSession(userId);
          removedCount++;

          // Check if we've freed enough memory to continue safely
          const newMemoryMB = this.getMemoryUsageMB();
          const newUtilization = newMemoryMB / this.MAX_RAM_USAGE_MB;

          if (newUtilization < 0.9) {
            this.logger.log(
              `✅ Memory usage reduced to safe levels (${(newUtilization * 100).toFixed(1)}%)`
            );
            break;
          }
        }
      } catch (error) {
        this.logger.error(
          `Error during emergency cleanup for user ${userId}:`,
          error
        );
      }
    }

    const finalMemoryMB = this.getMemoryUsageMB();
    const finalUtilization = finalMemoryMB / this.MAX_RAM_USAGE_MB;

    this.logger.warn(`🏁 Emergency cleanup completed:`);
    this.logger.warn(`- Sessions removed: ${removedCount}`);
    this.logger.warn(
      `- Remaining active sessions: ${this.activeSessions.size}`
    );
    this.logger.warn(
      `- Memory: ${finalMemoryMB}MB/${this.MAX_RAM_USAGE_MB}MB (${(finalUtilization * 100).toFixed(1)}%)`
    );

    if (finalUtilization > 0.95) {
      this.logger.error(
        `⚠️ CRITICAL: Memory usage still above 95% after cleanup. System may be unstable.`
      );
      this.logger.error(
        `Consider increasing MAX_RAM_USAGE_MB or reducing session load.`
      );
    } else {
      this.logger.log(
        `✅ Memory usage reduced to safe levels. Session persistence maintained.`
      );
    }
  }

  /**
   * Check for memory recovery and automatically reconnect sessions that were disconnected due to memory constraints
   */
  private async checkMemoryRecoveryAndReconnect(): Promise<void> {
    const currentMemoryMB = this.getMemoryUsageMB();
    const currentUtilization = currentMemoryMB / this.MAX_RAM_USAGE_MB;

    // Only attempt reconnection if memory usage is below 80% (safe threshold)
    if (currentUtilization < 0.8 && this.memoryDisconnectedSessions.size > 0) {
      this.logger.log(
        `🔄 Memory recovered to ${(currentUtilization * 100).toFixed(1)}% - attempting to reconnect ${this.memoryDisconnectedSessions.size} sessions`
      );

      // Reconnect sessions that were disconnected due to memory constraints
      const sessionsToReconnect = Array.from(this.memoryDisconnectedSessions);
      let reconnectedCount = 0;

      for (const userId of sessionsToReconnect) {
        try {
          // Check if session still exists in database and has indefinite persistence
          const authState = await this.authStateModel.findOne({ userId });
          const persistencePolicy =
            this.sessionPersistencePolicy.get(userId) || "indefinite";

          if (
            authState &&
            (persistencePolicy === "indefinite" ||
              authState.persistencePolicy === PersistencePolicy.PERSISTENT ||
              authState.persistencePolicy === PersistencePolicy.PERMANENT)
          ) {
            this.logger.log(
              `🔄 Reconnecting session ${userId} after memory recovery`
            );
            await this.activateSession(userId);
            this.memoryDisconnectedSessions.delete(userId);
            reconnectedCount++;

            // Check memory after each reconnection to avoid overloading
            const newMemoryMB = this.getMemoryUsageMB();
            const newUtilization = newMemoryMB / this.MAX_RAM_USAGE_MB;

            if (newUtilization > 0.85) {
              this.logger.log(
                `Memory usage reached ${(newUtilization * 100).toFixed(1)}% - stopping automatic reconnection`
              );
              break;
            }

            // Small delay between reconnections to avoid overwhelming the system
            await new Promise((resolve) => setTimeout(resolve, 1000));
          } else {
            // Remove from tracking if session no longer exists or is not persistent
            this.memoryDisconnectedSessions.delete(userId);
          }
        } catch (error) {
          this.logger.error(
            `Error reconnecting session ${userId} after memory recovery:`,
            error
          );
          // Keep in tracking for next attempt
        }
      }

      if (reconnectedCount > 0) {
        this.logger.log(
          `✅ Successfully reconnected ${reconnectedCount} sessions after memory recovery`
        );
      }
    }

    // Update last memory check
    this.lastMemoryCheck = Date.now();
  }

  private async clearSession(userId: string): Promise<void> {
    try {
      const sessionInfo = this.activeSessions.get(userId);
      if (sessionInfo?.socket) {
        try {
          sessionInfo.socket.ws?.close();
          // Remove all event listeners
          sessionInfo.socket.ev.removeAllListeners("connection.update");
          sessionInfo.socket.ev.removeAllListeners("creds.update");
          sessionInfo.socket.ev.removeAllListeners("messages.upsert");
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

      let state: any;
      if (savedData?.credentials) {
        this.logger.log(`[${userId}] Found existing auth state in database`);

        const credentials = this.convertBinaryToBuffer(savedData.credentials);
        const savedKeys = this.convertBinaryToBuffer(savedData.keys || {});

        // Create a proper auth state with Map-based keys storage
        const keys = new Map();

        // Restore keys from saved data
        if (savedKeys && typeof savedKeys === "object") {
          for (const [keyId, keyData] of Object.entries(savedKeys)) {
            keys.set(keyId, keyData);
          }
        }

        this.logger.log(`[${userId}] Auth state details:`, {
          hasCredentials: !!credentials,
          credentialsKeys: credentials ? Object.keys(credentials) : [],
          keysCount: keys.size,
          lastUpdated: savedData.lastUpdated,
          connectionStatus: savedData.connectionStatus,
        });

        state = {
          creds: credentials,
          keys: keys,
        };

        this.logger.log(
          `[${userId}] Auth state loaded successfully from database`
        );
      } else {
        this.logger.log(
          `[${userId}] No existing auth state found, creating new credentials`
        );
        state = {
          creds: initAuthCreds(),
          keys: new Map(),
        };
      }

      const saveCreds = async () => {
        try {
          this.logger.log(`[${userId}] Saving credentials update...`);

          // Log what's being saved for debugging
          this.logger.log(
            `[${userId}] Credentials keys:`,
            Object.keys(state.creds)
          );
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

          this.logger.log(
            `[${userId}] Auth state saved successfully. Document ID: ${result._id}`
          );
        } catch (error) {
          this.logger.error(`[${userId}] Error saving auth state:`, {
            error: error.message,
            stack: error.stack,
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

    if (obj._bsontype === "Binary") {
      return Buffer.from(obj.buffer);
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.convertBinaryToBuffer(item));
    }

    if (typeof obj === "object" && obj !== null) {
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
      return obj.map((item) => this.convertBufferForStorage(item));
    }

    if (typeof obj === "object" && obj !== null) {
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
          this.logger.log(
            `[${userId}] Reusing existing stable session with QR`
          );
          return existingQR;
        }
        this.logger.log(
          `[${userId}] Session already stable and connected, no QR needed`
        );
        throw new Error("Session already exists and is connected");
      }

      // Prevent creating multiple sessions simultaneously
      if (this.reconnectionInProgress.get(userId)) {
        this.logger.log(
          `[${userId}] Session creation already in progress, cannot create new session`
        );
        throw new Error("Session creation in progress, please wait");
      }

      // Mark creation as in progress
      this.reconnectionInProgress.set(userId, true);

      try {
        // Don't clear existing session if it's just conflicted - try to reuse it
        if (sessionInfo && !sessionInfo.isConnected) {
          const conflictCount = this.conflictAttempts.get(userId) || 0;
          if (conflictCount >= this.MAX_CONFLICT_ATTEMPTS) {
            this.logger.log(
              `[${userId}] Too many conflicts (${conflictCount}), avoiding reconnection`
            );
            throw new Error(
              "Session has too many conflicts, please wait before retrying"
            );
          }
        }

        // Only clear session if it's truly problematic
        if (sessionInfo && sessionInfo.isReconnecting) {
          this.logger.log(
            `[${userId}] Session is reconnecting, clearing to start fresh`
          );
          await this.clearSession(userId);
        }

        // Only perform emergency cleanup if memory is critically low
        if (this.getMemoryUsageMB() / this.MAX_RAM_USAGE_MB > 0.95) {
          await this.emergencyCleanupSessions();
        }

        const { state, saveCreds } = await this.loadAuthState(userId);

        // Enhanced auth state validation
        this.logger.log(`[${userId}] Auth state loaded. Validating...`, {
          hasState: !!state,
          hasCreds: !!state?.creds,
          hasKeys: !!state?.keys,
          credsKeys: state?.creds ? Object.keys(state.creds) : [],
          keysCount: state?.keys ? Object.keys(state.keys).length : 0,
        });

        // Critical validation: Check if auth state is actually valid for connection
        if (!state?.creds || !state?.keys) {
          this.logger.error(
            `[${userId}] ❌ INVALID AUTH STATE - Missing creds or keys!`,
            {
              hasCreds: !!state?.creds,
              hasKeys: !!state?.keys,
              stateStructure: state ? Object.keys(state) : "null",
            }
          );
          throw new Error("Invalid auth state: missing credentials or keys");
        }

        // Check for required credential fields
        const requiredCredFields = [
          "noiseKey",
          "signedIdentityKey",
          "signedPreKey",
          "registrationId",
        ];
        const missingFields = requiredCredFields.filter(
          (field) => !state.creds[field]
        );

        if (missingFields.length > 0) {
          this.logger.error(
            `[${userId}] ❌ MISSING REQUIRED CREDENTIAL FIELDS:`,
            missingFields
          );
          throw new Error(
            `Missing required credential fields: ${missingFields.join(", ")}`
          );
        }

        this.logger.log(`[${userId}] ✅ Auth state validation passed`);

        // Get latest Baileys version
        const { version, isLatest } = await fetchLatestBaileysVersion();
        if (!isLatest) {
          this.logger.warn(`Using outdated Baileys version: ${version}`);
        }

        this.logger.log(
          `[${userId}] Creating WhatsApp socket with Baileys version: ${version}`
        );

        // Initialize connection tracking for indefinite session persistence
        this.initializeConnectionTracking(userId);

        // Log detailed connection attempt information
        this.logger.log(`[${userId}] Connection attempt details:`, {
          timestamp: new Date().toISOString(),
          attempt: (this.connectionFailureCount.get(userId) || 0) + 1,
          lastAttempt: this.lastConnectionAttempt.get(userId),
          persistencePolicy:
            this.sessionPersistencePolicy.get(userId) || "indefinite",
          memoryUsage: `${this.getMemoryUsageMB()}MB / ${this.MAX_RAM_USAGE_MB}MB`,
        });

        // Set up connection timeout to prevent hanging connections
        this.setupConnectionTimeout(userId);

        // Enhanced socket configuration with debugging
        this.logger.log(`[${userId}] Creating socket with configuration:`, {
          version,
          browser: [this.DEVICE_NAME, this.BROWSER_NAME, this.BROWSER_VERSION],
          hasAuthState: !!state,
          authStateKeys: state ? Object.keys(state) : [],
          connectTimeoutMs: 20000,
          defaultQueryTimeoutMs: 20000,
        });

        const socket = makeWASocket({
          version,
          auth: state,
          printQRInTerminal: false,
          logger: this.pinoLogger,
          browser: [this.DEVICE_NAME, this.BROWSER_NAME, this.BROWSER_VERSION],
          syncFullHistory: false,
          markOnlineOnConnect: false,
          generateHighQualityLinkPreview: false,
          defaultQueryTimeoutMs: 20000, // Reduced to 20 seconds
          connectTimeoutMs: 20000, // Reduced to 20 seconds
          keepAliveIntervalMs: 45000, // Keep-alive every 45 seconds
          retryRequestDelayMs: 2000, // Shorter delay between retries
          maxMsgRetryCount: 1, // Minimal retry count to avoid conflicts
          emitOwnEvents: false,
          shouldSyncHistoryMessage: () => false,
          shouldIgnoreJid: () => false,
          linkPreviewImageThumbnailWidth: 192,
          transactionOpts: {
            maxCommitRetries: 3, // Reduced retries to avoid timeout issues
            delayBetweenTriesMs: 3000, // Shorter delay between transaction retries
          },
          // Disable some features that can cause conflicts
          cachedGroupMetadata: () => undefined,
          patchMessageBeforeSending: (msg) => {
            // Don't patch messages to avoid conflicts
            return msg;
          },
          getMessage: async (key) => {
            this.logger.debug(`[${userId}] getMessage called with key:`, key);
            return { conversation: "" };
          },
        });

        // Log socket creation success and initial state
        this.logger.log(
          `[${userId}] Socket created successfully. Initial state:`,
          {
            hasWebSocket: !!socket.ws,
            user: socket.user,
            authState: socket.authState?.creds ? "present" : "missing",
            socketType: typeof socket,
          }
        );

        // Add immediate WebSocket event debugging
        if (socket.ws) {
          const originalWs = socket.ws;
          this.logger.log(
            `[${userId}] WebSocket object exists, setting up connection debugging...`
          );

          // Monitor WebSocket events directly
          const wsOpenHandler = () => {
            this.logger.log(`[${userId}] 🔗 WebSocket OPENED successfully`);
          };

          const wsCloseHandler = (event: any) => {
            this.logger.warn(`[${userId}] 🔌 WebSocket CLOSED:`, {
              code: event?.code,
              reason: event?.reason,
              wasClean: event?.wasClean,
            });
          };

          const wsErrorHandler = (error: any) => {
            this.logger.error(`[${userId}] ❌ WebSocket ERROR:`, error);
          };

          const wsMessageHandler = (data: any) => {
            this.logger.debug(`[${userId}] 📨 WebSocket MESSAGE received:`, {
              dataType: typeof data,
              dataLength: data?.length || "unknown",
            });
          };

          // Add event listeners
          originalWs.on("open", wsOpenHandler);
          originalWs.on("close", wsCloseHandler);
          originalWs.on("error", wsErrorHandler);
          originalWs.on("message", wsMessageHandler);

          this.logger.log(`[${userId}] WebSocket event listeners attached`);
        } else {
          this.logger.error(
            `[${userId}] ❌ No WebSocket object found in socket!`
          );
        }

        this.logger.log(`[${userId}] WhatsApp socket created successfully`);

        const newSessionInfo: SessionInfo = {
          socket,
          lastUsed: new Date(),
          isConnected: false,
          isInitialConnection: true,
          qrRetryCount: 0,
        };

        this.activeSessions.set(userId, newSessionInfo);

        // Immediate connection state check
        setTimeout(() => {
          this.logger.log(
            `[${userId}] 🔍 Connection state check after 1 second:`,
            {
              hasSocket: !!newSessionInfo.socket,
              hasWebSocket: !!newSessionInfo.socket?.ws,
              isConnected: newSessionInfo.isConnected,
              socketUser: newSessionInfo.socket?.user,
              authStateCreds: !!newSessionInfo.socket?.authState?.creds,
            }
          );
        }, 1000);

        return new Promise<string>((resolve, reject) => {
          let qrResolved = false;
          let connectionResolved = false;

          // Set up QR timeout
          const qrTimeout = setTimeout(() => {
            if (!qrResolved && !connectionResolved) {
              this.logger.error(
                `QR code generation timeout for user ${userId}`
              );
              this.clearSession(userId);
              reject(new Error("QR code generation timeout"));
            }
          }, this.QR_CODE_TIMEOUT);

          this.qrTimeouts.set(userId, qrTimeout);

          socket.ev.on("creds.update", saveCreds);

          // Add error handling for various events with decryption error detection
          socket.ev.on("messages.upsert", async (messageUpdate) => {
            try {
              this.logger.debug(`[${userId}] Messages upsert:`, {
                messageCount: messageUpdate.messages.length,
                type: messageUpdate.type,
              });
            } catch (error) {
              this.logger.error(
                `[${userId}] Error processing messages.upsert:`,
                error
              );
              await this.handleDecryptionError(userId, error);
            }
          });

          socket.ev.on("presence.update", (presence) => {
            this.logger.debug(`[${userId}] Presence update:`, presence);
          });

          // Handle signal errors without crashing
          socket.ev.on("creds.update", (_update) => {
            try {
              saveCreds();
              this.logger.debug(`[${userId}] Credentials updated successfully`);
            } catch (error) {
              this.logger.error(`[${userId}] Error saving credentials:`, error);
            }
          });

          // Handle any other potential errors including decryption errors
          const uncaughtHandler = async (error: Error) => {
            if (error.message.includes("Timed Out")) {
              this.logger.warn(
                `[${userId}] Timeout error detected:`,
                error.message
              );
            } else if (
              this.persistentAuthStateService.shouldRefreshKeys(error)
            ) {
              this.logger.warn(
                `[${userId}] Decryption error in uncaught exception:`,
                error.message
              );
              await this.handleDecryptionError(userId, error);
            } else {
              this.logger.error(`[${userId}] Uncaught exception:`, error);
            }
          };

          const rejectionHandler = async (
            reason: any,
            promise: Promise<any>
          ) => {
            if (reason && typeof reason === "object" && "message" in reason) {
              const error = reason as Error;
              if (error.message.includes("Timed Out")) {
                this.logger.warn(
                  `[${userId}] Timeout rejection:`,
                  error.message
                );
              } else if (
                this.persistentAuthStateService.shouldRefreshKeys(error)
              ) {
                this.logger.warn(
                  `[${userId}] Decryption error in unhandled rejection:`,
                  error.message
                );
                await this.handleDecryptionError(userId, error);
              } else {
                this.logger.error(
                  `[${userId}] Unhandled rejection at:`,
                  promise,
                  "reason:",
                  reason
                );
              }
            } else {
              this.logger.error(
                `[${userId}] Unhandled rejection at:`,
                promise,
                "reason:",
                reason
              );
            }
          };

          process.on("uncaughtException", uncaughtHandler);
          process.on("unhandledRejection", rejectionHandler);

          socket.ev.on("connection.update", async (update) => {
            try {
              const {
                connection,
                lastDisconnect,
                qr,
                isNewLogin,
                isOnline,
                receivedPendingNotifications,
              } = update;

              // Enhanced connection logging with state tracking
              const connectionAttempt = this.connectionAttempts.get(userId);
              const currentState = connection
                ? this.mapBaileysConnectionToState(connection)
                : SessionConnectionState.DISCONNECTED;

              this.logger.log(
                `[${userId}] 🔄 CONNECTION UPDATE - State: ${currentState}`,
                {
                  connection,
                  isNewLogin,
                  isOnline,
                  receivedPendingNotifications,
                  qrPresent: !!qr,
                  attemptNumber: connectionAttempt?.attempt || "unknown",
                  timeSinceAttemptStart: connectionAttempt
                    ? Date.now() - connectionAttempt.startTime.getTime()
                    : "unknown",
                  lastDisconnectError: lastDisconnect?.error
                    ? {
                        name: lastDisconnect.error.name,
                        message: lastDisconnect.error.message,
                        statusCode: (lastDisconnect.error as any)?.output
                          ?.statusCode,
                      }
                    : null,
                  timestamp: new Date().toISOString(),
                  persistencePolicy:
                    this.sessionPersistencePolicy.get(userId) || "indefinite",
                }
              );

              // Update connection state tracking
              if (connectionAttempt) {
                connectionAttempt.state = currentState;
                this.connectionAttempts.set(userId, connectionAttempt);
              }

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
                    stack: error.stack,
                  });
                  this.clearSession(userId);
                  reject(error);
                }
              }

              if (connection === "connecting") {
                this.logger.log(`[${userId}] WhatsApp is connecting...`);
                newSessionInfo.isConnected = false;
              }

              if (connection === "open") {
                this.logger.log(
                  `[${userId}] ✅ CONNECTION ESTABLISHED SUCCESSFULLY - Session will persist indefinitely`
                );
                this.markSessionAsStable(userId);
                connectionResolved = true;

                // Update session info with connection success and enforce persistence policy
                newSessionInfo.isConnected = true; // ✅ CRITICAL FIX: Mark session as connected
                newSessionInfo.connectionState =
                  SessionConnectionState.CONNECTED;
                newSessionInfo.lastConnectionAttempt = new Date();
                newSessionInfo.connectionFailureCount = 0;

                // Clear all failure tracking - session is now stable and persistent
                this.reconnectionAttempts.delete(userId);
                this.conflictAttempts.delete(userId);
                this.qrCodes.delete(userId);
                this.clearQRTimeout(userId);
                this.connectionFailureCount.delete(userId);

                // Update connection attempt tracking and clear timeout
                const connectionAttempt = this.connectionAttempts.get(userId);
                if (connectionAttempt) {
                  connectionAttempt.state = SessionConnectionState.CONNECTED;
                  // Clear connection timeout on successful connection
                  if (connectionAttempt.timeoutId) {
                    clearTimeout(connectionAttempt.timeoutId);
                    connectionAttempt.timeoutId = undefined;
                  }
                  this.connectionAttempts.set(userId, connectionAttempt);
                }

                this.logger.log(
                  `[${userId}] Session persistence enforced - Policy: ${this.sessionPersistencePolicy.get(userId) || "indefinite"}`
                );
                this.logger.log(
                  `[${userId}] Connection established and marked as stable`
                );

                // Send webhook notification for successful connection
                await this.sendWebhook(userId, "connected", true, socket.user);

                try {
                  await this.authStateModel.findOneAndUpdate(
                    { userId },
                    {
                      connectionStatus: SessionStatus.CONNECTED,
                      lastUpdated: new Date(),
                      lastConnected: new Date(),
                      lastActivity: new Date(),
                      user: socket.user ? JSON.stringify(socket.user) : null,
                      phoneNumber: socket.user?.id || null,
                      deviceName: socket.user?.name || "WhatsApp Web",
                      isPersistent: true,
                      autoReconnect: true,
                      persistencePolicy: PersistencePolicy.PERMANENT, // Default to permanent persistence
                      reconnectionAttempts: 0,
                      $inc: { totalConnections: 1 },
                      errorCount: 0,
                      lastError: null,
                      circuitBreakerState: "closed",
                      conflictRetryCount: 0,
                      lastConflictTime: null,
                      wasGracefullyDisconnected: false,
                      serverInstanceId: this.SERVER_INSTANCE_ID,
                      lastServerStart: this.SERVER_START_TIME,
                      connectionInstanceId: `${userId}_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
                      lastHeartbeat: new Date(),
                    },
                    { upsert: true }
                  );
                  this.logger.log(
                    `[${userId}] Auth state updated with connected status and permanent persistence`
                  );
                } catch (dbError) {
                  this.logger.error(
                    `[${userId}] Error updating auth state:`,
                    dbError
                  );
                }

                // Send webhook notification
                this.sendWebhook(userId, "connected", true, socket.user);
              } else if (connection === "close") {
                this.logger.log(
                  `[${userId}] ⚠️ CONNECTION CLOSED - Analyzing for persistence strategy`
                );
                newSessionInfo.isConnected = false;
                newSessionInfo.connectionState =
                  SessionConnectionState.DISCONNECTED;

                const errorStatusCode = (lastDisconnect?.error as any)?.output
                  ?.statusCode;
                const shouldReconnect =
                  errorStatusCode !== DisconnectReason.loggedOut;
                const isRestartRequired = errorStatusCode === 515; // DisconnectReason.restartRequired
                const isConflict = errorStatusCode === 440; // Session conflict (logged in elsewhere)

                // Track connection failure for exponential backoff
                const currentFailures =
                  this.connectionFailureCount.get(userId) || 0;
                this.connectionFailureCount.set(userId, currentFailures + 1);

                // Update connection attempt tracking and clear timeout
                const connectionAttempt = this.connectionAttempts.get(userId);
                if (connectionAttempt) {
                  connectionAttempt.state = SessionConnectionState.FAILED;
                  connectionAttempt.lastError =
                    lastDisconnect?.error?.message || "Connection closed";
                  // Clear connection timeout on connection failure
                  if (connectionAttempt.timeoutId) {
                    clearTimeout(connectionAttempt.timeoutId);
                    connectionAttempt.timeoutId = undefined;
                  }
                  this.connectionAttempts.set(userId, connectionAttempt);
                }

                this.logger.log(`[${userId}] Connection failure analysis:`, {
                  errorStatusCode,
                  shouldReconnect,
                  isRestartRequired,
                  isConflict,
                  failureCount: currentFailures + 1,
                  persistencePolicy:
                    this.sessionPersistencePolicy.get(userId) || "indefinite",
                  errorMessage: lastDisconnect?.error?.message,
                });

                // Handle connection error with enhanced error tracking
                if (lastDisconnect?.error) {
                  this.handleSessionError(
                    userId,
                    lastDisconnect.error as Error,
                    "connection_close"
                  );
                }

                this.logger.log(`[${userId}] Disconnect analysis:`, {
                  errorStatusCode,
                  shouldReconnect,
                  isRestartRequired,
                  isConflict,
                  isInitialConnection: newSessionInfo.isInitialConnection,
                  wasConnected: newSessionInfo.isConnected,
                  errorMessage: lastDisconnect?.error?.message,
                  errorName: lastDisconnect?.error?.name,
                });

                if (isRestartRequired) {
                  // This is the expected "restart required" after successful pairing
                  this.logger.log(
                    `[${userId}] Restart required after pairing - restarting connection...`
                  );
                  newSessionInfo.isReconnecting = true;

                  // Set a flag to indicate this is a post-pairing restart
                  newSessionInfo.isInitialConnection = false;

                  // Update connection status and attempt immediate restart
                  await this.authStateModel.findOneAndUpdate(
                    { userId },
                    {
                      connectionStatus: "restarting_after_pairing",
                      lastUpdated: new Date(),
                    }
                  );

                  // Restart the connection without clearing the session
                  setTimeout(() => {
                    this.logger.log(
                      `[${userId}] Attempting restart after pairing...`
                    );
                    this.attemptReconnection(userId, true); // true = isPostPairingRestart
                  }, 1000); // Small delay before restart
                } else if (isConflict) {
                  // Session conflict - same account logged in elsewhere
                  this.logger.warn(
                    `[${userId}] Session conflict detected - account logged in elsewhere (status 440)`
                  );

                  // Handle conflict with progressive backoff instead of permanent blocking
                  await this.handleSessionConflict(userId, newSessionInfo);
                  return;
                } else if (!shouldReconnect) {
                  // User logged out
                  this.logger.log(
                    `[${userId}] User logged out, cleaning up session`
                  );
                  await this.authStateModel.deleteOne({ userId });
                  this.clearSession(userId);
                } else if (
                  newSessionInfo.isInitialConnection &&
                  !connectionResolved
                ) {
                  // Initial connection failed (but not due to restart requirement or conflict)
                  this.logger.error(
                    `[${userId}] Initial connection failed - rejecting QR promise`
                  );
                  this.clearSession(userId);
                  if (!qrResolved) {
                    reject(
                      new Error(
                        `Initial connection failed: ${lastDisconnect?.error?.message || "Unknown error"}`
                      )
                    );
                  }
                } else {
                  // Connection lost, attempt reconnection
                  await this.authStateModel.findOneAndUpdate(
                    { userId },
                    {
                      connectionStatus: "disconnected",
                      lastUpdated: new Date(),
                      lastDisconnected: new Date(),
                      lastDisconnectReason:
                        lastDisconnect?.error?.message || "Connection lost",
                      $inc: { reconnectionAttempts: 1 },
                    }
                  );

                  // Only attempt reconnection if not already in progress and not already reconnecting
                  if (
                    !newSessionInfo.isReconnecting &&
                    !this.reconnectionInProgress.get(userId)
                  ) {
                    this.attemptReconnection(userId);
                  } else {
                    this.logger.log(
                      `[${userId}] Reconnection skipped - already in progress or session is reconnecting`
                    );
                  }
                }
              } else if (connection === "connecting") {
                this.logger.log(`WhatsApp connecting for user ${userId}`);
              }
            } catch (connectionError) {
              this.logger.error(
                `[${userId}] Error in connection.update handler:`,
                connectionError
              );

              // Handle the error gracefully without crashing the app
              if (newSessionInfo) {
                newSessionInfo.isConnected = false;
                newSessionInfo.isReconnecting = false;
              }

              // Update database to reflect error state
              try {
                await this.authStateModel.findOneAndUpdate(
                  { userId },
                  {
                    connectionStatus: "disconnected",
                    lastUpdated: new Date(),
                    lastDisconnected: new Date(),
                    lastDisconnectReason:
                      connectionError.message || "Connection handler error",
                  }
                );
              } catch (dbError) {
                this.logger.error(
                  `[${userId}] Failed to update database after connection error:`,
                  dbError
                );
              }

              // Don't re-throw the error - let the session continue in error state
            }
          });

          socket.ev.on("creds.update", (_update) => {
            this.logger.log(`Credentials updated for user ${userId}`);
          });

          socket.ev.on("messages.upsert", (m) => {
            this.logger.debug(
              `Received ${m.messages.length} messages for user ${userId}`
            );
          });
        }).catch((promiseError) => {
          this.logger.error(
            `[${userId}] Promise error in session creation:`,
            promiseError
          );
          this.reconnectionInProgress.delete(userId);
          throw promiseError;
        }); // end of new Promise
      } catch (innerError) {
        this.logger.error(
          `Error in session creation inner try block for user ${userId}:`,
          innerError
        );
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

  private async attemptReconnection(
    userId: string,
    isPostPairingRestart = false,
    isConflictReconnect = false
  ): Promise<void> {
    const sessionInfo = this.activeSessions.get(userId);
    if (!sessionInfo) {
      this.logger.log(
        `[${userId}] No session info found, skipping reconnection`
      );
      return;
    }

    // Check if reconnection is already in progress for this user
    if (this.reconnectionInProgress.get(userId)) {
      this.logger.log(
        `[${userId}] Reconnection already in progress, skipping duplicate attempt`
      );
      return;
    }

    // Check if session is already connected (prevent unnecessary reconnections)
    if (sessionInfo.isConnected && !isPostPairingRestart) {
      this.logger.log(
        `[${userId}] Session already connected, skipping reconnection`
      );
      return;
    }

    // Enhanced error handling: Check circuit breaker and error limits
    if (!isPostPairingRestart && !this.canAttemptReconnection(userId)) {
      this.logger.log(
        `[${userId}] Reconnection blocked by error handling system`
      );
      return;
    }

    // Check for conflicts before attempting any reconnection
    const conflictCount = this.conflictAttempts.get(userId) || 0;
    if (conflictCount >= this.MAX_CONFLICT_ATTEMPTS || conflictCount >= 999) {
      this.logger.log(
        `[${userId}] Session marked as conflicted (${conflictCount}), refusing reconnection attempt`
      );
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
      this.logger.error(
        `Max reconnection attempts reached for user ${userId} (${attempts}/${maxAttempts})`
      );
      this.reconnectionInProgress.delete(userId); // Clear the progress flag
      this.clearSession(userId);
      return;
    }

    sessionInfo.isReconnecting = true;

    if (!isPostPairingRestart) {
      this.reconnectionAttempts.set(userId, attempts + 1);
    }

    const reconnectionType = isPostPairingRestart
      ? "post-pairing restart"
      : isConflictReconnect
        ? "conflict reconnection"
        : "reconnection";

    this.logger.log(
      `Scheduling ${reconnectionType} for user ${userId} in ${delay}ms ${isPostPairingRestart ? "" : `(attempt ${attempts + 1})`}`
    );

    setTimeout(async () => {
      try {
        await this.reconnectSession(userId);
      } catch (error) {
        this.logger.error(
          `${reconnectionType} failed for user ${userId}:`,
          error
        );
        sessionInfo.isReconnecting = false;

        // Enhanced error handling
        this.handleSessionError(userId, error as Error, reconnectionType);
      } finally {
        // Always clear the progress flag when done
        this.reconnectionInProgress.delete(userId);
      }
    }, delay);
  }

  private async reconnectSession(userId: string): Promise<void> {
    try {
      this.logger.log(
        `🔄 ENHANCED RECONNECT SESSION CALLED for user ${userId}`
      );
      this.logger.log(`Reconnecting session for user ${userId}`);

      let sessionInfo = this.activeSessions.get(userId);
      if (!sessionInfo) {
        this.logger.log(
          `📝 No session info found for user ${userId} - creating new session info for reconnection`
        );

        // Create new session info for reconnection (using only valid SessionInfo properties)
        sessionInfo = {
          socket: null as any, // Will be set after socket creation
          lastUsed: new Date(),
          isConnected: false,
          isReconnecting: true,
          connectionState: SessionConnectionState.CONNECTING,
          lastError: null,
          circuitBreakerState: "closed",
        };

        this.activeSessions.set(userId, sessionInfo);
        this.logger.log(`✅ Created new session info for user ${userId}`);
      }

      // Clear existing socket
      if (sessionInfo.socket) {
        try {
          sessionInfo.socket.ws?.close();
          // Remove all event listeners
          sessionInfo.socket.ev.removeAllListeners("connection.update");
          sessionInfo.socket.ev.removeAllListeners("creds.update");
          sessionInfo.socket.ev.removeAllListeners("messages.upsert");
        } catch (error) {
          this.logger.warn(
            `Error closing old socket for user ${userId}:`,
            error
          );
        }
      }

      // Create new socket with enhanced configuration and debugging
      const { state, saveCreds } = await this.loadAuthState(userId);

      // Enhanced auth state validation (same as createSession)
      this.logger.log(
        `[${userId}] Auth state loaded for reconnection. Validating...`,
        {
          hasState: !!state,
          hasCreds: !!state?.creds,
          hasKeys: !!state?.keys,
          credsKeys: state?.creds ? Object.keys(state.creds) : [],
          keysCount: state?.keys ? Object.keys(state.keys).length : 0,
        }
      );

      // Critical validation: Check if auth state is actually valid for connection
      if (!state?.creds || !state?.keys) {
        this.logger.error(
          `[${userId}] ❌ INVALID AUTH STATE FOR RECONNECTION - Missing creds or keys!`,
          {
            hasCreds: !!state?.creds,
            hasKeys: !!state?.keys,
            stateStructure: state ? Object.keys(state) : "null",
          }
        );
        throw new Error(
          "Invalid auth state for reconnection: missing credentials or keys"
        );
      }

      // Check for required credential fields
      const requiredCredFields = [
        "noiseKey",
        "signedIdentityKey",
        "signedPreKey",
        "registrationId",
      ];
      const missingFields = requiredCredFields.filter(
        (field) => !state.creds[field]
      );

      if (missingFields.length > 0) {
        this.logger.error(
          `[${userId}] ❌ MISSING REQUIRED CREDENTIAL FIELDS FOR RECONNECTION:`,
          missingFields
        );
        throw new Error(
          `Missing required credential fields for reconnection: ${missingFields.join(", ")}`
        );
      }

      this.logger.log(
        `[${userId}] ✅ Auth state validation passed for reconnection`
      );

      const { version } = await fetchLatestBaileysVersion();

      // Enhanced socket configuration with debugging (same as createSession)
      this.logger.log(
        `[${userId}] Creating reconnection socket with configuration:`,
        {
          version,
          browser: [this.DEVICE_NAME, this.BROWSER_NAME, this.BROWSER_VERSION],
          hasAuthState: !!state,
          authStateKeys: state ? Object.keys(state) : [],
          connectTimeoutMs: 20000,
          defaultQueryTimeoutMs: 20000,
        }
      );

      const socket = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: this.pinoLogger,
        browser: [this.DEVICE_NAME, this.BROWSER_NAME, this.BROWSER_VERSION],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        defaultQueryTimeoutMs: 20000, // Reduced to 20 seconds (same as createSession)
        connectTimeoutMs: 20000, // Reduced to 20 seconds (same as createSession)
        keepAliveIntervalMs: 45000, // Keep-alive every 45 seconds (same as createSession)
        retryRequestDelayMs: 2000, // Shorter delay between retries (same as createSession)
        maxMsgRetryCount: 1, // Minimal retry count to avoid conflicts (same as createSession)
        emitOwnEvents: false,
        shouldSyncHistoryMessage: () => false,
        shouldIgnoreJid: () => false,
        linkPreviewImageThumbnailWidth: 192,
        transactionOpts: {
          maxCommitRetries: 3, // Reduced retries to avoid timeout issues
          delayBetweenTriesMs: 3000, // Shorter delay between transaction retries
        },
        // Disable some features that can cause conflicts
        cachedGroupMetadata: () => undefined,
        patchMessageBeforeSending: (msg) => {
          // Don't patch messages to avoid conflicts
          return msg;
        },
        getMessage: async (key) => {
          this.logger.debug(
            `[${userId}] getMessage called during reconnection with key:`,
            key
          );
          return { conversation: "" };
        },
      });

      // Log socket creation success and initial state (same as createSession)
      this.logger.log(
        `[${userId}] Reconnection socket created successfully. Initial state:`,
        {
          hasWebSocket: !!socket.ws,
          user: socket.user,
          authState: socket.authState?.creds ? "present" : "missing",
          socketType: typeof socket,
        }
      );

      // Add immediate WebSocket event debugging (same as createSession)
      if (socket.ws) {
        const originalWs = socket.ws;
        this.logger.log(
          `[${userId}] WebSocket object exists for reconnection, setting up connection debugging...`
        );

        // Monitor WebSocket events directly
        const wsOpenHandler = () => {
          this.logger.log(
            `[${userId}] 🔗 Reconnection WebSocket OPENED successfully`
          );
        };

        const wsCloseHandler = (event: any) => {
          this.logger.warn(`[${userId}] 🔌 Reconnection WebSocket CLOSED:`, {
            code: event?.code,
            reason: event?.reason,
            wasClean: event?.wasClean,
          });
        };

        const wsErrorHandler = (error: any) => {
          this.logger.error(
            `[${userId}] ❌ Reconnection WebSocket ERROR:`,
            error
          );
        };

        const wsMessageHandler = (data: any) => {
          this.logger.debug(
            `[${userId}] 📨 Reconnection WebSocket MESSAGE received:`,
            {
              dataType: typeof data,
              dataLength: data?.length || "unknown",
            }
          );
        };

        // Add event listeners
        originalWs.on("open", wsOpenHandler);
        originalWs.on("close", wsCloseHandler);
        originalWs.on("error", wsErrorHandler);
        originalWs.on("message", wsMessageHandler);

        this.logger.log(
          `[${userId}] Reconnection WebSocket event listeners attached`
        );
      } else {
        this.logger.error(
          `[${userId}] ❌ No WebSocket object found in reconnection socket!`
        );
      }

      sessionInfo.socket = socket;
      sessionInfo.lastUsed = new Date();

      // Set up connection timeout to prevent hanging connections (same as createSession)
      this.setupConnectionTimeout(userId);

      // Immediate connection state check for reconnection
      setTimeout(() => {
        this.logger.log(
          `[${userId}] 🔍 Reconnection state check after 1 second:`,
          {
            hasSocket: !!sessionInfo.socket,
            hasWebSocket: !!sessionInfo.socket?.ws,
            isConnected: sessionInfo.isConnected,
            socketUser: sessionInfo.socket?.user,
            authStateCreds: !!sessionInfo.socket?.authState?.creds,
          }
        );
      }, 1000);

      socket.ev.on("creds.update", saveCreds);
      socket.ev.on("connection.update", async (update) => {
        try {
          const { connection, lastDisconnect } = update;

          if (connection === "open") {
            this.logger.log(`Reconnection successful for user ${userId}`);
            sessionInfo.isConnected = true;
            sessionInfo.isReconnecting = false;
            this.reconnectionAttempts.delete(userId);
            this.conflictAttempts.delete(userId); // Reset conflict attempts on successful connection
            this.reconnectionInProgress.delete(userId); // Clear reconnection progress flag

            // Reset error tracking on successful reconnection
            this.resetSessionErrors(userId);

            // Send webhook notification for successful reconnection
            await this.sendWebhook(userId, "connected", true, socket.user);

            await this.authStateModel.findOneAndUpdate(
              { userId },
              {
                connectionStatus: "connected",
                lastUpdated: new Date(),
                lastConnected: new Date(),
                user: socket.user,
                phoneNumber: socket.user?.id || null,
                deviceName: socket.user?.name || "WhatsApp Web",
                reconnectionAttempts: 0,
                isPersistent: true,
                autoReconnect: true,
              },
              { upsert: true }
            );

            // Send webhook notification
            this.sendWebhook(userId, "connected", true, socket.user);
          } else if (connection === "close") {
            sessionInfo.isConnected = false;
            const errorStatusCode = (lastDisconnect?.error as any)?.output
              ?.statusCode;
            const shouldReconnect =
              errorStatusCode !== DisconnectReason.loggedOut;
            const isRestartRequired = errorStatusCode === 515; // DisconnectReason.restartRequired
            const isConflict = errorStatusCode === 440; // Session conflict (logged in elsewhere)

            this.logger.log(
              `[${userId}] Reconnection handler - Disconnect analysis:`,
              {
                errorStatusCode,
                shouldReconnect,
                isRestartRequired,
                isConflict,
                errorMessage: lastDisconnect?.error?.message,
              }
            );

            if (isRestartRequired) {
              // This is the expected "restart required" during reconnection
              this.logger.log(
                `[${userId}] Restart required during reconnection - attempting immediate restart...`
              );
              if (!sessionInfo.isReconnecting) {
                this.attemptReconnection(userId, true); // true = isPostPairingRestart
              }
            } else if (isConflict) {
              // Stream conflict during reconnection - handle smartly
              this.logger.warn(
                `[${userId}] Stream conflict during reconnection`
              );
              await this.handleSessionConflict(userId, sessionInfo);

              await this.clearSession(userId);
              this.logger.log(
                `[${userId}] Reconnection stopped due to stream conflict`
              );
              return;
            } else if (!shouldReconnect) {
              await this.authStateModel.deleteOne({ userId });
              this.clearSession(userId);
            } else if (!sessionInfo.isReconnecting) {
              this.attemptReconnection(userId);
            }
          }
        } catch (connectionError) {
          this.logger.error(
            `[${userId}] Error in reconnection connection.update handler:`,
            connectionError
          );

          // Handle the error gracefully
          if (sessionInfo) {
            sessionInfo.isConnected = false;
            sessionInfo.isReconnecting = false;
          }

          // Update database to reflect error state
          try {
            await this.authStateModel.findOneAndUpdate(
              { userId },
              {
                connectionStatus: "disconnected",
                lastUpdated: new Date(),
                lastDisconnected: new Date(),
                lastDisconnectReason:
                  connectionError.message || "Reconnection handler error",
              }
            );
          } catch (dbError) {
            this.logger.error(
              `[${userId}] Failed to update database after reconnection error:`,
              dbError
            );
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
      throw new Error("QR code not found. Please create a new session.");
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
      this.logger.log(
        `[${userId}] 📊 INTELLIGENT STATUS CHECK - Getting comprehensive session status`
      );

      const authState = await this.authStateModel.findOne({ userId });
      let sessionInfo = this.activeSessions.get(userId);

      // Log session info for debugging
      if (sessionInfo) {
        this.logger.debug(
          `[${userId}] Session info: connected=${sessionInfo.isConnected}, initial=${sessionInfo.isInitialConnection}`
        );
      }

      // Check if no auth state exists
      if (!authState) {
        return {
          exists: false,
          connected: false,
          connectionStatus: "not_found",
          message: "No authentication state found for this user",
          canActivate: false,
          statusType: "no_auth",
          activationCapability: "requires_qr_scan",
        };
      }

      // INTELLIGENT STATUS LOGIC - Check if session can be activated like sendMessage does
      this.logger.log(
        `[${userId}] 🧠 Performing intelligent status assessment`
      );

      // Check if we can activate this session (same logic as sendMessage)
      const canActivate = await this.hasValidAuthState(userId);

      // Validate actual socket connection status
      const actualConnectionStatus = await this.validateSocketConnection(
        userId,
        sessionInfo
      );

      // Only update if there's a clear disconnection (not during authentication process)
      if (
        sessionInfo &&
        actualConnectionStatus.connectionStatus === "validation_error"
      ) {
        this.logger.warn(`[${userId}] Session validation error detected`);
        sessionInfo.isConnected = false;

        await this.authStateModel.findOneAndUpdate(
          { userId },
          {
            connectionStatus: "disconnected",
            lastUpdated: new Date(),
            lastDisconnectReason: "Validation error",
          }
        );
      }

      // ENHANCED STATUS DETERMINATION with intelligent activation capability
      let finalConnected = actualConnectionStatus.isConnected;
      let finalConnectionStatus = actualConnectionStatus.connectionStatus;
      let statusType = "basic_check";
      let activationCapability = "unknown";
      let canSendMessages = false;
      let statusMessage = "";

      if (actualConnectionStatus.isConnected) {
        // Currently connected and validated
        finalConnected = true;
        finalConnectionStatus = "connected";
        statusType = "currently_connected";
        activationCapability = "already_connected";
        canSendMessages = true;
        statusMessage = "Session is active and ready for messaging";
        this.logger.log(
          `[${userId}] ✅ Status: Currently connected and validated`
        );
      } else if (
        sessionInfo?.isInitialConnection === false &&
        sessionInfo.isConnected
      ) {
        // Stable session marked as connected by connection event
        finalConnected = true;
        finalConnectionStatus = "connected";
        statusType = "stable_connected";
        activationCapability = "already_connected";
        canSendMessages = true;
        statusMessage = "Session is stable and connected";
        this.logger.debug(
          `[${userId}] ✅ Using stable session state: connected`
        );
      } else if (sessionInfo?.isInitialConnection && sessionInfo.isConnected) {
        // Initial connection marked as connected
        finalConnected = true;
        finalConnectionStatus = "connected";
        statusType = "initial_connected";
        activationCapability = "already_connected";
        canSendMessages = true;
        statusMessage = "Session is newly connected and ready";
        this.logger.debug(
          `[${userId}] ✅ Using initial connection state: connected`
        );
      } else if (canActivate) {
        // Not currently connected but can be auto-activated (like sendMessage does)
        finalConnected = false; // Honest about current state
        finalConnectionStatus = "can_auto_activate";
        statusType = "activatable";
        activationCapability = "can_auto_activate";
        canSendMessages = true; // Can send because it will auto-activate
        statusMessage =
          "Session is disconnected but will auto-activate when sending messages (same as sendMessage behavior)";
        this.logger.log(
          `[${userId}] 🔄 Status: Disconnected but can auto-activate (matches sendMessage capability)`
        );
      } else {
        // Cannot be activated - needs QR scan
        finalConnected = false;
        finalConnectionStatus = authState.connectionStatus || "disconnected";
        statusType = "needs_qr";
        activationCapability = "requires_qr_scan";
        canSendMessages = false;
        statusMessage = "Session requires QR code scan to activate";
        this.logger.log(
          `[${userId}] ❌ Status: Disconnected and requires QR scan`
        );
      }

      return {
        // Basic status information
        exists: !!authState,
        connected: finalConnected,
        connectionStatus: finalConnectionStatus,
        lastUpdated: authState?.lastUpdated,
        user: authState?.user || sessionInfo?.socket?.user || null,

        // Enhanced intelligent status information
        statusType: statusType,
        activationCapability: activationCapability,
        canSendMessages: canSendMessages,
        message: statusMessage,

        // Session state information
        isSessionActive: !!sessionInfo,
        isReconnecting: sessionInfo?.isReconnecting || false,
        reconnectionAttempts: this.reconnectionAttempts.get(userId) || 0,
        socketState: actualConnectionStatus.socketState,
        lastValidated: new Date(),

        // Debug information
        inMemoryConnected: sessionInfo?.isConnected,
        isInitialConnection: sessionInfo?.isInitialConnection,
        validationResult: actualConnectionStatus.isConnected,
        canActivate: canActivate,
      };
    } catch (error) {
      this.logger.error(
        `Error getting session status for user ${userId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Active session status check - behaves EXACTLY like sendMessage by actually trying to activate the session
   * This gives you the real connection status that matches sendMessage capability
   */
  async getActiveSessionStatus(userId: string): Promise<any> {
    try {
      this.logger.log(
        `[${userId}] 🔍 ACTIVE STATUS CHECK - Testing real connection capability (EXACTLY like sendMessage)`
      );

      // Check if session is marked as conflicted (same as sendMessage)
      const conflictCount = this.conflictAttempts.get(userId) || 0;
      if (conflictCount >= 999) {
        return {
          exists: true,
          connected: false,
          connectionStatus: "conflicted",
          canSendMessages: false,
          activeCheck: true,
          activationAttempted: false,
          realConnectionStatus: "conflicted",
          message:
            "Session is in conflict state. User must logout from other devices first.",
        };
      }

      // First get the basic status
      const basicStatus = await this.getSessionStatus(userId);

      // If can't activate, return early (no auth state)
      if (!basicStatus.canActivate && !basicStatus.exists) {
        this.logger.log(`[${userId}] ❌ Cannot activate - requires QR scan`);
        return {
          ...basicStatus,
          activeCheck: true,
          activationAttempted: false,
          realConnectionStatus: "requires_qr",
          message: "Session requires QR code scan to activate",
        };
      }

      // Try to activate the session (EXACT same logic as sendMessage with retry)
      const maxRetries = 2;
      let lastError: any;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          this.logger.log(
            `[${userId}] 🔄 Attempting session activation for status check (attempt ${attempt}/${maxRetries})`
          );

          // Enhanced intelligent session activation and recovery (same as sendMessage)
          const forceReactivation = attempt > 1; // Force reactivation on retry attempts
          const activationResult = await this.intelligentSessionActivation(
            userId,
            forceReactivation
          );

          if (!activationResult.success) {
            throw new Error(
              `Session activation failed: ${activationResult.error}`
            );
          }

          const sessionInfo = this.activeSessions.get(userId);
          if (!sessionInfo?.socket) {
            throw new Error(
              "WhatsApp session could not be established after activation"
            );
          }

          // Enhanced session readiness verification (same as sendMessage)
          const readinessCheck = await this.verifySessionReadiness(userId);
          if (!readinessCheck.ready) {
            if (attempt < maxRetries) {
              this.logger.warn(
                `[${userId}] ⚠️ Session not ready (${readinessCheck.reason}) - will retry with force activation`
              );
              continue;
            }
            throw new Error(
              `Session not ready for messaging: ${readinessCheck.reason}`
            );
          }

          this.logger.log(
            `[${userId}] ✅ Session activated and ready (attempt ${attempt})`
          );

          // Get updated status after successful activation
          const updatedStatus = await this.getSessionStatus(userId);

          return {
            ...updatedStatus,
            connected: true,
            canSendMessages: true,
            activeCheck: true,
            activationAttempted: true,
            activationSuccessful: true,
            attemptsUsed: attempt,
            realConnectionStatus: "activated_and_ready",
            message: `Session was successfully activated and is ready for messaging (${attempt} attempt${attempt > 1 ? "s" : ""})`,
          };
        } catch (error) {
          lastError = error;
          this.logger.warn(
            `[${userId}] ⚠️ Status check activation attempt ${attempt} failed:`,
            error.message
          );

          if (attempt === maxRetries) {
            break;
          }
        }
      }

      // If all attempts failed, return failure status
      this.logger.error(
        `[${userId}] ❌ All activation attempts failed for status check`
      );
      return {
        ...basicStatus,
        connected: false,
        canSendMessages: false,
        activeCheck: true,
        activationAttempted: true,
        activationSuccessful: false,
        attemptsUsed: maxRetries,
        realConnectionStatus: "activation_failed",
        message: `Session activation failed after ${maxRetries} attempts: ${lastError?.message || "Unknown error"}`,
        lastError: lastError?.message,
      };
    } catch (error) {
      this.logger.error(
        `Error in active session status check for user ${userId}:`,
        error
      );
      return {
        exists: false,
        connected: false,
        connectionStatus: "error",
        canSendMessages: false,
        activeCheck: true,
        activationAttempted: false,
        realConnectionStatus: "check_error",
        message: `Status check failed: ${error.message}`,
        error: error.message,
      };
    }
  }

  /**
   * Get the EXACT status that sendMessage would encounter
   * This is the most accurate status check - it tells you if sendMessage would succeed
   */
  async getSendMessageCapabilityStatus(userId: string): Promise<any> {
    try {
      this.logger.log(
        `[${userId}] 📤 SEND MESSAGE CAPABILITY CHECK - Testing exact sendMessage behavior`
      );

      // Use the active status check which now matches sendMessage exactly
      const activeStatus = await this.getActiveSessionStatus(userId);

      return {
        ...activeStatus,
        checkType: "send_message_capability",
        canSendMessagesNow: activeStatus.canSendMessages,
        wouldSendMessageSucceed:
          activeStatus.connected && activeStatus.canSendMessages,
        statusExplanation: activeStatus.connected
          ? "sendMessage would succeed immediately"
          : activeStatus.realConnectionStatus === "requires_qr"
            ? "sendMessage would fail - QR scan required"
            : activeStatus.realConnectionStatus === "conflicted"
              ? "sendMessage would fail - session conflicted"
              : "sendMessage would fail - activation failed",
      };
    } catch (error) {
      this.logger.error(
        `Error checking sendMessage capability for user ${userId}:`,
        error
      );
      return {
        canSendMessagesNow: false,
        wouldSendMessageSucceed: false,
        checkType: "send_message_capability",
        error: error.message,
        statusExplanation: "sendMessage would fail - status check error",
      };
    }
  }

  async sendMessage(
    userId: string,
    to: string,
    message?: string,
    documentUrl?: string
  ): Promise<any> {
    const maxRetries = 2;
    let lastError: any;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.logger.log(
          `[${userId}] 📤 ENHANCED INTELLIGENT SEND MESSAGE - Attempt ${attempt}/${maxRetries} - Target: ${to}`
        );

        // Check if session is marked as conflicted
        const conflictCount = this.conflictAttempts.get(userId) || 0;
        if (conflictCount >= 999) {
          throw new Error(
            "Session is in conflict state. User must logout from other devices first before sending messages."
          );
        }

        // Enhanced intelligent session activation and recovery
        const forceReactivation = attempt > 1; // Force reactivation on retry attempts
        const activationResult = await this.intelligentSessionActivation(
          userId,
          forceReactivation
        );
        if (!activationResult.success) {
          throw new Error(
            `Session activation failed: ${activationResult.error}`
          );
        }

        const sessionInfo = this.activeSessions.get(userId);
        if (!sessionInfo?.socket) {
          throw new Error(
            "WhatsApp session could not be established after activation"
          );
        }

        // Enhanced session readiness verification
        const readinessCheck = await this.verifySessionReadiness(userId);
        if (!readinessCheck.ready) {
          if (attempt < maxRetries) {
            this.logger.warn(
              `[${userId}] ⚠️ Session not ready (${readinessCheck.reason}) - will retry with force activation`
            );
            continue;
          }
          throw new Error(
            `Session not ready for messaging: ${readinessCheck.reason}`
          );
        }

        this.logger.log(
          `[${userId}] ✅ Session verified ready - proceeding with message send (attempt ${attempt})`
        );
        this.updateSessionUsage(userId);

        // Attempt to send the message
        const sendResult = await this.performMessageSend(
          userId,
          to,
          message,
          documentUrl,
          sessionInfo
        );

        if (sendResult.success) {
          this.logger.log(
            `[${userId}] ✅ Message sent successfully on attempt ${attempt}`
          );
          return {
            ...sendResult.data,
            retried: attempt > 1,
            attempts: attempt,
          };
        } else {
          throw new Error(sendResult.error);
        }
      } catch (error) {
        lastError = error;
        this.logger.error(
          `[${userId}] ❌ Send attempt ${attempt} failed:`,
          error
        );

        if (attempt < maxRetries) {
          // Wait before retry with exponential backoff
          const delay = Math.pow(2, attempt - 1) * 1000;
          this.logger.log(
            `[${userId}] 🔄 Waiting ${delay}ms before retry attempt ${attempt + 1}`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // All attempts failed
    this.logger.error(
      `[${userId}] ❌ All ${maxRetries} send attempts failed. Last error:`,
      lastError
    );
    throw new Error(
      `Failed to send message after ${maxRetries} attempts: ${lastError.message}`
    );
  }

  /**
   * Perform the actual message sending with proper error handling
   */
  private async performMessageSend(
    userId: string,
    to: string,
    message?: string,
    documentUrl?: string,
    sessionInfo?: any
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
      if (!sessionInfo) {
        sessionInfo = this.activeSessions.get(userId);
      }

      if (!sessionInfo?.socket) {
        return { success: false, error: "No active socket available" };
      }

      // Format phone number
      let jid = to;
      if (!to.includes("@")) {
        jid = `${to}@s.whatsapp.net`;
      }

      let result: any;

      if (documentUrl) {
        const response = await fetch(documentUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch document: ${response.statusText}`);
        }

        const buffer = await response.arrayBuffer();
        const mimeType =
          response.headers.get("content-type") || "application/octet-stream";

        if (mimeType.startsWith("image/")) {
          result = await sessionInfo.socket.sendMessage(jid, {
            image: Buffer.from(buffer),
            caption: message || "",
          });
        } else if (mimeType.startsWith("audio/")) {
          result = await sessionInfo.socket.sendMessage(jid, {
            audio: Buffer.from(buffer),
            mimetype: mimeType,
          });
        } else if (mimeType.startsWith("video/")) {
          result = await sessionInfo.socket.sendMessage(jid, {
            video: Buffer.from(buffer),
            caption: message || "",
          });
        } else {
          result = await sessionInfo.socket.sendMessage(jid, {
            document: Buffer.from(buffer),
            mimetype: mimeType,
            fileName: documentUrl.split("/").pop() || "document",
            caption: message || "",
          });
        }
      } else if (message) {
        result = await sessionInfo.socket.sendMessage(jid, { text: message });
      } else {
        return {
          success: false,
          error: "Either message or document URL is required",
        };
      }

      this.logger.log(`[${userId}] Message sent successfully to ${jid}`);
      return {
        success: true,
        data: {
          messageId: result.key.id,
          timestamp: result.messageTimestamp,
          to: jid,
        },
      };
    } catch (sendError) {
      this.logger.error(`[${userId}] ❌ Message send failed:`, sendError);
      return { success: false, error: sendError.message };
    }
  }

  /**
   * Check for recent decryption errors that indicate session corruption
   */
  private hasRecentDecryptionErrors(userId: string): boolean {
    // This would ideally track decryption errors, but for now we'll use a simple heuristic
    // In a production system, you'd want to track these errors in a Map with timestamps
    const sessionInfo = this.activeSessions.get(userId);
    if (!sessionInfo?.socket) return false;

    // Check if socket has user info but connection issues (indicates potential corruption)
    return !!(sessionInfo.socket.user && !sessionInfo.isConnected);
  }

  /**
   * Perform enhanced activation with multiple retry strategies
   */
  private async performEnhancedActivation(
    userId: string
  ): Promise<{ success: boolean; error?: string }> {
    const maxRetries = 3;
    let lastError: string = "";

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.logger.log(
          `[${userId}] 🔄 Enhanced activation attempt ${attempt}/${maxRetries}`
        );

        // Clear any existing session completely
        await this.clearSession(userId);

        // Wait a moment for cleanup
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Activate session
        await this.activateSession(userId);

        // Enhanced connection verification with longer timeout
        const verificationResult = await this.waitForConnectionEstablishment(
          userId,
          30000
        );

        if (verificationResult.success) {
          this.logger.log(
            `[${userId}] ✅ Enhanced activation successful on attempt ${attempt}`
          );
          return { success: true };
        } else {
          lastError = verificationResult.error || "Connection not established";
          this.logger.warn(
            `[${userId}] ⚠️ Attempt ${attempt} failed: ${lastError}`
          );

          if (attempt < maxRetries) {
            // Exponential backoff
            const delay = Math.pow(2, attempt) * 1000;
            this.logger.log(`[${userId}] Waiting ${delay}ms before retry...`);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      } catch (error) {
        lastError = error.message;
        this.logger.error(
          `[${userId}] ❌ Enhanced activation attempt ${attempt} failed:`,
          error
        );

        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    return {
      success: false,
      error: `All activation attempts failed. Last error: ${lastError}`,
    };
  }

  /**
   * Wait for connection establishment with comprehensive checks
   */
  private async waitForConnectionEstablishment(
    userId: string,
    timeoutMs: number = 30000
  ): Promise<{ success: boolean; error?: string }> {
    const startTime = Date.now();
    const checkInterval = 1000; // Check every second

    while (Date.now() - startTime < timeoutMs) {
      const sessionInfo = this.activeSessions.get(userId);

      if (!sessionInfo) {
        return { success: false, error: "Session info not found" };
      }

      // Comprehensive connection check
      const isFullyConnected =
        sessionInfo.isConnected &&
        sessionInfo.socket &&
        sessionInfo.socket.user &&
        sessionInfo.socket.ws &&
        sessionInfo.connectionState === SessionConnectionState.CONNECTED;

      if (isFullyConnected) {
        this.logger.log(`[${userId}] ✅ Connection fully established`);
        return { success: true };
      }

      // Log current state for debugging
      this.logger.debug(`[${userId}] Connection check:`, {
        isConnected: sessionInfo.isConnected,
        hasSocket: !!sessionInfo.socket,
        hasUser: !!sessionInfo.socket?.user,
        hasWebSocket: !!sessionInfo.socket?.ws,
        connectionState: sessionInfo.connectionState,
        elapsed: Date.now() - startTime,
      });

      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    return {
      success: false,
      error: `Connection establishment timeout after ${timeoutMs}ms`,
    };
  }

  /**
   * Enhanced intelligent session activation with comprehensive state detection and recovery
   */
  private async intelligentSessionActivation(
    userId: string,
    forceReactivation: boolean = false
  ): Promise<{ success: boolean; error?: string }> {
    try {
      this.logger.log(
        `[${userId}] 🧠 INTELLIGENT SESSION ACTIVATION - Force: ${forceReactivation}`
      );

      // Check if session is marked as conflicted
      const conflictCount = this.conflictAttempts.get(userId) || 0;
      if (conflictCount >= 999) {
        return {
          success: false,
          error:
            "Session is in conflict state. User must logout from other devices first.",
        };
      }

      // Get current session state
      let sessionInfo = this.activeSessions.get(userId);
      const persistencePolicy =
        this.sessionPersistencePolicy.get(userId) || "indefinite";

      this.logger.log(`[${userId}] 📊 Current session state:`, {
        hasSession: !!sessionInfo,
        isConnected: sessionInfo?.isConnected || false,
        isReconnecting: sessionInfo?.isReconnecting || false,
        persistencePolicy,
        forceReactivation,
        connectionState: sessionInfo?.connectionState,
        hasSocket: !!sessionInfo?.socket,
        hasWebSocket: !!sessionInfo?.socket?.ws,
        socketUser: sessionInfo?.socket?.user,
      });

      // Check if auth state exists in database
      const authState = await this.authStateModel.findOne({ userId });
      if (!authState) {
        return {
          success: false,
          error: "WhatsApp session not found. Please scan QR code first.",
        };
      }

      // Enhanced session validation - check for corruption indicators
      if (sessionInfo?.socket) {
        const hasDecryptionErrors = this.hasRecentDecryptionErrors(userId);
        if (hasDecryptionErrors) {
          this.logger.warn(
            `[${userId}] 🔍 Detected recent decryption errors - forcing session refresh`
          );
          forceReactivation = true;
        }
      }

      // Scenario 1: Force reactivation requested or corruption detected
      if (forceReactivation) {
        this.logger.log(
          `[${userId}] 🔄 Force reactivation requested - performing enhanced activation`
        );
        return await this.performEnhancedActivation(userId);
      }

      // Scenario 2: No active session at all - activate from stored credentials
      if (!sessionInfo) {
        this.logger.log(
          `[${userId}] 🔄 No active session - triggering activation (policy: ${persistencePolicy})`
        );
        return await this.performEnhancedActivation(userId);
      }

      // Scenario 3: Session exists but not connected - attempt enhanced reconnection
      if (
        sessionInfo &&
        !sessionInfo.isConnected &&
        !sessionInfo.isReconnecting &&
        !this.reconnectionInProgress.get(userId)
      ) {
        // Quick check: if socket has user, it might actually be connected
        if (sessionInfo.socket?.user && sessionInfo.socket?.ws) {
          this.logger.log(
            `[${userId}] 🔄 Session marked disconnected but socket has user and websocket - updating status`
          );
          sessionInfo.isConnected = true;
          sessionInfo.connectionState = SessionConnectionState.CONNECTED;
          return { success: true };
        }

        this.logger.log(
          `[${userId}] 🔄 Session disconnected - attempting enhanced reconnection for message delivery`
        );
        return await this.performEnhancedActivation(userId);
      }

      // Scenario 4: Session exists and appears connected - enhanced verification
      if (
        sessionInfo?.isConnected ||
        (sessionInfo?.socket?.user && sessionInfo?.socket?.ws)
      ) {
        this.logger.log(
          `[${userId}] ✅ Session appears connected - performing enhanced verification`
        );

        // Update connection status if socket has user but session not marked as connected
        if (
          !sessionInfo.isConnected &&
          sessionInfo.socket?.user &&
          sessionInfo.socket?.ws
        ) {
          this.logger.log(
            `[${userId}] 🔄 Updating session connection status - socket has user authentication and websocket`
          );
          sessionInfo.isConnected = true;
          sessionInfo.connectionState = SessionConnectionState.CONNECTED;
        }

        // Perform a quick health check
        try {
          const healthCheck = await this.verifySessionReadiness(userId);
          if (healthCheck.ready) {
            this.logger.log(`[${userId}] ✅ Session health check passed`);
            return { success: true };
          } else {
            this.logger.warn(
              `[${userId}] ⚠️ Session health check failed: ${healthCheck.reason} - triggering refresh`
            );
            return await this.performEnhancedActivation(userId);
          }
        } catch (healthError) {
          this.logger.warn(
            `[${userId}] ⚠️ Session health check error: ${healthError.message} - assuming connected`
          );
          return { success: true };
        }
      }

      // Scenario 5: Session exists but in unknown state - attempt recovery
      if (sessionInfo) {
        this.logger.log(
          `[${userId}] ❓ Session in unknown state - attempting enhanced recovery`
        );

        if (sessionInfo.socket) {
          // Try to use existing socket if it seems viable
          if (sessionInfo.socket.user || sessionInfo.socket.ws) {
            this.logger.log(
              `[${userId}] 🔄 Existing socket has some connectivity - attempting to use`
            );
            return { success: true };
          }
        }

        // Last resort: perform enhanced activation
        this.logger.log(
          `[${userId}] 🔄 Unknown state recovery - performing enhanced activation`
        );
        return await this.performEnhancedActivation(userId);
      }

      return {
        success: false,
        error: "Unable to establish session after all attempts",
      };
    } catch (error) {
      this.logger.error(
        `[${userId}] ❌ Intelligent session activation error:`,
        error
      );
      return { success: false, error: error.message };
    }
  }

  /**
   * Verify session readiness for message sending
   */
  private async verifySessionReadiness(
    userId: string
  ): Promise<{ ready: boolean; reason?: string }> {
    try {
      const sessionInfo = this.activeSessions.get(userId);

      if (!sessionInfo) {
        return { ready: false, reason: "No session info available" };
      }

      if (!sessionInfo.socket) {
        return { ready: false, reason: "No socket available" };
      }

      // Check if socket has user information (indicates successful authentication)
      if (!sessionInfo.socket.user) {
        return {
          ready: false,
          reason: "Socket not authenticated (no user info)",
        };
      }

      // Check if WebSocket exists (basic connectivity check)
      if (!sessionInfo.socket.ws) {
        return { ready: false, reason: "No WebSocket connection available" };
      }

      // Enhanced connection verification with multiple checks
      let isActuallyConnected = false;
      let connectionDetails = "";

      try {
        // Primary check: if session is marked as connected and has authenticated socket
        if (sessionInfo.isConnected && sessionInfo.socket.user) {
          isActuallyConnected = true;
          connectionDetails = "session_marked_connected_with_auth";
          this.logger.debug(
            `[${userId}] ✅ Session marked connected with authentication`
          );
        } else {
          // Secondary check: validate actual socket connection
          const actualConnectionStatus = await this.validateSocketConnection(
            userId,
            sessionInfo
          );

          if (actualConnectionStatus.isConnected) {
            sessionInfo.isConnected = true;
            isActuallyConnected = true;
            connectionDetails = `validated_${actualConnectionStatus.connectionStatus}`;
            this.logger.log(
              `[${userId}] 🔄 Updated session connection status to connected via validation`
            );
          } else {
            // Tertiary check: if socket has user info, consider it connected even if validation fails
            if (sessionInfo.socket.user) {
              this.logger.warn(
                `[${userId}] ⚠️ Validation failed but socket has user info - considering connected`
              );
              sessionInfo.isConnected = true;
              isActuallyConnected = true;
              connectionDetails = `fallback_user_authenticated`;
            } else {
              connectionDetails = `disconnected_${actualConnectionStatus.connectionStatus}`;
              return {
                ready: false,
                reason: `Session not ready (${connectionDetails})`,
              };
            }
          }
        }
      } catch (statusError) {
        this.logger.debug(
          `[${userId}] Connection status validation failed:`,
          statusError
        );
        // Final fallback: if socket has user, assume connected
        if (sessionInfo.socket.user) {
          this.logger.warn(
            `[${userId}] ⚠️ Validation error but socket has user - assuming connected`
          );
          isActuallyConnected = true;
          connectionDetails = "error_fallback_with_user";
        } else {
          return {
            ready: false,
            reason: "Unable to verify connection status and no user info",
          };
        }
      }

      if (!isActuallyConnected) {
        return {
          ready: false,
          reason: `Session not connected (${connectionDetails})`,
        };
      }

      this.logger.log(
        `[${userId}] ✅ Session readiness verified - ready for messaging (${connectionDetails})`
      );
      return { ready: true };
    } catch (error) {
      this.logger.error(
        `[${userId}] ❌ Session readiness check failed:`,
        error
      );
      return {
        ready: false,
        reason: `Readiness check failed: ${error.message}`,
      };
    }
  }

  async restoreExistingSessions(): Promise<void> {
    try {
      this.logger.log("Starting enhanced persistent session restoration...");
      this.logger.log(`Server Instance ID: ${this.SERVER_INSTANCE_ID}`);
      this.logger.log(
        `Server Start Time: ${this.SERVER_START_TIME.toISOString()}`
      );

      // First, mark all sessions that were CONNECTED as DISCONNECTED to prevent conflicts
      // This handles the case where server restart left sessions in CONNECTED state
      const connectedSessionsUpdate = await this.authStateModel.updateMany(
        {
          connectionStatus: SessionStatus.CONNECTED,
          persistencePolicy: {
            $in: [PersistencePolicy.PERSISTENT, PersistencePolicy.PERMANENT],
          },
        },
        {
          connectionStatus: SessionStatus.DISCONNECTED,
          lastUpdated: new Date(),
          lastDisconnected: new Date(),
          lastDisconnectReason:
            "Server restart - session marked for restoration",
          lastDisconnectType: "server_restart",
          wasGracefullyDisconnected: false,
          serverInstanceId: this.SERVER_INSTANCE_ID,
          lastServerStart: this.SERVER_START_TIME,
        }
      );

      if (connectedSessionsUpdate.modifiedCount > 0) {
        this.logger.log(
          `Marked ${connectedSessionsUpdate.modifiedCount} previously connected sessions as disconnected for safe restoration`
        );
      }

      // Use the new schema method to find sessions that should be restored
      const existingSessions = await (
        this.authStateModel as any
      ).findSessionsForRestore();

      this.logger.log(
        `Found ${existingSessions.length} persistent sessions to restore`
      );

      if (existingSessions.length === 0) {
        this.logger.log("No persistent sessions found to restore");
        return;
      }

      // Sort sessions by priority and last connected time
      existingSessions.sort((a: any, b: any) => {
        // Higher priority first
        if (a.priority !== b.priority) {
          return b.priority - a.priority;
        }
        // More recently connected first
        const aTime = a.lastConnected ? a.lastConnected.getTime() : 0;
        const bTime = b.lastConnected ? b.lastConnected.getTime() : 0;
        return bTime - aTime;
      });

      const restorationResults = {
        total: existingSessions.length,
        successful: 0,
        failed: 0,
        skipped: 0,
      };

      // Restore sessions with enhanced error handling and retry logic
      for (let i = 0; i < existingSessions.length; i++) {
        const session = existingSessions[i];
        const maxRetries = 3;
        let retryCount = 0;
        let restored = false;

        this.logger.log(
          `Restoring session ${i + 1}/${existingSessions.length}: ${session.userId} (Policy: ${session.persistencePolicy}, Priority: ${session.priority})`
        );

        while (retryCount < maxRetries && !restored) {
          try {
            // Add progressive delay between session restorations
            const baseDelay = 2000; // 2 seconds base delay
            const progressiveDelay = i * 1000; // Additional 1 second per session
            const retryDelay = retryCount * 2000; // Additional 2 seconds per retry
            const totalDelay = baseDelay + progressiveDelay + retryDelay;

            if (i > 0 || retryCount > 0) {
              this.logger.log(
                `Waiting ${totalDelay}ms before restoration attempt ${retryCount + 1}...`
              );
              await new Promise((resolve) => setTimeout(resolve, totalDelay));
            }

            // Check if session is already active (might have been restored by another process)
            if (this.activeSessions.has(session.userId)) {
              this.logger.log(
                `Session ${session.userId} already active, skipping restoration`
              );
              restorationResults.skipped++;
              restored = true;
              break;
            }

            // Attempt to restore the session
            await this.activateExistingSession(session.userId);

            // Update session metadata on successful restoration
            await this.authStateModel.findOneAndUpdate(
              { userId: session.userId },
              {
                lastUpdated: new Date(),
                lastActivity: new Date(),
                reconnectionAttempts: 0,
                errorCount: 0,
                lastError: null,
                lastErrorTime: null,
                circuitBreakerState: "closed",
              }
            );

            this.logger.log(
              `Successfully restored session for ${session.userId}`
            );
            restorationResults.successful++;
            restored = true;
          } catch (error) {
            retryCount++;
            this.logger.warn(
              `Restoration attempt ${retryCount}/${maxRetries} failed for ${session.userId}:`,
              error.message
            );

            if (retryCount >= maxRetries) {
              this.logger.error(
                `Failed to restore session for ${session.userId} after ${maxRetries} attempts`
              );

              // Update failure count and status
              await this.authStateModel.findOneAndUpdate(
                { userId: session.userId },
                {
                  connectionStatus: SessionStatus.DISCONNECTED,
                  lastUpdated: new Date(),
                  lastActivity: new Date(),
                  lastDisconnected: new Date(),
                  lastDisconnectReason: `Restoration failed: ${error.message}`,
                  $inc: { reconnectionAttempts: 1, errorCount: 1 },
                  lastError: error.message,
                  lastErrorTime: new Date(),
                }
              );

              restorationResults.failed++;
            }
          }
        }

        // Log progress every 10 sessions
        if ((i + 1) % 10 === 0) {
          this.logger.log(
            `Restoration progress: ${i + 1}/${existingSessions.length} processed (${restorationResults.successful} successful, ${restorationResults.failed} failed, ${restorationResults.skipped} skipped)`
          );
        }
      }

      this.logger.log(`Persistent session restoration completed:`, {
        total: restorationResults.total,
        successful: restorationResults.successful,
        failed: restorationResults.failed,
        skipped: restorationResults.skipped,
        activeSessions: this.activeSessions.size,
      });

      // Schedule retry for failed sessions after a delay
      if (restorationResults.failed > 0) {
        this.logger.log(
          `Scheduling retry for ${restorationResults.failed} failed sessions in 5 minutes...`
        );
        setTimeout(
          () => {
            this.retryFailedSessionRestorations().catch((err) =>
              this.logger.error(
                "Error in retry failed session restorations:",
                err
              )
            );
          },
          5 * 60 * 1000
        ); // 5 minutes
      }
    } catch (error) {
      this.logger.error(
        "Critical error in persistent session restoration:",
        error
      );
    }
  }

  /**
   * Retry failed session restorations
   */
  private async retryFailedSessionRestorations(): Promise<void> {
    try {
      this.logger.log("Retrying failed session restorations...");

      // Find sessions that failed to restore (disconnected with recent errors)
      const failedSessions = await this.authStateModel.find({
        connectionStatus: SessionStatus.DISCONNECTED,
        persistencePolicy: {
          $in: [PersistencePolicy.PERSISTENT, PersistencePolicy.PERMANENT],
        },
        autoReconnect: true,
        isManuallyDisabled: { $ne: true },
        lastErrorTime: { $gte: new Date(Date.now() - 30 * 60 * 1000) }, // Errors in last 30 minutes
        errorCount: { $lt: 10 }, // Don't retry sessions with too many errors
      });

      this.logger.log(
        `Found ${failedSessions.length} failed sessions to retry`
      );

      for (const session of failedSessions) {
        try {
          // Skip if session is already active
          if (this.activeSessions.has(session.userId)) {
            continue;
          }

          this.logger.log(`Retrying restoration for ${session.userId}...`);

          await this.activateExistingSession(session.userId);

          this.logger.log(`Successfully restored ${session.userId} on retry`);

          // Add delay between retries
          await new Promise((resolve) => setTimeout(resolve, 5000));
        } catch (error) {
          this.logger.warn(
            `Retry failed for ${session.userId}:`,
            error.message
          );

          // Increment error count
          await this.authStateModel.findOneAndUpdate(
            { userId: session.userId },
            {
              $inc: { errorCount: 1 },
              lastError: error.message,
              lastErrorTime: new Date(),
            }
          );
        }
      }

      this.logger.log("Failed session restoration retry completed");
    } catch (error) {
      this.logger.error("Error in retry failed session restorations:", error);
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
        browser: [this.DEVICE_NAME, this.BROWSER_NAME, this.BROWSER_VERSION],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        defaultQueryTimeoutMs: 30000,
        connectTimeoutMs: 30000,
        keepAliveIntervalMs: 10000,
        retryRequestDelayMs: 1000,
        maxMsgRetryCount: 3,
        emitOwnEvents: false,
        getMessage: async (_key) => {
          return { conversation: "" };
        },
      });

      const sessionInfo: SessionInfo = {
        socket,
        lastUsed: new Date(),
        isConnected: false,
        isInitialConnection: false,
      };

      this.activeSessions.set(userId, sessionInfo);

      socket.ev.on("creds.update", saveCreds);
      socket.ev.on("connection.update", async (update) => {
        try {
          const { connection, lastDisconnect } = update;

          if (connection === "open") {
            this.logger.log(`Existing session restored for user: ${userId}`);
            sessionInfo.isConnected = true;
            sessionInfo.isReconnecting = false;
            this.reconnectionAttempts.delete(userId);

            // Send webhook notification for existing session restoration
            await this.sendWebhook(userId, "connected", true, socket.user);

            await this.authStateModel.findOneAndUpdate(
              { userId },
              {
                connectionStatus: "connected",
                lastUpdated: new Date(),
                lastConnected: new Date(),
                user: socket.user,
                phoneNumber: socket.user?.id || null,
                deviceName: socket.user?.name || "WhatsApp Web",
                reconnectionAttempts: 0,
                isPersistent: true,
                autoReconnect: true,
              },
              { upsert: true }
            );

            // Send webhook notification
            this.sendWebhook(userId, "connected", true, socket.user);
          } else if (connection === "close") {
            sessionInfo.isConnected = false;
            const errorStatusCode = (lastDisconnect?.error as any)?.output
              ?.statusCode;
            const shouldReconnect =
              errorStatusCode !== DisconnectReason.loggedOut;
            const isConflict = errorStatusCode === 440; // Session conflict (logged in elsewhere)

            if (isConflict) {
              // Stream conflict during activation - handle smartly
              this.logger.warn(`[${userId}] Stream conflict during activation`);
              await this.handleSessionConflict(userId, sessionInfo);

              await this.clearSession(userId);
              this.logger.log(
                `[${userId}] Activation stopped due to stream conflict`
              );
              return;
            } else if (!shouldReconnect) {
              await this.authStateModel.deleteOne({ userId });
              this.clearSession(userId);
            } else {
              await this.authStateModel.findOneAndUpdate(
                { userId },
                { connectionStatus: "disconnected", lastUpdated: new Date() }
              );

              if (!sessionInfo.isReconnecting) {
                this.attemptReconnection(userId);
              }
            }
          }
        } catch (connectionError) {
          this.logger.error(
            `[${userId}] Error in existing session connection.update handler:`,
            connectionError
          );

          // Handle the error gracefully
          if (sessionInfo) {
            sessionInfo.isConnected = false;
            sessionInfo.isReconnecting = false;
          }

          // Update database to reflect error state
          try {
            await this.authStateModel.findOneAndUpdate(
              { userId },
              {
                connectionStatus: "disconnected",
                lastUpdated: new Date(),
                lastDisconnected: new Date(),
                lastDisconnectReason:
                  connectionError.message || "Existing session handler error",
              }
            );
          } catch (dbError) {
            this.logger.error(
              `[${userId}] Failed to update database after existing session error:`,
              dbError
            );
          }
        }
      });
    } catch (error) {
      this.logger.error(
        `Error activating existing session for user ${userId}:`,
        error
      );
      throw error;
    }
  }

  async activateSession(userId: string): Promise<void> {
    try {
      this.logger.log(
        `[${userId}] Activating session without QR using stored credentials...`
      );

      // Check if session is marked as conflicted
      const conflictCount = this.conflictAttempts.get(userId) || 0;
      if (conflictCount >= 999) {
        throw new Error(
          "Session is marked as conflicted. User must logout from other devices first."
        );
      }

      // Check if session is already active and stable
      if (this.isSessionStable(userId)) {
        this.logger.log(`[${userId}] Session already active and stable`);
        return;
      }

      // Verify we have valid auth state for QR-less activation
      const hasValidAuth = await this.hasValidAuthState(userId);
      if (!hasValidAuth) {
        throw new Error(
          "No valid authentication data found. QR code scan required for initial setup."
        );
      }

      // Check if activation is already in progress
      if (this.reconnectionInProgress.get(userId)) {
        this.logger.log(
          `[${userId}] Session activation already in progress, waiting...`
        );
        // Wait for completion with longer timeout
        let attempts = 0;
        while (this.reconnectionInProgress.get(userId) && attempts < 60) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          attempts++;
        }
        this.logger.log(
          `[${userId}] Finished waiting for activation (${attempts}s)`
        );
        return;
      }

      const authState = await this.authStateModel.findOne({ userId });
      if (!authState || !authState.credentials) {
        throw new Error("No authentication state found for user");
      }

      // Check if we already have a session - don't recreate unnecessarily
      const existingSession = this.activeSessions.get(userId);
      if (existingSession?.socket && !existingSession.isReconnecting) {
        this.logger.log(
          `[${userId}] Existing session found, marking as active instead of recreating`
        );
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

        // Wait a moment to check if connection was actually established
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Validate that the session is actually connected before marking as successful
        const sessionInfo = this.activeSessions.get(userId);
        const isActuallyConnected =
          sessionInfo?.isConnected &&
          sessionInfo?.connectionState === SessionConnectionState.CONNECTED &&
          sessionInfo?.socket;

        if (isActuallyConnected) {
          this.logger.log(
            `[${userId}] ✅ Session activated and connected successfully`
          );
          // Reset failure count on successful connection
          this.connectionFailureCount.delete(userId);
        } else {
          this.logger.warn(
            `[${userId}] ⚠️ Session activated but connection not established`
          );
          this.logger.warn(
            `[${userId}] Connection details: connected=${sessionInfo?.isConnected}, state=${sessionInfo?.connectionState}, socket=${!!sessionInfo?.socket}`
          );

          // Track this as a connection failure for exponential backoff
          const currentFailures = this.connectionFailureCount.get(userId) || 0;
          this.connectionFailureCount.set(userId, currentFailures + 1);

          this.logger.warn(
            `[${userId}] Connection failure count: ${currentFailures + 1} - will retry with exponential backoff`
          );

          throw new Error(
            `Session activated but connection not established (failures: ${currentFailures + 1})`
          );
        }
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
    return Array.from(this.activeSessions.values()).filter((s) => s.isConnected)
      .length;
  }

  async clearAllSessions(): Promise<void> {
    this.logger.log("Clearing all active sessions for recovery...");

    const userIds = Array.from(this.activeSessions.keys());
    for (const userId of userIds) {
      try {
        await this.clearSession(userId);
        this.logger.log(`[${userId}] Session cleared`);
      } catch (error) {
        this.logger.error(`[${userId}] Error clearing session:`, error);
      }
    }

    // Clear all tracking maps
    this.reconnectionAttempts.clear();
    this.conflictAttempts.clear();
    this.reconnectionInProgress.clear();
    this.qrCodes.clear();

    // Clear all QR timeouts
    for (const userId of userIds) {
      this.clearQRTimeout(userId);
    }

    this.logger.log(`Cleared ${userIds.length} sessions`);
  }

  getSessionStats(): any {
    const memoryMB = this.getMemoryUsageMB();
    const activeCount = this.activeSessions.size;
    const reconnectingCount = Array.from(this.activeSessions.values()).filter(
      (session) => session.isReconnecting
    ).length;
    const connectedCount = Array.from(this.activeSessions.values()).filter(
      (session) => session.isConnected
    ).length;

    return {
      activeSessions: activeCount,
      connectedSessions: connectedCount,
      reconnectingSessions: reconnectingCount,
      memoryUsageMB: memoryMB,
      maxMemoryMB: this.MAX_RAM_USAGE_MB,
      memoryUtilization: `${((memoryMB / this.MAX_RAM_USAGE_MB) * 100).toFixed(1)}%`,
      conflictedSessions: this.conflictAttempts.size,
      reconnectionsInProgress: this.reconnectionInProgress.size,
      shouldCleanup: this.shouldCleanupSessions(),
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
    if (sessionCount % 50 === 0 || memoryMB > this.MAX_RAM_USAGE_MB * 0.9) {
      this.logger.log(
        `Memory usage: ${memoryMB}MB / ${this.MAX_RAM_USAGE_MB}MB, Sessions: ${sessionCount}`
      );
    }

    // Only cleanup in emergency situations (>95% RAM usage)
    // This is much more conservative than before to preserve sessions
    return memoryMB > this.MAX_RAM_USAGE_MB * 0.95;
  }

  private isSessionStable(userId: string): boolean {
    const sessionInfo = this.activeSessions.get(userId);
    if (!sessionInfo) return false;

    // Session is stable if it's connected, not reconnecting, and not in progress
    return (
      sessionInfo.isConnected &&
      !sessionInfo.isReconnecting &&
      !this.reconnectionInProgress.get(userId)
    );
  }

  private markSessionAsStable(userId: string): void {
    const sessionInfo = this.activeSessions.get(userId);
    if (sessionInfo) {
      sessionInfo.isConnected = true;
      sessionInfo.isReconnecting = false;
      sessionInfo.isInitialConnection = false; // Clear initial connection flag
      sessionInfo.lastUsed = new Date();
      this.reconnectionInProgress.delete(userId);

      // Reset error tracking on successful connection
      this.resetSessionErrors(userId);

      this.logger.log(
        `[${userId}] Session marked as stable and fully connected`
      );
    }
  }

  /**
   * Validates the actual socket connection status by checking the socket state
   * and attempting a lightweight operation to verify connectivity
   */
  private async validateSocketConnection(
    userId: string,
    sessionInfo?: SessionInfo
  ): Promise<{
    isConnected: boolean;
    connectionStatus: string;
    socketState: string;
  }> {
    if (!sessionInfo?.socket) {
      return {
        isConnected: false,
        connectionStatus: "disconnected",
        socketState: "no_socket",
      };
    }

    try {
      // Check socket connection state
      const socket = sessionInfo.socket;

      // Check if socket has WebSocket connection
      const hasWebSocket = socket.ws && typeof socket.ws === "object";
      if (!hasWebSocket) {
        return {
          isConnected: false,
          connectionStatus: "disconnected",
          socketState: "no_websocket",
        };
      }

      // Check WebSocket ready state (accessing the underlying WebSocket)
      const wsReadyState = (socket.ws as any)?.readyState;

      // WebSocket ready states: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
      if (wsReadyState !== 1) {
        return {
          isConnected: false,
          connectionStatus: wsReadyState === 0 ? "connecting" : "disconnected",
          socketState: this.getSocketStateString(wsReadyState),
        };
      }

      // If the session info says it's connected, and the socket is open, trust it
      // This is more reliable than checking user data which might not be immediately available
      if (sessionInfo.isConnected && wsReadyState === 1) {
        this.logger.debug(
          `[${userId}] Socket is open and session marked as connected - trusting session state`
        );
        return {
          isConnected: true,
          connectionStatus: "connected",
          socketState: socket.user
            ? "open_and_authenticated"
            : "open_authenticating",
        };
      }

      // If socket is open but session not marked as connected, check authentication
      if (wsReadyState === 1) {
        if (socket.user) {
          // Socket is open and authenticated
          return {
            isConnected: true,
            connectionStatus: "connected",
            socketState: "open_and_authenticated",
          };
        } else {
          // Socket is open but not yet authenticated (might be in process)
          return {
            isConnected: false,
            connectionStatus: "authenticating",
            socketState: "open_authenticating",
          };
        }
      }

      // Socket is not open
      return {
        isConnected: false,
        connectionStatus: "disconnected",
        socketState: this.getSocketStateString(wsReadyState),
      };
    } catch (error) {
      this.logger.error(
        `[${userId}] Error validating socket connection:`,
        error
      );
      return {
        isConnected: false,
        connectionStatus: "validation_error",
        socketState: "error",
      };
    }
  }

  private getSocketStateString(state: number | undefined): string {
    switch (state) {
      case 0:
        return "connecting";
      case 1:
        return "open";
      case 2:
        return "closing";
      case 3:
        return "closed";
      default:
        return "unknown";
    }
  }

  /**
   * Enhanced error handling with circuit breaker pattern
   */
  private handleSessionError(
    userId: string,
    error: Error,
    context: string
  ): void {
    const sessionInfo = this.activeSessions.get(userId);
    if (!sessionInfo) return;

    // Update error tracking
    sessionInfo.lastError = error.message;
    sessionInfo.errorCount = (sessionInfo.errorCount || 0) + 1;

    this.logger.error(
      `[${userId}] Error in ${context}: ${error.message} (Error count: ${sessionInfo.errorCount})`
    );

    // Check if circuit breaker should be triggered
    if (sessionInfo.errorCount >= this.CIRCUIT_BREAKER_THRESHOLD) {
      this.triggerCircuitBreaker(userId, sessionInfo);
    }

    // Update database with error information
    this.authStateModel
      .findOneAndUpdate(
        { userId },
        {
          lastDisconnected: new Date(),
          lastDisconnectReason: `${context}: ${error.message}`,
          $inc: { reconnectionAttempts: 1 },
        }
      )
      .catch((dbError) => {
        this.logger.error(
          `[${userId}] Failed to update error in database:`,
          dbError
        );
      });
  }

  /**
   * Trigger circuit breaker for a session
   */
  private triggerCircuitBreaker(
    userId: string,
    sessionInfo: SessionInfo
  ): void {
    sessionInfo.circuitBreakerState = "open";
    sessionInfo.lastCircuitBreakerReset = new Date();

    this.logger.warn(
      `[${userId}] Circuit breaker triggered - too many errors (${sessionInfo.errorCount})`
    );

    // Stop all reconnection attempts
    sessionInfo.isReconnecting = false;
    this.reconnectionInProgress.delete(userId);

    // Schedule circuit breaker reset
    setTimeout(() => {
      this.resetCircuitBreaker(userId);
    }, this.CIRCUIT_BREAKER_TIMEOUT);
  }

  /**
   * Reset circuit breaker to half-open state
   */
  private resetCircuitBreaker(userId: string): void {
    const sessionInfo = this.activeSessions.get(userId);
    if (!sessionInfo) return;

    sessionInfo.circuitBreakerState = "half-open";
    sessionInfo.errorCount = 0;

    this.logger.log(`[${userId}] Circuit breaker reset to half-open state`);
  }

  /**
   * Check if session can attempt reconnection based on circuit breaker state
   */
  private canAttemptReconnection(userId: string): boolean {
    const sessionInfo = this.activeSessions.get(userId);
    if (!sessionInfo) return false;

    // Check circuit breaker state
    if (sessionInfo.circuitBreakerState === "open") {
      this.logger.log(
        `[${userId}] Reconnection blocked - circuit breaker is open`
      );
      return false;
    }

    // Check error count
    if ((sessionInfo.errorCount || 0) >= this.MAX_ERROR_COUNT) {
      this.logger.log(
        `[${userId}] Reconnection blocked - too many errors (${sessionInfo.errorCount})`
      );
      return false;
    }

    return true;
  }

  /**
   * Reset error count for a session (called on successful connection)
   */
  private resetSessionErrors(userId: string): void {
    const sessionInfo = this.activeSessions.get(userId);
    if (sessionInfo) {
      sessionInfo.errorCount = 0;
      sessionInfo.lastError = undefined;
      sessionInfo.circuitBreakerState = "closed";
      sessionInfo.lastCircuitBreakerReset = undefined;
    }
  }

  /**
   * Initialize connection tracking for indefinite session persistence
   */
  private initializeConnectionTracking(userId: string): void {
    // Set default persistence policy to indefinite (never close automatically)
    if (!this.sessionPersistencePolicy.has(userId)) {
      this.sessionPersistencePolicy.set(userId, "indefinite");
    }

    // Initialize connection attempt tracking
    const now = new Date();
    this.lastConnectionAttempt.set(userId, now);

    const currentFailures = this.connectionFailureCount.get(userId) || 0;
    const connectionAttempt: ConnectionAttemptInfo = {
      startTime: now,
      state: SessionConnectionState.CONNECTING,
      attempt: currentFailures + 1,
      lastError: undefined,
    };

    this.connectionAttempts.set(userId, connectionAttempt);

    this.logger.log(
      `[${userId}] Connection tracking initialized - Persistence: indefinite, Attempt: ${connectionAttempt.attempt}`
    );
  }

  /**
   * Map Baileys connection state to our internal state enum
   */
  private mapBaileysConnectionToState(
    connection: string
  ): SessionConnectionState {
    switch (connection) {
      case "open":
        return SessionConnectionState.CONNECTED;
      case "connecting":
        return SessionConnectionState.CONNECTING;
      case "close":
        return SessionConnectionState.DISCONNECTED;
      default:
        return SessionConnectionState.DISCONNECTED;
    }
  }

  /**
   * Set up connection timeout to prevent hanging connections
   */
  private setupConnectionTimeout(userId: string): NodeJS.Timeout {
    const CONNECTION_TIMEOUT = 30000; // 30 seconds timeout

    const timeoutId = setTimeout(() => {
      const connectionAttempt = this.connectionAttempts.get(userId);
      const sessionInfo = this.activeSessions.get(userId);

      // Check if connection is still in connecting state after timeout
      if (
        connectionAttempt &&
        connectionAttempt.state === SessionConnectionState.CONNECTING &&
        sessionInfo &&
        !sessionInfo.isConnected
      ) {
        this.logger.warn(
          `[${userId}] ⏰ CONNECTION TIMEOUT - Connection attempt exceeded ${CONNECTION_TIMEOUT}ms`
        );

        // Update connection state to timeout
        connectionAttempt.state = SessionConnectionState.TIMEOUT;
        connectionAttempt.lastError = "Connection timeout";
        this.connectionAttempts.set(userId, connectionAttempt);

        // Update session info
        if (sessionInfo) {
          sessionInfo.connectionState = SessionConnectionState.TIMEOUT;
          sessionInfo.lastError = "Connection timeout";
        }

        // Track this as a connection failure
        const currentFailures = this.connectionFailureCount.get(userId) || 0;
        this.connectionFailureCount.set(userId, currentFailures + 1);

        this.logger.log(
          `[${userId}] Connection timeout recorded - Failure count: ${currentFailures + 1}`
        );

        // Clear the session to allow for fresh reconnection attempt
        this.clearSession(userId).catch((error) => {
          this.logger.error(
            `[${userId}] Error clearing session after timeout:`,
            error
          );
        });
      }
    }, CONNECTION_TIMEOUT);

    // Store timeout ID in connection attempt for later cleanup
    const connectionAttempt = this.connectionAttempts.get(userId);
    if (connectionAttempt) {
      connectionAttempt.timeoutId = timeoutId;
      this.connectionAttempts.set(userId, connectionAttempt);
    }

    return timeoutId;
  }

  /**
   * Set session persistence policy for a user
   */
  async setSessionPersistence(
    userId: string,
    policy: PersistencePolicy = PersistencePolicy.PERMANENT,
    autoReconnect: boolean = true
  ): Promise<void> {
    try {
      const updateData: any = {
        persistencePolicy: policy,
        isPersistent: policy !== PersistencePolicy.TEMPORARY,
        autoReconnect,
        lastUpdated: new Date(),
        lastActivity: new Date(),
      };

      // Set session expiration based on policy
      if (policy === PersistencePolicy.TEMPORARY) {
        updateData.sessionExpires = new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000
        ); // 30 days
      } else {
        updateData.sessionExpires = null; // Never expires
      }

      await this.authStateModel.findOneAndUpdate({ userId }, updateData, {
        upsert: false,
      });

      this.logger.log(
        `[${userId}] Session persistence policy set to ${policy}, auto-reconnect: ${autoReconnect}`
      );
    } catch (error) {
      this.logger.error(
        `[${userId}] Error setting session persistence:`,
        error
      );
      throw error;
    }
  }

  /**
   * Set all existing sessions to permanent persistence (for migration)
   */
  async migrateAllSessionsToPermanent(): Promise<void> {
    try {
      this.logger.log(
        "Migrating all existing sessions to permanent persistence..."
      );

      const result = await this.authStateModel.updateMany(
        {}, // Update all sessions
        {
          persistencePolicy: PersistencePolicy.PERMANENT,
          isPersistent: true,
          autoReconnect: true,
          sessionExpires: null, // Never expires
          lastUpdated: new Date(),
        }
      );

      this.logger.log(
        `Migrated ${result.modifiedCount} sessions to permanent persistence`
      );
    } catch (error) {
      this.logger.error(
        "Error migrating sessions to permanent persistence:",
        error
      );
      throw error;
    }
  }

  /**
   * Force validation of socket connection (for debugging)
   */
  async forceValidateConnection(userId: string): Promise<any> {
    const sessionInfo = this.activeSessions.get(userId);
    const result = await this.validateSocketConnection(userId, sessionInfo);

    this.logger.log(`[${userId}] Force validation result:`, {
      isConnected: result.isConnected,
      connectionStatus: result.connectionStatus,
      socketState: result.socketState,
      hasSocket: !!sessionInfo?.socket,
      isInitialConnection: sessionInfo?.isInitialConnection,
      inMemoryConnected: sessionInfo?.isConnected,
    });

    return result;
  }

  /**
   * Get detailed session information including persistence settings
   */
  async getDetailedSessionInfo(userId: string): Promise<any> {
    try {
      const authState = await this.authStateModel.findOne({ userId });
      const sessionInfo = this.activeSessions.get(userId);
      const actualConnectionStatus = await this.validateSocketConnection(
        userId,
        sessionInfo
      );

      return {
        userId,
        exists: !!authState,
        connected: actualConnectionStatus.isConnected,
        connectionStatus: actualConnectionStatus.connectionStatus,
        socketState: actualConnectionStatus.socketState,
        isSessionActive: !!sessionInfo,
        isReconnecting: sessionInfo?.isReconnecting || false,
        reconnectionAttempts: authState?.reconnectionAttempts || 0,
        isPersistent: authState?.isPersistent || false,
        autoReconnect: authState?.autoReconnect || false,
        lastConnected: authState?.lastConnected,
        lastDisconnected: authState?.lastDisconnected,
        lastDisconnectReason: authState?.lastDisconnectReason,
        phoneNumber: authState?.phoneNumber,
        deviceName: authState?.deviceName,
        user: authState?.user || sessionInfo?.socket?.user || null,
        lastUpdated: authState?.lastUpdated,
        createdAt: (authState as any)?.createdAt,
        updatedAt: (authState as any)?.updatedAt,
        sessionMetadata: authState?.sessionMetadata,
        errorCount: sessionInfo?.errorCount || 0,
        lastError: sessionInfo?.lastError,
        circuitBreakerState: sessionInfo?.circuitBreakerState || "closed",
      };
    } catch (error) {
      this.logger.error(
        `Error getting detailed session info for user ${userId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Get all users with their session information
   */
  async getAllUsers(
    options: {
      status?: "connected" | "disconnected" | "all";
      limit?: number;
      offset?: number;
      search?: string;
    } = {}
  ): Promise<any[]> {
    try {
      const { status = "all", limit = 50, offset = 0, search } = options;

      // Build query
      let query: any = {};

      if (status !== "all") {
        if (status === "connected") {
          query.connectionStatus = "connected";
        } else if (status === "disconnected") {
          query.connectionStatus = { $ne: "connected" };
        }
      }

      if (search) {
        query.$or = [
          { userId: { $regex: search, $options: "i" } },
          { phoneNumber: { $regex: search, $options: "i" } },
          { deviceName: { $regex: search, $options: "i" } },
        ];
      }

      // Get users from database
      const authStates = await this.authStateModel
        .find(query)
        .sort({ lastUpdated: -1 })
        .skip(offset)
        .limit(limit)
        .exec();

      // Enhance with real-time session information
      const users = await Promise.all(
        authStates.map(async (authState) => {
          const sessionInfo = this.activeSessions.get(authState.userId);
          const actualConnectionStatus = await this.validateSocketConnection(
            authState.userId,
            sessionInfo
          );

          return {
            userId: authState.userId,
            connected: actualConnectionStatus.isConnected,
            connectionStatus: actualConnectionStatus.connectionStatus,
            socketState: actualConnectionStatus.socketState,
            isSessionActive: !!sessionInfo,
            isReconnecting: sessionInfo?.isReconnecting || false,
            reconnectionAttempts: authState.reconnectionAttempts || 0,
            isPersistent: authState.isPersistent || false,
            autoReconnect: authState.autoReconnect || false,
            lastConnected: authState.lastConnected,
            lastDisconnected: authState.lastDisconnected,
            lastDisconnectReason: authState.lastDisconnectReason,
            phoneNumber: authState.phoneNumber,
            deviceName: authState.deviceName,
            user: authState.user || sessionInfo?.socket?.user || null,
            lastUpdated: authState.lastUpdated,
            createdAt: (authState as any)?.createdAt,
            updatedAt: (authState as any)?.updatedAt,
            errorCount: sessionInfo?.errorCount || 0,
            lastError: sessionInfo?.lastError,
            circuitBreakerState: sessionInfo?.circuitBreakerState || "closed",
          };
        })
      );

      return users;
    } catch (error) {
      this.logger.error("Error getting all users:", error);
      throw error;
    }
  }

  /**
   * Delete a user completely (session and auth data)
   */
  async deleteUser(userId: string): Promise<void> {
    try {
      this.logger.log(`[${userId}] Deleting user completely`);

      // Clear active session first
      await this.clearUserSession(userId);

      // Delete from database
      await this.authStateModel.deleteOne({ userId });

      // Clean up any remaining references
      this.reconnectionAttempts.delete(userId);
      this.conflictAttempts.delete(userId);
      this.reconnectionInProgress.delete(userId);
      this.qrCodes.delete(userId);
      this.clearQRTimeout(userId);

      this.logger.log(`[${userId}] User deleted successfully`);
    } catch (error) {
      this.logger.error(`[${userId}] Error deleting user:`, error);
      throw error;
    }
  }

  /**
   * Get all conflicted sessions
   */
  async getConflictedSessions(): Promise<any[]> {
    try {
      const conflictedSessions = [];

      for (const [userId, conflictCount] of this.conflictAttempts.entries()) {
        if (conflictCount > 0) {
          const authState = await this.authStateModel.findOne({ userId });
          const sessionInfo = this.activeSessions.get(userId);

          conflictedSessions.push({
            userId,
            conflictCount,
            connectionStatus: authState?.connectionStatus || "unknown",
            lastUpdated: authState?.lastUpdated,
            lastConnected: authState?.lastConnected,
            lastDisconnectReason: authState?.lastDisconnectReason,
            isActive: !!sessionInfo,
            isConnected: sessionInfo?.isConnected || false,
            phoneNumber: authState?.phoneNumber,
            deviceName: authState?.deviceName,
          });
        }
      }

      return conflictedSessions;
    } catch (error) {
      this.logger.error("Error getting conflicted sessions:", error);
      throw error;
    }
  }

  /**
   * Resolve session conflict by clearing conflict state and allowing reconnection
   * PRESERVES auth data - no re-authentication required
   */
  async resolveSessionConflict(userId: string): Promise<any> {
    try {
      this.logger.log(
        `[${userId}] Resolving session conflict while preserving auth data...`
      );

      // Clear conflict state but preserve auth data
      this.conflictAttempts.delete(userId);
      this.reconnectionAttempts.delete(userId);
      this.reconnectionInProgress.delete(userId);

      // Clear only the in-memory session, not the database auth data
      const sessionInfo = this.activeSessions.get(userId);
      if (sessionInfo) {
        try {
          if (sessionInfo.socket) {
            sessionInfo.socket.end(undefined);
          }
        } catch (error) {
          this.logger.warn(
            `[${userId}] Error closing socket during conflict resolution:`,
            error
          );
        }
      }
      this.activeSessions.delete(userId);
      this.qrCodes.delete(userId);
      this.clearQRTimeout(userId);

      // Update database status but PRESERVE credentials and keys
      await this.authStateModel.findOneAndUpdate(
        { userId },
        {
          connectionStatus: SessionStatus.DISCONNECTED,
          lastUpdated: new Date(),
          errorCount: 0,
          lastError: null,
          circuitBreakerState: "closed",
          // NOTE: NOT clearing credentials or keys - they remain for reconnection
        }
      );

      this.logger.log(
        `[${userId}] Session conflict resolved - auth data preserved, ready for reconnection`
      );

      return {
        userId,
        status: "resolved",
        message:
          "Session conflict cleared. Auth data preserved - no QR scan needed.",
        nextSteps: [
          "Make sure WhatsApp is logged out on all other devices",
          "Use the activate session endpoint to reconnect",
          "No QR code scanning required - existing auth will be used",
        ],
      };
    } catch (error) {
      this.logger.error(`[${userId}] Error resolving session conflict:`, error);
      throw error;
    }
  }

  /**
   * Force session takeover - OPTION 1: Preserve auth data (recommended)
   * OPTION 2: Complete reset (only if auth data is corrupted)
   */
  async forceSessionTakeover(
    userId: string,
    completeReset: boolean = false
  ): Promise<any> {
    try {
      this.logger.log(
        `[${userId}] Forcing session takeover (complete reset: ${completeReset})...`
      );

      // Clear all conflict and reconnection state
      this.conflictAttempts.delete(userId);
      this.reconnectionAttempts.delete(userId);
      this.reconnectionInProgress.delete(userId);

      // Clear existing session from memory
      await this.clearSession(userId);

      if (completeReset) {
        // OPTION 2: Complete reset - delete auth data (requires new QR)
        await this.authStateModel.deleteOne({ userId });
        this.logger.log(
          `[${userId}] Complete session reset - auth data deleted`
        );

        return {
          userId,
          status: "complete_reset",
          message: "Complete session reset. New QR scan required.",
          nextSteps: [
            "All session data has been completely removed",
            "Create a new session using the QR endpoint",
            "Scan the new QR code with your phone",
          ],
        };
      } else {
        // OPTION 1: Preserve auth data (recommended)
        await this.authStateModel.findOneAndUpdate(
          { userId },
          {
            connectionStatus: SessionStatus.DISCONNECTED,
            lastUpdated: new Date(),
            errorCount: 0,
            lastError: null,
            circuitBreakerState: "closed",
            // Keep credentials and keys for reconnection
          }
        );

        this.logger.log(
          `[${userId}] Session takeover completed - auth data preserved`
        );

        return {
          userId,
          status: "takeover_with_auth_preserved",
          message:
            "Session takeover completed. Auth data preserved - no QR scan needed.",
          nextSteps: [
            "Memory session cleared but auth data preserved",
            "Use activate session endpoint to reconnect",
            "No QR code scanning required",
          ],
        };
      }
    } catch (error) {
      this.logger.error(`[${userId}] Error forcing session takeover:`, error);
      throw error;
    }
  }

  /**
   * Smart conflict handling with progressive backoff
   */
  private async handleSessionConflict(
    userId: string,
    sessionInfo: SessionInfo
  ): Promise<void> {
    try {
      this.logger.warn(
        `[${userId}] Handling session conflict with smart resolution...`
      );

      // Mark session as disconnected
      sessionInfo.isConnected = false;
      sessionInfo.isReconnecting = false;
      this.reconnectionInProgress.delete(userId);

      // Get current conflict count and increment
      const currentConflictCount = this.conflictAttempts.get(userId) || 0;
      const newConflictCount = currentConflictCount + 1;
      this.conflictAttempts.set(userId, newConflictCount);

      // Update database with conflict information
      await this.authStateModel.findOneAndUpdate(
        { userId },
        {
          connectionStatus: SessionStatus.STREAM_CONFLICT,
          lastUpdated: new Date(),
          lastConflictTime: new Date(),
          conflictRetryCount: newConflictCount,
          lastDisconnectType: "conflict",
          serverInstanceId: this.SERVER_INSTANCE_ID,
          lastServerStart: this.SERVER_START_TIME,
          wasGracefullyDisconnected: false,
        }
      );

      // Progressive backoff strategy
      if (newConflictCount >= 5) {
        this.logger.warn(
          `[${userId}] Too many conflicts (${newConflictCount}), blocking for 1 hour`
        );
        // Don't permanently block, just wait longer
      } else if (newConflictCount >= 3) {
        this.logger.warn(
          `[${userId}] Multiple conflicts (${newConflictCount}), will retry after 30 minutes`
        );
      } else {
        this.logger.warn(
          `[${userId}] Conflict ${newConflictCount}, will retry after 5 minutes`
        );
      }

      // Clear the session to stop current activity
      await this.clearSession(userId);

      this.logger.log(
        `[${userId}] Session conflict handled - will allow retry after backoff period`
      );
    } catch (error) {
      this.logger.error(`[${userId}] Error handling session conflict:`, error);
    }
  }

  /**
   * Clear session conflict state only (without deleting session data)
   */
  async clearSessionConflict(userId: string): Promise<void> {
    try {
      this.logger.log(`[${userId}] Clearing session conflict state...`);

      // Clear conflict tracking
      this.conflictAttempts.delete(userId);
      this.reconnectionAttempts.delete(userId);
      this.reconnectionInProgress.delete(userId);

      // Update database status but keep session data
      await this.authStateModel.findOneAndUpdate(
        { userId },
        {
          connectionStatus: SessionStatus.DISCONNECTED,
          lastUpdated: new Date(),
          errorCount: 0,
          lastError: null,
          circuitBreakerState: "closed",
          conflictRetryCount: 0,
          lastConflictTime: null,
          wasGracefullyDisconnected: true,
          serverInstanceId: this.SERVER_INSTANCE_ID,
          lastServerStart: this.SERVER_START_TIME,
        }
      );

      this.logger.log(`[${userId}] Session conflict state cleared`);
    } catch (error) {
      this.logger.error(`[${userId}] Error clearing session conflict:`, error);
      throw error;
    }
  }

  /**
   * Check if user has valid auth state for reconnection without QR
   */
  async hasValidAuthState(userId: string): Promise<boolean> {
    try {
      const authState = await this.authStateModel.findOne({ userId });

      if (!authState || !authState.credentials) {
        return false;
      }

      // Check if credentials have required fields for WhatsApp connection
      const creds = authState.credentials;
      const hasRequiredFields = !!(
        creds.noiseKey &&
        creds.pairingEphemeralKeyPair &&
        creds.signedIdentityKey &&
        creds.signedPreKey &&
        creds.registrationId
      );

      this.logger.log(`[${userId}] Auth state validation:`, {
        hasCredentials: !!authState.credentials,
        hasRequiredFields,
        credentialKeys: creds ? Object.keys(creds) : [],
      });

      return hasRequiredFields;
    } catch (error) {
      this.logger.error(
        `[${userId}] Error checking auth state validity:`,
        error
      );
      return false;
    }
  }

  /**
   * Clear only conflicted sessions
   */
  async clearConflictedSessions(): Promise<void> {
    try {
      this.logger.log("Clearing conflicted sessions...");

      const conflictedUsers = Array.from(this.conflictAttempts.keys());
      let clearedCount = 0;

      for (const userId of conflictedUsers) {
        try {
          await this.clearUserSession(userId);
          this.conflictAttempts.delete(userId);
          this.reconnectionAttempts.delete(userId);
          this.reconnectionInProgress.delete(userId);
          this.logger.log(`[${userId}] Conflicted session cleared`);
          clearedCount++;
        } catch (error) {
          this.logger.error(
            `[${userId}] Error clearing conflicted session:`,
            error
          );
        }
      }

      this.logger.log(`Cleared ${clearedCount} conflicted sessions`);
    } catch (error) {
      this.logger.error("Error clearing conflicted sessions:", error);
      throw error;
    }
  }

  /**
   * Get comprehensive system statistics
   */
  async getSystemStats(): Promise<any> {
    try {
      // Get database statistics
      const totalUsers = await this.authStateModel.countDocuments();
      const connectedUsers = await this.authStateModel.countDocuments({
        connectionStatus: "connected",
      });
      const persistentUsers = await this.authStateModel.countDocuments({
        isPersistent: true,
      });
      const autoReconnectUsers = await this.authStateModel.countDocuments({
        autoReconnect: true,
      });

      // Get in-memory session statistics
      const activeSessionCount = this.activeSessions.size;
      const connectedSessionCount = Array.from(
        this.activeSessions.values()
      ).filter((session) => session.isConnected).length;
      const reconnectingSessionCount = Array.from(
        this.activeSessions.values()
      ).filter((session) => session.isReconnecting).length;

      // Get error statistics
      const sessionsWithErrors = Array.from(
        this.activeSessions.values()
      ).filter((session) => (session.errorCount || 0) > 0).length;
      const circuitBreakerOpenCount = Array.from(
        this.activeSessions.values()
      ).filter((session) => session.circuitBreakerState === "open").length;

      // Get memory usage
      const memoryUsage = this.getMemoryUsageMB();

      // Get recent activity
      const recentlyActive = await this.authStateModel
        .find({ lastUpdated: { $gte: new Date(Date.now() - 3600000) } }) // Last hour
        .countDocuments();

      return {
        database: {
          totalUsers,
          connectedUsers,
          disconnectedUsers: totalUsers - connectedUsers,
          persistentUsers,
          autoReconnectUsers,
          recentlyActive,
        },
        sessions: {
          activeSessionCount,
          connectedSessionCount,
          disconnectedSessionCount: activeSessionCount - connectedSessionCount,
          reconnectingSessionCount,
          sessionsWithErrors,
          circuitBreakerOpenCount,
        },
        system: {
          memoryUsageMB: memoryUsage,
          maxMemoryMB: this.MAX_RAM_USAGE_MB,
          memoryUtilization:
            ((memoryUsage / this.MAX_RAM_USAGE_MB) * 100).toFixed(2) + "%",
          uptime: process.uptime(),
          nodeVersion: process.version,
          platform: process.platform,
        },
        limits: {
          maxActiveSessions: this.MAX_ACTIVE_SESSIONS,
          maxReconnectionAttempts: this.MAX_RECONNECTION_ATTEMPTS,
          maxConflictAttempts: this.MAX_CONFLICT_ATTEMPTS,
          sessionIdleTimeout: this.SESSION_IDLE_TIMEOUT_MS,
          circuitBreakerThreshold: this.CIRCUIT_BREAKER_THRESHOLD,
          circuitBreakerTimeout: this.CIRCUIT_BREAKER_TIMEOUT,
        },
        counters: {
          totalReconnectionAttempts: Array.from(
            this.reconnectionAttempts.values()
          ).reduce((sum, attempts) => sum + attempts, 0),
          totalConflictAttempts: Array.from(
            this.conflictAttempts.values()
          ).reduce((sum, attempts) => sum + attempts, 0),
          reconnectionInProgress: this.reconnectionInProgress.size,
          activeQRCodes: this.qrCodes.size,
        },
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error("Error getting system statistics:", error);
      throw error;
    }
  }

  private async sendWebhook(
    userId: string,
    status: string,
    connected: boolean,
    user?: any
  ): Promise<void> {
    try {
      if (!this.WEBHOOK_URL) {
        this.logger.warn("WEBHOOK_URL not set; skipping webhook call");
        return;
      }
      const sessionInfo = this.activeSessions.get(userId);
      const payload = {
        sessionId: `session_${userId}`,
        status,
        connected,
        connectionStatus: status,
        user: user
          ? {
              name: user.name || user.id || "Unknown",
              number: user.id || "Unknown",
            }
          : null,
        data: {
          isSessionActive: !!sessionInfo,
          isReconnecting: sessionInfo?.isReconnecting || false,
          reconnectionAttempts: this.reconnectionAttempts.get(userId) || 0,
        },
      };

      const response = await fetch(this.WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        this.logger.warn(
          `[${userId}] Webhook failed: ${response.status} ${response.statusText}`
        );
      } else {
        this.logger.log(
          `[${userId}] Webhook sent successfully for status: ${status}`
        );
      }
    } catch (error) {
      this.logger.error(`[${userId}] Error sending webhook:`, error);
    }
  }
}
