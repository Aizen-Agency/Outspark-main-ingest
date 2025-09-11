import { logger, logEvent, logMetric } from './utils/logger';
import { config, validateConfig, environment } from './config/index';
import { getStats, healthCheck, setEmailAccount } from './services/memory-storage';
import { close as closeSQS } from './services/aws-sqs';
import { imapService } from './services/imap-service';
import { startMonitoring, stopMonitoring } from './services/monitoring';
import { EmailAccountsCredentials, EmailAccount } from './types/index';
import { supabaseDatabaseService } from './services/supabase-database.service';

let isShuttingDown = false;
const startTime = new Date();

/**
 * Setup process event handlers
 */
function setupProcessHandlers(): void {
  // Graceful shutdown handlers
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2')); // Nodemon restart

  // Uncaught exception handlers
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', error);
    gracefulShutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection', { reason, promise });
    gracefulShutdown('unhandledRejection');
  });

  // Memory warning handler
  process.on('warning', (warning) => {
    logger.warn('Process warning', warning);
  });
}

/**
 * Get email accounts that are actively being monitored
 * This function fetches only accounts that are in the imap_connection_status table
 * and need IMAP monitoring (not all available accounts)
 */
async function getEmailAccounts(): Promise<EmailAccountsCredentials[]> {
  try {
    // Option 1: Direct database connection using Supabase
    if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
      try {
        return await getActiveMonitoringAccounts();
      } catch (dbError) {
        logger.warn('Supabase query failed, falling back to mock data:', dbError as any);
        return getEmailAccountsMock();
      }
    }
    
    // Option 2: API call to main server (if separate deployment)
    // if (process.env.MAIN_SERVER_API_URL) {
    //   return await getEmailAccountsViaAPI();
    // }
    
    // Option 3: Mock data for testing/development
    logger.warn('No Supabase configuration found, using mock data for development');
    return getEmailAccountsMock();
    
  } catch (error) {
    logger.error('Failed to fetch email accounts:', error as any);
    return getEmailAccountsMock(); // Fallback to mock data
  }
}

/**
 * Fetch only accounts that are actively being monitored
 * This joins email_accounts_credentials with imap_connection_status
 * to get only accounts that need IMAP monitoring
 */
async function getActiveMonitoringAccounts(): Promise<EmailAccountsCredentials[]> {
  try {
    // Initialize Supabase connection
    await supabaseDatabaseService.initialize();
    
    // Get accounts that need monitoring using Supabase
    const accounts = await supabaseDatabaseService.getActiveMonitoringAccounts();
    
    // Convert Supabase format to our expected interface format
    const result: EmailAccountsCredentials[] = accounts.map(account => ({
      id: account.id,
      userId: account.userId,
      email: account.email,
      firstName: account.firstName,
      lastName: account.lastName,
      imapUsername: account.imapUsername,
      imapPassword: account.imapPassword,
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      smtpUsername: account.smtpUsername,
      smtpPassword: account.smtpPassword,
      smtpHost: account.smtpHost,
      smtpPort: account.smtpPort,
      dailyLimit: account.dailyLimit ?? undefined,
      warmupEnabled: account.warmupEnabled,
      warmupLimit: account.warmupLimit ?? undefined,
      warmupIncrement: account.warmupIncrement ?? undefined,
      isActive: account.isActive,
      createdAt: new Date(account.createdAt),
      updatedAt: new Date(account.updatedAt)
    }));
    
    logger.info(`Found ${result.length} active monitoring accounts (using Supabase)`);
    return result;
    
  } catch (error) {
    logger.error('Failed to fetch active monitoring accounts:', error as any);
    throw error;
  }
}

/**
 * Fetch email accounts via API call to main server
 */
