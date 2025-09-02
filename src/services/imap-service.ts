import { ImapFlow, ImapFlowOptions, FetchMessageObject } from 'imapflow';
import { logger, logError, logMetric } from '../utils/logger';
import { config } from '../config/index';
import { sendMessage } from './aws-sqs';
import { 
  EmailAccount, 
  EmailMessage, 
  QueuePayload, 
  EmailAccountsCredentials, 
  ImapConnectionStatus, 
  ImapConnectionStatusEntity,
  ConnectionStatus 
} from '../types/index.js';

export class IMAPService {
  private clients: Map<string, ImapFlow> = new Map();
  private idleConnections: Map<string, boolean> = new Map();
  private connectionStatuses: Map<string, ImapConnectionStatus> = new Map();
  private pollingIntervals: Map<string, NodeJS.Timeout> = new Map();

  constructor() {
    logger.info('IMAP Service initialized');
    
    // Start self-healing mechanism
    this.startSelfHealing();
  }

  /**
   * Initialize all email accounts from database
   * This method should be called with the actual database data
   * Only accounts that are in imap_connection_status will be initialized
   */
  async initializeAllAccounts(accounts: EmailAccountsCredentials[]): Promise<void> {
    try {
      const activeAccounts = accounts.filter(acc => acc.isActive);
      logger.info(`Found ${activeAccounts.length} active monitoring accounts to initialize`);

      // Process accounts in batches to avoid overwhelming the system
      const batchSize = 10;
      for (let i = 0; i < activeAccounts.length; i += batchSize) {
        const batch = activeAccounts.slice(i, i + batchSize);
        
        await Promise.all(
          batch.map(account => this.initializeAccountFromDB(account))
        );

        // Small delay between batches to be nice to IMAP servers
        if (i + batchSize < activeAccounts.length) {
          await this.delay(2000);
        }
      }

      logger.info('All active monitoring accounts initialized');
    } catch (error: unknown) {
      throw error;
    }
  }

  /**
   * Initialize a single account from database data
   */
  private async initializeAccountFromDB(dbAccount: EmailAccountsCredentials): Promise<void> {
    try {
      // Check if already connected and healthy
      const existingClient = this.clients.get(dbAccount.id);
      if (existingClient && this.idleConnections.get(dbAccount.id)) {
        // Verify connection is actually healthy
        try {
          await existingClient.noop();
          logger.debug(`Account ${dbAccount.email} already connected and healthy`);
        return;
        } catch (error) {
          logger.warn(`Account ${dbAccount.email} connection unhealthy, reconnecting`);
          await this.removeAccount(dbAccount.id);
        }
      }

      // Convert database entity to EmailAccount type
      const emailAccount: EmailAccount = {
        id: dbAccount.id,
        email: dbAccount.email,
        password: dbAccount.imapPassword,
        host: dbAccount.imapHost,
        port: dbAccount.imapPort,
        secure: dbAccount.imapPort === 993,
        tls: dbAccount.imapPort === 993 || dbAccount.imapPort === 587,
        tlsOptions: { rejectUnauthorized: false },
        maxConcurrentConnections: config.maxConnectionsPerAccount,
        retryAttempts: config.retryAttempts,
        retryDelay: config.retryDelay,
        isActive: dbAccount.isActive,
        lastSync: new Date(),
        createdAt: dbAccount.createdAt,
        updatedAt: dbAccount.updatedAt
      };

      // Create IMAP client
      const client = await this.createImapClient(emailAccount);
      this.clients.set(dbAccount.id, client);

      // Update connection status
      await this.updateConnectionStatus(dbAccount.id, ConnectionStatus.CONNECTED, dbAccount.email);

      // Start monitoring
      await this.startMonitoring(dbAccount.id);

      logger.info(`Account ${dbAccount.email} initialized successfully`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.updateConnectionStatus(dbAccount.id, ConnectionStatus.ERROR, undefined, errorMessage);
      throw error;
    }
  }

  /**
   * Create IMAP client for an account
   */
  private async createImapClient(account: EmailAccount): Promise<ImapFlow> {
    const imapOptions: ImapFlowOptions = {
      host: account.host,
      port: account.port,
      secure: account.secure,
      auth: {
        user: account.email,
        pass: account.password,
      },
      tls: account.tls ? { rejectUnauthorized: false } : undefined,
      logger: false, // Disable IMAPFlow internal logging
      maxIdleTime: config.idleTimeout,
      emitLogs: false,
    };

    const client = new ImapFlow(imapOptions);

    // Setup client event handlers
    this.setupClientEventHandlers(client, account.id);

    return client;
  }

  /**
   * Setup event handlers for IMAP client
   */
  private setupClientEventHandlers(client: ImapFlow, accountId: string): void {
    // Use any type for event handlers to avoid TypeScript issues
    (client as any).on('connect', async () => {
      await this.updateConnectionStatus(accountId, ConnectionStatus.CONNECTED);
      logMetric('imap_connection_established', 1, { accountId });
      logger.info('IMAP connection established', { accountId });
    });

    (client as any).on('ready', async () => {
      await this.updateConnectionStatus(accountId, ConnectionStatus.IDLE);
      logger.info('IMAP client ready', { accountId });
    });

    (client as any).on('error', async (error: any) => {
      this.idleConnections.set(accountId, false);
      const errorMessage = error?.message || String(error);
      await this.updateConnectionStatus(accountId, ConnectionStatus.ERROR, undefined, errorMessage);
      logMetric('imap_connection_error', 1, { accountId });
      logError('IMAP client error', error);
    });

    (client as any).on('close', async () => {
      this.idleConnections.set(accountId, false);
      await this.updateConnectionStatus(accountId, ConnectionStatus.DISCONNECTED);
      logger.warn('IMAP connection closed', { accountId });
    });
  }

  /**
   * Start monitoring an account for new emails
   */
  private async startMonitoring(accountId: string): Promise<void> {
    const client = this.clients.get(accountId);
    if (!client) {
      throw new Error(`Account ${accountId} not connected`);
    }

    try {
      // Connect to IMAP server
      await client.connect();
      
      // Open INBOX
      const lock = await client.getMailboxLock('INBOX');
      
      try {
        // Get current message count
        const mailbox = await client.mailboxOpen('INBOX');
        const totalMessages = mailbox.exists;
        
        logger.info('Started monitoring account', { 
          accountId, 
          totalMessages,
          mailbox: mailbox.path 
        });

        // Start watching for new messages
        await this.watchForNewMessages(client, accountId, mailbox);
        
      } finally {
        lock.release();
      }
    } catch (error) {
      throw error;
    }
  }

  /**
   * Watch for new messages in real-time using IDLE
   */
  private async watchForNewMessages(client: ImapFlow, accountId: string, mailbox: any): Promise<void> {
    try {
      logger.info(`Starting IDLE monitoring for account ${accountId}`);
      
      // Add timeout and better error handling for IDLE
      const idlePromise = client.idle();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('IDLE timeout after 10 seconds')), 10000)
      );
      
