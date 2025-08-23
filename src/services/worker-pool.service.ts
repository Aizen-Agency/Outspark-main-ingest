import { EventEmitter } from 'events';
import { logger, logError, logMetric } from '../utils/logger';
import { config } from '../config/index';
import { EmailAccountsCredentials } from '../types/index';

export interface WorkerTask {
  id: string;
  accountId: string;
  account: EmailAccountsCredentials;
  priority: 'high' | 'medium' | 'low';
  type: 'poll' | 'idle' | 'health-check';
  createdAt: Date;
  retryCount: number;
  maxRetries: number;
}

export interface WorkerStats {
  workerId: string;
  status: 'idle' | 'busy' | 'error';
  tasksProcessed: number;
  tasksFailed: number;
  currentTask?: WorkerTask;
  lastActivity: Date;
  memoryUsage: number;
  cpuUsage: number;
}

export class WorkerPool extends EventEmitter {
  private workers: Map<string, WorkerStats> = new Map();
  private taskQueue: WorkerTask[] = [];
  private activeWorkers: number = 0;
  private maxWorkers: number;
  private workerTimeout: number;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor(maxWorkers: number = 10, workerTimeout: number = 300000) {
    super();
    this.maxWorkers = maxWorkers;
    this.workerTimeout = workerTimeout;
    
    logger.info('Worker Pool initialized', { maxWorkers, workerTimeout });
    
    // Start health monitoring
    this.startHealthMonitoring();
  }

