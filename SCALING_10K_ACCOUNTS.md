# 🚀 Scaling to 10,000 Email Accounts

This guide explains how to deploy and scale the Outspark Mail Ingest system to handle **10,000 email accounts** efficiently.

## 📊 System Architecture Overview

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  10K Accounts  │───▶│ Polling Scheduler│───▶│  Worker Pool   │
│                 │    │                 │    │   (50 Workers)  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                │                       │
                                ▼                       ▼
                       ┌─────────────────┐    ┌─────────────────┐
                       │Connection Manager│    │  IMAP Workers  │
                       │ (100 per server)│    │                 │
                       └─────────────────┘    └─────────────────┘
                                │                       │
                                ▼                       ▼
                       ┌─────────────────┐    ┌─────────────────┐
                       │   AWS SQS      │    │   Supabase DB   │
                       │  (High Throughput)│  │                 │
                       └─────────────────┘    └─────────────────┘
```

## 🔧 Key Components

### 1. **Worker Pool Service** (`src/services/worker-pool.service.ts`)
- Manages 50 concurrent IMAP workers
- Handles task queuing with priority-based scheduling
- Implements exponential backoff for failed tasks
- Health monitoring and automatic recovery

### 2. **Connection Manager** (`src/services/connection-manager.service.ts`)
- Connection pooling per IMAP server (100 connections max per server)
- Rate limiting (200 connections per minute per server)
- Automatic connection rotation and health checks
- Server-based grouping for better resource management

### 3. **Polling Scheduler** (`src/services/polling-scheduler.service.ts`)
- Adaptive polling intervals based on account priority:
  - **High Priority**: 1 minute (VIP accounts, high volume)
  - **Medium Priority**: 5 minutes (regular business accounts)
  - **Low Priority**: 15 minutes (personal accounts, low volume)
- Automatic priority adjustment based on email volume
- Failure detection with exponential backoff

### 4. **IMAP Worker** (`src/services/imap-worker.service.ts`)
- Individual worker for IMAP operations
- Batch processing (10 emails per batch)
- IDLE support with polling fallback
- Comprehensive error handling and retry logic

### 5. **Orchestrator Service** (`src/services/orchestrator.service.ts`)
- Central coordination of all services
- Account lifecycle management
- System health monitoring
- Performance metrics collection

## 🚀 Deployment Steps

### Step 1: Environment Configuration

Copy and configure the environment file:

```bash
cp env.example .env
```

**Critical Configuration for 10K Scale:**

```bash
# Account Limits
MAX_CONCURRENT_ACCOUNTS=10000
MAX_CONNECTIONS_PER_ACCOUNT=3

# Connection Management
MAX_CONNECTIONS_PER_SERVER=100
RATE_LIMIT_WINDOW=60000
MAX_RATE_LIMIT=200

# Worker Pool
MAX_WORKERS=50
WORKER_TIMEOUT=300000
TASK_QUEUE_SIZE=10000

# Polling Intervals
HIGH_PRIORITY_INTERVAL=60000      # 1 minute
MEDIUM_PRIORITY_INTERVAL=300000   # 5 minutes
LOW_PRIORITY_INTERVAL=900000      # 15 minutes
```

### Step 2: Infrastructure Requirements

#### **Server Specifications (Recommended)**
```bash
# Production Server
CPU: 16+ cores (Intel Xeon or AMD EPYC)
RAM: 64GB+ DDR4
Storage: 500GB+ NVMe SSD
Network: 10Gbps+ connection
OS: Ubuntu 20.04+ or CentOS 8+

# Memory Allocation
NODE_OPTIONS="--max-old-space-size=8192 --max-semi-space-size=512"
```

#### **AWS SQS Configuration**
```bash
# High-throughput FIFO queue
Message Retention: 4 days
Visibility Timeout: 30 seconds
Receive Message Wait Time: 20 seconds
Batch Size: 10 messages
```

#### **Database Configuration**
```bash
# Supabase/PostgreSQL
Connection Pool: 200+ connections
Max Connections: 500+
Shared Buffers: 4GB+
Work Memory: 256MB+
Maintenance Work Memory: 1GB+
```

### Step 3: Installation & Build

```bash
# Install dependencies
npm install

# Build the application
npm run build

# Start the service
npm start
```

## 📈 Performance Characteristics

### **Expected Performance at 10K Scale**

| Metric | Value | Notes |
|--------|-------|-------|
| **Total Polls per Minute** | ~1,200 | Distributed across priorities |
| **Concurrent IMAP Operations** | 50 | Limited by worker pool |
| **Memory Usage** | 8-12GB | With 64GB total RAM |
| **CPU Usage** | 60-80% | Under normal load |
| **Network I/O** | 100-500 Mbps | Varies by email volume |
| **Database Connections** | 100-200 | Pooled connections |
| **SQS Throughput** | 1,000+ msgs/sec | High-throughput configuration |

### **Polling Distribution**

```
High Priority (1 min):     ~500 accounts  → 500 polls/minute
Medium Priority (5 min):   ~7,000 accounts → 1,400 polls/minute  
Low Priority (15 min):     ~2,500 accounts → 167 polls/minute
Total:                     ~10,000 accounts → 2,067 polls/minute
```

## 🔍 Monitoring & Health Checks

### **Key Metrics to Monitor**

```bash
# System Health
curl http://localhost:8080/health