      try {
        await Promise.race([idlePromise, timeoutPromise]);
        this.idleConnections.set(accountId, true);
        logger.info(`✅ IDLE connection established and active for account ${accountId}`);
      } catch (idleError) {
        logger.error(`❌ IDLE command failed for account ${accountId}`, { 
          accountId, 
          error: idleError,
          errorMessage: idleError instanceof Error ? idleError.message : 'Unknown error'
        });
        // Fall back to polling instead of IDLE
        await this.fallbackToPolling(client, accountId);
        return;
      }
      
      // Listen for new messages
      (client as any).on('exists', async (update: any) => {
        logger.info(`🔔 NEW MESSAGE DETECTED via IDLE`, { 
          accountId, 
          updatePath: update.path, 
          messageCount: update.count,
          timestamp: new Date().toISOString()
        });
        
        if (update.path === 'INBOX' && this.idleConnections.get(accountId)) {
          logger.info(`📧 Processing new email for account ${accountId}`, { accountId, messageCount: update.count });
          await this.processNewEmail(client, accountId, update.count);
        } else {
          logger.warn(`⚠️ Skipping message - not INBOX or connection inactive`, { 
            accountId, 
            updatePath: update.path, 
            isIDLEActive: this.idleConnections.get(accountId),
            expectedPath: 'INBOX'
          });
        }
      });

