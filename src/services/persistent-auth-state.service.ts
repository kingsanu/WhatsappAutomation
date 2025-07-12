import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuthState, AuthStateDocument } from '../schemas/auth-state.schema';
import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { promisify } from 'util';

export interface SerializedAuthState {
  creds: any;
  keys: any;
  metadata: {
    userId: string;
    phoneNumber?: string;
    deviceName?: string;
    lastSaved: Date;
    version: string;
    compressed?: boolean;
    checksum?: string;
    serializationVersion: string;
  };
}

export interface SessionStateMetrics {
  originalSize: number;
  compressedSize: number;
  compressionRatio: number;
  serializationTime: number;
  deserializationTime: number;
  checksumValid: boolean;
}

@Injectable()
export class PersistentAuthStateService {
  private readonly logger = new Logger(PersistentAuthStateService.name);
  private readonly authStateCache = new Map<string, any>();
  private readonly saveQueue = new Map<string, NodeJS.Timeout>();
  private readonly metricsCache = new Map<string, SessionStateMetrics>();
  private readonly SAVE_DELAY = 2000; // 2 seconds delay for batching saves
  private readonly COMPRESSION_THRESHOLD = 1024; // Compress if data > 1KB
  private readonly SERIALIZATION_VERSION = '2.0.0';

  // Promisified compression functions
  private readonly gzip = promisify(zlib.gzip);
  private readonly gunzip = promisify(zlib.gunzip);

  constructor(
    @InjectModel(AuthState.name)
    private authStateModel: Model<AuthStateDocument>,
  ) {}

  /**
   * Create a new auth state for a user
   */
  async createAuthState(userId: string): Promise<any> {
    try {
      this.logger.log(`[${userId}] Creating new persistent auth state...`);

      // Initialize new credentials
      const { state, saveCreds } = await this.initializeAuthState(userId);

      // Save initial state to database
      await this.saveAuthStateToDatabase(userId, state);

      this.logger.log(`[${userId}] New persistent auth state created`);
      return { state, saveCreds };
    } catch (error) {
      this.logger.error(`[${userId}] Error creating auth state:`, error);
      throw error;
    }
  }

  /**
   * Load existing auth state for a user
   */
  async loadAuthState(userId: string): Promise<any> {
    try {
      this.logger.log(`[${userId}] Loading persistent auth state...`);

      // Check cache first
      if (this.authStateCache.has(userId)) {
        this.logger.log(`[${userId}] Auth state loaded from cache`);
        return this.authStateCache.get(userId);
      }

      // Load from database
      const authStateDoc = await this.authStateModel.findOne({ userId });
      if (!authStateDoc || !authStateDoc.credentials) {
        this.logger.log(`[${userId}] No existing auth state found, creating new one`);
        return this.createAuthState(userId);
      }

      // Deserialize the auth state with integrity checking
      const state = await this.deserializeAuthStateWithIntegrity(authStateDoc);
      const { saveCreds } = await this.initializeAuthState(userId, state);

      // Cache the state
      this.authStateCache.set(userId, { state, saveCreds });

      this.logger.log(`[${userId}] Persistent auth state loaded successfully`);
      return { state, saveCreds };
    } catch (error) {
      this.logger.error(`[${userId}] Error loading auth state:`, error);
      // Fallback to creating new state
      return this.createAuthState(userId);
    }
  }

  /**
   * Initialize auth state with proper save mechanism
   */
  private async initializeAuthState(userId: string, existingState?: any): Promise<any> {
    const state = existingState || initAuthCreds();

    const saveCreds = async () => {
      try {
        // Debounce saves to avoid too frequent database writes
        if (this.saveQueue.has(userId)) {
          clearTimeout(this.saveQueue.get(userId));
        }

        const saveTimeout = setTimeout(async () => {
          try {
            await this.saveAuthStateToDatabase(userId, state);
            this.saveQueue.delete(userId);
          } catch (error) {
            this.logger.error(`[${userId}] Error in delayed save:`, error);
          }
        }, this.SAVE_DELAY);

        this.saveQueue.set(userId, saveTimeout);

        // Also update cache immediately
        this.authStateCache.set(userId, { state, saveCreds });
      } catch (error) {
        this.logger.error(`[${userId}] Error in saveCreds:`, error);
      }
    };

    return { state, saveCreds };
  }

