import pino from 'pino';
import pinoPretty from 'pino-pretty';
import { LoggerConfig } from '../types/index';
import { environment } from '../config/index';

class Logger {
  private logger: pino.Logger;
  private config: LoggerConfig;

  constructor(config: LoggerConfig) {
    this.config = config;
    
    this.logger = pino({
      level: config.level,
      base: {
        pid: process.pid,
        hostname: process.env.HOSTNAME || 'unknown',
        version: process.env.npm_package_version || 'unknown',
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
        log: (object) => {
          return object;
        },
      },
      serializers: {
        err: pino.stdSerializers.err,
        req: pino.stdSerializers.req,
        res: pino.stdSerializers.res,
      },
    }, environment.isDevelopment ? pinoPretty({
      colorize: true,
      levelFirst: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    }) : undefined);
  }

  info(message: string, data?: Record<string, any>): void {
    this.logger.info(data || {}, message);
  }

  error(message: string, error?: Error | Record<string, any>): void {
    if (error instanceof Error) {
      this.logger.error({ err: error }, message);
    } else {
      this.logger.error(error || {}, message);
    }
  }

  warn(message: string, data?: Record<string, any>): void {
    this.logger.warn(data || {}, message);
  }

  debug(message: string, data?: Record<string, any>): void {
    this.logger.debug(data || {}, message);
  }

  trace(message: string, data?: Record<string, any>): void {
    this.logger.trace(data || {}, message);
  }

  // Structured logging for performance metrics
  metric(name: string, value: number, tags?: Record<string, string>): void {
    this.logger.info({
      type: 'metric',
      metric: name,
      value,
      tags: tags || {},
      timestamp: new Date().toISOString(),
    });
  }

  // Structured logging for business events
  event(eventName: string, data?: Record<string, any>): void {
    this.logger.info({
      type: 'event',
      event: eventName,
      data: data || {},
      timestamp: new Date().toISOString(),
    });
  }

  // Structured logging for audit trails
  audit(action: string, userId?: string, details?: Record<string, any>): void {
    this.logger.info({
      type: 'audit',
      action,
      userId: userId || 'system',
      details: details || {},
      timestamp: new Date().toISOString(),
    });
  }

  // Performance logging with timing
  time(label: string): () => void {
    const start = Date.now();
    return () => {
      const duration = Date.now() - start;
      this.metric(`${label}_duration`, duration);
      this.debug(`${label} completed in ${duration}ms`);
    };
  }

  // Child logger for specific contexts
  child(context: Record<string, any>): Logger {
    const childLogger = new Logger(this.config);
    childLogger.logger = this.logger.child(context);
    return childLogger;
  }

  // Get the underlying pino logger for advanced usage
  getPinoLogger(): pino.Logger {
    return this.logger;
  }
}

// Create default logger instance
export const logger = new Logger({
  level: environment.isDevelopment ? 'debug' : 'info',
  format: environment.isDevelopment ? 'pretty' : 'json',
  destination: 'console',
});

// Export the Logger class for creating custom loggers
export { Logger };

// Convenience functions for common logging patterns
export const logError = (message: string, error?: Error | Record<string, any>) => {
  logger.error(message, error);
};

export const logInfo = (message: string, data?: Record<string, any>) => {
  logger.info(message, data);
};

export const logMetric = (name: string, value: number, tags?: Record<string, string>) => {
  logger.metric(name, value, tags);
};

export const logEvent = (eventName: string, data?: Record<string, any>) => {
  logger.event(eventName, data);
};

export const logAudit = (action: string, userId?: string, details?: Record<string, any>) => {
  logger.audit(action, userId, details);
};
