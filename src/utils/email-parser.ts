import { simpleParser, ParsedMail } from 'mailparser';
import { logger } from './logger';

export interface ParsedEmailData {
  accountId: string;
  messageId: string;
  internalMessageId: string;
  threadId: string;
  inReplyTo: string;
  references: string[];
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  receivedAt: Date;
  timestamp: string;
  isReply: boolean;
  attachments?: EmailAttachment[];
  rawMessage?: string; // Base64 encoded raw message for reference
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  size: number;
  content: string; // Base64 encoded
}

/**
 * Parse raw RFC-5322 email message using mailparser
 * This handles proper encoding, MIME parsing, and content extraction
 */
export async function parseEmailMessage(
  rawMessage: Buffer | string,
  accountId: string,
  messageUid: number
): Promise<ParsedEmailData> {
  try {
    // Convert to Buffer if it's a string
    const messageBuffer = Buffer.isBuffer(rawMessage) ? rawMessage : Buffer.from(rawMessage, 'utf8');
    
    // Parse the email using mailparser
    const parsed: ParsedMail = await simpleParser(messageBuffer);
    
    // Extract threading information
    const messageId = parsed.messageId || '';
    const inReplyTo = parsed.inReplyTo || '';
    const references = Array.isArray(parsed.references) ? parsed.references : (parsed.references ? [parsed.references] : []);
    
    // Determine if this is a reply
    const isReply = Boolean(inReplyTo || references.length > 0);
    
    // Generate internal message ID for tracking
    const internalMessageId = `${accountId}_${messageUid}_${Date.now()}`;
    
    // Extract email addresses
    const fromAddress = (parsed.from as any)?.value?.[0]?.address || '';
    const toAddresses = (parsed.to as any)?.value?.map((addr: any) => addr.address).filter(Boolean) || [];
    
    // Get clean text content (prefer text over html)
    const textContent = (parsed.text as string) || (parsed.html as string) || '';
    
    // Process attachments if any
    const attachments: EmailAttachment[] = [];
    if (parsed.attachments && parsed.attachments.length > 0) {
      for (const attachment of parsed.attachments) {
        attachments.push({
          filename: attachment.filename || 'unknown',
          contentType: attachment.contentType || 'application/octet-stream',
          size: attachment.size || 0,
          content: attachment.content.toString('base64')
        });
      }
    }
    
    // Get received date
    const receivedAt = parsed.date || new Date();
    
    const result: ParsedEmailData = {
      accountId,
      messageId,
      internalMessageId,
      threadId: inReplyTo, // Use inReplyTo as threadId for threading
      inReplyTo,
      references,
      from: fromAddress,
      to: toAddresses,
      subject: parsed.subject || '',
      text: textContent,
      html: parsed.html as string | undefined,
      receivedAt,
      timestamp: receivedAt.toISOString(),
      isReply,
      attachments: attachments.length > 0 ? attachments : undefined,
      rawMessage: messageBuffer.toString('base64') // Store raw message as base64 for reference
    };
    
    logger.debug('Email parsed successfully', {
      accountId,
      messageId,
      internalMessageId,
      subject: result.subject,
      from: result.from,
      to: result.to,
      isReply: result.isReply,
      hasAttachments: attachments.length > 0,
      textLength: textContent.length,
      htmlLength: (parsed.html as string)?.length || 0
    });
    
    return result;
    
  } catch (error) {
    logger.error('Failed to parse email message', {
      accountId,
      messageUid,
      error: error instanceof Error ? error.message : String(error)
    });
    
    // Return a fallback structure if parsing fails
    return {
      accountId,
      messageId: '',
      internalMessageId: `${accountId}_${messageUid}_${Date.now()}`,
      threadId: '',
      inReplyTo: '',
      references: [],
      from: '',
      to: [],
      subject: '',
      text: rawMessage.toString('utf8'), // Fallback to raw message as string
      receivedAt: new Date(),
      timestamp: new Date().toISOString(),
      isReply: false
    };
  }
}

/**
 * Check if a message is too large for SQS (256KB limit)
 */
export function isMessageTooLarge(message: string | Buffer): boolean {
  const size = Buffer.isBuffer(message) ? message.length : Buffer.byteLength(message, 'utf8');
  return size > 250000; // 250KB threshold (leaving some buffer)
}

/**
 * Truncate message content if it's too large
 */
export function truncateMessage(message: string, maxLength: number = 200000): string {
  if (message.length <= maxLength) {
    return message;
  }
  
  return message.substring(0, maxLength) + '\n\n[Message truncated due to size]';
}