  /**
   * Save auth state to database with compression and integrity checking
   */
  private async saveAuthStateToDatabase(userId: string, state: any): Promise<void> {
    const startTime = Date.now();

    try {
      // Serialize with advanced serialization
      const serializedCreds = await this.serializeWithCompression(state.creds, userId + '_creds');
      const serializedKeys = await this.serializeWithCompression(state.keys, userId + '_keys');

      // Calculate metrics
      const serializationTime = Date.now() - startTime;

      await this.authStateModel.findOneAndUpdate(
        { userId },
        {
          credentials: serializedCreds.data,
          keys: serializedKeys.data,
          lastUpdated: new Date(),
          lastActivity: new Date(),
          // Store serialization metadata
          serializationMetadata: {
            version: this.SERIALIZATION_VERSION,
            credsCompressed: serializedCreds.compressed,
            keysCompressed: serializedKeys.compressed,
            credsChecksum: serializedCreds.checksum,
            keysChecksum: serializedKeys.checksum,
            serializationTime,
            lastSerialized: new Date()
          },
          // Preserve existing session metadata
          $setOnInsert: {
            persistencePolicy: 'permanent',
            isPersistent: true,
            autoReconnect: true,
            sessionExpires: null,
            sessionCreated: new Date(),
            totalConnections: 0,
            totalDisconnections: 0,
            errorCount: 0,
            priority: 5
          }
        },
        { upsert: true }
      );

      // Store metrics
      this.metricsCache.set(userId, {
        originalSize: serializedCreds.originalSize + serializedKeys.originalSize,
        compressedSize: serializedCreds.compressedSize + serializedKeys.compressedSize,
        compressionRatio: (serializedCreds.originalSize + serializedKeys.originalSize) /
                         (serializedCreds.compressedSize + serializedKeys.compressedSize),
        serializationTime,
        deserializationTime: 0,
        checksumValid: true
      });

      this.logger.debug(`[${userId}] Auth state saved with compression:`, {
        originalSize: serializedCreds.originalSize + serializedKeys.originalSize,
        compressedSize: serializedCreds.compressedSize + serializedKeys.compressedSize,
        compressionRatio: this.metricsCache.get(userId)?.compressionRatio.toFixed(2),
        serializationTime
      });
    } catch (error) {
      this.logger.error(`[${userId}] Error saving auth state to database:`, error);
      throw error;
    }
  }

  /**
   * Advanced serialization for WhatsApp auth state with proper Buffer handling
   */
  private serializeAuthState(data: any): any {
    if (!data) return {};

    try {
      return this.deepSerialize(data);
    } catch (error) {
      this.logger.error('Error serializing auth state:', error);
      return {};
    }
  }

  /**
   * Deep serialization with comprehensive type handling
   */
  private deepSerialize(obj: any): any {
    if (obj === null || obj === undefined) {
      return obj;
    }

    // Handle Buffer objects
    if (Buffer.isBuffer(obj)) {
      return {
        __type: 'Buffer',
        __data: obj.toString('base64')
      };
    }

    // Handle Uint8Array objects
    if (obj instanceof Uint8Array) {
      return {
        __type: 'Uint8Array',
        __data: Buffer.from(obj).toString('base64')
      };
    }

    // Handle Map objects
    if (obj instanceof Map) {
      return {
        __type: 'Map',
        __data: Array.from(obj.entries()).map(([key, value]) => [
          this.deepSerialize(key),
          this.deepSerialize(value)
        ])
      };
    }

    // Handle Set objects
    if (obj instanceof Set) {
      return {
        __type: 'Set',
        __data: Array.from(obj).map(item => this.deepSerialize(item))
      };
    }

    // Handle Date objects
    if (obj instanceof Date) {
      return {
        __type: 'Date',
        __data: obj.toISOString()
      };
    }

    // Handle BigInt
    if (typeof obj === 'bigint') {
      return {
        __type: 'BigInt',
        __data: obj.toString()
      };
    }

    // Handle arrays
    if (Array.isArray(obj)) {
      return obj.map(item => this.deepSerialize(item));
    }

    // Handle plain objects
    if (typeof obj === 'object' && obj.constructor === Object) {
      const serialized: any = {};
      for (const [key, value] of Object.entries(obj)) {
        serialized[key] = this.deepSerialize(value);
      }
      return serialized;
    }

    // Handle primitive types and functions
    if (typeof obj === 'function') {
      return {
        __type: 'Function',
        __data: obj.toString()
      };
    }

    // Return primitive values as-is
    return obj;
  }

