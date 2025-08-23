import { SQSClient, SendMessageCommand, SendMessageBatchCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { logger, logError, logMetric } from '../utils/logger';
import { config, awsConfig } from '../config/index';
import { QueuePayload } from '../types/index';

// Initialize SQS client once
const sqsClient = new SQSClient({
  region: config.sqs.region,
  credentials: {
    accessKeyId: awsConfig.accessKeyId || '',
    secretAccessKey: awsConfig.secretAccessKey || '',
    sessionToken: awsConfig.sessionToken,
  },
  maxAttempts: 3,
  requestHandler: {
    httpOptions: {
      timeout: 30000,
      connectTimeout: 5000,
    },
  },
});

logger.info('AWS SQS Service initialized', {
  region: config.sqs.region,
  queueUrl: config.sqs.queueUrl,
  maxMessages: config.sqs.maxMessages,
});

/**
 * Send a single message to SQS
 */
export async function sendMessage(payload: QueuePayload): Promise<string> {
  const timer = logger.time('sqs_send_message');
  
  try {
    const command = new SendMessageCommand({
      QueueUrl: config.sqs.queueUrl,
      MessageBody: JSON.stringify(payload),
      // Add these two required parameters for FIFO queues
      MessageGroupId: payload.data.accountId || 'default', // Use accountId as group ID
      MessageDeduplicationId: `${payload.data.accountId}_${Date.now()}`, // Unique deduplication ID
      MessageAttributes: {
        'MessageType': {
          StringValue: payload.type,
          DataType: 'String',
        },
        'AccountId': {
          StringValue: payload.data.accountId,
          DataType: 'String',
        },
        'OriginalMessageId': {
          StringValue: payload.data.messageId,
          DataType: 'String',
        },
        'InternalMessageId': {
          StringValue: payload.data.internalMessageId,
          DataType: 'String',
        },
        'ThreadId': {
          StringValue: payload.data.threadId || '',
          DataType: 'String',
        },
        'IsReply': {
          StringValue: payload.data.isReply.toString(),
          DataType: 'String',
        },
        'HasTextContent': {
          StringValue: (payload.data.text && payload.data.text.length > 0).toString(),
          DataType: 'String',
        },
        'TextLength': {
          StringValue: (payload.data.text?.length || 0).toString(),
          DataType: 'String',
        },
        'Timestamp': {
          StringValue: payload.data.timestamp,
          DataType: 'String',
        },
      },
      DelaySeconds: 0,
    });

    const response = await sqsClient.send(command);
    
    if (response.MessageId) {
      logMetric('sqs_message_sent', 1, { type: payload.type });
      logger.info('Message sent to SQS successfully', {
        messageId: response.MessageId,
        type: payload.type,
        accountId: payload.data.accountId,
      });
      
      timer();
      return response.MessageId;
    } else {
      throw new Error('No message ID returned from SQS');
    }
  } catch (error) {
    logMetric('sqs_message_failed', 1, { type: payload.type });
    logError('Failed to send message to SQS', error as Error);
    throw error;
  }
}

/**
 * Send multiple messages in a batch to SQS for better performance
 */
export async function sendMessageBatch(payloads: QueuePayload[]): Promise<string[]> {
  if (payloads.length === 0) {
    return [];
  }

  if (payloads.length > 10) {
    throw new Error('Batch size cannot exceed 10 messages');
  }

  const timer = logger.time('sqs_send_batch');
  
  try {
    const entries = payloads.map((payload, index) => ({
      Id: `msg_${index}_${Date.now()}`,
      MessageBody: JSON.stringify(payload),
      MessageAttributes: {
        'MessageType': {
          StringValue: payload.type,
          DataType: 'String',
        },
        'AccountId': {
          StringValue: payload.data.accountId,
          DataType: 'String',
        },
        'OriginalMessageId': {
          StringValue: payload.data.messageId,
          DataType: 'String',
        },
        'InternalMessageId': {
          StringValue: payload.data.internalMessageId,
          DataType: 'String',
        },
        'ThreadId': {
          StringValue: payload.data.threadId || '',
          DataType: 'String',
        },
        'IsReply': {
          StringValue: payload.data.isReply.toString(),
          DataType: 'String',
        },
        'HasTextContent': {
          StringValue: (payload.data.text && payload.data.text.length > 0).toString(),
          DataType: 'String',
        },
        'TextLength': {
          StringValue: (payload.data.text?.length || 0).toString(),
          DataType: 'String',
        },
        'Timestamp': {
          StringValue: payload.data.timestamp,
          DataType: 'String',
        },
      },
      DelaySeconds: 0,
    }));

    const command = new SendMessageBatchCommand({
      QueueUrl: config.sqs.queueUrl,
      Entries: entries,
    });

    const response = await sqsClient.send(command);
    
    if (response.Successful && response.Successful.length > 0) {
      const successfulIds = response.Successful.map(msg => msg.MessageId!);
      
      logMetric('sqs_batch_sent', successfulIds.length, { 
        batchSize: payloads.length.toString(),
        successful: successfulIds.length.toString(),
      });
      
      logger.info('Batch messages sent to SQS successfully', {
        batchSize: payloads.length,
        successful: successfulIds.length,
        messageIds: successfulIds,
      });

      // Log failed messages if any
      if (response.Failed && response.Failed.length > 0) {
        logger.warn('Some messages in batch failed to send', {
          failed: response.Failed.length,
          failures: response.Failed,
        });
      }

      timer();
      return successfulIds;
    } else {
      throw new Error('No successful messages in batch');
    }
  } catch (error) {
    logMetric('sqs_batch_failed', 1, { batchSize: payloads.length.toString() });
    logError('Failed to send message batch to SQS', error as Error);
    throw error;
  }
}

/**
 * Get queue attributes for monitoring
 */
export async function getQueueAttributes(): Promise<Record<string, string>> {
  try {
    const command = new GetQueueAttributesCommand({
      QueueUrl: config.sqs.queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed'],
    });

    const response = await sqsClient.send(command);
    return response.Attributes || {};
  } catch (error) {
    logError('Failed to get queue attributes', error as Error);
    return {};
  }
}

/**
 * Get current queue depth for monitoring
 */
export async function getQueueDepth(): Promise<number> {
  try {
    const attributes = await getQueueAttributes();
    const depth = parseInt(attributes.ApproximateNumberOfMessages || '0');
    
    logMetric('sqs_queue_depth', depth);
    return depth;
  } catch (error) {
    logError('Failed to get queue depth', error as Error);
    return 0;
  }
}

/**
 * Health check for the SQS service
 */
export async function healthCheck(): Promise<boolean> {
  try {
    await getQueueAttributes();
    return true;
  } catch (error) {
    logger.error('SQS health check failed', error as Error);
    return false;
  }
}

/**
 * Close the SQS client
 */
export async function close(): Promise<void> {
  try {
    await sqsClient.destroy();
    logger.info('AWS SQS client closed');
  } catch (error) {
    logError('Error closing SQS client', error as Error);
  }
}

/**
 * Get service statistics
 */
export function getStats(): Record<string, any> {
  return {
    region: config.sqs.region,
    queueUrl: config.sqs.queueUrl,
    maxMessages: config.sqs.maxMessages,
    visibilityTimeout: config.sqs.visibilityTimeout,
    waitTimeSeconds: config.sqs.waitTimeSeconds,
  };
}
