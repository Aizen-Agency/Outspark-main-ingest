import { ServiceConfig, LoggerConfig } from '../types/index';
import dotenv from 'dotenv';

dotenv.config();

export const config: ServiceConfig = {
  // Scale to 10k accounts
  maxConcurrentAccounts: parseInt(process.env.MAX_CONCURRENT_ACCOUNTS || '10000'),
  maxConnectionsPerAccount: parseInt(process.env.MAX_CONNECTIONS_PER_ACCOUNT || '3'),
  connectionTimeout: parseInt(process.env.CONNECTION_TIMEOUT || '30000'),
  idleTimeout: parseInt(process.env.IDLE_TIMEOUT || '120000'), // 2 minutes for IDLE
  retryAttempts: parseInt(process.env.RETRY_ATTEMPTS || '3'),
  retryDelay: parseInt(process.env.RETRY_DELAY || '5000'),
  batchSize: parseInt(process.env.BATCH_SIZE || '100'),
  pollInterval: parseInt(process.env.POLL_INTERVAL || '300000'), // 5 minutes default
  
  // Worker pool configuration
  workerPool: {
    maxWorkers: parseInt(process.env.MAX_WORKERS || '50'),
    workerTimeout: parseInt(process.env.WORKER_TIMEOUT || '300000'), // 5 minutes
    taskQueueSize: parseInt(process.env.TASK_QUEUE_SIZE || '10000'),
  },
  
  // Connection management
  connectionPool: {
    maxConnectionsPerServer: parseInt(process.env.MAX_CONNECTIONS_PER_SERVER || '100'),
    rateLimitWindow: parseInt(process.env.RATE_LIMIT_WINDOW || '60000'), // 1 minute
    maxRateLimit: parseInt(process.env.MAX_RATE_LIMIT || '200'), // 200 connections per minute per server
    connectionIdleTimeout: parseInt(process.env.CONNECTION_IDLE_TIMEOUT || '300000'), // 5 minutes
  },
  
  // Polling configuration
  polling: {
    highPriorityInterval: parseInt(process.env.HIGH_PRIORITY_INTERVAL || '60000'), // 1 minute
    mediumPriorityInterval: parseInt(process.env.MEDIUM_PRIORITY_INTERVAL || '300000'), // 5 minutes
    lowPriorityInterval: parseInt(process.env.LOW_PRIORITY_INTERVAL || '900000'), // 15 minutes
    maxConsecutiveFailures: parseInt(process.env.MAX_CONSECUTIVE_FAILURES || '5'),
    backoffMultiplier: parseFloat(process.env.BACKOFF_MULTIPLIER || '2.0'),
  },
  
  sqs: {
    region: process.env.AWS_REGION || 'us-east-1',
    queueUrl: process.env.AWS_SQS_QUEUE_URL || '',
    maxMessages: parseInt(process.env.AWS_SQS_MAX_MESSAGES || '10'),
    visibilityTimeout: parseInt(process.env.AWS_SQS_VISIBILITY_TIMEOUT || '30'),
    waitTimeSeconds: parseInt(process.env.AWS_SQS_WAIT_TIME || '20'),
    batchSize: parseInt(process.env.AWS_SQS_BATCH_SIZE || '10'),
  },
  
  monitoring: {
    enabled: process.env.MONITORING_ENABLED === 'true',
    metricsPort: parseInt(process.env.METRICS_PORT || '9090'),
    healthCheckPort: parseInt(process.env.HEALTH_CHECK_PORT || '8080'),
    metricsInterval: parseInt(process.env.METRICS_INTERVAL || '60000'), // 1 minute
  },
  
  // Connection settings
  connection: {
    maxRetries: 3,
    retryDelay: 5000, // 5 seconds
    connectionTimeout: 30000, // 30 seconds
    idleTimeout: 30000, // 30 seconds for IDLE
    noopInterval: 30000, // 30 seconds for NOOP
    maxIdleFailures: 3, // Max IDLE failures before falling back to polling
    pollingInterval: 30000, // 30 seconds for polling fallback
  },
};

export const loggerConfig: LoggerConfig = {
  level: (process.env.LOG_LEVEL as any) || 'info',
  format: (process.env.LOG_FORMAT as any) || 'json',
  destination: (process.env.LOG_DESTINATION as any) || 'console',
  filePath: process.env.LOG_FILE_PATH || './logs/app.log',
  maxSize: process.env.LOG_MAX_SIZE || '20m',
  maxFiles: parseInt(process.env.LOG_MAX_FILES || '14'),
};

export const environment = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  isDevelopment: process.env.NODE_ENV === 'development',
  isTest: process.env.NODE_ENV === 'test',
};

export const awsConfig = {
  region: process.env.AWS_REGION || 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  sessionToken: process.env.AWS_SESSION_TOKEN,
};

export const imapDefaults = {
  defaultPorts: {
    imap: 143,
    imaps: 993,
  },
  defaultHosts: {
    gmail: 'imap.gmail.com',
    outlook: 'outlook.office365.com',
    yahoo: 'imap.mail.yahoo.com',
  },
};

// Validation
export function validateConfig(): void {
  const requiredEnvVars = [
    'AWS_SQS_QUEUE_URL',
    'AWS_REGION',
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
  ];

  const missing = requiredEnvVars.filter(envVar => !process.env[envVar]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (config.maxConcurrentAccounts <= 0) {
    throw new Error('MAX_CONCURRENT_ACCOUNTS must be greater than 0');
  }

  if (config.maxConnectionsPerAccount <= 0) {
    throw new Error('MAX_CONNECTIONS_PER_ACCOUNT must be greater than 0');
  }

  if (config.sqs.queueUrl === '') {
    throw new Error('AWS_SQS_QUEUE_URL is required');
  }
}

// Get configuration for specific environment
export function getConfigForEnvironment(env: string): Partial<ServiceConfig> {
  switch (env) {
    case 'production':
      return {
        maxConcurrentAccounts: 500,
        maxConnectionsPerAccount: 10,
        connectionTimeout: 60000,
        idleTimeout: 120000,
        retryAttempts: 5,
        retryDelay: 10000,
        batchSize: 100,
        pollInterval: 5000,
      };
    case 'staging':
      return {
        maxConcurrentAccounts: 200,
        maxConnectionsPerAccount: 8,
        connectionTimeout: 45000,
        idleTimeout: 90000,
        retryAttempts: 4,
        retryDelay: 8000,
        batchSize: 75,
        pollInterval: 8000,
      };
    case 'development':
      return {
        maxConcurrentAccounts: 50,
        maxConnectionsPerAccount: 3,
        connectionTimeout: 30000,
        idleTimeout: 60000,
        retryAttempts: 3,
        retryDelay: 5000,
        batchSize: 25,
        pollInterval: 15000,
      };
    default:
      return {};
  }
}
