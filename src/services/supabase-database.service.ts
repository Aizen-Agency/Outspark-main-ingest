import { supabase, EmailAccountsCredentials, ImapConnectionStatus, ConnectionStatusEnum, testConnection } from '../Database/config/supabase';
import { logger } from '../utils/logger';

export class SupabaseDatabaseService {
    // Map to track ongoing upsert operations to prevent race conditions
    private readonly ongoingUpserts: Map<string, Promise<ImapConnectionStatus>> = new Map();

    /**
     * Initialize and test database connection
     */
    async initialize(): Promise<void> {
        // Log environment variables (without sensitive data)
        logger.info('Supabase configuration check:', {
            hasUrl: !!process.env.SUPABASE_URL,
            hasKey: !!process.env.SUPABASE_ANON_KEY,
            urlPreview: process.env.SUPABASE_URL ? `${process.env.SUPABASE_URL.substring(0, 20)}...` : 'missing'
        });

        const isConnected = await testConnection();
        if (!isConnected) {
            throw new Error('Failed to connect to Supabase database');
        }
        logger.info('Supabase database connection initialized successfully');
    }

    /**
     * Get active email accounts that need IMAP monitoring
     * Uses optimized JOIN query to fetch everything in one database call
     */
    async getActiveMonitoringAccounts(): Promise<EmailAccountsCredentials[]> {
        try {
            logger.info('Fetching active monitoring accounts with optimized JOIN query...');

            const { data: accounts, error } = await supabase
            .from('imap_connection_status')
            .select('*, email_accounts_credentials(id, userId, email, firstName, lastName, imapUsername, imapPassword, imapHost, imapPort, smtpUsername, smtpPassword, smtpHost, smtpPort, dailyLimit, warmupEnabled, warmupLimit, warmupIncrement, isActive, createdAt, updatedAt)')
            .eq('isActive', true)

            if (error) {
                logger.error('Failed to fetch active monitoring accounts:', error);
                throw error;
            }

            if (!accounts || accounts.length === 0) {
                logger.info('No active monitoring accounts found');
                return [];
            }

            // Transform the joined data back to EmailAccountsCredentials format
            const result: EmailAccountsCredentials[] = accounts.map(account => ({
                id: account.email_accounts_credentials.id,  // ✅ Use the actual email account ID
                userId: account.email_accounts_credentials.userId,
                email: account.email_accounts_credentials.email,
                firstName: account.email_accounts_credentials.firstName,
                lastName: account.email_accounts_credentials.lastName,
                imapUsername: account.email_accounts_credentials.imapUsername,
                imapPassword: account.email_accounts_credentials.imapPassword,
                imapHost: account.email_accounts_credentials.imapHost,
                imapPort: account.email_accounts_credentials.imapPort,
                smtpUsername: account.email_accounts_credentials.smtpUsername,
                smtpPassword: account.email_accounts_credentials.smtpPassword,
                smtpHost: account.email_accounts_credentials.smtpHost,
                smtpPort: account.email_accounts_credentials.smtpPort,
                dailyLimit: account.email_accounts_credentials.dailyLimit,
                warmupEnabled: account.email_accounts_credentials.warmupEnabled,
                warmupLimit: account.email_accounts_credentials.warmupLimit,
                warmupIncrement: account.email_accounts_credentials.warmupIncrement,
                isActive: account.email_accounts_credentials.isActive,
                createdAt: account.email_accounts_credentials.createdAt,
                updatedAt: account.email_accounts_credentials.updatedAt
            }));

            logger.info(`Found ${result.length} active monitoring accounts using optimized JOIN query`);
            return result;

        } catch (error) {
            logger.error('Failed to fetch active monitoring accounts:', error as any);

            // Fallback to the old method if JOIN query fails
            logger.warn('JOIN query failed, falling back to separate queries method...');
            return this.getActiveMonitoringAccountsFallback();
        }
    }

