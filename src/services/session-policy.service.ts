import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuthState, AuthStateDocument, SessionStatus, PersistencePolicy } from '../schemas/auth-state.schema';
import { getSessionConfig, SessionConfig } from '../config/session-config';

export interface SessionPolicyRule {
  id: string;
  name: string;
  description: string;
  condition: (session: AuthStateDocument) => boolean;
  action: (session: AuthStateDocument) => Promise<void>;
  priority: number;
  enabled: boolean;
  lastExecuted?: Date;
  executionCount: number;
}

export interface PolicyExecutionResult {
  ruleId: string;
  sessionId: string;
  action: string;
  success: boolean;
  error?: string;
  timestamp: Date;
}

@Injectable()
export class SessionPolicyService implements OnModuleInit {
  private readonly logger = new Logger(SessionPolicyService.name);
  private readonly config: SessionConfig;
  private policyRules: SessionPolicyRule[] = [];
  private policyInterval: NodeJS.Timeout | null = null;
  private executionHistory: PolicyExecutionResult[] = [];
  private readonly maxHistorySize = 1000;

  constructor(
    @InjectModel(AuthState.name)
    private authStateModel: Model<AuthStateDocument>,
  ) {
    this.config = getSessionConfig();
    this.initializePolicyRules();
  }

  async onModuleInit() {
    this.logger.log('Session Policy Service initialized');
    this.startPolicyExecution();
  }

  private initializePolicyRules(): void {
    this.policyRules = [
      // Rule 1: Ensure all sessions have permanent persistence by default
      {
        id: 'ensure_permanent_persistence',
        name: 'Ensure Permanent Persistence',
        description: 'Set all sessions without explicit persistence policy to permanent',
        condition: (session) => !session.persistencePolicy || session.persistencePolicy === PersistencePolicy.TEMPORARY,
        action: async (session) => {
          await this.authStateModel.findByIdAndUpdate(session._id, {
            persistencePolicy: PersistencePolicy.PERMANENT,
            isPersistent: true,
            sessionExpires: null,
            autoReconnect: true
          });
          this.logger.log(`[${session.userId}] Updated to permanent persistence policy`);
        },
        priority: 1,
        enabled: true,
        executionCount: 0
      },

      // Rule 2: Reset error counts for sessions that have been stable
      {
        id: 'reset_stable_session_errors',
        name: 'Reset Stable Session Errors',
        description: 'Reset error counts for sessions that have been connected for over 1 hour',
        condition: (session) => {
          return session.connectionStatus === SessionStatus.CONNECTED &&
                 session.errorCount > 0 &&
                 session.lastConnected &&
                 (Date.now() - session.lastConnected.getTime()) > 3600000; // 1 hour
        },
        action: async (session) => {
          await this.authStateModel.findByIdAndUpdate(session._id, {
            errorCount: 0,
            lastError: null,
            lastErrorTime: null,
            circuitBreakerState: 'closed',
            circuitBreakerLastReset: null
          });
          this.logger.log(`[${session.userId}] Reset error count for stable session`);
        },
        priority: 2,
        enabled: true,
        executionCount: 0
      },

      // Rule 3: Update last activity for connected sessions
      {
        id: 'update_activity_for_connected',
        name: 'Update Activity for Connected Sessions',
        description: 'Update lastActivity for connected sessions to prevent false inactivity',
        condition: (session) => {
          return session.connectionStatus === SessionStatus.CONNECTED &&
                 session.lastActivity &&
                 (Date.now() - session.lastActivity.getTime()) > 300000; // 5 minutes
        },
        action: async (session) => {
          await this.authStateModel.findByIdAndUpdate(session._id, {
            lastActivity: new Date(),
            lastUpdated: new Date()
          });
        },
        priority: 3,
        enabled: true,
        executionCount: 0
      },

      // Rule 4: Enable auto-reconnect for persistent sessions
      {
        id: 'enable_auto_reconnect',
        name: 'Enable Auto-Reconnect',
        description: 'Ensure all persistent sessions have auto-reconnect enabled',
        condition: (session) => {
          return (session.persistencePolicy === PersistencePolicy.PERSISTENT || 
                  session.persistencePolicy === PersistencePolicy.PERMANENT) &&
                 !session.autoReconnect;
        },
        action: async (session) => {
          await this.authStateModel.findByIdAndUpdate(session._id, {
            autoReconnect: true,
            lastUpdated: new Date()
          });
          this.logger.log(`[${session.userId}] Enabled auto-reconnect for persistent session`);
        },
        priority: 4,
        enabled: true,
        executionCount: 0
      },

      // Rule 5: Set priority for sessions based on activity
      {
        id: 'set_session_priority',
        name: 'Set Session Priority',
        description: 'Set higher priority for recently active sessions',
        condition: (session) => {
          const recentlyActive = session.lastActivity && 
                                (Date.now() - session.lastActivity.getTime()) < 86400000; // 24 hours
          const shouldHaveHighPriority = recentlyActive && session.priority < 5;
          const shouldHaveLowPriority = !recentlyActive && session.priority > 2;
          return shouldHaveHighPriority || shouldHaveLowPriority;
        },
        action: async (session) => {
          const recentlyActive = session.lastActivity && 
                                (Date.now() - session.lastActivity.getTime()) < 86400000;
          const newPriority = recentlyActive ? 5 : 2;
          
          await this.authStateModel.findByIdAndUpdate(session._id, {
            priority: newPriority,
            lastUpdated: new Date()
          });
        },
        priority: 5,
        enabled: true,
        executionCount: 0
      },

      // Rule 6: Clean up temporary sessions that have expired
      {
        id: 'cleanup_expired_temporary',
        name: 'Cleanup Expired Temporary Sessions',
        description: 'Remove temporary sessions that have expired',
        condition: (session) => {
          return session.persistencePolicy === PersistencePolicy.TEMPORARY &&
                 session.sessionExpires &&
                 session.sessionExpires < new Date();
        },
        action: async (session) => {
          await this.authStateModel.findByIdAndDelete(session._id);
          this.logger.log(`[${session.userId}] Removed expired temporary session`);
        },
        priority: 6,
        enabled: true,
        executionCount: 0
      },

      // Rule 7: Update environment and deployment info
      {
        id: 'update_environment_info',
        name: 'Update Environment Info',
        description: 'Update environment and deployment information for sessions',
        condition: (session) => {
          return !session.environment || 
                 !session.nodeId || 
                 !session.deploymentVersion ||
                 session.environment !== this.config.environment ||
                 session.nodeId !== this.config.nodeId ||
                 session.deploymentVersion !== this.config.deploymentVersion;
        },
        action: async (session) => {
          await this.authStateModel.findByIdAndUpdate(session._id, {
            environment: this.config.environment,
            nodeId: this.config.nodeId,
            deploymentVersion: this.config.deploymentVersion,
            lastUpdated: new Date()
          });
        },
        priority: 7,
        enabled: true,
        executionCount: 0
      }
    ];

    this.logger.log(`Initialized ${this.policyRules.length} session policy rules`);
  }

