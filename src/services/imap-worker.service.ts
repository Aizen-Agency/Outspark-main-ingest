import { ImapFlow, ImapFlowOptions, FetchMessageObject } from 'imapflow';
import { logger, logError, logMetric } from '../utils/logger';
import { config } from '../config/index';
import { sendMessage, sendMessageBatch } from './aws-sqs';
import { imapService } from './imap-service';
import { pollingScheduler } from './polling-scheduler.service';
import { 
  EmailAccount, 
  EmailMessage, 
  QueuePayload, 
  EmailAccountsCredentials, 
  ConnectionStatus 
} from '../types/index';

export interface ImapWorkerTask {
  id: string;
  accountId: string;
  account: EmailAccountsCredentials;
  type: 'poll' | 'idle' | 'health-check';
  priority: 'high' | 'medium' | 'low';
  createdAt: Date;
  retryCount: number;
  maxRetries: number;
}

export interface ImapWorkerStats {
  workerId: string;
  tasksProcessed: number;
  tasksFailed: number;
  emailsProcessed: number;
  emailsFailed: number;
  currentTask?: ImapWorkerTask;
  lastActivity: Date;
  memoryUsage: number;
  cpuUsage: number;
}

export class ImapWorker {
  private workerId: string;
  private stats: ImapWorkerStats;
  private isShutdown: boolean = false;

  constructor(workerId: string) {
    this.workerId = workerId;
    this.stats = {
      workerId,
      tasksProcessed: 0,
      tasksFailed: 0,
      emailsProcessed: 0,
      emailsFailed: 0,
      lastActivity: new Date(),
      memoryUsage: 0,
      cpuUsage: 0
    };
    
    logger.info('IMAP Worker initialized', { workerId });
  }

  /**
   * Execute an IMAP task
   */
  async executeTask(task: ImapWorkerTask): Promise<void> {
    if (this.isShutdown) {
      throw new Error('Worker is shutdown');
    }

    this.stats.currentTask = task;
    this.stats.lastActivity = new Date();
    
    const startTime = Date.now();
    
    try {
      logger.debug('Worker executing IMAP task', { 
        workerId: this.workerId, 
        taskId: task.id, 
        accountId: task.accountId,
        type: task.type 
      });

      switch (task.type) {
        case 'poll':
          await this.executePollTask(task);
          break;
        case 'idle':
          await this.executeIdleTask(task);
          break;
        case 'health-check':
          await this.executeHealthCheckTask(task);
          break;
        default:
          throw new Error(`Unknown task type: ${task.type}`);
      }

      // Update stats
      this.stats.tasksProcessed++;
      this.stats.currentTask = undefined;
      
      const executionTime = Date.now() - startTime;
      
      logMetric('imap_worker_task_completed', 1, {
        workerId: this.workerId,
        taskType: task.type,
        accountId: task.accountId,
        executionTime: executionTime.toString()
      });

      logger.info('IMAP task completed successfully', {
        workerId: this.workerId,
        taskId: task.id,
        accountId: task.accountId,
        executionTime
      });

    } catch (error) {
      // Update failure stats
      this.stats.tasksFailed++;
      this.stats.currentTask = undefined;
      
      logMetric('imap_worker_task_failed', 1, {
        workerId: this.workerId,
        taskType: task.type,
        accountId: task.accountId,
        error: error instanceof Error ? error.message : String(error)
      });

      logger.error('IMAP task failed', {
        workerId: this.workerId,
        taskId: task.id,
        accountId: task.accountId,
        error
      });

      throw error;
    }
  }

