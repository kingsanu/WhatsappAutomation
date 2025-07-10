import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuthState, AuthStateDocument } from '../schemas/auth-state.schema';
import { WhatsAppService } from './whatsapp.service';

export interface HealthCheckResult {
  userId: string;
  isHealthy: boolean;
  issues: string[];
  recommendations: string[];
  lastChecked: Date;
  metrics: {
    responseTime?: number;
    errorRate?: number;
    uptime?: number;
    lastActivity?: Date;
  };
}

export interface SystemHealth {
  overall: 'healthy' | 'degraded' | 'critical';
  totalSessions: number;
  healthySessions: number;
  unhealthySessions: number;
  criticalIssues: string[];
  warnings: string[];
  recommendations: string[];
  lastCheck: Date;
}

@Injectable()
export class SessionHealthService implements OnModuleInit {
  private readonly logger = new Logger(SessionHealthService.name);
  private healthCheckInterval: NodeJS.Timeout;
  private readonly HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL || '300000'); // 5 minutes
  private readonly RESPONSE_TIME_THRESHOLD = parseInt(process.env.RESPONSE_TIME_THRESHOLD || '5000'); // 5 seconds
  private readonly ERROR_RATE_THRESHOLD = parseFloat(process.env.ERROR_RATE_THRESHOLD || '0.1'); // 10%
  private readonly INACTIVITY_THRESHOLD = parseInt(process.env.INACTIVITY_THRESHOLD || '3600000'); // 1 hour

  constructor(
    @InjectModel(AuthState.name)
    private authStateModel: Model<AuthStateDocument>,
    private whatsappService: WhatsAppService,
  ) {}

  async onModuleInit() {
    this.logger.log('Session Health Service initialized');
    
    // Start periodic health checks
    this.startHealthMonitoring();
    
    // Perform initial health check
    setTimeout(() => {
      this.performSystemHealthCheck().catch(error => {
        this.logger.error('Initial health check failed:', error);
      });
    }, 10000); // Wait 10 seconds after startup
  }

  /**
   * Start periodic health monitoring
   */
  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(async () => {
      try {
        await this.performSystemHealthCheck();
      } catch (error) {
        this.logger.error('Periodic health check failed:', error);
      }
    }, this.HEALTH_CHECK_INTERVAL);

    this.logger.log(`Health monitoring started with ${this.HEALTH_CHECK_INTERVAL}ms interval`);
  }

  /**
   * Stop health monitoring
   */
  stopHealthMonitoring(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.logger.log('Health monitoring stopped');
    }
  }

  /**
   * Perform comprehensive system health check
   */
  async performSystemHealthCheck(): Promise<SystemHealth> {
    const startTime = Date.now();
    this.logger.log('Starting system health check...');

    try {
      // Get all users from database
      const allUsers = await this.authStateModel.find({}).exec();
      const healthResults: HealthCheckResult[] = [];
      
      // Check health of each session
      for (const user of allUsers) {
        try {
          const healthResult = await this.checkSessionHealth(user.userId);
          healthResults.push(healthResult);
        } catch (error) {
          this.logger.error(`Health check failed for user ${user.userId}:`, error);
          healthResults.push({
            userId: user.userId,
            isHealthy: false,
            issues: [`Health check failed: ${error.message}`],
            recommendations: ['Manual intervention required'],
            lastChecked: new Date(),
            metrics: {}
          });
        }
      }

      // Analyze overall system health
      const systemHealth = this.analyzeSystemHealth(healthResults);
      
      // Log health summary
      const duration = Date.now() - startTime;
      this.logger.log(`Health check completed in ${duration}ms. Overall: ${systemHealth.overall}, Healthy: ${systemHealth.healthySessions}/${systemHealth.totalSessions}`);
      
      // Take corrective actions if needed
      await this.takeCorrectiveActions(healthResults);
      
      return systemHealth;
    } catch (error) {
      this.logger.error('System health check failed:', error);
      throw error;
    }
  }

  /**
   * Check health of a specific session
   */
  async checkSessionHealth(userId: string): Promise<HealthCheckResult> {
    const startTime = Date.now();
    const issues: string[] = [];
    const recommendations: string[] = [];
    const metrics: any = {};

    try {
      // Get session status with response time measurement
      const statusStartTime = Date.now();
      const sessionStatus = await this.whatsappService.getSessionStatus(userId);
      metrics.responseTime = Date.now() - statusStartTime;

      // Check response time
      if (metrics.responseTime > this.RESPONSE_TIME_THRESHOLD) {
        issues.push(`Slow response time: ${metrics.responseTime}ms`);
        recommendations.push('Consider session restart if performance continues to degrade');
      }

      // Check connection status
      if (!sessionStatus.connected && sessionStatus.exists) {
        issues.push('Session exists but not connected');
        recommendations.push('Attempt session reconnection');
      }

      // Check for excessive reconnection attempts
      if (sessionStatus.reconnectionAttempts > 5) {
        issues.push(`High reconnection attempts: ${sessionStatus.reconnectionAttempts}`);
        recommendations.push('Investigate connection stability issues');
      }

      // Check for circuit breaker state
      const detailedInfo = await this.whatsappService.getDetailedSessionInfo(userId);
      if (detailedInfo.circuitBreakerState === 'open') {
        issues.push('Circuit breaker is open - session blocked due to errors');
        recommendations.push('Wait for circuit breaker reset or manually reset session');
      }

      // Check error rate
      if (detailedInfo.errorCount > 0) {
        const errorRate = detailedInfo.errorCount / 10; // Assuming 10 operations window
        metrics.errorRate = errorRate;
        
        if (errorRate > this.ERROR_RATE_THRESHOLD) {
          issues.push(`High error rate: ${(errorRate * 100).toFixed(1)}%`);
          recommendations.push('Investigate error patterns and consider session reset');
        }
      }

      // Check inactivity
      if (detailedInfo.lastUpdated) {
        const inactivityTime = Date.now() - new Date(detailedInfo.lastUpdated).getTime();
        metrics.uptime = inactivityTime;
        
        if (inactivityTime > this.INACTIVITY_THRESHOLD && detailedInfo.connected) {
          issues.push(`Long inactivity period: ${Math.round(inactivityTime / 60000)} minutes`);
          recommendations.push('Verify session is still responsive');
        }
      }

      // Check for persistent session configuration
      if (!detailedInfo.isPersistent && detailedInfo.connected) {
        recommendations.push('Consider enabling session persistence for better reliability');
      }

      const isHealthy = issues.length === 0;
      
      return {
        userId,
        isHealthy,
        issues,
        recommendations,
        lastChecked: new Date(),
        metrics
      };

    } catch (error) {
      return {
        userId,
        isHealthy: false,
        issues: [`Health check error: ${error.message}`],
        recommendations: ['Manual investigation required'],
        lastChecked: new Date(),
        metrics: { responseTime: Date.now() - startTime }
      };
    }
  }

  /**
   * Analyze overall system health based on individual session results
   */
  private analyzeSystemHealth(healthResults: HealthCheckResult[]): SystemHealth {
    const totalSessions = healthResults.length;
    const healthySessions = healthResults.filter(r => r.isHealthy).length;
    const unhealthySessions = totalSessions - healthySessions;
    
    const criticalIssues: string[] = [];
    const warnings: string[] = [];
    const recommendations: string[] = [];

    // Analyze patterns across all sessions
    const highErrorRateSessions = healthResults.filter(r => 
      r.metrics.errorRate && r.metrics.errorRate > this.ERROR_RATE_THRESHOLD
    ).length;
    
    const slowResponseSessions = healthResults.filter(r => 
      r.metrics.responseTime && r.metrics.responseTime > this.RESPONSE_TIME_THRESHOLD
    ).length;

    const circuitBreakerOpenSessions = healthResults.filter(r => 
      r.issues.some(issue => issue.includes('circuit breaker'))
    ).length;

    // Determine overall health status
    let overall: 'healthy' | 'degraded' | 'critical';
    
    if (unhealthySessions === 0) {
      overall = 'healthy';
    } else if (unhealthySessions / totalSessions < 0.2) { // Less than 20% unhealthy
      overall = 'degraded';
      warnings.push(`${unhealthySessions} sessions are unhealthy`);
    } else {
      overall = 'critical';
      criticalIssues.push(`${unhealthySessions} sessions are unhealthy (${((unhealthySessions/totalSessions)*100).toFixed(1)}%)`);
    }

    // Add specific warnings and recommendations
    if (highErrorRateSessions > 0) {
      warnings.push(`${highErrorRateSessions} sessions have high error rates`);
      recommendations.push('Investigate error patterns and consider session resets');
    }

    if (slowResponseSessions > 0) {
      warnings.push(`${slowResponseSessions} sessions have slow response times`);
      recommendations.push('Monitor system resources and consider scaling');
    }

    if (circuitBreakerOpenSessions > 0) {
      criticalIssues.push(`${circuitBreakerOpenSessions} sessions have circuit breakers open`);
      recommendations.push('Review error logs and reset problematic sessions');
    }

    return {
      overall,
      totalSessions,
      healthySessions,
      unhealthySessions,
      criticalIssues,
      warnings,
      recommendations,
      lastCheck: new Date()
    };
  }

  /**
   * Take corrective actions based on health check results
   */
  private async takeCorrectiveActions(healthResults: HealthCheckResult[]): Promise<void> {
    for (const result of healthResults) {
      if (!result.isHealthy) {
        await this.handleUnhealthySession(result);
      }
    }
  }

  /**
   * Handle an unhealthy session with automatic recovery attempts
   */
  private async handleUnhealthySession(healthResult: HealthCheckResult): Promise<void> {
    const { userId, issues, recommendations } = healthResult;
    
    this.logger.warn(`Unhealthy session detected for ${userId}:`, { issues, recommendations });

    try {
      // Auto-recovery logic based on specific issues
      for (const issue of issues) {
        if (issue.includes('not connected') && issue.includes('exists')) {
          this.logger.log(`[${userId}] Attempting automatic reconnection for disconnected session`);
          // The WhatsApp service should handle this automatically, but we can trigger it
          await this.whatsappService.activateSession(userId);
        }
        
        if (issue.includes('circuit breaker')) {
          this.logger.log(`[${userId}] Circuit breaker is open, scheduling reset check`);
          // Circuit breaker will reset automatically after timeout
        }
        
        if (issue.includes('High reconnection attempts')) {
          this.logger.log(`[${userId}] High reconnection attempts detected, clearing session for fresh start`);
          await this.whatsappService.clearUserSession(userId);
        }
      }
    } catch (error) {
      this.logger.error(`[${userId}] Auto-recovery failed:`, error);
    }
  }

  /**
   * Get current system health status
   */
  async getCurrentSystemHealth(): Promise<SystemHealth> {
    return this.performSystemHealthCheck();
  }

  /**
   * Get health status for a specific user
   */
  async getUserHealth(userId: string): Promise<HealthCheckResult> {
    return this.checkSessionHealth(userId);
  }
}
