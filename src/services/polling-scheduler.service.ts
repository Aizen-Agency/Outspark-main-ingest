import { EventEmitter } from 'events';
import { logger, logError, logMetric } from '../utils/logger';
import { config } from '../config/index';
import { EmailAccountsCredentials } from '../types/index';
import { workerPool } from './worker-pool.service';
import { connectionManager } from './connection-manager.service';

export interface PollingSchedule {
  accountId: string;
  account: EmailAccountsCredentials;
  priority: 'high' | 'medium' | 'low';
  interval: number; // milliseconds
  lastPolled: Date;
  nextPoll: Date;
  emailVolume: 'high' | 'medium' | 'low';
  successRate: number; // 0-1
  consecutiveFailures: number;
  maxFailures: number;
  isActive: boolean;
  // Add IDLE support
  supportsIdle: boolean;
  idleEnabled: boolean;
  lastIdleAttempt: Date;
  idleFailures: number;
  maxIdleFailures: number;
}

export interface PollingMetrics {
  totalAccounts: number;
  activeAccounts: number;
  highPriorityAccounts: number;
  mediumPriorityAccounts: number;
  lowPriorityAccounts: number;
  averagePollingInterval: number;
  totalPollsPerMinute: number;
  successRate: number;
}

export class PollingScheduler extends EventEmitter {
  private schedules: Map<string, PollingSchedule> = new Map();
  private pollingTimers: Map<string, NodeJS.Timeout> = new Map();
  private schedulerInterval: NodeJS.Timeout | null = null;
  private metricsInterval: NodeJS.Timeout | null = null;
  
  // Configuration
  private baseIntervals = {
    high: 60000,      // 1 minute for high priority
    medium: 300000,   // 5 minutes for medium priority
    low: 900000       // 15 minutes for low priority
  };
  
  private adaptiveIntervals = {
    highVolume: 60000,    // 1 minute for high volume
    mediumVolume: 300000, // 5 minutes for medium volume
    lowVolume: 900000     // 15 minutes for low volume
  };

  constructor() {
    super();
    logger.info('Polling Scheduler initialized');
    
    this.startScheduler();
    this.startMetricsCollection();
  }

  /**
   * Add or update an account's polling schedule
   */
  addAccount(account: EmailAccountsCredentials, priority: 'high' | 'medium' | 'low' = 'medium'): void {
    const accountId = account.id;
    
    // Remove existing schedule if any
    this.removeAccount(accountId);
    
    // Determine initial polling interval based on priority
    const baseInterval = this.baseIntervals[priority];
    
    // Detect if account supports IDLE
    const supportsIdle = this.detectIdleSupport(account);
    
    // Create new schedule
    const schedule: PollingSchedule = {
      accountId,
      account,
      priority,
      interval: baseInterval,
      lastPolled: new Date(0), // Never polled
      nextPoll: new Date(Date.now() + baseInterval),
      emailVolume: 'low', // Will be updated based on actual usage
      successRate: 1.0, // Start optimistic
      consecutiveFailures: 0,
      maxFailures: 3,
      isActive: true,
      supportsIdle, // Set based on detection
      idleEnabled: supportsIdle, // Enable IDLE if supported
      lastIdleAttempt: new Date(0), // Default to 0
      idleFailures: 0, // Default to 0
      maxIdleFailures: 3 // Default to 3
    };
    
    this.schedules.set(accountId, schedule);
    
    // Schedule first poll
    this.scheduleNextPoll(accountId);
    
    logMetric('polling_schedule_added', 1, {
      accountId,
      priority,
      interval: baseInterval.toString(),
      supportsIdle: supportsIdle.toString(),
      idleEnabled: supportsIdle.toString()
    });
    
    logger.info('Account added to polling schedule', {
      accountId,
      email: account.email,
      priority,
      interval: baseInterval,
      nextPoll: schedule.nextPoll,
      supportsIdle,
      idleEnabled: supportsIdle
    });
  }

