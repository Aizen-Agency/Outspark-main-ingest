// Copy the content from Downloads/supabase.ts
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      email_accounts_credentials: {
        Row: {
          createdAt: string
          dailyLimit: number | null
          email: string
          firstName: string
          id: string
          imapHost: string
          imapPassword: string
          imapPort: number
          imapUsername: string
          isActive: boolean
          lastName: string
          smtpHost: string
          smtpPassword: string
          smtpPort: number
          smtpUsername: string
          updatedAt: string
          userId: string
          warmupEnabled: boolean
          warmupIncrement: number | null
          warmupLimit: number | null
        }
        Insert: {
          createdAt?: string
          dailyLimit?: number | null
          email: string
          firstName: string
          id?: string
          imapHost: string
          imapPassword: string
          imapPort: number
          imapUsername: string
          isActive?: boolean
          lastName: string
          smtpHost: string
          smtpPassword: string
          smtpPort: number
          smtpUsername: string
          updatedAt?: string
          userId: string
          warmupEnabled?: boolean
          warmupIncrement?: number | null
          warmupLimit?: number | null
        }
        Update: {
          createdAt?: string
          dailyLimit?: number | null
          email?: string
          firstName?: string
          id?: string
          imapHost?: string
          imapPassword?: string
          imapPort?: number
          imapUsername?: string
          isActive?: boolean
          lastName?: string
          smtpHost?: string
          smtpPassword?: string
          smtpPort?: number
          smtpUsername?: string
          updatedAt?: string
          userId?: string
          warmupEnabled?: boolean
          warmupIncrement?: number | null
          warmupLimit?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "FK_b68b2869694ae57740bea03b61d"
            columns: ["userId"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      imap_connection_status: {
        Row: {
          connectionAttempts: number
          createdAt: string
          email: string
          emailAccountId: string
          emailsProcessed: number
          failedConnections: number
          id: string
          isActive: boolean
          lastConnectedAt: string | null
          lastDisconnectedAt: string | null
          lastEmailProcessedAt: string | null
          lastErrorAt: string | null
          lastErrorMessage: string | null
          nextReconnectAttempt: string | null
          status: Database["public"]["Enums"]["imap_connection_status_status_enum"]
          successfulConnections: number
          updatedAt: string
        }
        Insert: {
          connectionAttempts?: number
          createdAt?: string
          email: string
          emailAccountId: string
          emailsProcessed?: number
          failedConnections?: number
          id?: string
          isActive?: boolean
          lastConnectedAt?: string | null
          lastDisconnectedAt?: string | null
          lastEmailProcessedAt?: string | null
          lastErrorAt?: string | null
          lastErrorMessage?: string | null
          nextReconnectAttempt?: string | null
          status?: Database["public"]["Enums"]["imap_connection_status_status_enum"]
          successfulConnections?: number
          updatedAt?: string
        }
        Update: {
          connectionAttempts?: number
          createdAt?: string
          email?: string
          emailAccountId?: string
          emailsProcessed?: number
          failedConnections?: number
          id?: string
          isActive?: boolean
          lastConnectedAt?: string | null
          lastDisconnectedAt?: string | null
          lastEmailProcessedAt?: string | null
          lastErrorAt?: string | null
          lastErrorMessage?: string | null
          nextReconnectAttempt?: string | null
          status?: Database["public"]["Enums"]["imap_connection_status_status_enum"]
          successfulConnections?: number
          updatedAt?: string
        }
        Relationships: [
          {
            foreignKeyName: "FK_5fd4d16c5a5786f1d1b200370c0"
            columns: ["emailAccountId"]
            isOneToOne: false
            referencedRelation: "email_accounts_credentials"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      imap_connection_status_status_enum:
        | "connecting"
        | "connected"
        | "idle"
        | "disconnected"
        | "error"
        | "reconnecting"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}