    /**
     * Fallback method using separate queries (the old implementation)
     * Only used if the optimized JOIN query fails
     */
    private async getActiveMonitoringAccountsFallback(): Promise<EmailAccountsCredentials[]> {
        try {
            // Get all active email accounts
            const { data: emailAccounts, error: emailError } = await supabase
                .from('email_accounts_credentials')
                .select('*')
                .eq('isActive', true)
                .order('createdAt', { ascending: false });

            if (emailError) {
                logger.error('Failed to fetch email accounts:', emailError);
                throw emailError;
            }

            if (!emailAccounts || emailAccounts.length === 0) {
                logger.info('No active email accounts found');
                return [];
            }

            // Get IMAP connection statuses for accounts that need monitoring
            const accountIds = emailAccounts.map(acc => acc.id);
            const { data: connectionStatuses, error: statusError } = await supabase
                .from('imap_connection_status')
                .select('emailAccountId, status, isActive')
                .in('emailAccountId', accountIds)
                .eq('isActive', true)
                .in('status', [
                    'disconnected' as ConnectionStatusEnum,
                    'error' as ConnectionStatusEnum,
                    'reconnecting' as ConnectionStatusEnum,
                    'connecting' as ConnectionStatusEnum
                ]);

            if (statusError) {
                logger.error('Failed to fetch IMAP connection statuses:', statusError);
                throw statusError;
            }

            // Filter email accounts to only those that need monitoring
            const accountsNeedingMonitoring = connectionStatuses?.map(status => status.emailAccountId) || [];
            const result = emailAccounts.filter(account =>
                accountsNeedingMonitoring.includes(account.id)
            );

            logger.info(`Found ${result.length} active monitoring accounts using fallback method`);
            return result;

        } catch (error) {
            logger.error('Failed to fetch active monitoring accounts with fallback:', error as any);
            throw error;
        }
    }

    /**
     * Get all active email accounts
     */
    async getAllActiveAccounts(): Promise<EmailAccountsCredentials[]> {
        try {
            const { data, error } = await supabase
                .from('email_accounts_credentials')
                .select('*')
                .eq('isActive', true)
                .order('createdAt', { ascending: false });

            if (error) {
                logger.error('Failed to fetch all active accounts:', error);
                throw error;
            }

            logger.info(`Found ${data?.length || 0} total active email accounts`);
            return data || [];

        } catch (error) {
            logger.error('Failed to fetch all active accounts:', error as any);
            throw error;
        }
    }

    /**
     * Get all active email accounts with their connection status
     * Uses optimized JOIN to fetch complete information in one query
     */
    async getAllActiveAccountsWithStatus(): Promise<Array<EmailAccountsCredentials & { connectionStatus?: any }>> {
        try {
            logger.info('Fetching all active accounts with connection status...');

            // Single query with LEFT JOIN to get accounts and their connection status
            const { data: accounts, error } = await supabase
                .from('email_accounts_credentials')
                .select(`
          *,
          imap_connection_status(
            id,
            status,
            lastConnectedAt,
            lastDisconnectedAt,
            lastErrorAt,
            lastErrorMessage,
            connectionAttempts,
            successfulConnections,
            failedConnections,
            emailsProcessed,
            lastEmailProcessedAt,
            nextReconnectAttempt,
            isActive,
            createdAt,
            updatedAt
          )
        `)
                .eq('isActive', true)
                .order('createdAt', { ascending: false });

            if (error) {
                logger.error('Failed to fetch active accounts with status:', error);
                throw error;
            }

            if (!accounts || accounts.length === 0) {
                logger.info('No active accounts found');
                return [];
            }

            // Transform the joined data
            const result = accounts.map(account => ({
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
                dailyLimit: account.dailyLimit,
                warmupEnabled: account.warmupEnabled,
                warmupLimit: account.warmupLimit,
                warmupIncrement: account.warmupIncrement,
                isActive: account.isActive,
                createdAt: account.createdAt,
                updatedAt: account.updatedAt,
                connectionStatus: account.imap_connection_status?.[0] ? {
                    id: account.imap_connection_status[0].id,
                    emailAccountId: account.id,
                    email: account.email,
                    status: account.imap_connection_status[0].status,
                    lastConnectedAt: account.imap_connection_status[0].lastConnectedAt ? new Date(account.imap_connection_status[0].lastConnectedAt) : undefined,
                    lastDisconnectedAt: account.imap_connection_status[0].lastDisconnectedAt ? new Date(account.imap_connection_status[0].lastDisconnectedAt) : undefined,
                    lastErrorAt: account.imap_connection_status[0].lastErrorAt ? new Date(account.imap_connection_status[0].lastErrorAt) : undefined,
                    lastErrorMessage: account.imap_connection_status[0].lastErrorMessage,
                    connectionAttempts: account.imap_connection_status[0].connectionAttempts,
                    successfulConnections: account.imap_connection_status[0].successfulConnections,
                    failedConnections: account.imap_connection_status[0].failedConnections,
                    emailsProcessed: account.imap_connection_status[0].emailsProcessed,
                    lastEmailProcessedAt: account.imap_connection_status[0].lastEmailProcessedAt ? new Date(account.imap_connection_status[0].lastEmailProcessedAt) : undefined,
                    isActive: account.imap_connection_status[0].isActive,
                    nextReconnectAttempt: account.imap_connection_status[0].nextReconnectAttempt ? new Date(account.imap_connection_status[0].nextReconnectAttempt) : undefined,
                    createdAt: new Date(account.imap_connection_status[0].createdAt),
                    updatedAt: new Date(account.imap_connection_status[0].updatedAt)
                } : undefined
            }));

            logger.info(`Found ${result.length} active accounts with connection status`);
            return result;

        } catch (error) {
            logger.error('Failed to fetch active accounts with status:', error as any);
            throw error;
        }
    }

