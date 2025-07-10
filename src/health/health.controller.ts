import {
  Controller,
  Get,
  Post,
  Param,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { SessionHealthService, SystemHealth, HealthCheckResult } from '../services/session-health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly sessionHealthService: SessionHealthService) {}

  /**
   * Get overall system health status
   */
  @Get('system')
  async getSystemHealth(): Promise<{ success: boolean; data: SystemHealth; message: string }> {
    try {
      const systemHealth = await this.sessionHealthService.getCurrentSystemHealth();
      
      return {
        success: true,
        data: systemHealth,
        message: `System health: ${systemHealth.overall}`,
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: 'Failed to retrieve system health',
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get health status for a specific user
   */
  @Get('user/:userId')
  async getUserHealth(@Param('userId') userId: string): Promise<{ success: boolean; data: HealthCheckResult; message: string }> {
    try {
      const userHealth = await this.sessionHealthService.getUserHealth(userId);
      
      return {
        success: true,
        data: userHealth,
        message: `User ${userId} health: ${userHealth.isHealthy ? 'healthy' : 'unhealthy'}`,
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: 'Failed to retrieve user health',
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Trigger manual system health check
   */
  @Post('check')
  async triggerHealthCheck(): Promise<{ success: boolean; data: SystemHealth; message: string }> {
    try {
      const systemHealth = await this.sessionHealthService.performSystemHealthCheck();
      
      return {
        success: true,
        data: systemHealth,
        message: 'Health check completed successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: 'Health check failed',
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Simple health endpoint for load balancers
   */
  @Get()
  async simpleHealthCheck() {
    try {
      // Quick health check without full system analysis
      const systemHealth = await this.sessionHealthService.getCurrentSystemHealth();
      
      if (systemHealth.overall === 'critical') {
        throw new HttpException(
          {
            status: HttpStatus.SERVICE_UNAVAILABLE,
            error: 'System is in critical state',
            message: 'Service temporarily unavailable',
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      
      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        systemHealth: systemHealth.overall
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: 'Health check failed',
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
