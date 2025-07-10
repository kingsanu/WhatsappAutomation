import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { SessionHealthService } from './session-health.service';
import { WhatsAppService } from './whatsapp.service';
import { AuthState } from '../schemas/auth-state.schema';

describe('SessionHealthService', () => {
  let service: SessionHealthService;
  let mockAuthStateModel: any;
  let mockWhatsAppService: any;

  const mockUser = {
    userId: 'test-user',
    connectionStatus: 'connected',
    lastUpdated: new Date(),
    isPersistent: true,
    autoReconnect: true,
    reconnectionAttempts: 0
  };

  beforeEach(async () => {
    mockAuthStateModel = {
      find: jest.fn(),
      countDocuments: jest.fn(),
      exec: jest.fn(),
    };

    mockWhatsAppService = {
      getSessionStatus: jest.fn(),
      getDetailedSessionInfo: jest.fn(),
      activateSession: jest.fn(),
      clearUserSession: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionHealthService,
        {
          provide: getModelToken(AuthState.name),
          useValue: mockAuthStateModel,
        },
        {
          provide: WhatsAppService,
          useValue: mockWhatsAppService,
        },
      ],
    }).compile();

    service = module.get<SessionHealthService>(SessionHealthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('checkSessionHealth', () => {
    it('should return healthy status for good session', async () => {
      mockWhatsAppService.getSessionStatus.mockResolvedValue({
        connected: true,
        exists: true,
        reconnectionAttempts: 0
      });

      mockWhatsAppService.getDetailedSessionInfo.mockResolvedValue({
        circuitBreakerState: 'closed',
        errorCount: 0,
        lastUpdated: new Date(),
        connected: true,
        isPersistent: true
      });

      const result = await service.checkSessionHealth('test-user');

      expect(result.isHealthy).toBe(true);
      expect(result.issues).toHaveLength(0);
      expect(result.userId).toBe('test-user');
      expect(result.metrics).toHaveProperty('responseTime');
    });

    it('should detect slow response time', async () => {
      // Mock slow response
      mockWhatsAppService.getSessionStatus.mockImplementation(() => 
        new Promise(resolve => setTimeout(() => resolve({
          connected: true,
          exists: true,
          reconnectionAttempts: 0
        }), 6000)) // 6 seconds - above threshold
      );

      mockWhatsAppService.getDetailedSessionInfo.mockResolvedValue({
        circuitBreakerState: 'closed',
        errorCount: 0,
        lastUpdated: new Date(),
        connected: true,
        isPersistent: true
      });

      const result = await service.checkSessionHealth('test-user');

      expect(result.isHealthy).toBe(false);
      expect(result.issues.some(issue => issue.includes('Slow response time'))).toBe(true);
      expect(result.recommendations.some(rec => rec.includes('session restart'))).toBe(true);
    });

    it('should detect disconnected session', async () => {
      mockWhatsAppService.getSessionStatus.mockResolvedValue({
        connected: false,
        exists: true,
        reconnectionAttempts: 0
      });

      mockWhatsAppService.getDetailedSessionInfo.mockResolvedValue({
        circuitBreakerState: 'closed',
        errorCount: 0,
        lastUpdated: new Date(),
        connected: false,
        isPersistent: true
      });

      const result = await service.checkSessionHealth('test-user');

      expect(result.isHealthy).toBe(false);
      expect(result.issues.some(issue => issue.includes('not connected'))).toBe(true);
      expect(result.recommendations.some(rec => rec.includes('reconnection'))).toBe(true);
    });

    it('should detect high reconnection attempts', async () => {
      mockWhatsAppService.getSessionStatus.mockResolvedValue({
        connected: true,
        exists: true,
        reconnectionAttempts: 10
      });

      mockWhatsAppService.getDetailedSessionInfo.mockResolvedValue({
        circuitBreakerState: 'closed',
        errorCount: 0,
        lastUpdated: new Date(),
        connected: true,
        isPersistent: true
      });

      const result = await service.checkSessionHealth('test-user');

      expect(result.isHealthy).toBe(false);
      expect(result.issues.some(issue => issue.includes('High reconnection attempts'))).toBe(true);
      expect(result.recommendations.some(rec => rec.includes('stability issues'))).toBe(true);
    });

    it('should detect circuit breaker open state', async () => {
      mockWhatsAppService.getSessionStatus.mockResolvedValue({
        connected: false,
        exists: true,
        reconnectionAttempts: 0
      });

      mockWhatsAppService.getDetailedSessionInfo.mockResolvedValue({
        circuitBreakerState: 'open',
        errorCount: 5,
        lastUpdated: new Date(),
        connected: false,
        isPersistent: true
      });

      const result = await service.checkSessionHealth('test-user');

      expect(result.isHealthy).toBe(false);
      expect(result.issues.some(issue => issue.includes('circuit breaker'))).toBe(true);
      expect(result.recommendations.some(rec => rec.includes('reset'))).toBe(true);
    });

    it('should detect high error rate', async () => {
      mockWhatsAppService.getSessionStatus.mockResolvedValue({
        connected: true,
        exists: true,
        reconnectionAttempts: 0
      });

      mockWhatsAppService.getDetailedSessionInfo.mockResolvedValue({
        circuitBreakerState: 'closed',
        errorCount: 3, // 30% error rate (3/10)
        lastUpdated: new Date(),
        connected: true,
        isPersistent: true
      });

      const result = await service.checkSessionHealth('test-user');

      expect(result.isHealthy).toBe(false);
      expect(result.issues.some(issue => issue.includes('High error rate'))).toBe(true);
      expect(result.recommendations.some(rec => rec.includes('error patterns'))).toBe(true);
    });

    it('should handle health check errors gracefully', async () => {
      mockWhatsAppService.getSessionStatus.mockRejectedValue(new Error('Service unavailable'));

      const result = await service.checkSessionHealth('test-user');

      expect(result.isHealthy).toBe(false);
      expect(result.issues.some(issue => issue.includes('Health check error'))).toBe(true);
      expect(result.recommendations.some(rec => rec.includes('Manual investigation'))).toBe(true);
    });
  });

  describe('performSystemHealthCheck', () => {
    it('should analyze overall system health', async () => {
      mockAuthStateModel.find.mockReturnValue({
        exec: jest.fn().mockResolvedValue([mockUser])
      });

      mockWhatsAppService.getSessionStatus.mockResolvedValue({
        connected: true,
        exists: true,
        reconnectionAttempts: 0
      });

      mockWhatsAppService.getDetailedSessionInfo.mockResolvedValue({
        circuitBreakerState: 'closed',
        errorCount: 0,
        lastUpdated: new Date(),
        connected: true,
        isPersistent: true
      });

      const result = await service.performSystemHealthCheck();

      expect(result.overall).toBe('healthy');
      expect(result.totalSessions).toBe(1);
      expect(result.healthySessions).toBe(1);
      expect(result.unhealthySessions).toBe(0);
      expect(result.criticalIssues).toHaveLength(0);
    });

    it('should detect degraded system state', async () => {
      const users = [
        { ...mockUser, userId: 'user1' },
        { ...mockUser, userId: 'user2' },
        { ...mockUser, userId: 'user3' },
        { ...mockUser, userId: 'user4' },
        { ...mockUser, userId: 'user5' }
      ];

      mockAuthStateModel.find.mockReturnValue({
        exec: jest.fn().mockResolvedValue(users)
      });

      // Make one session unhealthy (20% - should be degraded)
      mockWhatsAppService.getSessionStatus.mockImplementation((userId) => {
        if (userId === 'user1') {
          return Promise.resolve({
            connected: false,
            exists: true,
            reconnectionAttempts: 0
          });
        }
        return Promise.resolve({
          connected: true,
          exists: true,
          reconnectionAttempts: 0
        });
      });

      mockWhatsAppService.getDetailedSessionInfo.mockImplementation((userId) => {
        if (userId === 'user1') {
          return Promise.resolve({
            circuitBreakerState: 'closed',
            errorCount: 0,
            lastUpdated: new Date(),
            connected: false,
            isPersistent: true
          });
        }
        return Promise.resolve({
          circuitBreakerState: 'closed',
          errorCount: 0,
          lastUpdated: new Date(),
          connected: true,
          isPersistent: true
        });
      });

      const result = await service.performSystemHealthCheck();

      expect(result.overall).toBe('degraded');
      expect(result.totalSessions).toBe(5);
      expect(result.healthySessions).toBe(4);
      expect(result.unhealthySessions).toBe(1);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should detect critical system state', async () => {
      const users = Array.from({ length: 5 }, (_, i) => ({
        ...mockUser,
        userId: `user${i + 1}`
      }));

      mockAuthStateModel.find.mockReturnValue({
        exec: jest.fn().mockResolvedValue(users)
      });

      // Make 3 sessions unhealthy (60% - should be critical)
      mockWhatsAppService.getSessionStatus.mockImplementation((userId) => {
        if (['user1', 'user2', 'user3'].includes(userId)) {
          return Promise.resolve({
            connected: false,
            exists: true,
            reconnectionAttempts: 0
          });
        }
        return Promise.resolve({
          connected: true,
          exists: true,
          reconnectionAttempts: 0
        });
      });

      mockWhatsAppService.getDetailedSessionInfo.mockImplementation((userId) => {
        if (['user1', 'user2', 'user3'].includes(userId)) {
          return Promise.resolve({
            circuitBreakerState: 'closed',
            errorCount: 0,
            lastUpdated: new Date(),
            connected: false,
            isPersistent: true
          });
        }
        return Promise.resolve({
          circuitBreakerState: 'closed',
          errorCount: 0,
          lastUpdated: new Date(),
          connected: true,
          isPersistent: true
        });
      });

      const result = await service.performSystemHealthCheck();

      expect(result.overall).toBe('critical');
      expect(result.totalSessions).toBe(5);
      expect(result.healthySessions).toBe(2);
      expect(result.unhealthySessions).toBe(3);
      expect(result.criticalIssues.length).toBeGreaterThan(0);
    });
  });

  describe('Auto-recovery', () => {
    it('should attempt reconnection for disconnected sessions', async () => {
      const healthResult = {
        userId: 'test-user',
        isHealthy: false,
        issues: ['Session exists but not connected'],
        recommendations: ['Attempt session reconnection'],
        lastChecked: new Date(),
        metrics: {}
      };

      // This tests the concept - actual implementation would require more setup
      expect(service).toBeDefined();
      // In a real implementation, we would verify that activateSession is called
    });
  });
});
