import { PersistencePolicy } from '../schemas/auth-state.schema';

export interface SessionConfig {
  // Persistence settings
  defaultPersistencePolicy: PersistencePolicy;
  enableAutoReconnect: boolean;
  enableSessionRestoration: boolean;
  
  // Resource management
  maxActiveSessions: number;
  maxRamUsageMB: number;
  emergencyCleanupThreshold: number; // RAM percentage (0.95 = 95%)
  
  // Timing settings
  sessionCleanupInterval: number; // milliseconds
  sessionIdleTimeout: number; // milliseconds (0 = never timeout)
  qrCodeTimeout: number; // milliseconds
  
  // Reconnection settings
  maxReconnectionAttempts: number;
  maxConflictAttempts: number;
  reconnectionBaseDelay: number; // milliseconds
  reconnectionMaxDelay: number; // milliseconds
  
  // Circuit breaker settings
  circuitBreakerThreshold: number;
  circuitBreakerTimeout: number; // milliseconds
  maxErrorCount: number;
  
  // Restoration settings
  restorationBatchSize: number;
  restorationDelay: number; // milliseconds between sessions
  restorationRetryDelay: number; // milliseconds
  restorationMaxRetries: number;
  
  // Monitoring settings
  enableHealthMonitoring: boolean;
  healthCheckInterval: number; // milliseconds
  enableMetrics: boolean;
  
  // Backup settings
  enableSessionBackup: boolean;
  backupInterval: number; // milliseconds
  backupRetentionDays: number;
  
  // Environment settings
  environment: string;
  nodeId: string;
  deploymentVersion: string;
}

export const defaultSessionConfig: SessionConfig = {
  // Persistence settings - prioritize persistence
  defaultPersistencePolicy: PersistencePolicy.PERMANENT,
  enableAutoReconnect: true,
  enableSessionRestoration: true,
  
  // Resource management - increased limits for persistence
  maxActiveSessions: parseInt(process.env.MAX_ACTIVE_SESSIONS || '1000'),
  maxRamUsageMB: parseInt(process.env.MAX_RAM_USAGE_MB || '20480'), // 20GB
  emergencyCleanupThreshold: parseFloat(process.env.EMERGENCY_CLEANUP_THRESHOLD || '0.95'), // 95%
  
  // Timing settings - conservative for persistence
  sessionCleanupInterval: parseInt(process.env.SESSION_CLEANUP_INTERVAL || '3600000'), // 1 hour
  sessionIdleTimeout: parseInt(process.env.SESSION_IDLE_TIMEOUT_MS || '0'), // Never timeout
  qrCodeTimeout: parseInt(process.env.QR_CODE_TIMEOUT || '60000'), // 1 minute
  
  // Reconnection settings
  maxReconnectionAttempts: parseInt(process.env.MAX_RECONNECTION_ATTEMPTS || '5'),
  maxConflictAttempts: parseInt(process.env.MAX_CONFLICT_ATTEMPTS || '2'),
  reconnectionBaseDelay: parseInt(process.env.RECONNECTION_BASE_DELAY || '3000'), // 3 seconds
  reconnectionMaxDelay: parseInt(process.env.RECONNECTION_MAX_DELAY || '300000'), // 5 minutes
  
  // Circuit breaker settings
  circuitBreakerThreshold: parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD || '5'),
  circuitBreakerTimeout: parseInt(process.env.CIRCUIT_BREAKER_TIMEOUT || '300000'), // 5 minutes
  maxErrorCount: parseInt(process.env.MAX_ERROR_COUNT || '10'),
  
  // Restoration settings
  restorationBatchSize: parseInt(process.env.RESTORATION_BATCH_SIZE || '10'),
  restorationDelay: parseInt(process.env.RESTORATION_DELAY || '2000'), // 2 seconds
  restorationRetryDelay: parseInt(process.env.RESTORATION_RETRY_DELAY || '300000'), // 5 minutes
  restorationMaxRetries: parseInt(process.env.RESTORATION_MAX_RETRIES || '3'),
  
  // Monitoring settings
  enableHealthMonitoring: process.env.ENABLE_HEALTH_MONITORING !== 'false',
  healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL || '60000'), // 1 minute
  enableMetrics: process.env.ENABLE_METRICS !== 'false',
  
  // Backup settings
  enableSessionBackup: process.env.ENABLE_SESSION_BACKUP === 'true',
  backupInterval: parseInt(process.env.BACKUP_INTERVAL || '86400000'), // 24 hours
  backupRetentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || '30'),
  
  // Environment settings
  environment: process.env.NODE_ENV || 'development',
  nodeId: process.env.NODE_ID || require('os').hostname(),
  deploymentVersion: process.env.DEPLOYMENT_VERSION || '1.0.0'
};