  /**
   * Advanced deserialization for WhatsApp auth state with integrity checking
   */
  private async deserializeAuthStateWithIntegrity(authStateDoc: any): Promise<any> {
    const startTime = Date.now();

    try {
      const metadata = authStateDoc.serializationMetadata || {};
      const userId = authStateDoc.userId;

      // Deserialize credentials with integrity checking
      const creds = authStateDoc.credentials ?
        await this.deserializeWithCompression(
          authStateDoc.credentials,
          metadata.credsChecksum,
          `${userId}_creds`
        ) : initAuthCreds();

      // Deserialize keys with integrity checking
      const keys = authStateDoc.keys ?
        await this.deserializeWithCompression(
          authStateDoc.keys,
          metadata.keysChecksum,
          `${userId}_keys`
        ) : new Map();

      const state = { creds, keys };

      // Validate critical auth state components
      this.validateAuthState(state);

      // Update metrics
      const deserializationTime = Date.now() - startTime;
      const existingMetrics = this.metricsCache.get(userId);
      if (existingMetrics) {
        existingMetrics.deserializationTime = deserializationTime;
        existingMetrics.checksumValid = true;
      }

      this.logger.debug(`[${userId}] Auth state deserialized successfully:`, {
        deserializationTime,
        version: metadata.version || 'legacy',
        credsCompressed: metadata.credsCompressed || false,
        keysCompressed: metadata.keysCompressed || false
      });

      return state;
    } catch (error) {
      this.logger.error('Error deserializing auth state with integrity check:', error);

      // Fallback to legacy deserialization
      try {
        this.logger.warn('Attempting legacy deserialization fallback...');
        return this.deserializeAuthStateLegacy(authStateDoc.credentials, authStateDoc.keys);
      } catch (fallbackError) {
        this.logger.error('Legacy deserialization also failed:', fallbackError);
        return {
          creds: initAuthCreds(),
          keys: new Map()
        };
      }
    }
  }

  /**
   * Legacy deserialization for backward compatibility
   */
  private deserializeAuthStateLegacy(credentials: any, keys: any): any {
    try {
      const state = {
        creds: credentials ? this.deepDeserialize(credentials) : initAuthCreds(),
        keys: keys ? this.deepDeserialize(keys) : new Map()
      };

      // Validate critical auth state components
      this.validateAuthState(state);

      return state;
    } catch (error) {
      this.logger.error('Error in legacy deserialization:', error);
      return {
        creds: initAuthCreds(),
        keys: new Map()
      };
    }
  }

  /**
   * Deep deserialization with comprehensive type restoration
   */
  private deepDeserialize(obj: any): any {
    if (obj === null || obj === undefined) {
      return obj;
    }

    // Handle special serialized objects
    if (typeof obj === 'object' && obj.__type) {
      switch (obj.__type) {
        case 'Buffer':
          return Buffer.from(obj.__data, 'base64');

        case 'Uint8Array':
          return new Uint8Array(Buffer.from(obj.__data, 'base64'));

        case 'Map':
          const map = new Map();
          for (const [key, value] of obj.__data) {
            map.set(
              this.deepDeserialize(key),
              this.deepDeserialize(value)
            );
          }
          return map;

        case 'Set':
          return new Set(obj.__data.map((item: any) => this.deepDeserialize(item)));

        case 'Date':
          return new Date(obj.__data);

        case 'BigInt':
          return BigInt(obj.__data);

        case 'Function':
          // For security, don't deserialize functions - return null
          this.logger.warn('Function deserialization skipped for security');
          return null;

        default:
          this.logger.warn(`Unknown serialized type: ${obj.__type}`);
          return obj.__data;
      }
    }

    // Handle arrays
    if (Array.isArray(obj)) {
      return obj.map(item => this.deepDeserialize(item));
    }

    // Handle plain objects
    if (typeof obj === 'object' && obj.constructor === Object) {
      const deserialized: any = {};
      for (const [key, value] of Object.entries(obj)) {
        deserialized[key] = this.deepDeserialize(value);
      }
      return deserialized;
    }

    // Return primitive values as-is
    return obj;
  }

