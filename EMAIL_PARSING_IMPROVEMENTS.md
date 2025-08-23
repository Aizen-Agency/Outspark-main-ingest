# Email Parsing Improvements

## Overview
This document outlines the comprehensive improvements made to the email parsing system to preserve original email metadata and threading information.

## Problems Solved

### ❌ **Before (Issues)**:
1. **Wrong messageId**: Generated local IDs instead of preserving original Gmail Message-ID
2. **Missing threading data**: In-Reply-To and References headers were lost
3. **Incomplete metadata**: Only basic fields were sent to SQS
4. **Poor traceability**: No way to track email conversations

### ✅ **After (Solutions)**:
1. **Original Message-ID preserved**: Gmail's Message-ID header is maintained
2. **Complete threading**: In-Reply-To and References are captured
3. **Dual ID system**: Original ID + internal tracking ID
4. **Rich metadata**: All email headers and threading info preserved

## New Data Structure

### **QueuePayload Interface**:
```typescript
interface QueuePayload {
  type: 'email_reply';
  data: {
    accountId: string;
    messageId: string;        // Original Gmail Message-ID
    internalMessageId: string; // Internal tracking ID
    threadId?: string;        // In-Reply-To header
    inReplyTo?: string;       // In-Reply-To header
    references?: string[];     // References array
    timestamp: string;
    from: string;
    to: string[];
    subject: string;
    text: string;             // Full email body content (headers + body)
    isReply: boolean;
    receivedAt: string;
  };
}
```

### **Example SQS Payload**:
```json
{
  "type": "email_reply",
  "data": {
    "accountId": "6c3be8b3-0948-401a-8b97-bf52f4cb0e88",
    "messageId": "<CABMU1SANQwh=-9yFw+zZufDo37uHNnEuBetWGwCd=T4FmD79Xw@mail.gmail.com>",
    "internalMessageId": "6c3be8b3-0948-401a-8b97-bf52f4cb0e88_142_1755892996969",
    "threadId": "<f0a5293a-d027-4fc7-aae6-d05c99d9ad02.1755891242609.xj7eermeuzr@useaizentoolsmedia.com>",
    "inReplyTo": "<f0a5293a-d027-4fc7-aae6-d05c99d9ad02.1755891242609.xj7eermeuzr@useaizentoolsmedia.com>",
    "references": [
      "<f0a5293a-d027-4fc7-aae6-d05c99d9ad02.1755890887990.yxay12c549f@useaizentoolsmedia.com>",
      "<f0a5293a-d027-4fc7-aae6-d05c99d9ad02.1755891242609.xj7eermeuzr@useaizentoolsmedia.com>"
    ],
    "timestamp": "2025-08-22T20:02:51.000Z",
    "from": "shashank@aizentools.com",
    "to": ["zoe@useaizentoolsmedia.com"],
    "subject": "Re: Travis, quick question for strategy??",
    "text": "Return-Path: <shashank@aizentools.com>\r\nDelivered-To: zoe@useaizentoolsmedia.com\r\n... [FULL EMAIL BODY WITH ALL HEADERS] ...",
    "isReply": true,
    "receivedAt": "2025-08-22T20:02:51.000Z"
  }
}
```

## Key Improvements

### 1. **Dual Message ID System**
- **`messageId`**: Original Gmail Message-ID header (for email threading)
- **`internalMessageId`**: Generated internal ID (for system tracking)

### 2. **Complete Threading Information**
- **`threadId`**: In-Reply-To header for conversation linking
- **`inReplyTo`**: Direct reference to parent message
- **`references`**: Full conversation history array

### 3. **Enhanced SQS Attributes**
- **OriginalMessageId**: For filtering by original email ID
- **InternalMessageId**: For system tracking
- **ThreadId**: For conversation grouping
- **IsReply**: Boolean flag for reply detection
- **HasTextContent**: Boolean flag indicating if email has body content
- **TextLength**: Length of email body content for monitoring

### 4. **Complete Email Content Preservation**
- **`text` field**: Contains the full email body including:
  - All email headers (Return-Path, Delivered-To, Received, DKIM, etc.)
  - Authentication results and security headers
  - MIME content (plain text and HTML versions)
  - Email body content
  - Complete conversation history in replies

### 5. **Comprehensive Logging**
- **Raw IMAP data**: Complete message envelope
- **Threading info**: All threading headers
- **SQS payload**: Final message structure
- **Validation**: Required field checks

## Implementation Details

### **parseEmail Method**:
```typescript
private parseEmail(message: FetchMessageObject, accountId: string): any {
  const envelope = message.envelope;
  
  // Extract threading information
  const originalMessageId = envelope.messageId || '';
  const inReplyTo = envelope.inReplyTo || '';
  const references = (envelope as any).references || [];
  
  // Generate internal tracking ID
  const internalMessageId = `${accountId}_${message.uid}_${Date.now()}`;
  
  return {
    messageId: originalMessageId,           // Original Gmail Message-ID
    internalMessageId,                      // Internal tracking ID
    threadId: inReplyTo,                   // In-Reply-To header
    inReplyTo,                             // In-Reply-To header
    references,                             // References array
    // ... other fields
  };
}
```

### **SQS Message Structure**:
```typescript
const sqsPayload: QueuePayload = {
  type: 'email_reply',
  data: {
    accountId: emailData.accountId,
    messageId: emailData.messageId,           // Original Message-ID
    internalMessageId: emailData.internalMessageId, // Internal ID
    threadId: emailData.threadId,             // Thread ID
    inReplyTo: emailData.inReplyTo,           // In-Reply-To
    references: emailData.references,         // References
    // ... complete metadata
  }
};
```

## Benefits

### 1. **Email Threading**
- ✅ Preserve conversation history
- ✅ Link related emails together
- ✅ Maintain Gmail threading structure

### 2. **System Tracking**
- ✅ Internal IDs for monitoring
- ✅ Complete audit trail
- ✅ Performance metrics

### 3. **Downstream Processing**
- ✅ Rich metadata for consumers
- ✅ Thread-aware processing
- ✅ Better email categorization

### 4. **Debugging & Monitoring**
- ✅ Comprehensive logging
- ✅ Data validation
- ✅ Error tracking

## Testing

Run the test script to verify the implementation:
```bash
node test-email-parsing.js
```

This will demonstrate:
- Email parsing functionality
- SQS payload structure
- Data preservation
- Threading information

## Migration Notes

### **Breaking Changes**:
- `QueuePayload.data` structure has changed
- New required fields added
- SQS message attributes updated

### **Backward Compatibility**:
- Existing consumers need to update
- New fields are optional where possible
- Internal tracking IDs are always generated

## Future Enhancements

### **Potential Improvements**:
1. **Email body parsing**: Extract plain text vs HTML
2. **Attachment handling**: Process email attachments
3. **Spam detection**: Basic spam scoring
4. **Rate limiting**: Prevent email flooding
5. **Retry logic**: Handle SQS failures gracefully