    /**
     * Get IMAP connection status for a specific email account
     */
    async getImapConnectionStatus(emailAccountId: string): Promise<ImapConnectionStatus | null> {
        try {
            const { data, error } = await supabase
                .from('imap_connection_status')
                .select('*')
                .eq('emailAccountId', emailAccountId)
                .eq('isActive', true)
                .single();

            if (error && error.code !== 'PGRST116') { // PGRST116 is "not found"
                logger.error(`Failed to fetch IMAP connection status for account ${emailAccountId}:`, error);
                throw error;
            }

            return data || null;

        } catch (error) {
            logger.error(`Failed to fetch IMAP connection status for account ${emailAccountId}:`, error as any);
            throw error;
        }
    }

    /**
     * Create or update IMAP connection status
     */
    async upsertImapConnectionStatus(connectionData: {
        emailAccountId: string;
        email: string;
        status: ConnectionStatusEnum;
        lastConnectedAt?: string;
        lastDisconnectedAt?: string;
        lastErrorAt?: string;
        lastErrorMessage?: string;
        connectionAttempts?: number;
        successfulConnections?: number;
        failedConnections?: number;
        emailsProcessed?: number;
        lastEmailProcessedAt?: string;
        nextReconnectAttempt?: string;
    }): Promise<ImapConnectionStatus> {
        const { emailAccountId } = connectionData;

        // Check if there's already an ongoing upsert for this account
        const existingPromise = this.ongoingUpserts.get(emailAccountId);
        if (existingPromise) {
            logger.debug(`Waiting for ongoing upsert to complete for account ${emailAccountId}`);
            return existingPromise;
        }

        // Create and store the upsert promise
        const upsertPromise = this.performUpsert(connectionData);
        this.ongoingUpserts.set(emailAccountId, upsertPromise);

        try {
            const result = await upsertPromise;
            return result;
        } finally {
            // Clean up the promise from the map
            this.ongoingUpserts.delete(emailAccountId);
        }
    }