export class SessionConfigManager {
  private config: SessionConfig;

  constructor(customConfig?: Partial<SessionConfig>) {
    this.config = { ...defaultSessionConfig, ...customConfig };
    this.validateConfig();
  }

  getConfig(): SessionConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<SessionConfig>): void {
    this.config = { ...this.config, ...updates };
    this.validateConfig();
  }

  private validateConfig(): void {
    // Validate persistence settings
    if (!Object.values(PersistencePolicy).includes(this.config.defaultPersistencePolicy)) {
      throw new Error(`Invalid default persistence policy: ${this.config.defaultPersistencePolicy}`);
    }

    // Validate resource limits
    if (this.config.maxActiveSessions <= 0) {
      throw new Error('maxActiveSessions must be greater than 0');
    }

    if (this.config.maxRamUsageMB <= 0) {
      throw new Error('maxRamUsageMB must be greater than 0');
    }

    if (this.config.emergencyCleanupThreshold <= 0 || this.config.emergencyCleanupThreshold > 1) {
      throw new Error('emergencyCleanupThreshold must be between 0 and 1');
    }

    // Validate timing settings
    if (this.config.sessionCleanupInterval < 60000) { // Minimum 1 minute
      throw new Error('sessionCleanupInterval must be at least 60000ms (1 minute)');
    }

    if (this.config.qrCodeTimeout < 10000) { // Minimum 10 seconds
      throw new Error('qrCodeTimeout must be at least 10000ms (10 seconds)');
    }

    // Validate reconnection settings
    if (this.config.maxReconnectionAttempts < 0) {
      throw new Error('maxReconnectionAttempts must be non-negative');
    }

    if (this.config.reconnectionBaseDelay < 1000) { // Minimum 1 second
      throw new Error('reconnectionBaseDelay must be at least 1000ms (1 second)');
    }

    // Validate circuit breaker settings
    if (this.config.circuitBreakerThreshold <= 0) {
      throw new Error('circuitBreakerThreshold must be greater than 0');
    }

    if (this.config.maxErrorCount <= 0) {
      throw new Error('maxErrorCount must be greater than 0');
    }
  }

  // Get configuration for specific environments
  getProductionConfig(): SessionConfig {
    return {
      ...this.config,
      defaultPersistencePolicy: PersistencePolicy.PERMANENT,
      maxActiveSessions: 2000,
      maxRamUsageMB: 32768, // 32GB
      emergencyCleanupThreshold: 0.98, // 98%
      sessionIdleTimeout: 0, // Never timeout in production
      enableHealthMonitoring: true,
      enableMetrics: true,
      enableSessionBackup: true
    };
  }

  getDevelopmentConfig(): SessionConfig {
    return {
      ...this.config,
      defaultPersistencePolicy: PersistencePolicy.PERSISTENT,
      maxActiveSessions: 100,
      maxRamUsageMB: 4096, // 4GB
      emergencyCleanupThreshold: 0.90, // 90%
      sessionIdleTimeout: 3600000, // 1 hour in development
      enableHealthMonitoring: true,
      enableMetrics: false,
      enableSessionBackup: false
    };
  }

  getTestConfig(): SessionConfig {
    return {
      ...this.config,
      defaultPersistencePolicy: PersistencePolicy.TEMPORARY,
      maxActiveSessions: 10,
      maxRamUsageMB: 1024, // 1GB
      emergencyCleanupThreshold: 0.80, // 80%
      sessionIdleTimeout: 300000, // 5 minutes in test
      enableHealthMonitoring: false,
      enableMetrics: false,
      enableSessionBackup: false
    };
  }
}

// Export singleton instance
export const sessionConfigManager = new SessionConfigManager();

// Export environment-specific configs
export const getSessionConfig = (environment?: string): SessionConfig => {
  const env = environment || process.env.NODE_ENV || 'development';
  
  switch (env) {
    case 'production':
      return sessionConfigManager.getProductionConfig();
    case 'development':
      return sessionConfigManager.getDevelopmentConfig();
    case 'test':
      return sessionConfigManager.getTestConfig();
    default:
      return sessionConfigManager.getConfig();
  }
};