  /**
   * Validate auth state integrity after deserialization
   */
  private validateAuthState(state: any): void {
    const creds = state.creds;
    const keys = state.keys;

    // Check critical credential fields
    const requiredCredFields = [
      'noiseKey',
      'pairingEphemeralKeyPair',
      'signedIdentityKey',
      'signedPreKey',
      'registrationId'
    ];

    const missingFields = requiredCredFields.filter(field => !creds[field]);
    if (missingFields.length > 0) {
      this.logger.warn('Auth state missing critical fields:', missingFields);
    }

    // Validate Buffer fields are properly restored
    if (creds.noiseKey && !Buffer.isBuffer(creds.noiseKey)) {
      this.logger.warn('noiseKey is not a Buffer after deserialization');
    }

    // Validate keys structure
    if (!(keys instanceof Map)) {
      this.logger.warn('Keys is not a Map after deserialization');
    }

    // Log validation results
    this.logger.debug('Auth state validation:', {
      hasNoiseKey: !!creds.noiseKey,
      hasPairingKey: !!creds.pairingEphemeralKeyPair,
      hasSignedIdentity: !!creds.signedIdentityKey,
      hasSignedPreKey: !!creds.signedPreKey,
      hasRegistrationId: !!creds.registrationId,
      keysCount: keys instanceof Map ? keys.size : 'not a Map',
      missingFields
    });
  }

  /**
   * Refresh encryption keys when decryption fails
   */
  async refreshEncryptionKeys(userId: string): Promise<void> {
    try {
      this.logger.warn(`[${userId}] Refreshing encryption keys due to decryption failures...`);

      // Clear corrupted keys from cache
      this.authStateCache.delete(userId);

      // Load fresh auth state
      const authStateDoc = await this.authStateModel.findOne({ userId });
      if (!authStateDoc) {
        throw new Error('No auth state found for key refresh');
      }

      // Reset encryption keys but preserve credentials
      const freshState = {
        creds: authStateDoc.credentials ?
          await this.deserializeWithCompression(authStateDoc.credentials, authStateDoc.serializationMetadata?.credsChecksum, `${userId}_creds`) :
          initAuthCreds(),
        keys: new Map() // Start with fresh keys
      };

      // Validate and cache the refreshed state
      this.validateAuthState(freshState);
      const { saveCreds } = await this.initializeAuthState(userId, freshState);
      this.authStateCache.set(userId, { state: freshState, saveCreds });

      // Update database to mark keys as refreshed
      const serializedKeys = await this.serializeWithCompression(freshState.keys, userId + '_keys');
      await this.authStateModel.findOneAndUpdate(
        { userId },
        {
          keys: serializedKeys.data,
          lastUpdated: new Date(),
          lastKeyRefresh: new Date(),
          keyRefreshReason: 'Decryption failure recovery'
        }
      );

      this.logger.log(`[${userId}] Encryption keys refreshed successfully`);
    } catch (error) {
      this.logger.error(`[${userId}] Error refreshing encryption keys:`, error);
      throw error;
    }
  }

  /**
   * Check if session needs key refresh based on error patterns
   */
  shouldRefreshKeys(error: any): boolean {
    if (!error || !error.message) return false;

    const keyRefreshIndicators = [
      'Cannot destructure',
      'Bad MAC',
      'No matching sessions found',
      'failed to decrypt message',
      'Session error',
      'undefined session',
      'intermediate value',
      'SessionError'
    ];

    return keyRefreshIndicators.some(indicator =>
      error.message.toLowerCase().includes(indicator.toLowerCase())
    );
  }