    /**
     * Perform the actual upsert operation
     */
    private async performUpsert(connectionData: {
        emailAccountId: string;
        email: string;
        status: ConnectionStatusEnum;
        lastConnectedAt?: string;
        lastDisconnectedAt?: string;
        lastErrorAt?: string;
        lastErrorMessage?: string;
        connectionAttempts?: number;
        successfulConnections?: number;
        failedConnections?: number;
        emailsProcessed?: number;
        lastEmailProcessedAt?: string;
        nextReconnectAttempt?: string;
    }): Promise<ImapConnectionStatus> {
        try {
            // First try to update existing record
            const { data: updateData, error: updateError } = await supabase
                .from('imap_connection_status')
                .update({
                    ...connectionData,
                    updatedAt: new Date().toISOString(),
                })
                .eq('emailAccountId', connectionData.emailAccountId)
                .select()
                .single();

            // If update succeeded, return the data
            if (!updateError && updateData) {
                return updateData;
            }

            // If record doesn't exist (PGRST116), try to insert
            if (updateError?.code === 'PGRST116') {
                const { data: insertData, error: insertError } = await supabase
                    .from('imap_connection_status')
                    .insert({
                        ...connectionData,
                        updatedAt: new Date().toISOString(),
                        createdAt: new Date().toISOString(),
                        isActive: true,
                    })
                    .select()
                    .single();

                if (insertError) {
                    // If insert fails due to duplicate key, try update one more time
                    if (insertError.code === '23505') {
                        logger.warn(`Duplicate key detected for emailAccountId ${connectionData.emailAccountId}, retrying update`);

                        const { data: retryData, error: retryError } = await supabase
                            .from('imap_connection_status')
                            .update({
                                ...connectionData,
                                updatedAt: new Date().toISOString(),
                            })
                            .eq('emailAccountId', connectionData.emailAccountId)
                            .select()
                            .single();

                        if (retryError) {
                            logger.error('Failed to upsert IMAP connection status after retry:', retryError);
                            throw retryError;
                        }

                        return retryData;
                    }

                    logger.error('Failed to insert IMAP connection status:', insertError);
                    throw insertError;
                }

                return insertData;
            }

            // For other update errors, throw them
            logger.error('Failed to update IMAP connection status:', updateError);
            throw updateError;

        } catch (error) {
            logger.error('Failed to upsert IMAP connection status:', error as any);
            throw error;
        }
    }

    /**
     * Get accounts that need reconnection
     */
    async getAccountsNeedingReconnection(): Promise<string[]> {
        try {
            const { data, error } = await supabase
                .from('imap_connection_status')
                .select('emailAccountId')
                .eq('isActive', true)
                .in('status', ['error' as ConnectionStatusEnum, 'disconnected' as ConnectionStatusEnum]);

            if (error) {
                logger.error('Failed to fetch accounts needing reconnection:', error);
                throw error;
            }

            return data?.map((item: any) => item.emailAccountId) || [];

        } catch (error) {
            logger.error('Failed to fetch accounts needing reconnection:', error as any);
            throw error;
        }
    }

    /**
     * Update connection status for an account
     */
    async updateConnectionStatus(
        emailAccountId: string,
        status: ConnectionStatusEnum,
        errorMessage?: string
    ): Promise<void> {
        try {
            const updates: Partial<ImapConnectionStatus> = {
                status,
                updatedAt: new Date().toISOString(),
            };

            if (status === 'connected') {
                updates.lastConnectedAt = new Date().toISOString();
                // Note: Supabase doesn't support SQL functions like "column + 1" in updates
                // We'll need to handle incrementing separately
            } else if (status === 'error') {
                updates.lastErrorAt = new Date().toISOString();
                updates.lastErrorMessage = errorMessage;
            } else if (status === 'disconnected') {
                updates.lastDisconnectedAt = new Date().toISOString();
            }

            const { error } = await supabase
                .from('imap_connection_status')
                .update(updates)
                .eq('emailAccountId', emailAccountId);

            if (error) {
                logger.error(`Failed to update connection status for account ${emailAccountId}:`, error);
                throw error;
            }

            // Handle counter increments separately
            if (status === 'connected') {
                await this.incrementSuccessfulConnections(emailAccountId);
            } else if (status === 'error') {
                await this.incrementFailedConnections(emailAccountId);
            }

        } catch (error) {
            logger.error(`Failed to update connection status for account ${emailAccountId}:`, error as any);
            throw error;
        }
    }