  /**
   * Detect if an account supports IDLE
   */
  private detectIdleSupport(account: EmailAccountsCredentials): boolean {
    const host = account.imapHost.toLowerCase();
    
    // Known IDLE-supporting providers
    const idleSupportingProviders = [
      'gmail.com',
      'outlook.office365.com',
      'imap.mail.yahoo.com',
      'zoho.com',
      'protonmail.com'
    ];
    
    // Known providers that don't support IDLE well
    const nonIdleProviders = [
      'mailscale.com', // Your current provider
      'shared-hosting.com',
      'cpanel.com'
    ];
    
    // Check if it's a known non-IDLE provider
    for (const provider of nonIdleProviders) {
      if (host.includes(provider)) {
        return false;
      }
    }
    
    // Check if it's a known IDLE-supporting provider
    for (const provider of idleSupportingProviders) {
      if (host.includes(provider)) {
        return true;
      }
    }
    
    // Default to true for unknown providers (they can try IDLE)
    return true;
  }

  /**
   * Remove an account from polling
   */
  removeAccount(accountId: string): void {
    // Clear existing timer
    const existingTimer = this.pollingTimers.get(accountId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.pollingTimers.delete(accountId);
    }
    
    // Remove schedule
    this.schedules.delete(accountId);
    
    logger.debug('Account removed from polling schedule', { accountId });
  }

