import { createClient } from '@supabase/supabase-js';
import { Database } from '../../types/supabase';
import { logger } from '../../utils/logger';

// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('SUPABASE_URL:', supabaseUrl);
  console.error('SUPABASE_ANON_KEY:', supabaseKey);
  throw new Error('Missing required Supabase environment variables: SUPABASE_URL and SUPABASE_ANON_KEY');
}

// Create Supabase client with proper typing
export const supabase = createClient<Database>(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false, // Since this is a server-side service
  },
  db: {
    schema: 'public',
  },
});

// Test database connection
export async function testConnection(): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('email_accounts_credentials')
      .select('id')
      .limit(1);

    if (error) {
      logger.error('Supabase connection test failed:', error);
      return false;
    }

    logger.info('Supabase connection test successful');
    return true;
  } catch (error) {
    logger.error('Supabase connection test error:', error as any);
    return false;
  }
}

// Export types for convenience
export type EmailAccountsCredentials = Database['public']['Tables']['email_accounts_credentials']['Row'];
export type ImapConnectionStatus = Database['public']['Tables']['imap_connection_status']['Row'];
export type ConnectionStatusEnum = Database['public']['Enums']['imap_connection_status_status_enum'];