  /**
   * Serialize with optional compression and integrity checking
   */
  private async serializeWithCompression(data: any, identifier: string): Promise<{
    data: any;
    compressed: boolean;
    checksum: string;
    originalSize: number;
    compressedSize: number;
  }> {
    try {
      // First serialize the data
      const serialized = this.deepSerialize(data);
      const jsonString = JSON.stringify(serialized);
      const originalBuffer = Buffer.from(jsonString, 'utf8');
      const originalSize = originalBuffer.length;

      let finalData: any;
      let compressed = false;
      let compressedSize = originalSize;

      // Compress if data is large enough
      if (originalSize > this.COMPRESSION_THRESHOLD) {
        try {
          const compressedBuffer = await this.gzip(originalBuffer);
          compressedSize = compressedBuffer.length;

          // Only use compression if it actually reduces size
          if (compressedSize < originalSize * 0.9) {
            finalData = {
              __compressed: true,
              __data: compressedBuffer.toString('base64')
            };
            compressed = true;
          } else {
            finalData = serialized;
          }
        } catch (compressionError) {
          this.logger.warn(`[${identifier}] Compression failed, using uncompressed:`, compressionError);
          finalData = serialized;
        }
      } else {
        finalData = serialized;
      }

      // Calculate checksum for integrity
      const checksum = crypto
        .createHash('sha256')
        .update(originalBuffer)
        .digest('hex');

      return {
        data: finalData,
        compressed,
        checksum,
        originalSize,
        compressedSize
      };
    } catch (error) {
      this.logger.error(`[${identifier}] Error in serializeWithCompression:`, error);
      throw error;
    }
  }

  /**
   * Deserialize with decompression and integrity checking
   */
  private async deserializeWithCompression(
    data: any,
    expectedChecksum?: string,
    identifier?: string
  ): Promise<any> {
    try {
      let jsonString: string;

      // Check if data is compressed
      if (data && typeof data === 'object' && data.__compressed) {
        try {
          const compressedBuffer = Buffer.from(data.__data, 'base64');
          const decompressedBuffer = await this.gunzip(compressedBuffer);
          jsonString = decompressedBuffer.toString('utf8');
        } catch (decompressionError) {
          this.logger.error(`[${identifier}] Decompression failed:`, decompressionError);
          throw new Error('Failed to decompress auth state data');
        }
      } else {
        // Data is not compressed
        jsonString = JSON.stringify(data);
      }

      // Verify checksum if provided
      if (expectedChecksum) {
        const actualChecksum = crypto
          .createHash('sha256')
          .update(Buffer.from(jsonString, 'utf8'))
          .digest('hex');

        if (actualChecksum !== expectedChecksum) {
          this.logger.error(`[${identifier}] Checksum mismatch:`, {
            expected: expectedChecksum,
            actual: actualChecksum
          });
          throw new Error('Auth state integrity check failed');
        }
      }

      // Parse and deserialize
      const parsed = JSON.parse(jsonString);
      return this.deepDeserialize(parsed);
    } catch (error) {
      this.logger.error(`[${identifier}] Error in deserializeWithCompression:`, error);
      throw error;
    }
  }

  /**
   * Check if user has valid persistent auth state
   */
  async hasValidAuthState(userId: string): Promise<boolean> {
    try {
      const authStateDoc = await this.authStateModel.findOne({ userId });
      
      if (!authStateDoc || !authStateDoc.credentials) {
        return false;
      }

      // Check if credentials have required fields
      const creds = authStateDoc.credentials;
      return !!(creds.noiseKey && creds.pairingEphemeralKeyPair && creds.signedIdentityKey);
    } catch (error) {
      this.logger.error(`[${userId}] Error checking auth state validity:`, error);
      return false;
    }
  }

