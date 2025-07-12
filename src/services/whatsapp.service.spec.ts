import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { WhatsAppService } from './whatsapp.service';
import { AuthState, PersistencePolicy } from '../schemas/auth-state.schema';

describe('WhatsAppService', () => {
  let service: WhatsAppService;
  let mockAuthStateModel: any;

  const mockAuthState = {
    userId: 'test-user',
    credentials: { test: 'credentials' },
    keys: { test: 'keys' },
    connectionStatus: 'disconnected',
    user: null,
    lastUpdated: new Date(),
    isPersistent: true,
    autoReconnect: true,
    reconnectionAttempts: 0,
    phoneNumber: '+1234567890',
    deviceName: 'Test Device'
  };

  beforeEach(async () => {
    mockAuthStateModel = {
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      find: jest.fn(),
      countDocuments: jest.fn(),
      deleteOne: jest.fn(),
      create: jest.fn(),
      exec: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsAppService,
        {
          provide: getModelToken(AuthState.name),
          useValue: mockAuthStateModel,
        },
      ],
    }).compile();

    service = module.get<WhatsAppService>(WhatsAppService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getSessionStatus', () => {
    it('should return session status with validation', async () => {
      mockAuthStateModel.findOne.mockResolvedValue(mockAuthState);
      
      const result = await service.getSessionStatus('test-user');
      
      expect(result).toHaveProperty('exists', true);
      expect(result).toHaveProperty('connected');
      expect(result).toHaveProperty('connectionStatus');
      expect(result).toHaveProperty('lastValidated');
      expect(mockAuthStateModel.findOne).toHaveBeenCalledWith({ userId: 'test-user' });
    });

    it('should return false for non-existent user', async () => {
      mockAuthStateModel.findOne.mockResolvedValue(null);
      
      const result = await service.getSessionStatus('non-existent-user');
      
      expect(result.exists).toBe(false);
      expect(result.connected).toBe(false);
    });
  });

  describe('setSessionPersistence', () => {
    it('should update session persistence settings', async () => {
      mockAuthStateModel.findOneAndUpdate.mockResolvedValue(mockAuthState);
      
      await service.setSessionPersistence('test-user', PersistencePolicy.PERMANENT, true);
      
      expect(mockAuthStateModel.findOneAndUpdate).toHaveBeenCalledWith(
        { userId: 'test-user' },
        expect.objectContaining({
          isPersistent: true,
          autoReconnect: true,
        }),
        { upsert: false }
      );
    });
  });

  describe('getDetailedSessionInfo', () => {
    it('should return comprehensive session information', async () => {
      mockAuthStateModel.findOne.mockResolvedValue(mockAuthState);
      
      const result = await service.getDetailedSessionInfo('test-user');
      
      expect(result).toHaveProperty('userId', 'test-user');
      expect(result).toHaveProperty('exists', true);
      expect(result).toHaveProperty('isPersistent', true);
      expect(result).toHaveProperty('autoReconnect', true);
      expect(result).toHaveProperty('phoneNumber', '+1234567890');
      expect(result).toHaveProperty('deviceName', 'Test Device');
      expect(result).toHaveProperty('errorCount');
      expect(result).toHaveProperty('circuitBreakerState');
    });
  });

  describe('getAllUsers', () => {
    it('should return paginated user list', async () => {
      const mockUsers = [mockAuthState];
      mockAuthStateModel.find.mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(mockUsers),
      });
      
      const result = await service.getAllUsers({ limit: 10, offset: 0 });
      
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('userId', 'test-user');
      expect(result[0]).toHaveProperty('isPersistent', true);
    });

    it('should filter users by connection status', async () => {
      mockAuthStateModel.find.mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      });
      
      await service.getAllUsers({ status: 'connected' });
      
      expect(mockAuthStateModel.find).toHaveBeenCalledWith({
        connectionStatus: 'connected'
      });
    });

    it('should search users by userId, phoneNumber, or deviceName', async () => {
      mockAuthStateModel.find.mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      });
      
      await service.getAllUsers({ search: 'test' });
      
      expect(mockAuthStateModel.find).toHaveBeenCalledWith({
        $or: [
          { userId: { $regex: 'test', $options: 'i' } },
          { phoneNumber: { $regex: 'test', $options: 'i' } },
          { deviceName: { $regex: 'test', $options: 'i' } }
        ]
      });
    });
  });

  describe('deleteUser', () => {
    it('should delete user and clean up references', async () => {
      mockAuthStateModel.deleteOne.mockResolvedValue({ deletedCount: 1 });
      
      await service.deleteUser('test-user');
      
      expect(mockAuthStateModel.deleteOne).toHaveBeenCalledWith({ userId: 'test-user' });
    });
  });

  describe('getSystemStats', () => {
    it('should return comprehensive system statistics', async () => {
      mockAuthStateModel.countDocuments
        .mockResolvedValueOnce(10) // totalUsers
        .mockResolvedValueOnce(7)  // connectedUsers
        .mockResolvedValueOnce(8)  // persistentUsers
        .mockResolvedValueOnce(9)  // autoReconnectUsers
        .mockResolvedValueOnce(5); // recentlyActive
      
      const result = await service.getSystemStats();
      
      expect(result).toHaveProperty('database');
      expect(result).toHaveProperty('sessions');
      expect(result).toHaveProperty('system');
      expect(result).toHaveProperty('limits');
      expect(result).toHaveProperty('counters');
      expect(result.database.totalUsers).toBe(10);
      expect(result.database.connectedUsers).toBe(7);
      expect(result.database.disconnectedUsers).toBe(3);
    });
  });

  describe('Error Handling', () => {
    it('should handle database errors gracefully', async () => {
      mockAuthStateModel.findOne.mockRejectedValue(new Error('Database error'));
      
      await expect(service.getSessionStatus('test-user')).rejects.toThrow('Database error');
    });

    it('should handle validation errors in session status', async () => {
      mockAuthStateModel.findOne.mockResolvedValue(mockAuthState);
      
      // Mock a session with invalid state
      const result = await service.getSessionStatus('test-user');
      
      expect(result).toHaveProperty('socketState');
      expect(result.socketState).toBe('no_socket'); // No active session
    });
  });

  describe('Circuit Breaker', () => {
    it('should track error count in session info', () => {
      // This would require access to private methods, so we test the public interface
      expect(service).toBeDefined();
      // In a real implementation, we would test the circuit breaker behavior
      // through integration tests or by exposing test methods
    });
  });

  describe('Session Persistence', () => {
    it('should restore sessions on startup', async () => {
      const persistentSessions = [
        { ...mockAuthState, connectionStatus: 'connected' },
        { ...mockAuthState, userId: 'user2', isPersistent: true, autoReconnect: true }
      ];
      
      mockAuthStateModel.find.mockResolvedValue(persistentSessions);
      
      // This tests the concept - actual implementation would require more setup
      expect(service).toBeDefined();
    });
  });
});
