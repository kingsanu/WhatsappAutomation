import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuthState, AuthStateDocument, SessionStatus, PersistencePolicy } from '../schemas/auth-state.schema';
import { getSessionConfig } from '../config/session-config';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

export interface SessionBackup {
  id: string;
  timestamp: Date;
  sessionCount: number;
  backupSize: number;
  checksum: string;
  filePath: string;
  metadata: {
    environment: string;
    nodeId: string;
    deploymentVersion: string;
    backupType: 'full' | 'incremental';
  };
}

export interface BackupRestoreResult {
  success: boolean;
  sessionsRestored: number;
  sessionsSkipped: number;
  errors: string[];
  duration: number;
}

@Injectable()
export class SessionBackupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionBackupService.name);
  private readonly config = getSessionConfig();
  private backupInterval: NodeJS.Timeout | null = null;
  private readonly backupDir = path.join(process.cwd(), 'backups', 'sessions');
  private backupHistory: SessionBackup[] = [];

  constructor(
    @InjectModel(AuthState.name)
    private authStateModel: Model<AuthStateDocument>,
  ) {}

  async onModuleInit() {
    if (this.config.enableSessionBackup) {
      this.logger.log('Session Backup Service initialized');
      await this.ensureBackupDirectory();
      await this.loadBackupHistory();
      this.startBackupSchedule();
    }
  }

  onModuleDestroy() {
    if (this.backupInterval) {
      clearInterval(this.backupInterval);
    }
  }

  private async ensureBackupDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.backupDir, { recursive: true });
      this.logger.log(`Backup directory ensured: ${this.backupDir}`);
    } catch (error) {
      this.logger.error('Failed to create backup directory:', error);
      throw error;
    }
  }

  private async loadBackupHistory(): Promise<void> {
    try {
      const historyFile = path.join(this.backupDir, 'backup-history.json');
      try {
        const historyData = await fs.readFile(historyFile, 'utf-8');
        this.backupHistory = JSON.parse(historyData);
        this.logger.log(`Loaded ${this.backupHistory.length} backup records from history`);
      } catch (error) {
        // History file doesn't exist, start fresh
        this.backupHistory = [];
        this.logger.log('No backup history found, starting fresh');
      }
    } catch (error) {
      this.logger.error('Error loading backup history:', error);
      this.backupHistory = [];
    }
  }

  private async saveBackupHistory(): Promise<void> {
    try {
      const historyFile = path.join(this.backupDir, 'backup-history.json');
      await fs.writeFile(historyFile, JSON.stringify(this.backupHistory, null, 2));
    } catch (error) {
      this.logger.error('Error saving backup history:', error);
    }
  }

  private startBackupSchedule(): void {
    this.backupInterval = setInterval(async () => {
      try {
        await this.createBackup('full');
      } catch (error) {
        this.logger.error('Scheduled backup failed:', error);
      }
    }, this.config.backupInterval);

    // Create initial backup after 1 minute
    setTimeout(() => {
      this.createBackup('full').catch(error => {
        this.logger.error('Initial backup failed:', error);
      });
    }, 60000);

    this.logger.log(`Backup schedule started with ${this.config.backupInterval}ms interval`);
  }

  async createBackup(type: 'full' | 'incremental' = 'full'): Promise<SessionBackup> {
    const startTime = Date.now();
    this.logger.log(`Creating ${type} session backup...`);

    try {
      // Get sessions to backup
      let sessions: AuthStateDocument[];
      
      if (type === 'full') {
        sessions = await this.authStateModel.find({}).exec();
      } else {
        // Incremental: only sessions modified since last backup
        const lastBackup = this.getLatestBackup();
        const since = lastBackup ? lastBackup.timestamp : new Date(0);
        sessions = await this.authStateModel.find({
          lastUpdated: { $gte: since }
        }).exec();
      }

      if (sessions.length === 0) {
        this.logger.log('No sessions to backup');
        return null;
      }

      // Prepare backup data
      const backupData = {
        metadata: {
          timestamp: new Date(),
          sessionCount: sessions.length,
          backupType: type,
          environment: this.config.environment,
          nodeId: this.config.nodeId,
          deploymentVersion: this.config.deploymentVersion,
          version: '1.0.0'
        },
        sessions: sessions.map(session => ({
          userId: session.userId,
          credentials: session.credentials,
          keys: session.keys,
          connectionStatus: session.connectionStatus,
          user: session.user,
          lastUpdated: session.lastUpdated,
          lastConnected: session.lastConnected,
          lastDisconnected: session.lastDisconnected,
          lastDisconnectReason: session.lastDisconnectReason,
          reconnectionAttempts: session.reconnectionAttempts,
          autoReconnect: session.autoReconnect,
          sessionMetadata: session.sessionMetadata,
          phoneNumber: session.phoneNumber,
          deviceName: session.deviceName,
          persistencePolicy: session.persistencePolicy,
          isPersistent: session.isPersistent,
          sessionCreated: session.sessionCreated,
          sessionExpires: session.sessionExpires,
          lastActivity: session.lastActivity,
          totalConnections: session.totalConnections,
          totalDisconnections: session.totalDisconnections,
          errorCount: session.errorCount,
          lastError: session.lastError,
          lastErrorTime: session.lastErrorTime,
          circuitBreakerState: session.circuitBreakerState,
          circuitBreakerLastReset: session.circuitBreakerLastReset,
          hasBackup: session.hasBackup,
          lastBackupTime: session.lastBackupTime,
          backupLocation: session.backupLocation,
          isManuallyDisabled: session.isManuallyDisabled,
          disabledReason: session.disabledReason,
          disabledAt: session.disabledAt,
          disabledBy: session.disabledBy,
          priority: session.priority,
          tags: session.tags,
          environment: session.environment,
          deploymentVersion: session.deploymentVersion,
          nodeId: session.nodeId
        }))
      };

      // Generate backup file
      const backupId = crypto.randomUUID();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `session-backup-${type}-${timestamp}-${backupId}.json`;
      const filePath = path.join(this.backupDir, fileName);

      // Write backup file
      const backupJson = JSON.stringify(backupData, null, 2);
      await fs.writeFile(filePath, backupJson);

      // Calculate checksum
      const checksum = crypto.createHash('sha256').update(backupJson).digest('hex');

      // Create backup record
      const backup: SessionBackup = {
        id: backupId,
        timestamp: new Date(),
        sessionCount: sessions.length,
        backupSize: Buffer.byteLength(backupJson, 'utf8'),
        checksum,
        filePath,
        metadata: {
          environment: this.config.environment,
          nodeId: this.config.nodeId,
          deploymentVersion: this.config.deploymentVersion,
          backupType: type
        }
      };

      // Update backup history
      this.backupHistory.push(backup);
      await this.saveBackupHistory();

      // Update session backup metadata
      await this.authStateModel.updateMany(
        { userId: { $in: sessions.map(s => s.userId) } },
        {
          hasBackup: true,
          lastBackupTime: new Date(),
          backupLocation: filePath
        }
      );

      // Cleanup old backups
      await this.cleanupOldBackups();

      const duration = Date.now() - startTime;
      this.logger.log(`${type} backup created successfully: ${fileName} (${sessions.length} sessions, ${(backup.backupSize / 1024 / 1024).toFixed(2)}MB, ${duration}ms)`);

      return backup;
    } catch (error) {
      this.logger.error(`Failed to create ${type} backup:`, error);
      throw error;
    }
  }

  async restoreFromBackup(backupId: string, options: {
    overwriteExisting?: boolean;
    onlyMissingSessions?: boolean;
    dryRun?: boolean;
  } = {}): Promise<BackupRestoreResult> {
    const startTime = Date.now();
    const { overwriteExisting = false, onlyMissingSessions = true, dryRun = false } = options;
    
    this.logger.log(`${dryRun ? 'Simulating' : 'Starting'} restore from backup: ${backupId}`);

    try {
      // Find backup
      const backup = this.backupHistory.find(b => b.id === backupId);
      if (!backup) {
        throw new Error(`Backup not found: ${backupId}`);
      }

      // Read backup file
      const backupData = JSON.parse(await fs.readFile(backup.filePath, 'utf-8'));

      // Verify checksum
      const backupJson = JSON.stringify(backupData);
      const checksum = crypto.createHash('sha256').update(backupJson).digest('hex');
      if (checksum !== backup.checksum) {
        throw new Error('Backup file corrupted - checksum mismatch');
      }

      const result: BackupRestoreResult = {
        success: true,
        sessionsRestored: 0,
        sessionsSkipped: 0,
        errors: [],
        duration: 0
      };

      // Process each session
      for (const sessionData of backupData.sessions) {
        try {
          const existingSession = await this.authStateModel.findOne({ userId: sessionData.userId });

          if (existingSession) {
            if (onlyMissingSessions) {
              result.sessionsSkipped++;
              continue;
            }
            if (!overwriteExisting) {
              result.sessionsSkipped++;
              continue;
            }
          }

          if (!dryRun) {
            if (existingSession && overwriteExisting) {
              await this.authStateModel.findOneAndUpdate(
                { userId: sessionData.userId },
                {
                  ...sessionData,
                  lastUpdated: new Date(),
                  // Preserve current connection status if session is active
                  connectionStatus: existingSession.connectionStatus === SessionStatus.CONNECTED ? 
                    existingSession.connectionStatus : sessionData.connectionStatus
                }
              );
            } else {
              await this.authStateModel.create({
                ...sessionData,
                lastUpdated: new Date()
              });
            }
          }

          result.sessionsRestored++;
        } catch (error) {
          result.errors.push(`Failed to restore session ${sessionData.userId}: ${error.message}`);
        }
      }

      result.duration = Date.now() - startTime;
      result.success = result.errors.length === 0;

      this.logger.log(`Restore ${dryRun ? 'simulation' : 'operation'} completed: ${result.sessionsRestored} restored, ${result.sessionsSkipped} skipped, ${result.errors.length} errors (${result.duration}ms)`);

      return result;
    } catch (error) {
      this.logger.error('Restore operation failed:', error);
      throw error;
    }
  }

  private async cleanupOldBackups(): Promise<void> {
    try {
      const cutoffDate = new Date(Date.now() - this.config.backupRetentionDays * 24 * 60 * 60 * 1000);
      const oldBackups = this.backupHistory.filter(b => b.timestamp < cutoffDate);

      for (const backup of oldBackups) {
        try {
          await fs.unlink(backup.filePath);
          this.logger.log(`Deleted old backup: ${backup.id}`);
        } catch (error) {
          this.logger.warn(`Failed to delete backup file ${backup.filePath}:`, error);
        }
      }

      // Remove from history
      this.backupHistory = this.backupHistory.filter(b => b.timestamp >= cutoffDate);
      
      if (oldBackups.length > 0) {
        await this.saveBackupHistory();
        this.logger.log(`Cleaned up ${oldBackups.length} old backups`);
      }
    } catch (error) {
      this.logger.error('Error cleaning up old backups:', error);
    }
  }

  // Public methods
  getBackupHistory(): SessionBackup[] {
    return [...this.backupHistory];
  }

  getLatestBackup(): SessionBackup | null {
    return this.backupHistory.length > 0 ? 
      this.backupHistory[this.backupHistory.length - 1] : null;
  }

  async getBackupInfo(backupId: string): Promise<any> {
    const backup = this.backupHistory.find(b => b.id === backupId);
    if (!backup) {
      throw new Error(`Backup not found: ${backupId}`);
    }

    try {
      const backupData = JSON.parse(await fs.readFile(backup.filePath, 'utf-8'));
      return {
        ...backup,
        sessions: backupData.sessions.length,
        metadata: backupData.metadata
      };
    } catch (error) {
      throw new Error(`Failed to read backup file: ${error.message}`);
    }
  }

  async forceBackup(): Promise<SessionBackup> {
    return this.createBackup('full');
  }

  getBackupStats(): any {
    const totalBackups = this.backupHistory.length;
    const totalSize = this.backupHistory.reduce((sum, b) => sum + b.backupSize, 0);
    const latestBackup = this.getLatestBackup();
    
    return {
      totalBackups,
      totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
      latestBackup: latestBackup ? {
        timestamp: latestBackup.timestamp,
        sessionCount: latestBackup.sessionCount,
        sizeMB: (latestBackup.backupSize / 1024 / 1024).toFixed(2)
      } : null,
      retentionDays: this.config.backupRetentionDays,
      backupDirectory: this.backupDir
    };
  }
}