    /**
     * Increment connection attempts for an account
     */
    async incrementConnectionAttempts(emailAccountId: string): Promise<void> {
        try {
            // First get current value
            const { data: currentData, error: fetchError } = await supabase
                .from('imap_connection_status')
                .select('connectionAttempts')
                .eq('emailAccountId', emailAccountId)
                .single();

            if (fetchError) {
                logger.error(`Failed to fetch current connection attempts for account ${emailAccountId}:`, fetchError);
                throw fetchError;
            }

            // Update with incremented value
            const { error: updateError } = await supabase
                .from('imap_connection_status')
                .update({
                    connectionAttempts: (currentData?.connectionAttempts || 0) + 1,
                    updatedAt: new Date().toISOString()
                })
                .eq('emailAccountId', emailAccountId);

            if (updateError) {
                logger.error(`Failed to increment connection attempts for account ${emailAccountId}:`, updateError);
                throw updateError;
            }

        } catch (error) {
            logger.error(`Failed to increment connection attempts for account ${emailAccountId}:`, error as any);
            throw error;
        }
    }

    /**
     * Increment successful connections count
     */
    private async incrementSuccessfulConnections(emailAccountId: string): Promise<void> {
        try {
            const { data: currentData, error: fetchError } = await supabase
                .from('imap_connection_status')
                .select('successfulConnections')
                .eq('emailAccountId', emailAccountId)
                .single();

            if (fetchError) {
                throw fetchError;
            }

            const { error: updateError } = await supabase
                .from('imap_connection_status')
                .update({
                    successfulConnections: (currentData?.successfulConnections || 0) + 1
                })
                .eq('emailAccountId', emailAccountId);

            if (updateError) {
                throw updateError;
            }
        } catch (error) {
            logger.error(`Failed to increment successful connections for account ${emailAccountId}:`, error as any);
        }
    }

    /**
     * Increment failed connections count
     */
    private async incrementFailedConnections(emailAccountId: string): Promise<void> {
        try {
            const { data: currentData, error: fetchError } = await supabase
                .from('imap_connection_status')
                .select('failedConnections')
                .eq('emailAccountId', emailAccountId)
                .single();

            if (fetchError) {
                throw fetchError;
            }

            const { error: updateError } = await supabase
                .from('imap_connection_status')
                .update({
                    failedConnections: (currentData?.failedConnections || 0) + 1
                })
                .eq('emailAccountId', emailAccountId);

            if (updateError) {
                throw updateError;
            }
        } catch (error) {
            logger.error(`Failed to increment failed connections for account ${emailAccountId}:`, error as any);
        }
    }

    /**
     * Get database health status
     */
    async healthCheck(): Promise<boolean> {
        try {
            return await testConnection();
        } catch (error) {
            logger.error('Database health check failed:', error as any);
            return false;
        }
    }

    /**
     * Create initial IMAP connection status record for a new account
     */
    async createImapConnectionStatus(emailAccountId: string, email: string): Promise<ImapConnectionStatus> {
        try {
            const { data, error } = await supabase
                .from('imap_connection_status')
                .insert({
                    emailAccountId,
                    email,
                    status: 'disconnected' as ConnectionStatusEnum,
                    connectionAttempts: 0,
                    successfulConnections: 0,
                    failedConnections: 0,
                    emailsProcessed: 0,
                    isActive: true,
                })
                .select()
                .single();

            if (error) {
                logger.error('Failed to create IMAP connection status:', error);
                throw error;
            }

            return data;
        } catch (error) {
            logger.error('Failed to create IMAP connection status:', error as any);
            throw error;
        }
    }

    /**
     * Set connection status to idle for an account
     */
    async setConnectionIdle(emailAccountId: string): Promise<void> {
        try {
            const { error } = await supabase
                .from('imap_connection_status')
                .update({
                    status: 'idle' as ConnectionStatusEnum,
                    updatedAt: new Date().toISOString()
                })
                .eq('emailAccountId', emailAccountId);

            if (error) {
                logger.error(`Failed to set connection idle for account ${emailAccountId}:`, error);
                throw error;
            }
        } catch (error) {
            logger.error(`Failed to set connection idle for account ${emailAccountId}:`, error as any);
            throw error;
        }
    }
}

// Export singleton instance
export const supabaseDatabaseService = new SupabaseDatabaseService();
