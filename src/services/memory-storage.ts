import { logger, logMetric } from '../utils/logger';
import { EmailAccount, ConnectionPool, EmailMessage } from '../types/index';

// In-memory storage
const accounts = new Map<string, EmailAccount>();
const connectionPools = new Map<string, ConnectionPool>();
const activeAccountIds = new Set<string>();
const counters = new Map<string, number>();
const metrics = new Map<string, number>();

/**
 * Initialize memory storage
 */
export function initialize(): void {
  logger.info('Memory storage initialized');
}

/**
 * Health check for memory storage
 */
export function healthCheck(): boolean {
  return true; // Always healthy for in-memory storage
}

// Connection Pool Management
/**
 * Store connection pool information
 */
export function setConnectionPool(pool: ConnectionPool): void {
  connectionPools.set(pool.id, pool);
  logMetric('memory_pool_stored', 1);
}

/**
 * Get connection pool information
 */
export function getConnectionPool(poolId: string): ConnectionPool | undefined {
  return connectionPools.get(poolId);
}

/**
 * Remove connection pool
 */
export function removeConnectionPool(poolId: string): void {
  connectionPools.delete(poolId);
  logMetric('memory_pool_removed', 1);
}

// Email Account Management
/**
 * Store email account configuration
 */
export function setEmailAccount(account: EmailAccount): void {
  accounts.set(account.id, account);
  if (account.isActive) {
    activeAccountIds.add(account.id);
  }
  logMetric('memory_account_stored', 1);
}

/**
 * Get email account configuration
 */
export function getEmailAccount(accountId: string): EmailAccount | undefined {
  return accounts.get(accountId);
}

/**
 * Get all active account IDs
 */
export function getActiveAccountIds(): string[] {
  return Array.from(activeAccountIds);
}

/**
 * Remove email account
 */
export function removeEmailAccount(accountId: string): void {
  accounts.delete(accountId);
  activeAccountIds.delete(accountId);
  logMetric('memory_account_removed', 1);
}

/**
 * Get all accounts
 */
export function getAllAccounts(): EmailAccount[] {
  return Array.from(accounts.values());
}

/**
 * Update account
 */
export function updateAccount(accountId: string, updates: Partial<EmailAccount>): void {
  const account = accounts.get(accountId);
  if (account) {
    const updatedAccount = { ...account, ...updates, updatedAt: new Date() };
    accounts.set(accountId, updatedAccount);
    
    if (updatedAccount.isActive) {
      activeAccountIds.add(accountId);
    } else {
      activeAccountIds.delete(accountId);
    }
  }
}

// Rate Limiting (Simple in-memory implementation)
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

/**
 * Check rate limit for an account
 */
export function checkRateLimit(accountId: string, limit: number, window: number): boolean {
  const key = `ratelimit:${accountId}`;
  const now = Date.now();
  
  const current = rateLimitStore.get(key);
  if (!current || now > current.resetTime) {
    rateLimitStore.set(key, { count: 1, resetTime: now + window * 1000 });
    return true;
  }
  
  if (current.count >= limit) {
    return false;
  }
  
  current.count++;
  return true;
}

/**
 * Get current rate limit count
 */
export function getRateLimitCount(accountId: string): number {
  const key = `ratelimit:${accountId}`;
  const current = rateLimitStore.get(key);
  return current ? current.count : 0;
}

// Performance Metrics
/**
 * Increment performance counter
 */
export function incrementCounter(key: string, value: number = 1): number {
  const current = counters.get(key) || 0;
  const newValue = current + value;
  counters.set(key, newValue);
  return newValue;
}

/**
 * Get performance counter
 */
export function getCounter(key: string): number {
  return counters.get(key) || 0;
}

/**
 * Set performance metric
 */
export function setMetric(key: string, value: number): void {
  metrics.set(key, value);
}

/**
 * Get performance metric
 */
export function getMetric(key: string): number | undefined {
  return metrics.get(key);
}

// Utility Methods
/**
 * Clear all data for testing
 */
export function clearAll(): void {
  accounts.clear();
  connectionPools.clear();
  activeAccountIds.clear();
  counters.clear();
  metrics.clear();
  rateLimitStore.clear();
  logger.info('All memory storage data cleared');
}

/**
 * Get storage statistics
 */
export function getStats(): Record<string, any> {
  return {
    accountsCount: accounts.size,
    activeAccountsCount: activeAccountIds.size,
    connectionPoolsCount: connectionPools.size,
    countersCount: counters.size,
    metricsCount: metrics.size,
    rateLimitEntriesCount: rateLimitStore.size,
  };
}
