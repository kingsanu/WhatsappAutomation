import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AuthStateDocument = AuthState & Document;

// Session state enum for better type safety
export enum SessionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  AUTHENTICATING = 'authenticating',
  RECONNECTING = 'reconnecting',
  STREAM_CONFLICT = 'stream_conflict',
  RESTARTING_AFTER_PAIRING = 'restarting_after_pairing',
  ERROR = 'error',
  LOGGED_OUT = 'logged_out'
}

// Session persistence policy enum
export enum PersistencePolicy {
  TEMPORARY = 'temporary',        // Session expires after inactivity
  PERSISTENT = 'persistent',      // Session persists indefinitely
  PERMANENT = 'permanent'         // Session never expires, never cleaned up
}

@Schema({
  timestamps: true,
  collection: 'auth_states'
})
export class AuthState {
  @Prop({ required: true, unique: true })
  userId: string;

  @Prop({ type: Object, required: true })
  credentials: any;

  @Prop({ type: Object, default: {} })
  keys: any;

  @Prop({
    type: String,
    enum: Object.values(SessionStatus),
    default: SessionStatus.DISCONNECTED
  })
  connectionStatus: SessionStatus;

  @Prop({ type: Object, default: null })
  user: any;

  @Prop({ type: Date, default: Date.now })
  lastUpdated: Date;

  // Enhanced session persistence fields
  @Prop({ type: Date, default: null })
  lastConnected: Date;

  @Prop({ type: Date, default: null })
  lastDisconnected: Date;

  @Prop({ type: String, default: null })
  lastDisconnectReason: string;

  @Prop({ type: Number, default: 0 })
  reconnectionAttempts: number;

  @Prop({ type: Boolean, default: true })
  autoReconnect: boolean;

  @Prop({ type: Object, default: null })
  sessionMetadata: any;

  @Prop({ type: String, default: null })
  phoneNumber: string;

  @Prop({ type: String, default: null })
  deviceName: string;

  // Enhanced persistence configuration
  @Prop({
    type: String,
    enum: Object.values(PersistencePolicy),
    default: PersistencePolicy.PERMANENT
  })
  persistencePolicy: PersistencePolicy;

  @Prop({ type: Boolean, default: true })
  isPersistent: boolean;

  // Session lifecycle tracking
  @Prop({ type: Date, default: Date.now })
  sessionCreated: Date;

  @Prop({ type: Date, default: null })
  sessionExpires: Date; // null means never expires

  @Prop({ type: Date, default: Date.now })
  lastActivity: Date;

  // Session health and monitoring
  @Prop({ type: Number, default: 0 })
  totalConnections: number;

  @Prop({ type: Number, default: 0 })
  totalDisconnections: number;

  @Prop({ type: Number, default: 0 })
  errorCount: number;

  @Prop({ type: String, default: null })
  lastError: string;

  @Prop({ type: Date, default: null })
  lastErrorTime: Date;

  // Circuit breaker state
  @Prop({
    type: String,
    enum: ['closed', 'open', 'half-open'],
    default: 'closed'
  })
  circuitBreakerState: string;

  @Prop({ type: Date, default: null })
  circuitBreakerLastReset: Date;

  // Session backup and recovery
  @Prop({ type: Boolean, default: false })
  hasBackup: boolean;

  @Prop({ type: Date, default: null })
  lastBackupTime: Date;

  @Prop({ type: String, default: null })
  backupLocation: string;

  // Administrative fields
  @Prop({ type: Boolean, default: false })
  isManuallyDisabled: boolean;

  @Prop({ type: String, default: null })
  disabledReason: string;

  @Prop({ type: Date, default: null })
  disabledAt: Date;

  @Prop({ type: String, default: null })
  disabledBy: string;

  // Session priority for resource management
  @Prop({ type: Number, default: 1, min: 1, max: 10 })
  priority: number;

  // Tags for session categorization
  @Prop({ type: [String], default: [] })
  tags: string[];

  // Environment and deployment info
  @Prop({ type: String, default: null })
  environment: string;

  @Prop({ type: String, default: null })
  deploymentVersion: string;

  @Prop({ type: String, default: null })
  nodeId: string; // For multi-instance deployments

  // Serialization metadata for advanced session state handling
  @Prop({ type: Object, default: null })
  serializationMetadata: {
    version?: string;
    credsCompressed?: boolean;
    keysCompressed?: boolean;
    credsChecksum?: string;
    keysChecksum?: string;
    serializationTime?: number;
    lastSerialized?: Date;
  };