  /**
   * Execute a polling task
   */
  private async executePollTask(task: ImapWorkerTask): Promise<void> {
    const { accountId, account } = task;
    
    // Get connection from connection manager
    const connection = await imapService.getConnection(accountId, account, task.priority);
    
    try {
      // Validate connection before attempting operations
      if (!this.isConnectionValid(connection)) {
        throw new Error('Connection is not valid or ready');
      }
      
      // Check if connection is already connected, if not connect
      try {
        // Try a simple operation to test if connection is alive
        await connection.noop();
        logger.debug('Connection is already active', { workerId: this.workerId, accountId });
      } catch (error) {
        // Connection is not active, try to connect
        logger.debug('Connection not active, attempting to connect', { workerId: this.workerId, accountId });
        await connection.connect();
        logger.debug('Connection established successfully', { workerId: this.workerId, accountId });
      }
      
      // Open INBOX
      const lock = await connection.getMailboxLock('INBOX');
      
      try {
        // Get mailbox status
        const mailbox = await connection.mailboxOpen('INBOX');
        const currentMessageCount = mailbox.exists;
        
        logger.debug('Mailbox opened for polling', {
          workerId: this.workerId,
          accountId,
          currentMessageCount,
          mailbox: mailbox.path
        });

        // Get last processed message count from database or cache
        const lastProcessedCount = await this.getLastProcessedCount(accountId);
        
        if (currentMessageCount > lastProcessedCount) {
          const newMessageCount = currentMessageCount - lastProcessedCount;
          
          logger.info('New messages detected during polling', {
            workerId: this.workerId,
            accountId,
            lastProcessedCount,
            currentMessageCount,
            newMessageCount
          });

          // Process new messages in batches
          await this.processNewMessages(connection, accountId, lastProcessedCount + 1, currentMessageCount);
          
          // Update last processed count
          await this.updateLastProcessedCount(accountId, currentMessageCount);
        } else {
          logger.debug('No new messages during polling', {
            workerId: this.workerId,
            accountId,
            lastProcessedCount,
            currentMessageCount
          });
        }

      } finally {
        lock.release();
      }

    } catch (error) {
      // Log the specific error for debugging
      logger.error('Polling task failed', {
        workerId: this.workerId,
        accountId,
        error: error instanceof Error ? error.message : String(error),
        errorCode: (error as any)?.code || 'unknown'
      });
      
      // Re-throw the error to be handled by the scheduler
      throw error;
    } finally {
      // Release connection back to pool
      imapService.releaseConnection(accountId);
    }
  }

  /**
   * Execute an IDLE task
   */
  private async executeIdleTask(task: ImapWorkerTask): Promise<void> {
    const { accountId, account } = task;
    
    // Get connection from connection manager
    const connection = await imapService.getConnection(accountId, account, task.priority);
    
    try {
      // Validate connection before attempting operations
      if (!this.isConnectionValid(connection)) {
        throw new Error('Connection is not valid or ready');
      }
      
      // Check if connection is already connected, if not connect
      try {
        // Try a simple operation to test if connection is alive
        await connection.noop();
        logger.debug('Connection is already active for IDLE', { workerId: this.workerId, accountId });
      } catch (error) {
        // Connection is not active, try to connect
        logger.debug('Connection not active for IDLE, attempting to connect', { workerId: this.workerId, accountId });
        await connection.connect();
        logger.debug('Connection established successfully for IDLE', { workerId: this.workerId, accountId });
      }
      
      // Open INBOX
      const lock = await connection.getMailboxLock('INBOX');
      
      try {
        // Get current message count
        const mailbox = await connection.mailboxOpen('INBOX');
        const currentMessageCount = mailbox.exists;
        
        logger.debug('Starting IDLE monitoring', {
          workerId: this.workerId,
          accountId,
          currentMessageCount
        });

        // Start IDLE with timeout
        const idlePromise = connection.idle();
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('IDLE timeout after 30 seconds')), 30000)
        );
        
