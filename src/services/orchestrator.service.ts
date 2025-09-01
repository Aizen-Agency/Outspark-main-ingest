import { EventEmitter } from 'events';
import { logger, logError, logMetric } from '../utils/logger';
import { config } from '../config/index';
import { EmailAccountsCredentials } from '../types/index';
import { workerPool } from './worker-pool.service';
import { pollingScheduler } from './polling-scheduler.service';
import { imapService } from './imap-service';
import { ImapWorker } from './imap-worker.service';

export interface OrchestratorStats {
  totalAccounts: number;
  activeAccounts: number;
  pausedAccounts: number;
  failedAccounts: number;
  totalWorkers: number;
  activeWorkers: number;
  totalConnections: number;
  activeConnections: number;
  messagesProcessed: number;
  messagesFailed: number;
  systemHealth: 'healthy' | 'degraded' | 'unhealthy';
}

export class OrchestratorService extends EventEmitter {
  private workers: Map<string, ImapWorker> = new Map();
  private accounts: Map<string, EmailAccountsCredentials> = new Map();
  private accountPriorities: Map<string, 'high' | 'medium' | 'low'> = new Map();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private metricsInterval: NodeJS.Timeout | null = null;
  private isShutdown: boolean = false;

  constructor() {
    super();
    logger.info('Orchestrator Service initialized');
    
    this.startHealthMonitoring();
    this.startMetricsCollection();
  }

  /**
   * Initialize the system with email accounts
   */
  async initializeAccounts(accounts: EmailAccountsCredentials[]): Promise<void> {
    try {
      logger.info(`Initializing ${accounts.length} email accounts`);
      
      // Store accounts in memory
      for (const account of accounts) {
        this.accounts.set(account.id, account);
        
        // Determine initial priority based on account characteristics
        const priority = this.determineAccountPriority(account);
        this.accountPriorities.set(account.id, priority);
      }

      // Initialize workers
      await this.initializeWorkers();
      
      // Add accounts to polling scheduler
      for (const account of accounts) {
        if (account.isActive) {
          const priority = this.accountPriorities.get(account.id) || 'medium';
          pollingScheduler.addAccount(account, priority);
        }
      }

      logger.info('Account initialization completed', {
        totalAccounts: accounts.length,
        activeAccounts: accounts.filter(a => a.isActive).length
      });

    } catch (error) {
      logError('Failed to initialize accounts', error as Error);
      throw error;
    }
  }

  /**
   * Initialize worker pool
   */
  private async initializeWorkers(): Promise<void> {
    const maxWorkers = config.workerPool.maxWorkers;
    
    logger.info(`Initializing ${maxWorkers} IMAP workers`);
    
    for (let i = 0; i < maxWorkers; i++) {
      const workerId = `worker_${i + 1}`;
      const worker = new ImapWorker(workerId);
      this.workers.set(workerId, worker);
    }
    
    logger.info('Worker initialization completed', { totalWorkers: this.workers.size });
  }

  /**
   * Determine account priority based on characteristics
   */
  private determineAccountPriority(account: EmailAccountsCredentials): 'high' | 'medium' | 'low' {
    // High priority: Business accounts, VIP users, high email volume
    if (account.dailyLimit && account.dailyLimit > 1000) {
      return 'high';
    }
    
    // Medium priority: Regular business accounts
    if (account.dailyLimit && account.dailyLimit > 100) {
      return 'medium';
    }
    
    // Low priority: Personal accounts, low volume
    return 'low';
  }

  /**
   * Update account priority
   */
  updateAccountPriority(accountId: string, newPriority: 'high' | 'medium' | 'low'): void {
    const account = this.accounts.get(accountId);
    if (!account) {
      logger.warn('Account not found for priority update', { accountId });
      return;
    }

    const oldPriority = this.accountPriorities.get(accountId);
    this.accountPriorities.set(accountId, newPriority);
    
    // Update polling scheduler
    pollingScheduler.updateAccountPriority(accountId, newPriority);
    
    logger.info('Account priority updated', {
      accountId,
      email: account.email,
      oldPriority,
      newPriority
    });
  }