  // Instance tracking for server restart detection
  @Prop({ type: String, default: null })
  serverInstanceId: string; // Unique ID for each server startup

  @Prop({ type: Date, default: null })
  lastServerStart: Date; // When this server instance started

  @Prop({ type: Boolean, default: false })
  wasGracefullyDisconnected: boolean; // Was properly closed before server shutdown

  @Prop({ type: String, default: null })
  connectionInstanceId: string; // Unique ID for each socket connection

  @Prop({ type: Date, default: null })
  lastHeartbeat: Date; // Last time we received data from WhatsApp

  @Prop({ type: Number, default: 0 })
  conflictRetryCount: number; // How many times we've tried to resolve conflicts

  @Prop({ type: Date, default: null })
  lastConflictTime: Date; // When the last conflict occurred

  @Prop({ type: String, default: null })
  lastDisconnectType: string; // 'clean', 'conflict', 'network', 'server_restart'

  @Prop({ type: Date, default: null })
  lastKeyRefresh: Date; // When encryption keys were last refreshed

  @Prop({ type: String, default: null })
  keyRefreshReason: string; // Why keys were refreshed
}

export const AuthStateSchema = SchemaFactory.createForClass(AuthState);

// Create indexes for better performance (userId already has unique: true in @Prop)
AuthStateSchema.index({ connectionStatus: 1 });
AuthStateSchema.index({ lastUpdated: -1 });
AuthStateSchema.index({ lastConnected: -1 });
AuthStateSchema.index({ phoneNumber: 1 });
AuthStateSchema.index({ persistencePolicy: 1 });
AuthStateSchema.index({ lastActivity: -1 });
AuthStateSchema.index({ priority: -1 });
AuthStateSchema.index({ environment: 1, nodeId: 1 });

// Compound indexes for complex queries
AuthStateSchema.index({ connectionStatus: 1, persistencePolicy: 1 });
AuthStateSchema.index({ isPersistent: 1, autoReconnect: 1 });
AuthStateSchema.index({ isManuallyDisabled: 1, connectionStatus: 1 });
AuthStateSchema.index({ lastActivity: -1, persistencePolicy: 1 });

// TTL index for temporary sessions only (will not affect persistent/permanent sessions)
AuthStateSchema.index(
  { sessionExpires: 1 },
  {
    expireAfterSeconds: 0,
    partialFilterExpression: {
      sessionExpires: { $ne: null },
      persistencePolicy: PersistencePolicy.TEMPORARY
    }
  }
);

// Pre-save middleware to update lastActivity and session statistics
AuthStateSchema.pre('save', function(next) {
  if (this.isNew) {
    this.sessionCreated = new Date();
    this.totalConnections = 0;
    this.totalDisconnections = 0;
  }

  // Update lastActivity on any save
  this.lastUpdated = new Date();

  // Set session expiration based on persistence policy
  if (this.persistencePolicy === PersistencePolicy.TEMPORARY && !this.sessionExpires) {
    // Set expiration to 30 days for temporary sessions
    this.sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  } else if (this.persistencePolicy !== PersistencePolicy.TEMPORARY) {
    // Clear expiration for persistent and permanent sessions
    this.sessionExpires = null;
  }

  next();
});

// Pre-update middleware to track connection state changes
AuthStateSchema.pre(['updateOne', 'findOneAndUpdate'], function(next) {
  const update = this.getUpdate() as any;

  if (update.$set) {
    update.$set.lastUpdated = new Date();

    // Track connection state changes
    if (update.$set.connectionStatus === SessionStatus.CONNECTED) {
      update.$set.lastConnected = new Date();
      update.$inc = update.$inc || {};
      update.$inc.totalConnections = 1;
    } else if (update.$set.connectionStatus === SessionStatus.DISCONNECTED) {
      update.$set.lastDisconnected = new Date();
      update.$inc = update.$inc || {};
      update.$inc.totalDisconnections = 1;
    }
  }

  next();
});

// Static methods for session management
AuthStateSchema.statics.findPersistentSessions = function() {
  return this.find({
    $or: [
      { persistencePolicy: PersistencePolicy.PERSISTENT },
      { persistencePolicy: PersistencePolicy.PERMANENT }
    ],
    isManuallyDisabled: { $ne: true }
  });
};

