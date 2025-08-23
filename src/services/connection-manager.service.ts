import { EventEmitter } from 'events';
import { logger, logError, logMetric } from '../utils/logger';
import { config } from '../config/index';
import { EmailAccountsCredentials, ConnectionStatus } from '../types/index';

export interface ConnectionPool {
  serverHost: string;
  maxConnections: number;
  currentConnections: number;
  connections: Map<string, any>; // IMAP client connections
  lastConnectionTime: Date;
  rateLimitWindow: number;
  rateLimitCount: number;
  maxRateLimit: number;
}

export interface ConnectionMetrics {
  totalConnections: number;
  activeConnections: number;
  failedConnections: number;
  rateLimitedConnections: number;
  averageConnectionTime: number;
  serverGroups: number;
}

export class ConnectionManager extends EventEmitter {
  private connectionPools: Map<string, ConnectionPool> = new Map();
  private accountConnections: Map<string, string> = new Map(); // accountId -> serverHost
  private connectionQueue: Array<{
    accountId: string;
    account: EmailAccountsCredentials;
    priority: 'high' | 'medium' | 'low';
    resolve: (connection: any) => void;
    reject: (error: Error) => void;
  }> = [];
  private maxConnectionsPerServer: number;
  private rateLimitWindow: number;
  private maxRateLimit: number;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor(
    maxConnectionsPerServer: number = 50,
    rateLimitWindow: number = 60000, // 1 minute
    maxRateLimit: number = 100 // max connections per window
  ) {
    super();
    this.maxConnectionsPerServer = maxConnectionsPerServer;
    this.rateLimitWindow = rateLimitWindow;
    this.maxRateLimit = maxRateLimit;
    
    logger.info('Connection Manager initialized', { 
      maxConnectionsPerServer, 
      rateLimitWindow, 
      maxRateLimit 
    });
    
    this.startHealthMonitoring();
  }

  /**
   * Get or create a connection for an account
   */
  async getConnection(
    accountId: string, 
    account: EmailAccountsCredentials, 
    priority: 'high' | 'medium' | 'low' = 'medium'
  ): Promise<any> {
    const serverHost = this.getServerHost(account);
    
    // Check if account already has a connection
    const existingConnection = this.getExistingConnection(accountId, serverHost);
    if (existingConnection) {
      return existingConnection;
    }

    // Check if we can create a new connection
    if (this.canCreateConnection(serverHost)) {
      return this.createConnection(accountId, account, serverHost);
    }

    // Queue the request
    return new Promise<any>((resolve, reject) => {
      this.connectionQueue.push({
        accountId,
        account,
        priority,
        resolve,
        reject
      });
      
      // Sort queue by priority
      this.sortConnectionQueue();
      
      logger.debug('Connection request queued', { 
        accountId, 
        serverHost, 
        priority,
        queueLength: this.connectionQueue.length 
      });
    });
  }

  /**
   * Get existing connection for an account
   */
  private getExistingConnection(accountId: string, serverHost: string): any | null {
    const pool = this.connectionPools.get(serverHost);
    if (!pool) return null;

    const connection = pool.connections.get(accountId);
    if (connection && this.isConnectionHealthy(connection)) {
      return connection;
    }

    // Remove unhealthy connection
    if (connection) {
      pool.connections.delete(accountId);
      pool.currentConnections--;
    }

    return null;
  }

  /**
   * Check if connection is healthy
   */
  private isConnectionHealthy(connection: any): boolean {
    try {
      // Basic health check - can be enhanced
      return connection && !connection.destroyed && connection.connected;
    } catch {
      return false;
    }
  }

  /**
   * Check if we can create a new connection
   */
  private canCreateConnection(serverHost: string): boolean {
    const pool = this.connectionPools.get(serverHost);
    
    if (!pool) {
      return true; // New server, can create connection
    }

    // Check connection limits
    if (pool.currentConnections >= pool.maxConnections) {
      return false;
    }

    // Check rate limiting
    const now = Date.now();
    if (now - pool.lastConnectionTime.getTime() < pool.rateLimitWindow) {
      if (pool.rateLimitCount >= pool.maxRateLimit) {
        return false;
      }
    } else {
      // Reset rate limit window
      pool.rateLimitWindow = now;
      pool.rateLimitCount = 0;
    }

    return true;
  }