        try {
          await Promise.race([idlePromise, timeoutPromise]);
          
          logger.info('IDLE connection established', {
            workerId: this.workerId,
            accountId
          });

          // Listen for new messages
          connection.on('exists', async (update: any) => {
            if (update.path === 'INBOX') {
              logger.info('New message detected via IDLE', {
                workerId: this.workerId,
                accountId,
                messageCount: update.count
              });
              
              // Process new message
              await this.processNewMessages(connection, accountId, update.count, update.count);
            }
          });

          // Keep IDLE alive with periodic NOOP
          const noopInterval = setInterval(() => {
            if (!this.isShutdown) {
              connection.noop().catch((error: any) => {
                logger.warn('NOOP command failed', { workerId: this.workerId, accountId, error });
              });
            }
          }, 30000);

          // Wait for shutdown signal or IDLE failure
          await new Promise<void>((resolve, reject) => {
            const shutdownHandler = () => {
              clearInterval(noopInterval);
              resolve();
            };
            
            // Listen for shutdown event
            process.once('SIGTERM', shutdownHandler);
            process.once('SIGINT', shutdownHandler);
            
            // Listen for IDLE errors
            connection.on('error', (error: any) => {
              clearInterval(noopInterval);
              reject(error);
            });
            
            // Listen for connection close
            connection.on('close', () => {
              clearInterval(noopInterval);
              reject(new Error('Connection closed during IDLE'));
            });
          });

          // IDLE completed successfully
          logger.info('IDLE task completed successfully', { workerId: this.workerId, accountId });
          pollingScheduler.handleIdleTaskCompletion(accountId, true);

        } catch (idleError) {
          logger.warn('IDLE failed, falling back to polling', {
            workerId: this.workerId,
            accountId,
            error: idleError
          });
          
          // Notify scheduler that IDLE failed
          pollingScheduler.handleIdleTaskCompletion(accountId, false);
          
          // Fall back to polling
          await this.executePollTask(task);
        }

      } finally {
        lock.release();
      }

    } catch (error) {
      logger.error('IDLE task failed', {
        workerId: this.workerId,
        accountId,
        error: error instanceof Error ? error.message : String(error),
        errorCode: (error as any)?.code || 'unknown'
      });
      
      // Notify scheduler that IDLE failed
      pollingScheduler.handleIdleTaskCompletion(accountId, false);
      
      throw error;
    } finally {
      // Release connection back to pool
      imapService.releaseConnection(accountId);
    }
  }

  /**
   * Execute a health check task
   */
  private async executeHealthCheckTask(task: ImapWorkerTask): Promise<void> {
    const { accountId, account } = task;
    
    try {
      // Get connection from connection manager
      const connection = await imapService.getConnection(accountId, account, task.priority);
      
      try {
        // Validate connection before attempting operations
        if (!this.isConnectionValid(connection)) {
          throw new Error('Connection is not valid or ready');
        }
        
        // Perform health check by trying a NOOP command
        try {
          await connection.noop();
          logger.debug('Account health check passed', {
            workerId: this.workerId,
            accountId
          });
        } catch (error) {
          logger.warn('Account health check failed - NOOP command failed', {
            workerId: this.workerId,
            accountId,
            error: error instanceof Error ? error.message : String(error)
          });
          throw error;
        }
        
      } finally {
        // Release connection back to pool
        imapService.releaseConnection(accountId);
      }
      
    } catch (error) {
      logger.error('Health check task failed', {
        workerId: this.workerId,
        accountId,
        error: error instanceof Error ? error.message : String(error),
        errorCode: (error as any)?.code || 'unknown'
      });
      
      throw error;
    }
  }

  /**
   * Check if a connection is valid and ready for operations
   */
  private isConnectionValid(connection: any): boolean {
    try {
      // Check if connection exists and has required methods
      return connection && 
             typeof connection.noop === 'function' &&
             typeof connection.connect === 'function' &&
             typeof connection.getMailboxLock === 'function';
    } catch {
      return false;
    }
  }

  /**
   * Process new messages in batches
   */
  private async processNewMessages(
    connection: any, 
    accountId: string, 
    startMessage: number, 
    endMessage: number
  ): Promise<void> {
    const batchSize = 10; // Process 10 messages at a time
    const messages: QueuePayload[] = [];
    
    for (let i = startMessage; i <= endMessage; i += batchSize) {
      const batchEnd = Math.min(i + batchSize - 1, endMessage);
      
      try {
        // Fetch messages in batch
        const messageBatch = await connection.fetch(`${i}:${batchEnd}`, {
          envelope: true,
          source: true,
          uid: true
        });

        logger.debug('Fetched message batch', {
          workerId: this.workerId,
          accountId,
          start: i,
          end: batchEnd,
          count: batchEnd - i + 1
        });

        // Process each message in the batch
        for await (const message of messageBatch) {
          try {
            const emailData = this.parseEmail(message, accountId);
            
            // Validate email data
            if (!emailData.messageId || !emailData.internalMessageId) {
              logger.warn('Skipping email with missing required fields', {
                workerId: this.workerId,
                accountId,
                hasOriginalMessageId: !!emailData.messageId,
                hasInternalMessageId: !!emailData.internalMessageId
              });
              continue;
            }

            // Create SQS payload
            const sqsPayload: QueuePayload = {
              type: 'email_reply',
              data: {
                accountId: emailData.accountId,
                messageId: emailData.messageId,
                internalMessageId: emailData.internalMessageId,
                threadId: emailData.threadId,
                inReplyTo: emailData.inReplyTo,
                references: emailData.references,
                timestamp: emailData.timestamp,
                from: emailData.from,
                to: emailData.to,
                subject: emailData.subject,
                text: emailData.text,
                isReply: emailData.isReply,
                receivedAt: emailData.receivedAt.toISOString()
              }
            };

            messages.push(sqsPayload);
            
            // Update stats
            this.stats.emailsProcessed++;
            
          } catch (parseError) {
            logger.error('Failed to parse email message', {
              workerId: this.workerId,
              accountId,
              messageUid: message.uid,
              error: parseError
            });
            
            this.stats.emailsFailed++;
          }
        }

      } catch (fetchError) {
        logger.error('Failed to fetch message batch', {
          workerId: this.workerId,
          accountId,
          start: i,
          end: batchEnd,
          error: fetchError
        });
        
        // Continue with next batch
        continue;
      }
    }

    // Send messages to SQS in batches
    if (messages.length > 0) {
      try {
        if (messages.length <= 10) {
          // Send as single batch
          await sendMessageBatch(messages);
        } else {
          // Send in multiple batches
          for (let i = 0; i < messages.length; i += 10) {
            const batch = messages.slice(i, i + 10);
            await sendMessageBatch(batch);
          }
        }

        logger.info('Messages sent to SQS successfully', {
          workerId: this.workerId,
          accountId,
          messageCount: messages.length
        });

      } catch (sqsError) {
        logger.error('Failed to send messages to SQS', {
          workerId: this.workerId,
          accountId,
          messageCount: messages.length,
          error: sqsError
        });
        
        throw sqsError;
      }
    }
  }

  /**
   * Parse IMAP message to comprehensive format
   */
  private parseEmail(message: FetchMessageObject, accountId: string): any {
    const envelope = message.envelope;
    if (!envelope) {
      return {
        accountId,
        messageId: '',
        internalMessageId: `${accountId}_${message.uid}_${Date.now()}`,
        threadId: '',
        inReplyTo: '',
        references: [],
        from: '',
        to: [],
        subject: '',
        text: message.source?.toString() || '',
        receivedAt: new Date(),
        timestamp: new Date().toISOString(),
        isReply: false
      };
    }
    
    // Extract and clean email addresses
    const fromAddress = envelope.from?.[0]?.address || '';
    const toAddresses = envelope.to?.map(addr => addr.address).filter(Boolean) || [];
    
    // Extract threading information
    const originalMessageId = envelope.messageId || '';
    const inReplyTo = envelope.inReplyTo || '';
    const references = (envelope as any).references || [];
    
    // Determine if this is a reply based on threading headers
    const isReply = Boolean(inReplyTo || references.length > 0);
    
    // Generate internal message ID for tracking
    const internalMessageId = `${accountId}_${message.uid}_${Date.now()}`;
    
    return {
      accountId,
      messageId: originalMessageId,
      internalMessageId,
      threadId: inReplyTo,
      inReplyTo,
      references,
      from: fromAddress,
      to: toAddresses,
      subject: envelope.subject || '',
      text: message.source?.toString() || '',
      receivedAt: envelope.date || new Date(),
      timestamp: (envelope.date || new Date()).toISOString(),
      isReply
    };
  }

  /**
   * Get last processed message count for an account
   */
  private async getLastProcessedCount(accountId: string): Promise<number> {
    try {
      // TODO: Implement actual database call when method is available
      // For now, return 0 to process all messages
      logger.debug('Using placeholder for last processed count', { accountId });
      return 0;
      
    } catch (error) {
      logger.warn('Failed to get last processed count, defaulting to 0', {
        workerId: this.workerId,
        accountId,
        error
      });
      return 0;
    }
  }

  /**
   * Update last processed message count for an account
   */
  private async updateLastProcessedCount(accountId: string, count: number): Promise<void> {
    try {
      // TODO: Implement actual database call when method is available
      logger.debug('Using placeholder for updating last processed count', {
        workerId: this.workerId,
        accountId,
        count
      });
      
    } catch (error) {
      logger.warn('Failed to update last processed count', {
        workerId: this.workerId,
        accountId,
        count,
        error
      });
    }
  }

  /**
   * Get worker statistics
   */
  getStats(): ImapWorkerStats {
    return { ...this.stats };
  }

  /**
   * Shutdown the worker
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down IMAP worker', { workerId: this.workerId });
    
    this.isShutdown = true;
    
    // Clear current task
    this.stats.currentTask = undefined;
    
    logger.info('IMAP worker shutdown completed', { workerId: this.workerId });
  }
}