  /**
   * Add a task to the queue with priority
   */
  addTask(task: Omit<WorkerTask, 'id' | 'createdAt' | 'retryCount'>): string {
    const taskId = `${task.accountId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const fullTask: WorkerTask = {
      ...task,
      id: taskId,
      createdAt: new Date(),
      retryCount: 0,
    };

    // Insert based on priority
    const insertIndex = this.taskQueue.findIndex(t => this.getPriorityWeight(t.priority) < this.getPriorityWeight(fullTask.priority));
    
    if (insertIndex === -1) {
      this.taskQueue.push(fullTask);
    } else {
      this.taskQueue.splice(insertIndex, 0, fullTask);
    }

    logMetric('worker_task_queued', 1, { 
      priority: fullTask.priority, 
      type: fullTask.type,
      queueLength: this.taskQueue.length.toString()
    });

    logger.debug('Task added to queue', { 
      taskId, 
      priority: fullTask.priority, 
      queueLength: this.taskQueue.length 
    });

    // Try to process immediately if workers are available
    this.processNextTask();
    
    return taskId;
  }

  /**
   * Process the next available task
   */
  private processNextTask(): void {
    if (this.taskQueue.length === 0 || this.activeWorkers >= this.maxWorkers) {
      return;
    }

    const task = this.taskQueue.shift();
    if (!task) return;

    // Find available worker
    const availableWorker = this.findAvailableWorker();
    if (!availableWorker) {
      // Put task back at front of queue
      this.taskQueue.unshift(task);
      return;
    }

    this.executeTask(availableWorker, task);
  }

  /**
   * Find an available worker
   */
  private findAvailableWorker(): string | null {
    for (const [workerId, stats] of this.workers) {
      if (stats.status === 'idle') {
        return workerId;
      }
    }
    return null;
  }

  /**
   * Execute a task on a worker
   */
  private async executeTask(workerId: string, task: WorkerTask): Promise<void> {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    // Mark worker as busy
    worker.status = 'busy';
    worker.currentTask = task;
    worker.lastActivity = new Date();
    this.activeWorkers++;

    logger.debug('Worker executing task', { workerId, taskId: task.id, accountId: task.accountId });

    try {
      // Emit task execution event
      this.emit('taskStarted', { workerId, task });
      
      // Simulate task execution (replace with actual IMAP operations)
      await this.executeImapTask(task);
      
      // Mark task as successful
      worker.tasksProcessed++;
      worker.status = 'idle';
      worker.currentTask = undefined;
      this.activeWorkers--;

      logMetric('worker_task_completed', 1, { 
        workerId, 
        priority: task.priority, 
        type: task.type 
      });

      this.emit('taskCompleted', { workerId, task });
      
    } catch (error) {
      // Handle task failure
      worker.tasksFailed++;
      worker.status = 'idle';
      worker.currentTask = undefined;
      this.activeWorkers--;

      logMetric('worker_task_failed', 1, { 
        workerId, 
        priority: task.priority, 
        type: task.type,
        error: error instanceof Error ? error.message : String(error)
      });

      this.emit('taskFailed', { workerId, task, error });

      // Retry logic
      if (task.retryCount < task.maxRetries) {
        task.retryCount++;
        task.createdAt = new Date();
        
        // Add back to queue with exponential backoff
        const backoffDelay = Math.min(1000 * Math.pow(2, task.retryCount), 30000);
        setTimeout(() => {
          this.taskQueue.unshift(task);
          this.processNextTask();
        }, backoffDelay);

        logger.warn('Task failed, retrying', { 
          taskId: task.id, 
          retryCount: task.retryCount, 
          backoffDelay 
        });
      } else {
        logger.error('Task failed permanently', { 
          taskId: task.id, 
          accountId: task.accountId,
          maxRetries: task.maxRetries 
        });
      }
    }

    // Process next task
    this.processNextTask();
  }

  /**
   * Execute actual IMAP task (placeholder for now)
   */
  private async executeImapTask(task: WorkerTask): Promise<void> {
    // This will be replaced with actual IMAP operations
    const delay = Math.random() * 1000 + 500; // 500-1500ms
    await new Promise(resolve => setTimeout(resolve, delay));
    
    // Simulate occasional failures
    if (Math.random() < 0.1) { // 10% failure rate
      throw new Error('Simulated IMAP operation failure');
    }
  }

  /**
   * Get priority weight for sorting
   */
  private getPriorityWeight(priority: string): number {
    switch (priority) {
      case 'high': return 3;
      case 'medium': return 2;
      case 'low': return 1;
      default: return 0;
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
   * Perform health check on all workers
   */
  private performHealthCheck(): void {
    const now = new Date();
    const stats = this.getStats();

    logMetric('worker_pool_health', 1, {
      totalWorkers: stats.totalWorkers.toString(),
      activeWorkers: stats.activeWorkers.toString(),
      idleWorkers: stats.idleWorkers.toString(),
      queueLength: stats.queueLength.toString(),
      memoryUsage: stats.totalMemoryUsage.toString(),
      cpuUsage: stats.totalCpuUsage.toString()
    });

    // Check for stuck workers
    for (const [workerId, worker] of this.workers) {
      const timeSinceLastActivity = now.getTime() - worker.lastActivity.getTime();
      
      if (timeSinceLastActivity > this.workerTimeout && worker.status === 'busy') {
        logger.warn('Worker appears stuck, resetting', { 
          workerId, 
          timeSinceLastActivity,
          currentTask: worker.currentTask?.id 
        });
        
        worker.status = 'idle';
        worker.currentTask = undefined;
        this.activeWorkers--;
        
        // Re-queue the task if it exists
        if (worker.currentTask) {
          this.taskQueue.unshift(worker.currentTask);
        }
      }
    }

    // Log health status
    logger.debug('Worker pool health check completed', stats);
  }

  /**
   * Get comprehensive statistics
   */
  getStats(): Record<string, any> {
    const stats = {
      totalWorkers: this.workers.size,
      activeWorkers: this.activeWorkers,
      idleWorkers: Array.from(this.workers.values()).filter(w => w.status === 'idle').length,
      queueLength: this.taskQueue.length,
      totalMemoryUsage: 0,
      totalCpuUsage: 0,
      workers: Array.from(this.workers.entries()).map(([id, stats]) => ({
        id,
        ...stats
      }))
    };

    // Calculate totals
    for (const worker of this.workers.values()) {
      stats.totalMemoryUsage += worker.memoryUsage;
      stats.totalCpuUsage += worker.cpuUsage;
    }

    return stats;
  }

  /**
   * Shutdown the worker pool
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down worker pool');
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Wait for active tasks to complete
    while (this.activeWorkers > 0) {
      logger.info('Waiting for active workers to complete', { activeWorkers: this.activeWorkers });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    logger.info('Worker pool shutdown completed');
  }
}

// Export singleton instance
export const workerPool = new WorkerPool(
  parseInt(process.env.MAX_WORKERS || '10'),
  parseInt(process.env.WORKER_TIMEOUT || '300000')
);