  /**
   * Create a new connection
   */
  private async createConnection(
    accountId: string, 
    account: EmailAccountsCredentials, 
    serverHost: string
  ): Promise<any> {
    try {
      const startTime = Date.now();
      
      // Get or create connection pool
      let pool = this.connectionPools.get(serverHost);
      if (!pool) {
        pool = this.createConnectionPool(serverHost);
        this.connectionPools.set(serverHost, pool);
      }

      // Create IMAP client (placeholder - replace with actual IMAP client creation)
      const connection = await this.createImapClient(account);
      
      // Update pool metrics
      pool.currentConnections++;
      pool.connections.set(accountId, connection);
      pool.lastConnectionTime = new Date();
      pool.rateLimitCount++;
      
      // Track account connection
      this.accountConnections.set(accountId, serverHost);
      
      const connectionTime = Date.now() - startTime;
      
      logMetric('connection_created', 1, {
        serverHost,
        accountId,
        connectionTime: connectionTime.toString()
      });

      logger.info('Connection created successfully', {
        accountId,
        serverHost,
        connectionTime,
        poolConnections: pool.currentConnections
      });

      // Process queued connections
      this.processConnectionQueue();
      
      return connection;
      
    } catch (error) {
      logMetric('connection_failed', 1, {
        serverHost,
        accountId,
        error: error instanceof Error ? error.message : String(error)
      });
      
      logError('Failed to create connection', error as Error);
      throw error;
    }
  }

  /**
   * Create a connection pool for a server
   */
  private createConnectionPool(serverHost: string): ConnectionPool {
    return {
      serverHost,
      maxConnections: this.maxConnectionsPerServer,
      currentConnections: 0,
      connections: new Map(),
      lastConnectionTime: new Date(),
      rateLimitWindow: Date.now(),
      rateLimitCount: 0,
      maxRateLimit: this.maxRateLimit
    };
  }

  /**
   * Create IMAP client (placeholder - replace with actual implementation)
   */
  private async createImapClient(account: EmailAccountsCredentials): Promise<any> {
    // This is a placeholder - replace with actual IMAP client creation
    // For now, return a mock connection object
    
    const mockConnection = {
      id: `${account.id}_${Date.now()}`,
      accountId: account.id,
      serverHost: this.getServerHost(account),
      connected: true,
      destroyed: false,
      createdAt: new Date(),
      lastActivity: new Date(),
      
      // Mock methods
      connect: async () => {
        mockConnection.connected = true;
        mockConnection.lastActivity = new Date();
      },
      
      disconnect: async () => {
        mockConnection.connected = false;
      },
      
      isConnected: () => mockConnection.connected,
      
      // Health check method
      healthCheck: async () => {
        mockConnection.lastActivity = new Date();
        return mockConnection.connected;
      }
    };

    // Simulate connection time
    await new Promise(resolve => setTimeout(resolve, Math.random() * 100 + 50));
    
    return mockConnection;
  }

  /**
   * Get server host from account
   */
  private getServerHost(account: EmailAccountsCredentials): string {
    // Group accounts by IMAP server for better connection management
    const host = account.imapHost.toLowerCase();
    
    // Normalize common IMAP servers
    if (host.includes('gmail.com') || host.includes('google')) {
      return 'gmail.com';
    } else if (host.includes('outlook.com') || host.includes('office365.com')) {
      return 'outlook.office365.com';
    } else if (host.includes('yahoo.com')) {
      return 'imap.mail.yahoo.com';
    } else if (host.includes('mailscale')) {
      return 'mailscale.com';
    } else {
      return host;
    }
  }

  /**
   * Sort connection queue by priority
   */
  private sortConnectionQueue(): void {
    const priorityWeights = { high: 3, medium: 2, low: 1 };
    
    this.connectionQueue.sort((a, b) => {
      return priorityWeights[b.priority] - priorityWeights[a.priority];
    });
  }

  /**
   * Process queued connection requests
   */
  private processConnectionQueue(): void {
    while (this.connectionQueue.length > 0) {
      const request = this.connectionQueue[0];
      const serverHost = this.getServerHost(request.account);
      
      if (this.canCreateConnection(serverHost)) {
        this.connectionQueue.shift(); // Remove from queue
        
        // Create connection asynchronously
        this.createConnection(request.accountId, request.account, serverHost)
          .then(request.resolve)
          .catch(request.reject);
      } else {
        break; // Can't process more requests
      }
    }
  }