  /**
   * Pause account processing
   */
  pauseAccount(accountId: string): void {
    const account = this.accounts.get(accountId);
    if (!account) {
      logger.warn('Account not found for pause', { accountId });
      return;
    }

    // Pause in polling scheduler
    pollingScheduler.pauseAccount(accountId);
    
    // Mark as inactive
    account.isActive = false;
    
    logger.info('Account paused', { accountId, email: account.email });
  }

  /**
   * Resume account processing
   */
  resumeAccount(accountId: string): void {
    const account = this.accounts.get(accountId);
    if (!account) {
      logger.warn('Account not found for resume', { accountId });
      return;
    }

    // Mark as active
    account.isActive = true;
    
    // Resume in polling scheduler
    pollingScheduler.resumeAccount(accountId);
    
    logger.info('Account resumed', { accountId, email: account.email });
  }

  /**
   * Add new account
   */
  addAccount(account: EmailAccountsCredentials): void {
    this.accounts.set(account.id, account);
    
    const priority = this.determineAccountPriority(account);
    this.accountPriorities.set(account.id, priority);
    
    if (account.isActive) {
      pollingScheduler.addAccount(account, priority);
    }
    
    logger.info('New account added', {
      accountId: account.id,
      email: account.email,
      priority,
      isActive: account.isActive
    });
  }

  /**
   * Remove account
   */
  removeAccount(accountId: string): void {
    const account = this.accounts.get(accountId);
    if (!account) {
      logger.warn('Account not found for removal', { accountId });
      return;
    }

    // Remove from polling scheduler
    pollingScheduler.removeAccount(accountId);
    
    // Remove from memory
    this.accounts.delete(accountId);
    this.accountPriorities.delete(accountId);
    
    logger.info('Account removed', { accountId, email: account.email });
  }

