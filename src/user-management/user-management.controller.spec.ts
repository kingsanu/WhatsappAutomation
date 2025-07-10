import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { UserManagementController } from './user-management.controller';
import { WhatsAppService } from '../services/whatsapp.service';

describe('UserManagementController', () => {
  let controller: UserManagementController;
  let mockWhatsAppService: any;

  const mockUser = {
    userId: 'test-user',
    connected: true,
    connectionStatus: 'connected',
    isSessionActive: true,
    isPersistent: true,
    autoReconnect: true,
    phoneNumber: '+1234567890',
    deviceName: 'Test Device',
    lastUpdated: new Date(),
    errorCount: 0,
    circuitBreakerState: 'closed'
  };

  beforeEach(async () => {
    mockWhatsAppService = {
      getAllUsers: jest.fn(),
      getDetailedSessionInfo: jest.fn(),
      getSessionStatus: jest.fn(),
      sendMessage: jest.fn(),
      setSessionPersistence: jest.fn(),
      clearUserSession: jest.fn(),
      deleteUser: jest.fn(),
      getSystemStats: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserManagementController],
      providers: [
        {
          provide: WhatsAppService,
          useValue: mockWhatsAppService,
        },
      ],
    }).compile();

    controller = module.get<UserManagementController>(UserManagementController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getAllUsers', () => {
    it('should return paginated user list', async () => {
      const mockUsers = [mockUser];
      mockWhatsAppService.getAllUsers.mockResolvedValue(mockUsers);

      const result = await controller.getAllUsers({});

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockUsers);
      expect(result.pagination).toHaveProperty('limit');
      expect(result.pagination).toHaveProperty('offset');
      expect(mockWhatsAppService.getAllUsers).toHaveBeenCalledWith({
        status: 'all',
        limit: 50,
        offset: 0,
        search: undefined
      });
    });

    it('should filter users by status', async () => {
      mockWhatsAppService.getAllUsers.mockResolvedValue([]);

      await controller.getAllUsers({ status: 'connected' });

      expect(mockWhatsAppService.getAllUsers).toHaveBeenCalledWith({
        status: 'connected',
        limit: 50,
        offset: 0,
        search: undefined
      });
    });

    it('should limit results to maximum of 100', async () => {
      mockWhatsAppService.getAllUsers.mockResolvedValue([]);

      await controller.getAllUsers({ limit: 200 });

      expect(mockWhatsAppService.getAllUsers).toHaveBeenCalledWith({
        status: 'all',
        limit: 100, // Should be capped at 100
        offset: 0,
        search: undefined
      });
    });

    it('should handle service errors', async () => {
      mockWhatsAppService.getAllUsers.mockRejectedValue(new Error('Service error'));

      await expect(controller.getAllUsers({})).rejects.toThrow(HttpException);
    });
  });

  describe('getUserDetails', () => {
    it('should return user details', async () => {
      const mockDetails = { ...mockUser, exists: true };
      mockWhatsAppService.getDetailedSessionInfo.mockResolvedValue(mockDetails);

      const result = await controller.getUserDetails('test-user');

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockDetails);
      expect(mockWhatsAppService.getDetailedSessionInfo).toHaveBeenCalledWith('test-user');
    });

    it('should return 404 for non-existent user', async () => {
      mockWhatsAppService.getDetailedSessionInfo.mockResolvedValue({ exists: false });

      await expect(controller.getUserDetails('non-existent')).rejects.toThrow(
        new HttpException(
          expect.objectContaining({
            status: HttpStatus.NOT_FOUND,
          }),
          HttpStatus.NOT_FOUND
        )
      );
    });
  });

  describe('getUserStatus', () => {
    it('should return user status', async () => {
      const mockStatus = { connected: true, connectionStatus: 'connected' };
      mockWhatsAppService.getSessionStatus.mockResolvedValue(mockStatus);

      const result = await controller.getUserStatus('test-user');

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockStatus);
    });
  });

  describe('sendMessage', () => {
    it('should send message successfully', async () => {
      mockWhatsAppService.getSessionStatus.mockResolvedValue({ connected: true });
      mockWhatsAppService.sendMessage.mockResolvedValue({ messageId: 'msg123' });

      const result = await controller.sendMessage('test-user', {
        number: '1234567890',
        message: 'Test message'
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ messageId: 'msg123' });
      expect(mockWhatsAppService.sendMessage).toHaveBeenCalledWith(
        'test-user',
        '1234567890',
        'Test message',
        undefined
      );
    });

    it('should format phone number correctly', async () => {
      mockWhatsAppService.getSessionStatus.mockResolvedValue({ connected: true });
      mockWhatsAppService.sendMessage.mockResolvedValue({ messageId: 'msg123' });

      await controller.sendMessage('test-user', {
        number: '+1234567890',
        message: 'Test message'
      });

      expect(mockWhatsAppService.sendMessage).toHaveBeenCalledWith(
        'test-user',
        '1234567890', // Plus sign should be removed
        'Test message',
        undefined
      );
    });

    it('should reject if neither message nor document provided', async () => {
      await expect(controller.sendMessage('test-user', {
        number: '1234567890'
      })).rejects.toThrow(
        new HttpException(
          expect.objectContaining({
            status: HttpStatus.BAD_REQUEST,
          }),
          HttpStatus.BAD_REQUEST
        )
      );
    });

    it('should reject if session not connected', async () => {
      mockWhatsAppService.getSessionStatus.mockResolvedValue({ 
        connected: false, 
        connectionStatus: 'disconnected' 
      });

      await expect(controller.sendMessage('test-user', {
        number: '1234567890',
        message: 'Test message'
      })).rejects.toThrow(
        new HttpException(
          expect.objectContaining({
            status: HttpStatus.BAD_REQUEST,
          }),
          HttpStatus.BAD_REQUEST
        )
      );
    });
  });

  describe('setSessionPersistence', () => {
    it('should update session persistence', async () => {
      mockWhatsAppService.setSessionPersistence.mockResolvedValue(undefined);

      const result = await controller.setSessionPersistence('test-user', {
        isPersistent: true,
        autoReconnect: true
      });

      expect(result.success).toBe(true);
      expect(result.data.isPersistent).toBe(true);
      expect(result.data.autoReconnect).toBe(true);
      expect(mockWhatsAppService.setSessionPersistence).toHaveBeenCalledWith(
        'test-user',
        true,
        true
      );
    });

    it('should default autoReconnect to true', async () => {
      mockWhatsAppService.setSessionPersistence.mockResolvedValue(undefined);

      await controller.setSessionPersistence('test-user', {
        isPersistent: false
      });

      expect(mockWhatsAppService.setSessionPersistence).toHaveBeenCalledWith(
        'test-user',
        false,
        true // Default value
      );
    });
  });

  describe('disconnectUser', () => {
    it('should disconnect user session', async () => {
      mockWhatsAppService.clearUserSession.mockResolvedValue(undefined);

      const result = await controller.disconnectUser('test-user');

      expect(result.success).toBe(true);
      expect(result.message).toContain('disconnected successfully');
      expect(mockWhatsAppService.clearUserSession).toHaveBeenCalledWith('test-user');
    });
  });

  describe('deleteUser', () => {
    it('should delete user completely', async () => {
      mockWhatsAppService.deleteUser.mockResolvedValue(undefined);

      const result = await controller.deleteUser('test-user');

      expect(result.success).toBe(true);
      expect(result.message).toContain('deleted successfully');
      expect(mockWhatsAppService.deleteUser).toHaveBeenCalledWith('test-user');
    });
  });

  describe('getSystemStats', () => {
    it('should return system statistics', async () => {
      const mockStats = {
        database: { totalUsers: 10, connectedUsers: 7 },
        sessions: { activeSessionCount: 5 },
        system: { memoryUsageMB: 512 }
      };
      mockWhatsAppService.getSystemStats.mockResolvedValue(mockStats);

      const result = await controller.getSystemStats();

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockStats);
    });
  });

  describe('Error Handling', () => {
    it('should handle service errors gracefully', async () => {
      mockWhatsAppService.getAllUsers.mockRejectedValue(new Error('Database connection failed'));

      await expect(controller.getAllUsers({})).rejects.toThrow(HttpException);
    });

    it('should preserve HttpExceptions from service', async () => {
      const httpError = new HttpException('Custom error', HttpStatus.FORBIDDEN);
      mockWhatsAppService.getDetailedSessionInfo.mockRejectedValue(httpError);

      await expect(controller.getUserDetails('test-user')).rejects.toThrow(httpError);
    });
  });
});