  /**
   * Release a connection
   */
  releaseConnection(accountId: string): void {
    const serverHost = this.accountConnections.get(accountId);
    if (!serverHost) return;

    const pool = this.connectionPools.get(serverHost);
    if (!pool) return;

    const connection = pool.connections.get(accountId);
    if (connection) {
      // Cleanup connection
      try {
        if (connection.disconnect) {
          connection.disconnect();
        }
      } catch (error) {
        logger.warn('Error during connection cleanup', { accountId, error });
      }

      pool.connections.delete(accountId);
      pool.currentConnections--;
      this.accountConnections.delete(accountId);

      logger.debug('Connection released', { 
        accountId, 
        serverHost,
        poolConnections: pool.currentConnections 
      });

      // Process queued connections
      this.processConnectionQueue();
    }
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, 60000); // Every minute
  }

  /**
   * Perform health check on all connections
   */
  private async performHealthCheck(): Promise<void> {
    const startTime = Date.now();
    let healthyConnections = 0;
    let unhealthyConnections = 0;

    for (const [serverHost, pool] of this.connectionPools) {
      for (const [accountId, connection] of pool.connections) {
        try {
          if (connection.healthCheck) {
            const isHealthy = await connection.healthCheck();
            if (isHealthy) {
              healthyConnections++;
            } else {
              unhealthyConnections++;
              // Remove unhealthy connection
              this.releaseConnection(accountId);
            }
          }
        } catch (error) {
          unhealthyConnections++;
          logger.warn('Connection health check failed', { accountId, serverHost, error });
          this.releaseConnection(accountId);
        }
      }
    }

    const healthCheckTime = Date.now() - startTime;
    
    logMetric('connection_health_check', 1, {
      healthyConnections: healthyConnections.toString(),
      unhealthyConnections: unhealthyConnections.toString(),
      healthCheckTime: healthCheckTime.toString(),
      totalPools: this.connectionPools.size.toString()
    });

    logger.debug('Connection health check completed', {
      healthyConnections,
      unhealthyConnections,
      healthCheckTime,
      totalPools: this.connectionPools.size
    });
  }

  /**
   * Get connection metrics
   */
  getMetrics(): ConnectionMetrics {
    let totalConnections = 0;
    let activeConnections = 0;
    let failedConnections = 0;
    let rateLimitedConnections = 0;
    let totalConnectionTime = 0;
    let connectionCount = 0;

    for (const pool of this.connectionPools.values()) {
      totalConnections += pool.currentConnections;
      activeConnections += pool.connections.size;
      
      // Calculate average connection time (placeholder)
      totalConnectionTime += 1000; // Mock value
      connectionCount++;
    }

    return {
      totalConnections,
      activeConnections,
      failedConnections,
      rateLimitedConnections,
      averageConnectionTime: connectionCount > 0 ? totalConnectionTime / connectionCount : 0,
      serverGroups: this.connectionPools.size
    };
  }

  /**
   * Get connection pool statistics
   */
  getPoolStats(): Record<string, any> {
    const stats: Record<string, any> = {};
    
    for (const [serverHost, pool] of this.connectionPools) {
      stats[serverHost] = {
        maxConnections: pool.maxConnections,
        currentConnections: pool.currentConnections,
        connectionUtilization: (pool.currentConnections / pool.maxConnections) * 100,
        rateLimitCount: pool.rateLimitCount,
        maxRateLimit: pool.maxRateLimit,
        lastConnectionTime: pool.lastConnectionTime
      };
    }
    
    return stats;
  }

  /**
   * Shutdown all connections
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down connection manager');
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Release all connections
    for (const accountId of this.accountConnections.keys()) {
      this.releaseConnection(accountId);
    }

    // Clear pools
    this.connectionPools.clear();
    this.accountConnections.clear();
    this.connectionQueue = [];

    logger.info('Connection manager shutdown completed');
  }
}

// Export singleton instance
export const connectionManager = new ConnectionManager(
  parseInt(process.env.MAX_CONNECTIONS_PER_SERVER || '50'),
  parseInt(process.env.RATE_LIMIT_WINDOW || '60000'),
  parseInt(process.env.MAX_RATE_LIMIT || '100')
);