  /**
   * Clear auth state from cache but preserve in database
   */
  clearCache(userId: string): void {
    this.authStateCache.delete(userId);
    
    // Clear any pending saves
    if (this.saveQueue.has(userId)) {
      clearTimeout(this.saveQueue.get(userId));
      this.saveQueue.delete(userId);
    }
    
    this.logger.log(`[${userId}] Auth state cache cleared`);
  }

  /**
   * Force save auth state immediately
   */
  async forceSave(userId: string): Promise<void> {
    const cached = this.authStateCache.get(userId);
    if (cached && cached.state) {
      await this.saveAuthStateToDatabase(userId, cached.state);
      this.logger.log(`[${userId}] Auth state force saved`);
    }
  }

  /**
   * Get auth state statistics
   */
  async getAuthStateStats(): Promise<any> {
    try {
      const totalStates = await this.authStateModel.countDocuments();
      const validStates = await this.authStateModel.countDocuments({
        'credentials.noiseKey': { $exists: true }
      });
      const cachedStates = this.authStateCache.size;
      const pendingSaves = this.saveQueue.size;

      return {
        totalStates,
        validStates,
        cachedStates,
        pendingSaves,
        cacheHitRate: cachedStates > 0 ? ((cachedStates / Math.max(totalStates, 1)) * 100).toFixed(2) + '%' : '0%'
      };
    } catch (error) {
      this.logger.error('Error getting auth state stats:', error);
      return {
        totalStates: 0,
        validStates: 0,
        cachedStates: this.authStateCache.size,
        pendingSaves: this.saveQueue.size,
        cacheHitRate: '0%'
      };
    }
  }