  private startPolicyExecution(): void {
    // Execute policies every 5 minutes
    this.policyInterval = setInterval(async () => {
      try {
        await this.executePolicies();
      } catch (error) {
        this.logger.error('Error executing session policies:', error);
      }
    }, 5 * 60 * 1000); // 5 minutes

    // Execute policies immediately
    setTimeout(() => {
      this.executePolicies().catch(error => {
        this.logger.error('Error in initial policy execution:', error);
      });
    }, 30000); // Wait 30 seconds after startup
  }

  async executePolicies(): Promise<void> {
    this.logger.log('Executing session policies...');
    
    try {
      // Get all sessions from database
      const sessions = await this.authStateModel.find({}).exec();
      
      // Sort rules by priority
      const enabledRules = this.policyRules
        .filter(rule => rule.enabled)
        .sort((a, b) => a.priority - b.priority);

      let totalActionsExecuted = 0;

      for (const rule of enabledRules) {
        let ruleActionsExecuted = 0;
        
        for (const session of sessions) {
          try {
            if (rule.condition(session)) {
              await rule.action(session);
              
              // Record execution
              this.recordExecution({
                ruleId: rule.id,
                sessionId: session.userId,
                action: rule.name,
                success: true,
                timestamp: new Date()
              });
              
              ruleActionsExecuted++;
              totalActionsExecuted++;
            }
          } catch (error) {
            this.logger.error(`Error executing rule ${rule.id} for session ${session.userId}:`, error);
            
            // Record failed execution
            this.recordExecution({
              ruleId: rule.id,
              sessionId: session.userId,
              action: rule.name,
              success: false,
              error: error.message,
              timestamp: new Date()
            });
          }
        }

        if (ruleActionsExecuted > 0) {
          rule.executionCount += ruleActionsExecuted;
          rule.lastExecuted = new Date();
          this.logger.log(`Rule '${rule.name}' executed ${ruleActionsExecuted} actions`);
        }
      }

      this.logger.log(`Policy execution completed. Total actions: ${totalActionsExecuted}`);
    } catch (error) {
      this.logger.error('Error in policy execution:', error);
    }
  }

  private recordExecution(result: PolicyExecutionResult): void {
    this.executionHistory.push(result);
    
    // Keep only recent history
    if (this.executionHistory.length > this.maxHistorySize) {
      this.executionHistory = this.executionHistory.slice(-this.maxHistorySize);
    }
  }

  // Public methods for policy management
  getPolicyRules(): SessionPolicyRule[] {
    return [...this.policyRules];
  }

  enableRule(ruleId: string): boolean {
    const rule = this.policyRules.find(r => r.id === ruleId);
    if (rule) {
      rule.enabled = true;
      this.logger.log(`Enabled policy rule: ${rule.name}`);
      return true;
    }
    return false;
  }

  disableRule(ruleId: string): boolean {
    const rule = this.policyRules.find(r => r.id === ruleId);
    if (rule) {
      rule.enabled = false;
      this.logger.log(`Disabled policy rule: ${rule.name}`);
      return true;
    }
    return false;
  }

  getExecutionHistory(hours: number = 24): PolicyExecutionResult[] {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return this.executionHistory.filter(e => e.timestamp >= cutoff);
  }

  getPolicyStats(): any {
    const enabledRules = this.policyRules.filter(r => r.enabled).length;
    const totalExecutions = this.policyRules.reduce((sum, rule) => sum + rule.executionCount, 0);
    const recentExecutions = this.getExecutionHistory(1).length; // Last hour
    const successfulExecutions = this.getExecutionHistory(24).filter(e => e.success).length;
    const failedExecutions = this.getExecutionHistory(24).filter(e => !e.success).length;

    return {
      totalRules: this.policyRules.length,
      enabledRules,
      disabledRules: this.policyRules.length - enabledRules,
      totalExecutions,
      recentExecutions,
      successfulExecutions,
      failedExecutions,
      successRate: failedExecutions + successfulExecutions > 0 ? 
        (successfulExecutions / (successfulExecutions + failedExecutions) * 100).toFixed(2) + '%' : 'N/A'
    };
  }

  async forceExecutePolicies(): Promise<void> {
    this.logger.log('Force executing session policies...');
    await this.executePolicies();
  }

  stopPolicyExecution(): void {
    if (this.policyInterval) {
      clearInterval(this.policyInterval);
      this.policyInterval = null;
      this.logger.log('Policy execution stopped');
    }
  }
}