  /**
   * Schedule the next poll for an account
   */
  private scheduleNextPoll(accountId: string): void {
    const schedule = this.schedules.get(accountId);
    if (!schedule || !schedule.isActive) return;
    
    // Clear existing timer
    const existingTimer = this.pollingTimers.get(accountId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    
    // Calculate delay until next poll
    const now = Date.now();
    const delay = Math.max(0, schedule.nextPoll.getTime() - now);
    
    // Schedule next poll
    const timer = setTimeout(() => {
      this.executePoll(accountId);
    }, delay);
    
    this.pollingTimers.set(accountId, timer);
    
    logger.debug('Next poll scheduled', {
      accountId,
      delay,
      nextPoll: schedule.nextPoll
    });
  }

  /**
   * Execute a poll for an account
   */
  private async executePoll(accountId: string): Promise<void> {
    const schedule = this.schedules.get(accountId);
    if (!schedule || !schedule.isActive) return;
    
    const startTime = Date.now();
    
    try {
      logger.debug('Executing task', { 
        accountId, 
        priority: schedule.priority,
        supportsIdle: schedule.supportsIdle,
        idleEnabled: schedule.idleEnabled
      });
      
      // Determine task type: IDLE or polling
      let taskType: 'poll' | 'idle' = 'poll';
      
      if (schedule.idleEnabled && schedule.supportsIdle) {
        // Check if we should try IDLE
        const timeSinceLastIdle = Date.now() - schedule.lastIdleAttempt.getTime();
        const idleRetryInterval = 300000; // 5 minutes
        
        if (timeSinceLastIdle > idleRetryInterval) {
          taskType = 'idle';
          schedule.lastIdleAttempt = new Date();
        }
      }
      
      // Add task to worker pool
      const taskId = workerPool.addTask({
        accountId,
        account: schedule.account,
        priority: schedule.priority,
        type: taskType,
        maxRetries: 2
      });
      
      // Update schedule based on task type
      if (taskType === 'idle') {
        // For IDLE, we don't schedule next poll immediately
        // The worker will handle IDLE connection
        logger.info('IDLE task scheduled', { accountId, taskId });
      } else {
        // For polling, update schedule as before
        schedule.lastPolled = new Date();
        schedule.nextPoll = new Date(Date.now() + schedule.interval);
        schedule.consecutiveFailures = 0;
        
        // Update success rate
        schedule.successRate = Math.min(1.0, schedule.successRate + 0.1);
        
        // Schedule next poll
        this.scheduleNextPoll(accountId);
      }
      
      logMetric('task_executed', 1, {
        accountId,
        priority: schedule.priority,
        taskType,
        taskId,
        executionTime: (Date.now() - startTime).toString()
      });
      
    } catch (error) {
      // Handle task failure
      schedule.consecutiveFailures++;
      schedule.successRate = Math.max(0.0, schedule.successRate - 0.2);
      
      // If IDLE failed, increment IDLE failure count
      if (schedule.idleEnabled && schedule.supportsIdle) {
        schedule.idleFailures++;
        
        // Disable IDLE if too many failures
        if (schedule.idleFailures >= schedule.maxIdleFailures) {
          schedule.idleEnabled = false;
          logger.warn('IDLE disabled due to repeated failures', {
            accountId,
            idleFailures: schedule.idleFailures
          });
        }
      }
      
      logMetric('task_failed', 1, {
        accountId,
        priority: schedule.priority,
        taskType: 'poll', // Default to poll for metrics
        consecutiveFailures: schedule.consecutiveFailures.toString(),
        idleFailures: schedule.idleFailures?.toString() || '0',
        error: error instanceof Error ? error.message : String(error)
      });
      
      logger.warn('Task failed', {
        accountId,
        consecutiveFailures: schedule.consecutiveFailures,
        idleFailures: schedule.idleFailures,
        error
      });
      
      // Implement exponential backoff for failed accounts
      if (schedule.consecutiveFailures >= schedule.maxFailures) {
        this.handleAccountFailure(accountId);
      } else {
        // Retry with backoff
        const backoffDelay = Math.min(
          schedule.interval * Math.pow(2, schedule.consecutiveFailures),
          300000 // Max 5 minutes
        );
        
        schedule.nextPoll = new Date(Date.now() + backoffDelay);
        this.scheduleNextPoll(accountId);
      }
    }
  }

  /**
   * Handle account failure
   */
  private handleAccountFailure(accountId: string): void {
    const schedule = this.schedules.get(accountId);
    if (!schedule) return;
    
    logger.warn('Account marked as failed, reducing polling frequency', {
      accountId,
      consecutiveFailures: schedule.consecutiveFailures
    });
    
    // Reduce polling frequency for failed accounts
    schedule.interval = Math.min(schedule.interval * 2, 3600000); // Max 1 hour
    schedule.nextPoll = new Date(Date.now() + schedule.interval);
    
    // Mark as low priority temporarily
    schedule.priority = 'low';
    
    // Schedule next poll
    this.scheduleNextPoll(accountId);
  }

  /**
   * Update account email volume and adjust polling accordingly
   */
  updateAccountVolume(accountId: string, emailCount: number): void {
    const schedule = this.schedules.get(accountId);
    if (!schedule) return;
    
    let newVolume: 'high' | 'medium' | 'low';
    let newInterval: number;
    
    if (emailCount > 100) {
      newVolume = 'high';
      newInterval = this.adaptiveIntervals.highVolume;
    } else if (emailCount > 10) {
      newVolume = 'medium';
      newInterval = this.adaptiveIntervals.mediumVolume;
    } else {
      newVolume = 'low';
      newInterval = this.adaptiveIntervals.lowVolume;
    }
    
    // Only update if volume changed significantly
    if (newVolume !== schedule.emailVolume) {
      const oldInterval = schedule.interval;
      schedule.emailVolume = newVolume;
      schedule.interval = newInterval;
      
      // Adjust next poll time
      const timeUntilNext = schedule.nextPoll.getTime() - Date.now();
      if (timeUntilNext > 0) {
        schedule.nextPoll = new Date(Date.now() + Math.min(timeUntilNext, newInterval));
        this.scheduleNextPoll(accountId);
      }
      
      logger.info('Account volume updated', {
        accountId,
        oldVolume: schedule.emailVolume,
        newVolume,
        oldInterval,
        newInterval
      });
    }
  }

  /**
   * Start the main scheduler
   */
  private startScheduler(): void {
    this.schedulerInterval = setInterval(() => {
      this.processSchedules();
    }, 10000); // Check every 10 seconds
  }

  /**
   * Process all schedules
   */
  private processSchedules(): void {
    const now = Date.now();
    let overduePolls = 0;
    
    for (const [accountId, schedule] of this.schedules) {
      if (!schedule.isActive) continue;
      
      // Check if poll is overdue
      if (schedule.nextPoll.getTime() <= now) {
        overduePolls++;
        this.executePoll(accountId);
      }
    }
    
    if (overduePolls > 0) {
      logger.debug('Processed overdue polls', { overduePolls });
    }
  }

  /**
   * Start metrics collection
   */
  private startMetricsCollection(): void {
    this.metricsInterval = setInterval(() => {
      this.collectMetrics();
    }, 60000); // Every minute
  }

  /**
   * Collect and log metrics
   */
  private collectMetrics(): void {
    const metrics = this.getMetrics();
    
    logMetric('polling_scheduler_metrics', 1, {
      totalAccounts: metrics.totalAccounts.toString(),
      activeAccounts: metrics.activeAccounts.toString(),
      highPriorityAccounts: metrics.highPriorityAccounts.toString(),
      mediumPriorityAccounts: metrics.mediumPriorityAccounts.toString(),
      lowPriorityAccounts: metrics.lowPriorityAccounts.toString(),
      averagePollingInterval: metrics.averagePollingInterval.toString(),
      totalPollsPerMinute: metrics.totalPollsPerMinute.toString(),
      successRate: metrics.successRate.toString()
    });
    
    logger.debug('Polling scheduler metrics collected', metrics);
  }

  /**
   * Get comprehensive metrics
   */
  getMetrics(): PollingMetrics {
    const accounts = Array.from(this.schedules.values());
    const activeAccounts = accounts.filter(a => a.isActive);
    
    let totalInterval = 0;
    let totalSuccessRate = 0;
    let highPriority = 0;
    let mediumPriority = 0;
    let lowPriority = 0;
    
    for (const account of activeAccounts) {
      totalInterval += account.interval;
      totalSuccessRate += account.successRate;
      
      switch (account.priority) {
        case 'high': highPriority++; break;
        case 'medium': mediumPriority++; break;
        case 'low': lowPriority++; break;
      }
    }
    
    const averageInterval = activeAccounts.length > 0 ? totalInterval / activeAccounts.length : 0;
    const averageSuccessRate = activeAccounts.length > 0 ? totalSuccessRate / activeAccounts.length : 0;
    
    // Calculate polls per minute
    const totalPollsPerMinute = activeAccounts.reduce((total, account) => {
      return total + (60000 / account.interval);
    }, 0);
    
    return {
      totalAccounts: accounts.length,
      activeAccounts: activeAccounts.length,
      highPriorityAccounts: highPriority,
      mediumPriorityAccounts: mediumPriority,
      lowPriorityAccounts: lowPriority,
      averagePollingInterval: averageInterval,
      totalPollsPerMinute,
      successRate: averageSuccessRate
    };
  }

  /**
   * Get detailed schedule information
   */
  getScheduleDetails(): Record<string, any> {
    const details: Record<string, any> = {};
    
    for (const [accountId, schedule] of this.schedules) {
      details[accountId] = {
        email: schedule.account.email,
        priority: schedule.priority,
        interval: schedule.interval,
        lastPolled: schedule.lastPolled,
        nextPoll: schedule.nextPoll,
        emailVolume: schedule.emailVolume,
        successRate: schedule.successRate,
        consecutiveFailures: schedule.consecutiveFailures,
        isActive: schedule.isActive,
        supportsIdle: schedule.supportsIdle,
        idleEnabled: schedule.idleEnabled,
        lastIdleAttempt: schedule.lastIdleAttempt,
        idleFailures: schedule.idleFailures,
        maxIdleFailures: schedule.maxIdleFailures
      };
    }
    
    return details;
  }

  /**
   * Update account priority
   */
  updateAccountPriority(accountId: string, newPriority: 'high' | 'medium' | 'low'): void {
    const schedule = this.schedules.get(accountId);
    if (!schedule) return;
    
    const oldPriority = schedule.priority;
    schedule.priority = newPriority;
    schedule.interval = this.baseIntervals[newPriority];
    
    // Adjust next poll time
    schedule.nextPoll = new Date(Date.now() + schedule.interval);
    this.scheduleNextPoll(accountId);
    
    logger.info('Account priority updated', {
      accountId,
      oldPriority,
      newPriority,
      newInterval: schedule.interval
    });
  }

  /**
   * Pause polling for an account
   */
  pauseAccount(accountId: string): void {
    const schedule = this.schedules.get(accountId);
    if (!schedule) return;
    
    schedule.isActive = false;
    
    // Clear existing timer
    const existingTimer = this.pollingTimers.get(accountId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.pollingTimers.delete(accountId);
    }
    
    logger.info('Account polling paused', { accountId });
  }

  /**
   * Resume polling for an account
   */
  resumeAccount(accountId: string): void {
    const schedule = this.schedules.get(accountId);
    if (!schedule) return;
    
    schedule.isActive = true;
    schedule.nextPoll = new Date(Date.now() + schedule.interval);
    
    // Schedule next poll
    this.scheduleNextPoll(accountId);
    
    logger.info('Account polling resumed', { accountId });
  }

  /**
   * Handle IDLE task completion (success or failure)
   */
  handleIdleTaskCompletion(accountId: string, success: boolean): void {
    const schedule = this.schedules.get(accountId);
    if (!schedule) return;
    
    if (success) {
      // IDLE succeeded, reset failure count and keep it enabled
      schedule.idleFailures = 0;
      schedule.idleEnabled = true;
      
      logger.info('IDLE task completed successfully', { accountId });
      
      // Schedule next IDLE attempt after a delay
      const nextIdleDelay = 60000; // 1 minute
      schedule.nextPoll = new Date(Date.now() + nextIdleDelay);
      this.scheduleNextPoll(accountId);
      
    } else {
      // IDLE failed, increment failure count
      schedule.idleFailures++;
      
      logger.warn('IDLE task failed', { 
        accountId, 
        idleFailures: schedule.idleFailures,
        maxIdleFailures: schedule.maxIdleFailures
      });
      
      // Disable IDLE if too many failures
      if (schedule.idleFailures >= schedule.maxIdleFailures) {
        schedule.idleEnabled = false;
        logger.warn('IDLE disabled due to repeated failures', {
          accountId,
          idleFailures: schedule.idleFailures
        });
        
        // Fall back to polling immediately
        schedule.nextPoll = new Date(Date.now() + 30000); // 30 seconds
        this.scheduleNextPoll(accountId);
      } else {
        // Try IDLE again after a delay
        const retryDelay = Math.min(
          60000 * Math.pow(2, schedule.idleFailures), // Exponential backoff
          300000 // Max 5 minutes
        );
        schedule.nextPoll = new Date(Date.now() + retryDelay);
        this.scheduleNextPoll(accountId);
      }
    }
  }

  /**
   * Manually enable/disable IDLE for an account
   */
  setIdleEnabled(accountId: string, enabled: boolean): void {
    const schedule = this.schedules.get(accountId);
    if (!schedule) {
      logger.warn('Account not found for IDLE setting', { accountId });
      return;
    }
    
    if (!schedule.supportsIdle) {
      logger.warn('Account does not support IDLE', { accountId });
      return;
    }
    
    const oldEnabled = schedule.idleEnabled;
    schedule.idleEnabled = enabled;
    
    if (enabled) {
      schedule.idleFailures = 0; // Reset failure count
      logger.info('IDLE enabled for account', { accountId });
    } else {
      logger.info('IDLE disabled for account', { accountId });
    }
    
    // If enabling IDLE, schedule next attempt soon
    if (enabled && !oldEnabled) {
      schedule.nextPoll = new Date(Date.now() + 30000); // 30 seconds
      this.scheduleNextPoll(accountId);
    }
  }

  /**
   * Get IDLE statistics for an account
   */
  getIdleStats(accountId: string): {
    supportsIdle: boolean;
    idleEnabled: boolean;
    idleFailures: number;
    maxIdleFailures: number;
    lastIdleAttempt: Date;
  } | null {
    const schedule = this.schedules.get(accountId);
    if (!schedule) return null;
    
    return {
      supportsIdle: schedule.supportsIdle,
      idleEnabled: schedule.idleEnabled,
      idleFailures: schedule.idleFailures,
      maxIdleFailures: schedule.maxIdleFailures,
      lastIdleAttempt: schedule.lastIdleAttempt
    };
  }

  /**
   * Shutdown the scheduler
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down polling scheduler');
    
    // Clear all timers
    for (const timer of this.pollingTimers.values()) {
      clearTimeout(timer);
    }
    this.pollingTimers.clear();
    
    // Clear intervals
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
    }
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
    
    // Clear schedules
    this.schedules.clear();
    
    logger.info('Polling scheduler shutdown completed');
  }
}

// Export singleton instance
export const pollingScheduler = new PollingScheduler();