      // Keep IDLE connection alive with periodic NOOP
      setInterval(() => {
        if (this.idleConnections.get(accountId)) {
          logger.debug(`Sending NOOP to keep IDLE alive for ${accountId}`);
          client.noop().catch(error => {
            logger.warn('NOOP command failed', { accountId, error });
          });
        }
      }, 30000);

    } catch (error) {
      logger.error(`❌ Failed to establish IDLE connection for ${accountId}`, { accountId, error });
      logError('Failed to watch for new messages', error as Error);
      this.idleConnections.set(accountId, false);
      throw error;
    }
  }

  // Add fallback polling method with better debugging and error handling
  private async fallbackToPolling(client: ImapFlow, accountId: string): Promise<void> {
    logger.warn(`Falling back to polling for account ${accountId} since IDLE failed`);
    
    let lastMessageCount = 0;
    let consecutiveFailures = 0;
    const maxConsecutiveFailures = 3;
    
    try {
      // Get mailbox status using status() method
      const status = await client.status('INBOX', { messages: true });
      lastMessageCount = status.messages || 0;
      logger.info(`Initial message count for polling: ${lastMessageCount}`, { accountId, lastMessageCount });
    } catch (error) {
      logger.error(`Failed to get initial message count for ${accountId}`, { accountId, error });
      consecutiveFailures++;
    }

    // Poll every 30 seconds
    const pollInterval = setInterval(async () => {
      if (!this.clients.has(accountId)) {
        logger.warn(`Stopping polling for ${accountId} - client no longer exists`);
        clearInterval(pollInterval);
        return;
      }
      
      try {
        logger.debug(`🔍 Polling check for account ${accountId}...`);
        
        // Test connection health first
        try {
          await client.noop();
        } catch (noopError) {
          logger.warn(`Connection health check failed during polling for ${accountId}`, { 
            accountId, 
            error: noopError instanceof Error ? noopError.message : String(noopError) 
          });
          consecutiveFailures++;
          
          if (consecutiveFailures >= maxConsecutiveFailures) {
            logger.error(`Too many consecutive failures for ${accountId}, stopping polling`, { 
              accountId, 
              consecutiveFailures 
            });
            clearInterval(pollInterval);
            this.pollingIntervals.delete(accountId);
            return;
          }
          return; // Skip this polling cycle
        }
        
        // Get current mailbox status
        const status = await client.status('INBOX', { messages: true });
        const currentMessageCount = status.messages || 0;
        
        // Reset failure count on successful operation
        consecutiveFailures = 0;
        
        logger.debug(`Polling check complete`, { 
          accountId, 
          previousCount: lastMessageCount,
          currentCount: currentMessageCount 
        });
        
        if (currentMessageCount > lastMessageCount) {
          logger.info(`🔔 NEW MESSAGE DETECTED via POLLING`, { 
            accountId, 
            previousCount: lastMessageCount,
            currentCount: currentMessageCount,
            timestamp: new Date().toISOString()
          });
          
          // Process new messages
          for (let i = lastMessageCount + 1; i <= currentMessageCount; i++) {
            logger.info(`Processing message ${i} for account ${accountId}`);
            await this.processNewEmail(client, accountId, i);
          }
          lastMessageCount = currentMessageCount;
        } else {
          logger.debug(`No new messages for ${accountId}`, { 
            accountId, 
            messageCount: currentMessageCount 
          });
        }
      } catch (error) {
        consecutiveFailures++;
        logger.warn(`Polling check failed for ${accountId}`, { 
          accountId, 
          error: error instanceof Error ? error.message : String(error),
          consecutiveFailures,
          maxConsecutiveFailures
        });
        
        if (consecutiveFailures >= maxConsecutiveFailures) {
          logger.error(`Too many consecutive polling failures for ${accountId}, stopping polling`, { 
            accountId, 
            consecutiveFailures 
          });
          clearInterval(pollInterval);
          this.pollingIntervals.delete(accountId);
        }
      }
    }, 30000); // Poll every 30 seconds

    logger.info(`✅ Polling started for account ${accountId} - will check every 30 seconds`);
    this.pollingIntervals.set(accountId, pollInterval);
  }

  /**
   * Process new email and send to SQS
   */
  private async processNewEmail(client: ImapFlow, accountId: string, messageCount: number): Promise<void> {
    try {
      const lock = await client.getMailboxLock('INBOX');
      
      try {
        // Fetch the latest message
        const messages = await client.fetch(`${messageCount}:${messageCount}`, {
          envelope: true,
          source: true,
          uid: true
        });

        logger.info(`🔍 Fetched ${messageCount} messages for account ${accountId}`);
        
        for await (const message of messages) {
          logger.info(`📧 Raw IMAP message data:`, {
            accountId,
            messageCount,
            uid: message.uid,
            envelope: message.envelope,
            sourceLength: message.source?.length || 0,
            hasSource: !!message.source
          });
          
          const emailData = this.parseEmail(message, accountId);
          
          // Log the complete email content
          logger.info(`📬 COMPLETE EMAIL CONTENT:`, {
            accountId,
            messageCount,
            '=== EMAIL HEADERS ===': '---',
            from: emailData.from,
            to: emailData.to,
            subject: emailData.subject,
            receivedAt: emailData.receivedAt,
            timestamp: emailData.timestamp,
            isReply: emailData.isReply,
            '=== EMAIL THREADING ===': '---',
            originalMessageId: emailData.messageId,
            internalMessageId: emailData.internalMessageId,
            threadId: emailData.threadId,
            inReplyTo: emailData.inReplyTo,
            references: emailData.references,
            '=== EMAIL BODY ===': '---',
            fullText: emailData.text,
            '=== EMAIL METADATA ===': '---',
            messageId: emailData.messageId,
          });
          
          // Also log a cleaner version for readability
          logger.info(`📋 CLEAN EMAIL SUMMARY:`, {
            accountId,
            messageCount,
            from: emailData.from,
            to: emailData.to,
            subject: emailData.subject,
            bodyPreview: emailData.text?.substring(0, 500) + (emailData.text?.length > 500 ? '...' : ''),
            isReply: emailData.isReply,
            receivedAt: emailData.receivedAt,
            originalMessageId: emailData.messageId,
            internalMessageId: emailData.internalMessageId,
            threadId: emailData.threadId,
            inReplyTo: emailData.inReplyTo,
            referencesCount: emailData.references?.length || 0
          });
          
          // Validate email data before sending to SQS
          if (!emailData.messageId || !emailData.internalMessageId) {
            logger.warn(`Skipping email with missing required fields`, {
              accountId,
              messageCount,
              hasOriginalMessageId: !!emailData.messageId,
              hasInternalMessageId: !!emailData.internalMessageId
            });
            continue;
          }

          // Send to SQS immediately
          const sqsPayload: QueuePayload = {
            type: 'email_reply',
            data: {
              accountId: emailData.accountId,
              messageId: emailData.messageId,           // Original Message-ID header
              internalMessageId: emailData.internalMessageId, // Internal tracking ID
              threadId: emailData.threadId,             // In-Reply-To header
              inReplyTo: emailData.inReplyTo,           // In-Reply-To header
              references: emailData.references,         // References array
              timestamp: emailData.timestamp,
              from: emailData.from,
              to: emailData.to,
              subject: emailData.subject,
              text: emailData.text,                     // Full email body content
              isReply: emailData.isReply,
              receivedAt: emailData.receivedAt.toISOString()
            }
          };

          logger.info(`📤 SENDING TO SQS:`, {
            accountId,
            originalMessageId: sqsPayload.data.messageId,
            internalMessageId: sqsPayload.data.internalMessageId,
            threadId: sqsPayload.data.threadId,
            isReply: sqsPayload.data.isReply,
            referencesCount: sqsPayload.data.references?.length || 0
          });

          await sendMessage(sqsPayload);
          
          // Update metrics
          await this.updateEmailProcessed(accountId);
          
          logger.info(`✅ Successfully processed email from ${emailData.from} for account ${accountId}`);
        }

      } finally {
        lock.release();
      }
      
    } catch (error) {
      logError(`Failed to process email for ${accountId}:`, error as Error);
    }
  }

  /**
   * Parse IMAP message to comprehensive format preserving original metadata
   */
  private parseEmail(message: FetchMessageObject, accountId: string): any {
    const envelope = message.envelope;
    if (!envelope) {
      return {
        accountId,
        messageId: '',                    // Original Message-ID header
        internalMessageId: `${accountId}_${message.uid}_${Date.now()}`, // Internal tracking ID
        threadId: '',                     // In-Reply-To header
        inReplyTo: '',                    // In-Reply-To header
        references: [],                   // References array
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
      messageId: originalMessageId,           // Original Message-ID header
      internalMessageId,                      // Internal tracking ID
      threadId: inReplyTo,                   // In-Reply-To header for threading
      inReplyTo,                             // In-Reply-To header
      references,                             // References array for conversation history
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
   * Update connection status in database and memory
   */
  private async updateConnectionStatus(
    accountId: string, 
    status: ConnectionStatus, 
    email?: string,
    errorMessage?: string
  ): Promise<void> {
    try {
      let statusRecord = this.connectionStatuses.get(accountId);

      if (!statusRecord) {
        statusRecord = {
          id: accountId,
          emailAccountId: accountId,
          email: email || '',
          status,
          connectionAttempts: 0,
          successfulConnections: 0,
          failedConnections: 0,
          emailsProcessed: 0,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date()
        };
      }

      // Update status
      statusRecord.status = status;
      statusRecord.updatedAt = new Date();

      // Update specific fields based on status
      switch (status) {
        case ConnectionStatus.CONNECTED:
          statusRecord.lastConnectedAt = new Date();
          statusRecord.successfulConnections++;
          statusRecord.connectionAttempts++;
          break;
        case ConnectionStatus.DISCONNECTED:
          statusRecord.lastDisconnectedAt = new Date();
          break;
        case ConnectionStatus.ERROR:
          statusRecord.lastErrorAt = new Date();
          statusRecord.lastErrorMessage = errorMessage;
          statusRecord.failedConnections++;
          statusRecord.connectionAttempts++;
          break;
        case ConnectionStatus.IDLE:
          // IDLE is a good state, no special updates needed
          break;
        case ConnectionStatus.RECONNECTING:
          statusRecord.nextReconnectAttempt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
          break;
      }

      // Update in-memory status
      this.connectionStatuses.set(accountId, statusRecord);

      // Update database status
      await this.updateDatabaseConnectionStatus(statusRecord);

    } catch (error) {
      logger.error(`Failed to update connection status for ${accountId}:`, error as any);
    }
  }

  /**
   * Update connection status in the database
   */
  private async updateDatabaseConnectionStatus(statusRecord: ImapConnectionStatus): Promise<void> {
    try {
      // Import Supabase database service dynamically
      const { supabaseDatabaseService } = await import('./supabase-database.service');
      
      // Convert our internal status to Supabase format
      const connectionData = {
        emailAccountId: statusRecord.emailAccountId,
        email: statusRecord.email,
        status: statusRecord.status.toLowerCase() as any, // Convert to lowercase for Supabase enum
        lastConnectedAt: statusRecord.lastConnectedAt?.toISOString(),
        lastDisconnectedAt: statusRecord.lastDisconnectedAt?.toISOString(),
        lastErrorAt: statusRecord.lastErrorAt?.toISOString(),
        lastErrorMessage: statusRecord.lastErrorMessage,
        connectionAttempts: statusRecord.connectionAttempts,
        successfulConnections: statusRecord.successfulConnections,
        failedConnections: statusRecord.failedConnections,
        emailsProcessed: statusRecord.emailsProcessed,
        lastEmailProcessedAt: statusRecord.lastEmailProcessedAt?.toISOString(),
        nextReconnectAttempt: statusRecord.nextReconnectAttempt?.toISOString(),
      };

      await supabaseDatabaseService.upsertImapConnectionStatus(connectionData);

      logger.debug(`Updated database connection status for ${statusRecord.email}: ${statusRecord.status}`);
    } catch (error: any) {
      // Handle specific duplicate key violations more gracefully
      if (error?.code === '23505') {
        logger.debug(`Duplicate key handled for ${statusRecord.email}, status update completed by another process`);
      } else {
        logger.warn('Failed to update database connection status:', {
          email: statusRecord.email,
          emailAccountId: statusRecord.emailAccountId,
          status: statusRecord.status,
          error: error?.message || error
        });
      }
      // Don't throw here - we don't want to break the IMAP service if DB is down
    }
  }

  /**
   * Update email processed count in database
   */
  private async updateEmailProcessed(accountId: string): Promise<void> {
    try {
      const statusRecord = this.connectionStatuses.get(accountId);
      if (statusRecord) {
        statusRecord.emailsProcessed++;
        statusRecord.lastEmailProcessedAt = new Date();
        statusRecord.updatedAt = new Date();
        
        // Update in-memory status
        this.connectionStatuses.set(accountId, statusRecord);
        
        // Update database
        await this.updateDatabaseConnectionStatus(statusRecord);
      }
    } catch (error) {
      logger.error(`Failed to update email processed count for ${accountId}:`, error as any);
    }
  }

  /**
   * Get accounts that need reconnection
   * This checks both in-memory status and database status
   */
  async getAccountsNeedingReconnection(): Promise<string[]> {
    try {
      const accountsToReconnect: string[] = [];

      // Check in-memory status first
      for (const [accountId, status] of this.connectionStatuses) {
        if (
          (status.status === ConnectionStatus.DISCONNECTED || status.status === ConnectionStatus.ERROR) &&
          status.isActive
        ) {
          accountsToReconnect.push(accountId);
        }
      }

      // Also check for accounts that have clients but are in bad state
      for (const [accountId, client] of this.clients) {
        try {
          // Quick validation of existing connections
          await client.noop();
        } catch (error) {
          logger.debug(`Found bad connection for ${accountId}, marking for reconnection`);
          accountsToReconnect.push(accountId);
          // Mark as error status
          await this.updateConnectionStatus(accountId, ConnectionStatus.ERROR, 'Connection validation failed');
        }
      }

      // Also check database for accounts that might not be in memory
      try {
        const { supabaseDatabaseService } = await import('./supabase-database.service');
        
        const dbAccountIds = await supabaseDatabaseService.getAccountsNeedingReconnection();

        for (const accountId of dbAccountIds) {
          if (!accountsToReconnect.includes(accountId)) {
            accountsToReconnect.push(accountId);
          }
        }
      } catch (dbError) {
        logger.warn('Failed to check database for accounts needing reconnection:', dbError as any);
      }

      logger.info(`Found ${accountsToReconnect.length} accounts needing reconnection`);
      return accountsToReconnect;
    } catch (error) {
      logger.error('Failed to get accounts needing reconnection:', error as any);
      return [];
    }
  }

  /**
   * Reconnect specific accounts
   * This method should be called with the actual database data
   */
  async reconnectAccounts(accountIds: string[], accounts: EmailAccountsCredentials[]): Promise<void> {
    logger.info(`Attempting to reconnect ${accountIds.length} accounts`);
    
    const failedReconnections: string[] = [];
    
    for (const accountId of accountIds) {
      try {
        // Clean up any existing bad connections first
        await this.cleanupBadConnection(accountId);
        
        // Find account in the provided accounts array
        const account = accounts.find(acc => acc.id === accountId);
        
        if (account && account.isActive) {
          await this.initializeAccountFromDB(account);
          logger.info(`Successfully reconnected account ${accountId}`);
        } else {
          logger.warn(`Account ${accountId} not found or inactive, skipping reconnection`);
        }
      } catch (error) {
        logger.error(`Failed to reconnect account ${accountId}:`, error as Error);
        failedReconnections.push(accountId);
        // Don't throw error to allow other accounts to be reconnected
      }
    }
    
    if (failedReconnections.length > 0) {
      logger.warn(`Failed to reconnect ${failedReconnections.length} accounts:`, failedReconnections);
    }
    
    logger.info(`Reconnection attempt completed. Success: ${accountIds.length - failedReconnections.length}, Failed: ${failedReconnections.length}`);
  }

  /**
   * Clean up bad connections without throwing errors
   */
  private async cleanupBadConnection(accountId: string): Promise<void> {
    const client = this.clients.get(accountId);
    if (client) {
      this.idleConnections.set(accountId, false);
      try {
        // Try to logout, but handle connection errors gracefully
        await client.logout();
      } catch (error) {
        // Handle "Connection not available" error gracefully
        if (error instanceof Error && error.message.includes('Connection not available')) {
          logger.debug(`Connection not available for ${accountId}, proceeding with cleanup`);
        } else {
          logger.debug(`Error during client cleanup for ${accountId}:`, error as Error);
        }
        // Don't throw error for connection issues during cleanup
      }
      
      // Always cleanup regardless of logout success
      this.clients.delete(accountId);
      this.idleConnections.delete(accountId);
      
      await this.updateConnectionStatus(accountId, ConnectionStatus.DISCONNECTED);
      logger.debug(`Account ${accountId} cleaned up`);
    }
  }

  /**
   * Remove account and cleanup connections
   */
  async removeAccount(accountId: string): Promise<void> {
    const client = this.clients.get(accountId);
    if (client) {
      this.idleConnections.set(accountId, false);
      try {
        // Try to logout, but handle connection errors gracefully
        await client.logout();
        // await client.destroy();
      } catch (error) {
        // Handle "Connection not available" error gracefully
        if (error instanceof Error && error.message.includes('Connection not available')) {
          logger.debug(`Connection not available for ${accountId}, proceeding with cleanup`);
        } else {
          logger.warn(`Error during client cleanup for ${accountId}:`, error as Error);
        }
        // Don't throw error for connection issues during cleanup
      }
      
      // Always cleanup regardless of logout success
      this.clients.delete(accountId);
      this.idleConnections.delete(accountId);
      
      await this.updateConnectionStatus(accountId, ConnectionStatus.DISCONNECTED);
      logger.info(`Account ${accountId} removed and cleaned up`);
    }
  }

  /**
   * Get service statistics
   */
  getStats(): Record<string, any> {
    return {
      activeConnections: this.clients.size,
      idleConnections: Array.from(this.idleConnections.values()).filter(Boolean).length,
      totalAccounts: this.clients.size,
    };
  }

  /**
   * Get service metrics (replaces connectionManager.getMetrics)
   */
  getMetrics(): any {
    const activeConnections = this.clients.size;
    const idleConnections = Array.from(this.idleConnections.values()).filter(Boolean).length;
    
    return {
      totalConnections: activeConnections,
      activeConnections: activeConnections,
      failedConnections: 0, // Track this if needed
      rateLimitedConnections: 0, // Track this if needed
      averageConnectionTime: 0, // Track this if needed
      serverGroups: 1, // Simplified for now
      idleConnections: idleConnections,
      totalAccounts: this.clients.size
    };
  }

  /**
   * Get a connection for an account (for worker use)
   */
  async getConnection(accountId: string, account: EmailAccountsCredentials, priority: 'high' | 'medium' | 'low' = 'medium'): Promise<ImapFlow> {
    // Check if we already have a connection for this account
    let client = this.clients.get(accountId);
    
    if (client && this.isConnectionHealthy(client)) {
      // Test the connection with a NOOP to ensure it's actually working
      try {
        await client.noop();
        return client;
      } catch (error) {
        logger.warn(`Connection health check failed for ${accountId}, recreating connection`, { 
          accountId, 
          error: error instanceof Error ? error.message : String(error) 
        });
        // Connection is not actually healthy, remove it
        await this.removeAccount(accountId);
        client = undefined;
      }
    }
    
    // If no connection or unhealthy, create a new one with retry logic
    if (client) {
      await this.removeAccount(accountId);
    }
    
    // Create new connection with retry logic
    const maxRetries = 3;
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const emailAccount: EmailAccount = {
          id: account.id,
          email: account.email,
          password: account.imapPassword,
          host: account.imapHost,
          port: account.imapPort,
          secure: account.imapPort === 993,
          tls: account.imapPort === 993 || account.imapPort === 587,
          tlsOptions: { rejectUnauthorized: false },
          maxConcurrentConnections: config.maxConnectionsPerAccount,
          retryAttempts: config.retryAttempts,
          retryDelay: config.retryDelay,
          isActive: account.isActive,
          lastSync: new Date(),
          createdAt: account.createdAt,
          updatedAt: account.updatedAt
        };
        
        client = await this.createImapClient(emailAccount);
        this.clients.set(accountId, client);
        
        logger.info(`Connection created successfully for ${accountId} (attempt ${attempt})`, { accountId });
        return client;
        
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn(`Failed to create connection for ${accountId} (attempt ${attempt}/${maxRetries})`, { 
          accountId, 
          attempt, 
          maxRetries,
          error: lastError.message 
        });
        
        if (attempt < maxRetries) {
          // Wait before retrying with exponential backoff
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          await this.delay(delay);
        }
      }
    }
    
    // All retries failed
    throw new Error(`Failed to create connection for ${accountId} after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`);
  }

  /**
   * Release a connection (for worker use)
   */
  releaseConnection(accountId: string): void {
    // For now, we don't immediately release connections
    // They will be managed by the service lifecycle
    logger.debug(`Connection release requested for ${accountId}`);
  }

  /**
   * Check if connection is healthy
   */
  private isConnectionHealthy(client: ImapFlow): boolean {
    try {
      // ImapFlow doesn't have destroyed/connected properties
      // We'll check if the client exists and try a NOOP to test connectivity
      return client && typeof client.noop === 'function';
    } catch {
      return false;
    }
  }

  /**
   * Health check for all accounts
   */
  async healthCheck(): Promise<boolean> {
    try {
      let healthyConnections = 0;
      const totalConnections = this.clients.size;
      
      if (totalConnections === 0) {
        logger.warn('No IMAP connections available for health check');
        logMetric('imap_health_check', 0, { 
          healthy: 'unhealthy', 
          total: '0' 
        });
        return false;
      }
      
      for (const [accountId, client] of this.clients) {
        // Check if connection works (regardless of IDLE status)
        try {
          await client.noop();
          healthyConnections++;
        } catch (error) {
          logger.warn('Account health check failed', { accountId, error });
          // Mark this connection as needing reconnection
          await this.updateConnectionStatus(accountId, ConnectionStatus.ERROR, error instanceof Error ? error.message : String(error));
        }
      }
      
      const healthStatus = healthyConnections > 0;
      logMetric('imap_health_check', healthStatus ? 1 : 0, { 
        healthy: healthyConnections ? 'healthy' : 'unhealthy', 
        total: totalConnections.toString() 
      });
      
      logger.debug(`IMAP health check completed: ${healthyConnections}/${totalConnections} connections healthy`);
      
      return healthStatus;
    } catch (error) {
      logError('IMAP service health check failed', error as Error);
      return false;
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    logger.info('Starting IMAP service shutdown');
    
    // Clean up all polling intervals first
    for (const [accountId, interval] of this.pollingIntervals) {
      clearInterval(interval);
      logger.debug(`Cleaned up polling interval for ${accountId}`);
    }
    this.pollingIntervals.clear();
    
    const shutdownPromises: Promise<void>[] = [];
    
    for (const [accountId, client] of this.clients) {
      shutdownPromises.push(this.removeAccount(accountId));
    }
    
    try {
      const results = await Promise.allSettled(shutdownPromises);
      const successful = results.filter(result => result.status === 'fulfilled').length;
      const failed = results.filter(result => result.status === 'rejected').length;
      
      logger.info('IMAP service shutdown completed', { 
        successful, 
        failed, 
        total: this.clients.size 
      });
    } catch (error) {
      logError('Error during IMAP service shutdown', error as Error);
    }
  }

  /**
   * Validate if a connection is still active and usable
   */
  private async validateConnection(accountId: string, client: any): Promise<boolean> {
    try {
      await client.noop();
      return true;
    } catch (error) {
      logger.debug(`Connection validation failed for ${accountId}:`, error as Error);
      return false;
    }
  }

  /**
   * Utility method for delays
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Add this method to check IDLE status
  getIdleConnectionsStatus(): Record<string, boolean> {
    const status: Record<string, boolean> = {};
    for (const [accountId, isIdle] of this.idleConnections.entries()) {
      status[accountId] = isIdle;
    }
    return status;
  }

  /**
   * Start self-healing mechanism to prevent connection issues
   * This does what a restart does, but automatically
   */
  private startSelfHealing(): void {
    // Check connection health every 5 minutes
    setInterval(async () => {
      await this.performSelfHealing();
    }, 5 * 60 * 1000); // 5 minutes

    // Clean up orphaned resources every 10 minutes
    setInterval(async () => {
      await this.cleanupOrphanedResources();
    }, 10 * 60 * 1000); // 10 minutes

    logger.info('Self-healing mechanism started - will check every 5 minutes');
  }

  /**
   * Perform self-healing by validating and fixing connections
   */
  private async performSelfHealing(): Promise<void> {
    logger.debug('Starting self-healing check...');
    
    const deadConnections: string[] = [];
    let healthyConnections = 0;
    
    for (const [accountId, client] of this.clients) {
      try {
        // Test connection with NOOP
        await client.noop();
        healthyConnections++;
        logger.debug(`Connection healthy: ${accountId}`);
      } catch (error) {
        logger.warn(`Dead connection detected during self-healing: ${accountId}`, {
          accountId,
          error: error instanceof Error ? error.message : String(error)
        });
        deadConnections.push(accountId);
      }
    }
    
    // Clean up dead connections
    for (const accountId of deadConnections) {
      logger.info(`Self-healing: Removing dead connection for ${accountId}`);
      await this.removeAccount(accountId);
    }
    
    if (deadConnections.length > 0) {
      logger.info(`Self-healing completed: Removed ${deadConnections.length} dead connections, ${healthyConnections} healthy`);
    } else {
      logger.debug(`Self-healing completed: All ${healthyConnections} connections healthy`);
    }
  }

  /**
   * Clean up orphaned resources (timers, event handlers, etc.)
   */
  private async cleanupOrphanedResources(): Promise<void> {
    logger.debug('Starting orphaned resource cleanup...');
    
    // Clean up polling intervals for accounts that no longer exist
    const orphanedIntervals: string[] = [];
    for (const [accountId, interval] of this.pollingIntervals) {
      if (!this.clients.has(accountId)) {
        clearInterval(interval);
        orphanedIntervals.push(accountId);
      }
    }
    
    // Remove orphaned intervals from map
    for (const accountId of orphanedIntervals) {
      this.pollingIntervals.delete(accountId);
    }
    
    // Clean up idle connection status for accounts that no longer exist
    const orphanedIdleStatus: string[] = [];
    for (const [accountId, isIdle] of this.idleConnections) {
      if (!this.clients.has(accountId)) {
        orphanedIdleStatus.push(accountId);
      }
    }
    
    // Remove orphaned idle status
    for (const accountId of orphanedIdleStatus) {
      this.idleConnections.delete(accountId);
    }
    
    if (orphanedIntervals.length > 0 || orphanedIdleStatus.length > 0) {
      logger.info(`Resource cleanup completed: Removed ${orphanedIntervals.length} orphaned intervals, ${orphanedIdleStatus.length} orphaned idle statuses`);
    } else {
      logger.debug('Resource cleanup completed: No orphaned resources found');
    }
  }
}

// Export singleton instance
export const imapService = new IMAPService();

