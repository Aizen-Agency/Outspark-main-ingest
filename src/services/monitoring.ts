import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { logger, logMetric, logEvent } from '../utils/logger';
import { config } from '../config/index';
import { getAllAccounts, getCounter, getStats } from './memory-storage';
import { getQueueDepth, healthCheck as sqsHealthCheck } from './aws-sqs';
import { imapService } from './imap-service';
import { HealthStatus, Metrics } from '../types/index';
import os from 'os';

// Initialize Express app
const app = express();
const startTime = new Date();

// Setup middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true,
}));

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
const rateLimiter = new RateLimiterMemory({
  keyPrefix: 'monitoring',
  points: 100,
  duration: 60,
});

app.use(async (req, res, next) => {
  try {
    await rateLimiter.consume(req.ip || 'unknown');
    next();
  } catch (error: any) {
    res.status(429).json({
      error: 'Too many requests',
      retryAfter: Math.ceil(error.msBeforeNext / 1000),
    });
  }
});

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logMetric('http_request_duration', duration, {
      method: req.method,
      path: req.path,
      status: res.statusCode.toString(),
    });
  });
  next();
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const healthStatus = await getHealthStatus();
    const statusCode = healthStatus.status === 'healthy' ? 200 : 
                      healthStatus.status === 'degraded' ? 200 : 503;
    
    res.status(statusCode).json(healthStatus);
  } catch (error: any) {
    logger.error('Health check failed', error);
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Health check failed',
    });
  }
});

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    const metrics = await getMetrics();
    res.json(metrics);
  } catch (error: any) {
    logger.error('Metrics collection failed', error);
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
});

// Status endpoint
app.get('/status', async (req, res) => {
  try {
    const status = await getSystemStatus();
    res.json(status);
  } catch (error: any) {
    logger.error('Status collection failed', error);
    res.status(500).json({ error: 'Failed to collect status' });
  }
});

// System information endpoint
app.get('/system', (req, res) => {
  try {
    const systemInfo = {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      platform: process.platform,
      nodeVersion: process.version,
      pid: process.pid,
      startTime: startTime.toISOString(),
    };
    res.json(systemInfo);
  } catch (error: any) {
    logger.error('System info collection failed', error);
    res.status(500).json({ error: 'Failed to collect system info' });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'Outspark Mail Ingest Service',
    version: process.env.npm_package_version || 'unknown',
    status: 'running',
    uptime: process.uptime(),
    endpoints: {
      health: '/health',
      metrics: '/metrics',
      status: '/status',
      system: '/system',
    },
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.originalUrl,
    availableEndpoints: ['/health', '/metrics', '/status', '/system'],
  });
});

// Error handler
app.use((error: any, req: any, res: any, next: any) => {
  logger.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
  });
});

/**
 * Get comprehensive health status
 */
async function getHealthStatus(): Promise<HealthStatus> {
  try {
    const checks = await Promise.allSettled([
      sqsHealthCheck(),
      imapService.healthCheck(),
    ]);

    const [memoryHealthy, sqsHealthy, imapHealthy] = checks.map(check => 
      check.status === 'fulfilled' && check.value
    );

    // Determine overall health
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (!memoryHealthy || !sqsHealthy || !imapHealthy) {
      status = 'degraded';
    }
    if (!memoryHealthy && !sqsHealthy && !imapHealthy) {
      status = 'unhealthy';
    }

    const healthStatus: HealthStatus = {
      status,
      timestamp: new Date(),
      services: {
        memory: memoryHealthy,
        sqs: sqsHealthy,
        imap: imapHealthy,
        database: true, // Assuming database is always available
      },
      metrics: {
        activeConnections: imapService.getStats().activeConnections || 0,
        totalAccounts: getAllAccounts().length,
        messagesProcessed: getCounter('messages_processed') || 0,
        queueDepth: await getQueueDepth(),
        memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        cpuUsage: Math.round(process.cpuUsage().user / 1000000),
      },
    };

    return healthStatus;
  } catch (error: any) {
    logger.error('Failed to get health status:', error);
    throw error;
  }
}

/**
 * Get system metrics
 */
async function getMetrics(): Promise<Metrics> {
  try {
    const imapStatsData = imapService.getStats();
    const queueDepth = await getQueueDepth();
    const memoryStats = getStats();
    
    const metrics: Metrics = {
      accountsTotal: getAllAccounts().length,
      accountsActive: getAllAccounts().filter(acc => acc.isActive).length,
      connectionsActive: imapStatsData.activeConnections || 0,
      messagesProcessed: getCounter('messages_processed') || 0,
      messagesFailed: getCounter('messages_failed') || 0,
      queueDepth,
      memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      cpuUsage: Math.round(process.cpuUsage().user / 1000000),
      responseTime: 0, // Could be calculated from request logs
      errorRate: 0, // Could be calculated from error logs
    };

    return metrics;
  } catch (error: any) {
    logger.error('Failed to get metrics:', error);
    throw error;
  }
}

/**
 * Get comprehensive system status
 */
async function getSystemStatus(): Promise<any> {
  try {
    const healthStatus = await getHealthStatus();
    const metrics = await getMetrics();
    const systemInfo = {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      platform: process.platform,
      nodeVersion: process.version,
      pid: process.pid,
      startTime: startTime.toISOString(),
    };

    return {
      health: healthStatus,
      metrics,
      system: systemInfo,
      config: {
        maxConcurrentAccounts: config.maxConcurrentAccounts,
        maxConnectionsPerAccount: config.maxConnectionsPerAccount,
        batchSize: config.batchSize,
        pollInterval: config.pollInterval,
      },
    };
  } catch (error: any) {
    logger.error('Failed to get system status:', error);
    throw error;
  }
}

/**
 * Start the monitoring service
 */
export async function startMonitoring(port: number): Promise<void> {
  try {
    const server = app.listen(port, () => {
      logger.info(`Monitoring service started on port ${port}`);
      logEvent('monitoring_service_started', { port });
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
      server.close(() => {
        logger.info('Monitoring service stopped');
      });
    });

    process.on('SIGINT', () => {
      server.close(() => {
        logger.info('Monitoring service stopped');
      });
    });

  } catch (error) {
    logger.error('Failed to start monitoring service:', error as Error);
    throw error;
  }
}

/**
 * Stop the monitoring service
 */
export async function stopMonitoring(): Promise<void> {
  logger.info('Monitoring service stopping...');
  // The service will be stopped by the process signals
}

/**
 * Get Express app for testing
 */
export function getApp(): express.Application {
  return app;
}