  /**
   * Backup auth state to file system
   */
  async backupAuthState(userId: string, backupDir: string): Promise<string> {
    try {
      const authStateDoc = await this.authStateModel.findOne({ userId });
      if (!authStateDoc) {
        throw new Error('No auth state found for user');
      }

      const backupData = {
        userId,
        credentials: authStateDoc.credentials,
        keys: authStateDoc.keys,
        metadata: {
          phoneNumber: authStateDoc.phoneNumber,
          deviceName: authStateDoc.deviceName,
          lastUpdated: authStateDoc.lastUpdated,
          persistencePolicy: authStateDoc.persistencePolicy
        },
        backupTimestamp: new Date(),
        version: '1.0.0'
      };

      const fileName = `auth-state-${userId}-${Date.now()}.json`;
      const filePath = path.join(backupDir, fileName);
      
      await fs.mkdir(backupDir, { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(backupData, null, 2));

      this.logger.log(`[${userId}] Auth state backed up to ${filePath}`);
      return filePath;
    } catch (error) {
      this.logger.error(`[${userId}] Error backing up auth state:`, error);
      throw error;
    }
  }

  /**
   * Restore auth state from backup
   */
  async restoreAuthState(userId: string, backupFilePath: string): Promise<void> {
    try {
      const backupData = JSON.parse(await fs.readFile(backupFilePath, 'utf-8'));
      
      if (backupData.userId !== userId) {
        throw new Error('Backup file userId does not match target userId');
      }

      await this.authStateModel.findOneAndUpdate(
        { userId },
        {
          credentials: backupData.credentials,
          keys: backupData.keys,
          phoneNumber: backupData.metadata?.phoneNumber,
          deviceName: backupData.metadata?.deviceName,
          lastUpdated: new Date(),
          persistencePolicy: backupData.metadata?.persistencePolicy || 'permanent'
        },
        { upsert: true }
      );

      // Clear cache to force reload
      this.clearCache(userId);

      this.logger.log(`[${userId}] Auth state restored from backup`);
    } catch (error) {
      this.logger.error(`[${userId}] Error restoring auth state:`, error);
      throw error;
    }
  }

  /**
   * Get serialization metrics for a user
   */
  getSerializationMetrics(userId: string): SessionStateMetrics | null {
    return this.metricsCache.get(userId) || null;
  }

  /**
   * Get comprehensive serialization statistics
   */
  async getSerializationStats(): Promise<any> {
    try {
      const totalStates = await this.authStateModel.countDocuments();
      const compressedStates = await this.authStateModel.countDocuments({
        'serializationMetadata.credsCompressed': true
      });

      const allMetrics = Array.from(this.metricsCache.values());
      const avgCompressionRatio = allMetrics.length > 0 ?
        allMetrics.reduce((sum, m) => sum + m.compressionRatio, 0) / allMetrics.length : 0;

      const avgSerializationTime = allMetrics.length > 0 ?
        allMetrics.reduce((sum, m) => sum + m.serializationTime, 0) / allMetrics.length : 0;

      const avgDeserializationTime = allMetrics.length > 0 ?
        allMetrics.reduce((sum, m) => sum + m.deserializationTime, 0) / allMetrics.length : 0;

      const totalOriginalSize = allMetrics.reduce((sum, m) => sum + m.originalSize, 0);
      const totalCompressedSize = allMetrics.reduce((sum, m) => sum + m.compressedSize, 0);

      return {
        totalStates,
        compressedStates,
        compressionRate: totalStates > 0 ? (compressedStates / totalStates * 100).toFixed(2) + '%' : '0%',
        avgCompressionRatio: avgCompressionRatio.toFixed(2),
        avgSerializationTime: Math.round(avgSerializationTime),
        avgDeserializationTime: Math.round(avgDeserializationTime),
        totalOriginalSize: Math.round(totalOriginalSize / 1024) + ' KB',
        totalCompressedSize: Math.round(totalCompressedSize / 1024) + ' KB',
        spaceSaved: totalOriginalSize > 0 ?
          (((totalOriginalSize - totalCompressedSize) / totalOriginalSize) * 100).toFixed(2) + '%' : '0%',
        serializationVersion: this.SERIALIZATION_VERSION,
        cacheSize: this.authStateCache.size,
        metricsCount: this.metricsCache.size
      };
    } catch (error) {
      this.logger.error('Error getting serialization stats:', error);
      return {
        error: 'Failed to get serialization statistics',
        serializationVersion: this.SERIALIZATION_VERSION,
        cacheSize: this.authStateCache.size,
        metricsCount: this.metricsCache.size
      };
    }
  }

  /**
   * Validate serialization integrity for a user
   */
  async validateSerializationIntegrity(userId: string): Promise<{
    valid: boolean;
    issues: string[];
    metrics?: SessionStateMetrics;
  }> {
    try {
      const authStateDoc = await this.authStateModel.findOne({ userId });
      if (!authStateDoc) {
        return {
          valid: false,
          issues: ['Auth state not found in database']
        };
      }

      const issues: string[] = [];
      const metadata = authStateDoc.serializationMetadata || {};

      // Check serialization version
      if (!metadata.version) {
        issues.push('Missing serialization version - may be legacy format');
      } else if (metadata.version !== this.SERIALIZATION_VERSION) {
        issues.push(`Serialization version mismatch: ${metadata.version} vs ${this.SERIALIZATION_VERSION}`);
      }

      // Check checksums
      if (!metadata.credsChecksum) {
        issues.push('Missing credentials checksum');
      }
      if (!metadata.keysChecksum) {
        issues.push('Missing keys checksum');
      }

      // Try to deserialize and validate
      try {
        const state = await this.deserializeAuthStateWithIntegrity(authStateDoc);
        this.validateAuthState(state);
      } catch (error) {
        issues.push(`Deserialization failed: ${error.message}`);
      }

      const metrics = this.metricsCache.get(userId);

      return {
        valid: issues.length === 0,
        issues,
        metrics
      };
    } catch (error) {
      return {
        valid: false,
        issues: [`Validation error: ${error.message}`]
      };
    }
  }

  /**
   * Cleanup old auth states (only for temporary sessions)
   */
  async cleanupExpiredAuthStates(): Promise<number> {
    try {
      const result = await this.authStateModel.deleteMany({
        persistencePolicy: 'temporary',
        sessionExpires: { $lt: new Date() }
      });

      if (result.deletedCount > 0) {
        this.logger.log(`Cleaned up ${result.deletedCount} expired temporary auth states`);
      }

      return result.deletedCount;
    } catch (error) {
      this.logger.error('Error cleaning up expired auth states:', error);
      return 0;
    }
  }
}