async function getEmailAccountsViaAPI(): Promise<EmailAccountsCredentials[]> {
  try {
    const apiUrl = process.env.MAIN_SERVER_API_URL;
    const apiToken = process.env.API_TOKEN;
    
    if (!apiUrl) {
      throw new Error('MAIN_SERVER_API_URL environment variable not set');
    }
    
    const response = await fetch(`${apiUrl}/api/email-accounts`, {
      method: 'GET',
      headers: {
        'Authorization': apiToken ? `Bearer ${apiToken}` : '',
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }

    const accounts = await response.json();
    const activeAccounts = accounts.filter((acc: EmailAccountsCredentials) => acc.isActive);
    
    logger.info(`Fetched ${activeAccounts.length} active email accounts via API`);
    return activeAccounts;
    
  } catch (error) {
    logger.error('Failed to fetch email accounts via API:', error as Error);
    throw error;
  }
}

/**
 * Mock data for testing/development
 */
function getEmailAccountsMock(): EmailAccountsCredentials[] {
  return [
    {
      id: '1',
      userId: 'user1',
      email: 'test1@gmail.com',
      firstName: 'John',
      lastName: 'Doe',
      imapUsername: 'test1@gmail.com',
      imapPassword: 'app_password_1',
      imapHost: 'imap.gmail.com',
      imapPort: 993,
      smtpUsername: 'test1@gmail.com',
      smtpPassword: 'app_password_1',
      smtpHost: 'smtp.gmail.com',
      smtpPort: 587,
      dailyLimit: 100,
      warmupEnabled: false,
      warmupLimit: 0,
      warmupIncrement: 0,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date()
    },
    {
      id: '2',
      userId: 'user2',
      email: 'test2@outlook.com',
      firstName: 'Jane',
      lastName: 'Smith',
      imapUsername: 'test2@outlook.com',
      imapPassword: 'app_password_2',
      imapHost: 'outlook.office365.com',
      imapPort: 993,
      smtpUsername: 'test2@outlook.com',
      smtpPassword: 'app_password_2',
      smtpHost: 'smtp.office365.com',
      smtpPort: 587,
      dailyLimit: 100,
      warmupEnabled: false,
      warmupLimit: 0,
      warmupIncrement: 0,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date()
    }
  ];
}

/**
 * Initialize all services
 */
async function initialize(): Promise<void> {
  try {
    logger.info('Starting Outspark Mail Ingest Service', {
      version: process.env.npm_package_version || 'unknown',
      environment: environment.nodeEnv,
      nodeVersion: process.version,
      pid: process.pid,
    });

    // Validate configuration
    validateConfig();
    logger.info('Configuration validated successfully');

    // Initialize memory storage
    logger.info('Memory storage initialized');

    // Initialize AWS SQS service
    logger.info('AWS SQS service initialized');

    // Get email accounts from main database
    logger.info('Fetching email accounts from main database...');
    const emailAccounts = await getEmailAccounts();
    
    if (emailAccounts.length === 0) {
      logger.warn('No email accounts found - service will not process emails');
    } else {
      logger.info(`Found ${emailAccounts.length} email accounts`);
    }

    // Store accounts in memory storage for metrics tracking
    logger.info('Storing accounts in memory storage...');
    for (const account of emailAccounts) {
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
      setEmailAccount(emailAccount);
    }
    logger.info(`Stored ${emailAccounts.length} accounts in memory storage`);

    // Initialize IMAP service with the accounts data
    logger.info('Initializing IMAP service...');
    if (emailAccounts.length > 0) {
      try {
        await imapService.initializeAllAccounts(emailAccounts);
        logger.info('IMAP service initialized successfully');
      } catch (imapError) {
        logger.error('IMAP service initialization failed, but continuing with available connections', {
          error: imapError instanceof Error ? imapError.message : String(imapError)
        });
        // Don't fail the entire service - let it continue with partial functionality
      }
    } else {
      logger.info('No email accounts to initialize');
    }

    // Initialize monitoring service
    logger.info('Initializing monitoring service...');
    await startMonitoring(config.monitoring.healthCheckPort);
    logger.info('Monitoring service initialized');

    // Log startup metrics
    const uptime = Date.now() - startTime.getTime();
    logMetric('service_startup_time', uptime);
    logEvent('service_started', {
      uptime,
      environment: environment.nodeEnv,
    });

    logger.info('Mail Ingest Service started successfully', {
      uptime: `${Math.round(uptime / 1000)}ms`,
      emailAccountsCount: emailAccounts.length,
      config: {
        maxConcurrentAccounts: config.maxConcurrentAccounts,
        maxConnectionsPerAccount: config.maxConnectionsPerAccount,
        batchSize: config.batchSize,
        pollInterval: config.pollInterval,
      },
    });

  } catch (error) {
    logger.error('Failed to initialize services', error as Error);
    throw error;
  }
}

/**
 * Start the application
 */
async function start(): Promise<void> {
  try {
    await initialize();
    
    // Setup periodic health checks and connection recovery
    setupPeriodicHealthChecks();
    
    logger.info('Application started and ready to process emails');
    
  } catch (error) {
    logger.error('Failed to start application', error as Error);
    await gracefulShutdown('startup_failure');
    process.exit(1);
  }
}

/**
 * Setup periodic health checks and connection recovery
 */
function setupPeriodicHealthChecks(): void {
  // Health check every 30 seconds
  setInterval(async () => {
    try {
      const isHealthy = await performHealthCheck();
      if (!isHealthy) {
        logger.warn('Health check failed, attempting recovery');
        await attemptRecovery();
      }
    } catch (error) {
      logger.error('Periodic health check failed', error as Error);
    }
  }, 30000);

  // Connection recovery every 30 minutes
  setInterval(async () => {
    try {
      await performConnectionRecovery();
    } catch (error) {
      logger.error('Connection recovery failed', error as Error);
    }
  }, 30 * 60 * 1000); // Every 30 minutes

  // Account refresh every 10 minutes (NEW)
  setInterval(async () => {
    try {
      const newAccounts = await getEmailAccounts();
      if (newAccounts.length > 0) {
        // Update memory storage with new accounts
        for (const account of newAccounts) {
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
          setEmailAccount(emailAccount);
        }
        logger.info(`Refreshed ${newAccounts.length} accounts in memory storage`);
      }
    } catch (error) {
      logger.error('Account refresh failed', error as Error);
    }
  }, 10 * 60 * 1000); // Every 10 minutes

  // Performance metrics every 5 minutes
  setInterval(async () => {
    try {
      await collectPerformanceMetrics();
    } catch (error) {
      logger.error('Performance metrics collection failed', error as Error);
    }
  }, 300000);
}

/**
 * Perform health check on all accounts
 */
async function performHealthCheck(): Promise<boolean> {
  try {
    const checks = await Promise.allSettled([
      healthCheck(),
      imapService.healthCheck(),
      supabaseDatabaseService.healthCheck(),
    ]);

    const [memoryHealthy, imapHealthy, databaseHealthy] = checks.map(check => 
      check.status === 'fulfilled' && check.value
    );

    const overallHealth = memoryHealthy && imapHealthy && databaseHealthy;
    
    logMetric('periodic_health_check', overallHealth ? 1 : 0, {
      memory: memoryHealthy ? 'healthy' : 'unhealthy',
      imap: imapHealthy ? 'healthy' : 'unhealthy',
      database: databaseHealthy ? 'healthy' : 'unhealthy',
    });

    return overallHealth;
  } catch (error) {
    logger.error('Health check failed', error as Error);
    return false;
  }
}

/**
 * Perform connection recovery for failed accounts
 */
async function performConnectionRecovery(): Promise<void> {
  try {
    logger.info('Starting connection recovery check...');
    
    // Get fresh accounts data and attempt reconnection
    const emailAccounts = await getEmailAccounts();
    if (emailAccounts.length === 0) {
      logger.warn('No email accounts available for connection recovery');
      return;
    }

    const accountsToReconnect = await imapService.getAccountsNeedingReconnection();
    if (accountsToReconnect.length === 0) {
      logger.info('All connections are healthy');
      return;
    }

    logger.info(`Found ${accountsToReconnect.length} accounts needing reconnection`);
    
    // Reconnect accounts in batches
    const batchSize = 5;
    for (let i = 0; i < accountsToReconnect.length; i += batchSize) {
      const batch = accountsToReconnect.slice(i, i + batchSize);
      
      await imapService.reconnectAccounts(batch, emailAccounts);
      
      // Small delay between batches
      if (i + batchSize < accountsToReconnect.length) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    logger.info('Connection recovery completed');
    
  } catch (error) {
    logger.error('Connection recovery failed:', error as Error);
  }
}

/**
 * Attempt recovery from health check failure
 */
async function attemptRecovery(): Promise<void> {
  try {
    logger.info('Attempting service recovery...');
    
    // Perform connection recovery
    await performConnectionRecovery();
    
    logger.info('Recovery attempt completed');
    
  } catch (error) {
    logger.error('Recovery attempt failed:', error as Error);
  }
}

/**
 * Collect performance metrics
 */
async function collectPerformanceMetrics(): Promise<void> {
  try {
    const stats = getStats();
    const imapStats = imapService.getStats();
    
    // Log key metrics
    logMetric('performance_total_accounts', stats.accountsCount);
    logMetric('performance_active_accounts', stats.activeAccountsCount);
    logMetric('performance_imap_connections', imapStats.activeConnections);
    logMetric('performance_imap_idle_connections', imapStats.idleConnections);
    
    // Memory usage
    const memoryUsage = process.memoryUsage();
    logMetric('performance_memory_heap_used', Math.round(memoryUsage.heapUsed / 1024 / 1024));
    logMetric('performance_memory_heap_total', Math.round(memoryUsage.heapTotal / 1024 / 1024));
    logMetric('performance_memory_rss', Math.round(memoryUsage.rss / 1024 / 1024));
    
  } catch (error) {
    logger.error('Failed to collect performance metrics', error as Error);
  }
}

/**
 * Graceful shutdown
 */
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  logger.info('Starting graceful shutdown', { signal });

  try {
    // Stop monitoring service
    await stopMonitoring();
    logger.info('Monitoring service stopped');

    // Shutdown IMAP service
    await imapService.shutdown();
    logger.info('IMAP service shutdown completed');

    // Close SQS connection
    await closeSQS();
    logger.info('SQS connection closed');

    const uptime = Date.now() - startTime.getTime();
    logEvent('service_shutdown', { signal, uptime });
    
    logger.info('Graceful shutdown completed', {
      signal,
      uptime: `${Math.round(uptime / 1000)}s`,
    });

    process.exit(0);
    
  } catch (error) {
    logger.error('Error during graceful shutdown', error as Error);
    process.exit(1);
  }
}

// Start the application
start().catch((error) => {
  logger.error('Application startup failed', error);
  process.exit(1);
});