  /**
   * Update account email volume and adjust priority
   */
  updateAccountVolume(accountId: string, emailCount: number): void {
    const account = this.accounts.get(accountId);
    if (!account) return;

    // Update polling scheduler
    pollingScheduler.updateAccountVolume(accountId, emailCount);
    
    // Adjust priority based on volume
    let newPriority: 'high' | 'medium' | 'low';
    
    if (emailCount > 1000) {
      newPriority = 'high';
    } else if (emailCount > 100) {
      newPriority = 'medium';
    } else {
      newPriority = 'low';
    }
    
    const currentPriority = this.accountPriorities.get(accountId);
    if (newPriority !== currentPriority) {
      this.updateAccountPriority(accountId, newPriority);
    }
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, 30000); // Every 30 seconds
  }

  /**
   * Perform system health check
   */
  private async performHealthCheck(): Promise<void> {
    try {
      const stats = this.getStats();
      
      // Determine system health
      let systemHealth: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
      
      if (stats.failedAccounts > stats.totalAccounts * 0.1) {
        systemHealth = 'degraded';
      }
      
      if (stats.failedAccounts > stats.totalAccounts * 0.3) {
        systemHealth = 'unhealthy';
      }
      
      stats.systemHealth = systemHealth;
      
      // Log health status
      logMetric('orchestrator_health_check', 1, {
        systemHealth,
        totalAccounts: stats.totalAccounts.toString(),
        failedAccounts: stats.failedAccounts.toString(),
        activeWorkers: stats.activeWorkers.toString()
      });
      
      logger.debug('System health check completed', { systemHealth, stats });
      
      // Emit health status
      this.emit('healthStatus', stats);
      
    } catch (error) {
      logger.error('Health check failed', error as Error);
    }
  }

  /**
   * Start metrics collection
   */
  private startMetricsCollection(): void {
    this.metricsInterval = setInterval(() => {
      this.collectMetrics();
    }, config.monitoring.metricsInterval);
  }

  /**
   * Collect system metrics
   */
  private collectMetrics(): void {
    try {
      const stats = this.getStats();
      
      logMetric('orchestrator_metrics', 1, {
        totalAccounts: stats.totalAccounts.toString(),
        activeAccounts: stats.activeAccounts.toString(),
        totalWorkers: stats.totalWorkers.toString(),
        activeWorkers: stats.activeWorkers.toString(),
        totalConnections: stats.totalConnections.toString(),
        activeConnections: stats.activeConnections.toString(),
        messagesProcessed: stats.messagesProcessed.toString(),
        messagesFailed: stats.messagesFailed.toString(),
        systemHealth: stats.systemHealth
      });
      
    } catch (error) {
      logger.error('Metrics collection failed', error as Error);
    }
  }

  /**
   * Get comprehensive system statistics
   */
  getStats(): OrchestratorStats {
    const accounts = Array.from(this.accounts.values());
    const activeAccounts = accounts.filter(a => a.isActive);
    const failedAccounts = accounts.filter(a => !a.isActive).length;
    
    // Get worker stats
    const workerStats = Array.from(this.workers.values()).map(w => w.getStats());
    const activeWorkers = workerStats.filter(w => w.currentTask).length;
    
    // Get connection stats
    const connectionMetrics = imapService.getMetrics();
    
    // Get polling stats
    const pollingMetrics = pollingScheduler.getMetrics();
    
    // Calculate total messages processed
    const messagesProcessed = workerStats.reduce((total, w) => total + w.emailsProcessed, 0);
    const messagesFailed = workerStats.reduce((total, w) => total + w.emailsFailed, 0);
    
    return {
      totalAccounts: accounts.length,
      activeAccounts: activeAccounts.length,
      pausedAccounts: accounts.length - activeAccounts.length - failedAccounts,
      failedAccounts,
      totalWorkers: this.workers.size,
      activeWorkers,
      totalConnections: connectionMetrics.totalConnections,
      activeConnections: connectionMetrics.activeConnections,
      messagesProcessed,
      messagesFailed,
      systemHealth: 'healthy' // Will be updated by health check
    };
  }

  /**
   * Get detailed account information
   */
  getAccountDetails(): Record<string, any> {
    const details: Record<string, any> = {};
    
    for (const [accountId, account] of this.accounts) {
      const priority = this.accountPriorities.get(accountId);
      const schedule = pollingScheduler.getScheduleDetails()[accountId];
      
      details[accountId] = {
        email: account.email,
        isActive: account.isActive,
        priority,
        dailyLimit: account.dailyLimit,
        warmupEnabled: account.warmupEnabled,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
        schedule
      };
    }
    
    return details;
  }

  /**
   * Get system performance metrics
   */
  getPerformanceMetrics(): Record<string, any> {
    const workerStats = Array.from(this.workers.values()).map(w => w.getStats());
    const connectionMetrics = imapService.getMetrics();
    const pollingMetrics = pollingScheduler.getMetrics();
    
    return {
      workers: {
        total: this.workers.size,
        active: workerStats.filter(w => w.currentTask).length,
        idle: workerStats.filter(w => !w.currentTask).length,
        tasksProcessed: workerStats.reduce((total, w) => total + w.tasksProcessed, 0),
        tasksFailed: workerStats.reduce((total, w) => total + w.tasksFailed, 0),
        emailsProcessed: workerStats.reduce((total, w) => total + w.emailsProcessed, 0),
        emailsFailed: workerStats.reduce((total, w) => total + w.emailsFailed, 0)
      },
      connections: connectionMetrics,
      polling: pollingMetrics,
      system: this.getStats()
    };
  }

  /**
   * Shutdown the orchestrator
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down orchestrator service');
    
    this.isShutdown = true;
    
    // Clear intervals
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
    
    // Shutdown all services
    await Promise.all([
      workerPool.shutdown(),
      pollingScheduler.shutdown()
    ]);
    
    // Shutdown all workers
    const workerShutdowns = Array.from(this.workers.values()).map(w => w.shutdown());
    await Promise.all(workerShutdowns);
    
    // Clear memory
    this.workers.clear();
    this.accounts.clear();
    this.accountPriorities.clear();
    
    logger.info('Orchestrator service shutdown completed');
  }
}

// Export singleton instance
export const orchestratorService = new OrchestratorService();