AuthStateSchema.statics.findActiveSessions = function() {
  return this.find({
    connectionStatus: { $in: [SessionStatus.CONNECTED, SessionStatus.CONNECTING, SessionStatus.RECONNECTING] },
    isManuallyDisabled: { $ne: true }
  });
};

AuthStateSchema.statics.findSessionsForRestore = function() {
  const currentServerInstanceId = process.env.SERVER_INSTANCE_ID || require('os').hostname() + '_' + Date.now();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

  return this.find({
    $and: [
      // Main session selection criteria
      {
        $or: [
          // Case 1: Sessions that were gracefully disconnected
          {
            connectionStatus: { $in: [SessionStatus.DISCONNECTED, SessionStatus.RESTARTING_AFTER_PAIRING] },
            wasGracefullyDisconnected: true,
            autoReconnect: true,
            persistencePolicy: { $in: [PersistencePolicy.PERSISTENT, PersistencePolicy.PERMANENT] },
            lastConnected: { $exists: true }
          },
          // Case 2: Sessions from previous server instance (server restart scenario)
          {
            connectionStatus: { $in: [SessionStatus.CONNECTED, SessionStatus.DISCONNECTED] },
            autoReconnect: true,
            persistencePolicy: { $in: [PersistencePolicy.PERSISTENT, PersistencePolicy.PERMANENT] },
            lastConnected: { $exists: true },
            $and: [
              // Different server instance OR no instance tracking OR old server start
              {
                $or: [
                  { serverInstanceId: { $ne: currentServerInstanceId } },
                  { serverInstanceId: { $exists: false } },
                  { lastServerStart: { $lt: oneHourAgo } }
                ]
              },
              // Not too many recent conflicts
              {
                $or: [
                  { conflictRetryCount: { $lt: 3 } },
                  { lastConflictTime: { $lt: oneHourAgo } },
                  { lastConflictTime: { $exists: false } }
                ]
              }
            ]
          }
        ]
      },
      // Additional filters
      { isManuallyDisabled: { $ne: true } },
      // Don't restore sessions that had conflicts very recently
      {
        $or: [
          { lastConflictTime: { $exists: false } },
          { lastConflictTime: { $lt: fiveMinutesAgo } }
        ]
      }
    ]
  });
};

AuthStateSchema.statics.findExpiredSessions = function() {
  return this.find({
    persistencePolicy: PersistencePolicy.TEMPORARY,
    sessionExpires: { $lt: new Date() }
  });
};

// Instance methods
AuthStateSchema.methods.markAsConnected = function() {
  this.connectionStatus = SessionStatus.CONNECTED;
  this.lastConnected = new Date();
  this.lastActivity = new Date();
  this.reconnectionAttempts = 0;
  this.errorCount = 0;
  this.lastError = null;
  this.circuitBreakerState = 'closed';
  this.totalConnections += 1;
  return this.save();
};

AuthStateSchema.methods.markAsDisconnected = function(reason?: string) {
  this.connectionStatus = SessionStatus.DISCONNECTED;
  this.lastDisconnected = new Date();
  this.lastActivity = new Date();
  if (reason) {
    this.lastDisconnectReason = reason;
  }
  this.totalDisconnections += 1;
  return this.save();
};

AuthStateSchema.methods.incrementError = function(error: string) {
  this.errorCount += 1;
  this.lastError = error;
  this.lastErrorTime = new Date();
  this.lastActivity = new Date();
  return this.save();
};

AuthStateSchema.methods.resetErrors = function() {
  this.errorCount = 0;
  this.lastError = null;
  this.lastErrorTime = null;
  this.circuitBreakerState = 'closed';
  this.circuitBreakerLastReset = null;
  return this.save();
};

AuthStateSchema.methods.setPersistencePolicy = function(policy: PersistencePolicy) {
  this.persistencePolicy = policy;
  this.isPersistent = policy !== PersistencePolicy.TEMPORARY;

  if (policy === PersistencePolicy.TEMPORARY) {
    this.sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
  } else {
    this.sessionExpires = null; // Never expires
  }

  return this.save();
};

AuthStateSchema.methods.disable = function(reason: string, disabledBy?: string) {
  this.isManuallyDisabled = true;
  this.disabledReason = reason;
  this.disabledAt = new Date();
  this.disabledBy = disabledBy || 'system';
  return this.save();
};

AuthStateSchema.methods.enable = function() {
  this.isManuallyDisabled = false;
  this.disabledReason = null;
  this.disabledAt = null;
  this.disabledBy = null;
  return this.save();
};