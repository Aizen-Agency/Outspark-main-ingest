# Outspark Mail Ingest Service

A scalable IMAP mail ingestion service that monitors email accounts and processes incoming emails using Supabase database and AWS SQS integration.

## 🚀 Features

- **Supabase Integration**: Direct integration with your existing Supabase database
- **Real-time IMAP Monitoring**: Monitors multiple email accounts simultaneously  
- **Connection Status Tracking**: Tracks and manages IMAP connection states
- **AWS SQS Integration**: Queues processed emails for downstream services
- **Health Monitoring**: Built-in health checks and monitoring endpoints
- **Graceful Recovery**: Automatic reconnection and error recovery
- **Scalable Architecture**: Supports concurrent monitoring of multiple accounts

## 🏗️ Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Supabase DB   │────│  Mail Ingest    │────│    AWS SQS      │
│   - email_      │    │    Service      │    │   - Queued      │
│     accounts    │    │  - IMAP Mon.    │    │     Messages    │
│   - connection  │    │  - Processing   │    │   - Downstream  │
│     status      │    │  - Health       │    │     Services    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## 📦 Installation

### Prerequisites

- Node.js 18+
- Supabase account and project
- AWS account with SQS access
- Email accounts with IMAP access

### 1. Clone and Install

```bash
git clone <repository-url>
cd outspark-mail-ingest
npm install
```

### 2. Environment Configuration

Copy the environment template:

```bash
cp env.example .env
```

Configure your environment variables in `.env`:

```env
# Supabase Database Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key

# AWS SQS Configuration
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/your-queue-url

# Service Configuration
NODE_ENV=production
MAX_CONCURRENT_ACCOUNTS=100
MAX_CONNECTIONS_PER_ACCOUNT=3
BATCH_SIZE=10
POLL_INTERVAL=10000

# Monitoring Configuration
MONITORING_ENABLED=true
HEALTH_CHECK_PORT=8080
METRICS_PORT=9090
```

### 3. Database Setup

The service uses the following Supabase tables (which should already exist):

#### `email_accounts_credentials`
Stores email account configuration and credentials.

#### `imap_connection_status` 
Tracks IMAP connection status and statistics for each account.

### 4. Run the Service

Development:
```bash
npm run dev
```

Production:
```bash
npm run build
npm start
```

## 🔧 Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SUPABASE_URL` | Your Supabase project URL | Required |
| `SUPABASE_ANON_KEY` | Your Supabase anon key | Required |
| `AWS_SQS_QUEUE_URL` | SQS queue URL for processed emails | Required |
| `AWS_REGION` | AWS region | us-east-1 |
| `MAX_CONCURRENT_ACCOUNTS` | Maximum accounts to monitor simultaneously | 100 |
| `MAX_CONNECTIONS_PER_ACCOUNT` | Max IMAP connections per account | 3 |
| `HEALTH_CHECK_PORT` | Health check endpoint port | 8080 |

### Email Account Setup

Add email accounts to the `email_accounts_credentials` table in Supabase:

```sql
INSERT INTO email_accounts_credentials (
  userId, email, firstName, lastName,
  imapUsername, imapPassword, imapHost, imapPort,
  smtpUsername, smtpPassword, smtpHost, smtpPort,
  isActive, warmupEnabled
) VALUES (
  'user-id', 'user@example.com', 'John', 'Doe',
  'user@example.com', 'app-password', 'imap.gmail.com', 993,
  'user@example.com', 'app-password', 'smtp.gmail.com', 587,
  true, false
);
```

## 📊 Monitoring

### Health Checks

- **Service Health**: `GET http://localhost:8080/health`
- **Detailed Status**: `GET http://localhost:8080/status`

### Connection Status

The service automatically tracks connection status in the `imap_connection_status` table:

- `connecting` - Establishing connection
- `connected` - Successfully connected 
- `idle` - Connected and monitoring (target state)
- `disconnected` - Connection lost
- `error` - Connection failed
- `reconnecting` - Attempting to reconnect

## 🚦 How It Works

### 1. Account Discovery
- Queries `email_accounts_credentials` joined with `imap_connection_status`
- Only monitors accounts that need reconnection (DISCONNECTED, ERROR, RECONNECTING)

### 2. IMAP Monitoring
- Establishes IMAP connections to email accounts
- Monitors for new emails using IDLE command
- Maintains connections in `idle` state for real-time monitoring

### 3. Email Processing
- Processes incoming emails
- Sends processed data to AWS SQS
- Updates processing statistics

### 4. Connection Management
- Tracks connection attempts, successes, and failures
- Implements automatic reconnection with exponential backoff
- Updates connection status in real-time

## 🔄 Connection Lifecycle

```
DISCONNECTED → CONNECTING → CONNECTED → IDLE
      ↑              ↓
    ERROR  ←  RECONNECTING
```

### Target State: IDLE
When functioning correctly, all email accounts should be in `IDLE` state, which means:
- Successfully connected to IMAP server
- Actively monitoring for new emails
- Ready to process incoming messages

## 🛠️ Development

### Build
```bash
npm run build
```

### Type Checking
```bash
npm run typecheck
```

### Linting
```bash
npm run lint
npm run lint:fix
```

## 🚀 Deployment

### Docker (Recommended)

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist/ ./dist/
EXPOSE 8080 9090
CMD ["npm", "start"]
```

### PM2

```bash
npm install -g pm2
pm2 start dist/index.js --name "mail-ingest"
```

## 🔍 Troubleshooting

### Common Issues

1. **Connection Failures**
   - Check email credentials and IMAP settings
   - Verify firewall/network connectivity
   - Enable "Less secure app access" for Gmail accounts

2. **Database Connection Issues**
   - Verify Supabase URL and key
   - Check network connectivity to Supabase
   - Ensure proper table permissions

3. **SQS Integration Issues**
   - Verify AWS credentials and permissions
   - Check SQS queue URL and region
   - Ensure queue exists and is accessible

### Monitoring Logs

```bash
# View logs in development
npm run dev

# View logs in production (with PM2)
pm2 logs mail-ingest

# View specific log levels
LOG_LEVEL=debug npm run dev
```

## 📈 Performance

- **Concurrent Accounts**: Configurable via `MAX_CONCURRENT_ACCOUNTS`
- **Connection Pooling**: Manages multiple connections per account
- **Memory Efficient**: Uses streaming for large email processing
- **Fault Tolerant**: Graceful handling of connection failures

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

ISC License - see LICENSE file for details.

## 🙋‍♂️ Support

For support and questions:
- Check the troubleshooting section
- Review the logs for error details  
- Open an issue in the repository
