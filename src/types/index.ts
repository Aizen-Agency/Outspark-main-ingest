export interface EmailAccount {
  id: string;
  email: string;
  password: string;
  host: string;
  port: number;
  secure: boolean;
  tls: boolean;
  tlsOptions?: {
    rejectUnauthorized: boolean;
  };
  maxConcurrentConnections?: number;
  retryAttempts?: number;
  retryDelay?: number;
  isActive: boolean;
  lastSync?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// Database table interface - matches your existing table
export interface EmailAccountsCredentials {
  id: string;
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  imapUsername: string;
  imapPassword: string;
  imapHost: string;
  imapPort: number;
  smtpUsername: string;
  smtpPassword: string;
  smtpHost: string;
  smtpPort: number;
  dailyLimit?: number;
  warmupEnabled: boolean;
  warmupLimit?: number;
  warmupIncrement?: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Database entity for imap_connection_status table
 * This represents the actual database table structure
 */
export interface ImapConnectionStatusEntity {
  id: string;
  email_account_id: string;
  email: string;
  status: ConnectionStatus;
  last_connected_at?: Date;
  last_disconnected_at?: Date;
  last_error_at?: Date;
  last_error_message?: string;
  connection_attempts: number;
  successful_connections: number;
  failed_connections: number;
  emails_processed: number;
  last_email_processed_at?: Date;
  is_active: boolean;
  next_reconnect_attempt?: Date;
  created_at: Date;
  updated_at: Date;
}

/**
 * In-memory connection status tracking
 * This is used internally by the service
 */
export interface ImapConnectionStatus {
  id: string;
  emailAccountId: string;
  email: string;
  status: ConnectionStatus;
  lastConnectedAt?: Date;
  lastDisconnectedAt?: Date;
  lastErrorAt?: Date;
  lastErrorMessage?: string;
  connectionAttempts: number;
  successfulConnections: number;
  failedConnections: number;
  emailsProcessed: number;
  lastEmailProcessedAt?: Date;
  isActive: boolean;
  nextReconnectAttempt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export enum ConnectionStatus {
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  IDLE = 'idle',
  DISCONNECTED = 'disconnected',
  ERROR = 'error',
  RECONNECTING = 'reconnecting'
}

export interface EmailMessage {
  id: string;
  uid: number;
  accountId: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: EmailAttachment[];
  receivedAt: Date;
  processedAt?: Date;
  isReply: boolean;
  inReplyTo?: string;
  references?: string[];
  threadId?: string;
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
}

export interface SQSMessage {
  messageId: string;
  receiptHandle: string;
  body: string;
  attributes: Record<string, string>;
  messageAttributes: Record<string, any>;
  md5OfBody: string;
  eventSource: string;
  eventSourceARN: string;
  awsRegion: string;
}

export interface QueuePayload {
  type: 'email_reply';
  data: {
    accountId: string;
    messageId: string;        // Original email Message-ID header
    internalMessageId: string; // Our generated internal ID for tracking
    threadId?: string;        // In-Reply-To header for threading
    inReplyTo?: string;       // In-Reply-To header
    references?: string[];     // References array for conversation history
    timestamp: string;
    from: string;
    to: string[];
    subject: string;
    text: string;             // Full email body content (headers + body)
    isReply: boolean;
    receivedAt: string;
  };
}

export interface ConnectionPool {
  id: string;
  accountId: string;
  client: any; // IMAPFlow client
  isConnected: boolean;
  lastUsed: Date;
  connectionCount: number;
  maxConnections: number;
}

export interface ServiceConfig {
  maxConcurrentAccounts: number;
  maxConnectionsPerAccount: number;
  connectionTimeout: number;
  idleTimeout: number;
  retryAttempts: number;
  retryDelay: number;
  batchSize: number;
  pollInterval: number;
  
  // Worker pool configuration
  workerPool: {
    maxWorkers: number;
    workerTimeout: number;
    taskQueueSize: number;
  };
  
  // Connection management
  connectionPool: {
    maxConnectionsPerServer: number;
    rateLimitWindow: number;
    maxRateLimit: number;
    connectionIdleTimeout: number;
  };
  
  // Polling configuration
  polling: {
    highPriorityInterval: number;
    mediumPriorityInterval: number;
    lowPriorityInterval: number;
    maxConsecutiveFailures: number;
    backoffMultiplier: number;
  };
  
  sqs: {
    region: string;
    queueUrl: string;
    maxMessages: number;
    visibilityTimeout: number;
    waitTimeSeconds: number;
    batchSize: number;
  };
  
  monitoring: {
    enabled: boolean;
    metricsPort: number;
    healthCheckPort: number;
    metricsInterval: number;
  };
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: Date;
  services: {
    memory: boolean;
    sqs: boolean;
    imap: boolean;
    database: boolean;
  };
  metrics: {
    activeConnections: number;
    totalAccounts: number;
    messagesProcessed: number;
    queueDepth: number;
    memoryUsage: number;
    cpuUsage: number;
  };
}

export interface Metrics {
  accountsTotal: number;
  accountsActive: number;
  connectionsActive: number;
  messagesProcessed: number;
  messagesFailed: number;
  queueDepth: number;
  memoryUsage: number;
  cpuUsage: number;
  responseTime: number;
  errorRate: number;
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface LoggerConfig {
  level: LogLevel;
  format: 'json' | 'pretty';
  destination: 'console' | 'file' | 'both';
  filePath?: string;
  maxSize?: string;
  maxFiles?: number;
}