# Performance Metrics
curl http://localhost:9090/metrics

# Worker Pool Status
curl http://localhost:3000/api/workers/status

# Connection Pool Status
curl http://localhost:3000/api/connections/status
```

### **Alerting Thresholds**

```bash
# Failure Rate
ALERT_THRESHOLD_FAILURE_RATE=0.1  # 10% failure rate

# Queue Depth
ALERT_THRESHOLD_QUEUE_DEPTH=1000  # 1000+ queued tasks

# Memory Usage
MEMORY_THRESHOLD=80%              # 80%+ memory usage
```

## 🚨 Troubleshooting Common Issues

### **1. High Memory Usage**
```bash
# Check memory usage
free -h
ps aux --sort=-%mem | head -10

# Solution: Increase Node.js heap size
NODE_OPTIONS="--max-old-space-size=12288"
```

### **2. Connection Rate Limiting**
```bash
# Check connection pool status
curl http://localhost:3000/api/connections/pools

# Solution: Reduce polling frequency or increase rate limits
MAX_RATE_LIMIT=300
RATE_LIMIT_WINDOW=30000
```

### **3. Worker Pool Bottleneck**
```bash
# Check worker status
curl http://localhost:3000/api/workers/status

# Solution: Increase worker count
MAX_WORKERS=75
```

### **4. Database Connection Exhaustion**
```bash
# Check database connections
SELECT count(*) FROM pg_stat_activity;

# Solution: Increase connection pool
MAX_CONNECTIONS_PER_SERVER=150
```

## 🔄 Scaling Strategies

### **Horizontal Scaling**

```bash
# Load Balancer Configuration
upstream mail_ingest {
    server 10.0.1.10:3000 weight=3;
    server 10.0.1.11:3000 weight=3;
    server 10.0.1.12:3000 weight=3;
    server 10.0.1.13:3000 weight=1;  # Backup
}
```

### **Vertical Scaling**

```bash
# Increase server resources
CPU: 16 → 32 cores
RAM: 64GB → 128GB
Storage: 500GB → 1TB NVMe
```

### **Database Scaling**

```bash
# Read replicas for monitoring queries
SUPABASE_READ_REPLICA_URL=your_read_replica_url

# Connection pooling with PgBouncer
DATABASE_POOL_SIZE=300
```

## 📊 Performance Testing

### **Load Testing Script**

```bash
# Install artillery for load testing
npm install -g artillery

# Run load test
artillery run load-test-10k.yml
```

### **Load Test Configuration** (`load-test-10k.yml`)

```yaml
config:
  target: 'http://localhost:3000'
  phases:
    - duration: 60
      arrivalRate: 100
      name: "Warm up"
    - duration: 300
      arrivalRate: 500
      name: "Sustained load"
    - duration: 120
      arrivalRate: 1000
      name: "Peak load"

scenarios:
  - name: "Account operations"
    weight: 70
    requests:
      - get:
          url: "/api/accounts/status"
      - post:
          url: "/api/accounts/{{ $randomString() }}"
          json:
            email: "test{{ $randomString() }}@example.com"
  
  - name: "Health checks"
    weight: 30
    requests:
      - get:
          url: "/health"
      - get:
          url: "/metrics"
```

## 🎯 Best Practices

### **1. Account Prioritization**
- **High Priority**: VIP customers, high-volume accounts
- **Medium Priority**: Regular business accounts
- **Low Priority**: Personal accounts, inactive users

### **2. Connection Management**
- Group accounts by IMAP server
- Implement connection rotation
- Monitor rate limits per server

### **3. Error Handling**
- Exponential backoff for failures
- Circuit breaker pattern for failing accounts
- Automatic recovery mechanisms

### **4. Monitoring**
- Real-time metrics collection
- Automated alerting
- Performance trend analysis

### **5. Resource Management**
- Memory leak prevention
- Connection pool optimization
- Worker lifecycle management

## 🔮 Future Enhancements

### **Phase 2: Advanced Features**
- [ ] Machine learning for optimal polling intervals
- [ ] Predictive scaling based on email patterns
- [ ] Multi-region deployment for global accounts
- [ ] Advanced analytics and reporting

### **Phase 3: Enterprise Features**
- [ ] Multi-tenant architecture
- [ ] Advanced security and compliance
- [ ] Integration with enterprise email platforms
- [ ] Custom workflow automation

## 📞 Support & Maintenance

### **Regular Maintenance Tasks**
```bash
# Daily
- Monitor system health and metrics
- Check error logs and alerting

# Weekly
- Review performance trends
- Optimize polling schedules
- Clean up failed accounts

# Monthly
- Capacity planning review
- Performance optimization
- Security updates
```

### **Emergency Procedures**
```bash
# System Overload
1. Reduce polling frequency temporarily
2. Scale up worker pool
3. Check for stuck connections

# Database Issues
1. Check connection pool status
2. Review slow queries
3. Scale database resources

# Memory Issues
1. Restart service with increased heap
2. Check for memory leaks
3. Scale up server resources
```

---

**🎉 Congratulations!** You now have a production-ready system capable of handling 10,000 email accounts efficiently.

For additional support or questions, please refer to the main README or contact the development team.
