// File: lib/utils/shared-utils.ts
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import * as AWS from 'aws-sdk';
import {Logger, ValidationResult, ErrorResponse, RetryOptions,
    DLQHealthResult,
    ValidationRule
  } from '../dtos/lambda-utils'
import { AppContext } from '../../lib/utils/app-context';


/**
 * Shared utility class for all Lambda functions
 */
export class LambdaUtils {
  private logger: Logger;
  appContext: AppContext;

  constructor(logger: EventLogger, appContext: AppContext) {
    this.logger = logger;
    this.appContext = appContext;
  }
  /**
   * Validates event data against required fields and structure
   * @param data Event data to validate
   * @param rules Optional custom validation rules
   * @returns Validation result with valid flag and any errors
   */
  public validateEventData(data: any, rules?: ValidationRule[]): ValidationResult {
    const errors: string[] = [];

    if (!data || typeof data !== 'object') {
      return { valid: false, errors: ['Event data is required and must be an object'] };
    }

    // Default validation rules if none provided
    const validationRules = rules || [
      {
        field: 'match_id',
        validator: (value: any) => value !== undefined && value !== null && 
                  (typeof value === 'string' || typeof value === 'number') && 
                  (typeof value === 'string' ? value.length > 0 : true),
        message: 'match_id is required and must be a non-empty string or number'
      },
      {
        field: 'event_type',
        validator: (value: any) => typeof value === 'string' && value.length > 0,
        message: 'event_type is required and must be a non-empty string'
      },
      {
        field: 'timestamp',
        validator: (value: any) => {
          if (!value) return false;
          const date = new Date(value);
          return !isNaN(date.getTime());
        },
        message: 'timestamp is required and must be a valid date string'
      }
    ];

    // Run all validation rules
    validationRules.forEach(rule => {
      if (!rule.validator(data[rule.field])) {
        errors.push(rule.message);
      }
    });

    return { valid: errors.length === 0, errors };
  }

  /**
   * Generates a deterministic idempotency key from event data
   * @param event Event data
   * @returns SHA-256 hash as idempotency key
   */
  public generateEventIdempotencyKey(event: Record<string, any>): string {
    // Extract the fields that determine uniqueness
    const relevantFields = ['match_id', 'event_type', 'timestamp', 'player_id', 'team_id'];
    
    // Create a stable representation by filtering and sorting keys
    const stableObject = relevantFields.reduce<Record<string, any>>((obj, field) => {
      if (event[field] !== undefined) {
        obj[field] = event[field];
      }
      return obj;
    }, {});

    const stableString = JSON.stringify(stableObject);
    
    return crypto.createHash('sha256').update(stableString).digest('hex');
  }

  /**
   * Retries a function with exponential backoff
   * @param fn Function to retry
   * @param options Retry options
   * @returns Result of the function
   */
  public async retryWithBackoff<T>(
    fn: () => Promise<T>, 
    options: RetryOptions = {}
  ): Promise<T> {
    const {
      retries = 3,
      initialDelay = 500,
      maxDelay = 10000,
      factor = 2,
      retryableErrors = []
    } = options;

    let attempt = 0;
    let lastError: any;

    const shouldRetry = (error: any): boolean => {
      if (retryableErrors.length === 0) return true;
      
      return retryableErrors.some(errorType => 
        error.name === errorType || 
        error.code === errorType ||
        (error.message && typeof error.message === 'string' && error.message.includes(errorType))
      );
    };

    while (attempt < retries) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        
        if (this.logger) {
          this.logger.warn(`Attempt ${attempt + 1}/${retries} failed`, {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
        
        if (attempt === retries - 1 || !shouldRetry(error)) {
          if (this.logger) {
            this.logger.error(`All ${retries} retry attempts failed`, {
              error: lastError instanceof Error ? lastError.message : 'Unknown error'
            });
          }
          throw lastError;
        }
        
        const delay = Math.min(
          initialDelay * Math.pow(factor, attempt),
          maxDelay
        );
        
        if (this.logger) {
          this.logger.debug(`Waiting ${delay}ms before next attempt`);
        }
        
        await new Promise(resolve => setTimeout(resolve, delay));
        attempt++;
      }
    }

    throw lastError;
  }

  /**
   * Adds tracing information to an event
   * @param event Original event data
   * @returns Event with tracing info added
   */
  public addTracingInfo(event: Record<string, any>): Record<string, any> {
    const traceId = event.trace_id || uuidv4();
    const parentId = event.event_id || null;
    const eventId = event.event_id || `${Date.now()}-${event.event_type || 'event'}-${uuidv4()}`;
    
    return {
      ...event,
      event_id: eventId,
      trace_id: traceId,
      parent_id: parentId,
      processed_timestamp: new Date().toISOString()
    };
  }

  /**
   * Sends a message to a Dead Letter Queue
   * @param dlqUrl DLQ URL
   * @param message Message to send
   * @param region AWS region
   */
  public async sendToDLQ(
    dlqUrl: string, 
    message: Record<string, any>, 
    region: string = process.env.AWS_REGION || 'us-east-1'
  ): Promise<void> {
    if (!dlqUrl) {
      this.logger.warn('DLQ URL not provided. Failed event will not be retried.', {});
      return;
    }

    try {
      // Initialize SQS client
      const endpoint = process.env.AWS_ENDPOINT_URL; // For local development
      const sqsConfig: AWS.SQS.ClientConfiguration = {
        region,
        ...(endpoint ? { endpoint } : {})
      };
      
      const sqs = new AWS.SQS(sqsConfig);
      
      // Add metadata for DLQ message
      const enhancedMessage = {
        ...message,
        dlq_timestamp: new Date().toISOString(),
        retry_count: (message.retry_count || 0) + 1
      };
      
      // Send to DLQ
      await sqs.sendMessage({
        QueueUrl: dlqUrl,
        MessageBody: JSON.stringify(enhancedMessage)
      }).promise();
      
      this.logger.info('Event sent to DLQ for retry', {
        eventId: message.event_id || 'unknown'
      });
    } catch (error) {
      this.logger.error('Failed to send event to DLQ', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : 'No stack trace'
      });
    }
  }

  /**
   * Handles errors consistently
   * @param error The error that occurred
   * @param context Additional context information
   * @param dlqCallback Optional callback to send to DLQ
   * @returns Standardized error response
   */
  public async handleError(
    error: unknown, 
    context: Record<string, any> = {}, 
    dlqCallback?: () => Promise<void>
  ): Promise<ErrorResponse> {
    const err = error instanceof Error ? error : new Error(String(error));
    
    this.logger.error('Error occurred', {
      message: err.message,
      stack: err.stack,
      ...context
    });
    
    // Execute DLQ callback if provided
    if (dlqCallback) {
      await dlqCallback();
    }
    
    return {
      status: 'error',
      message: err.message,
      code: this.getErrorStatusCode(err),
      request_id: context.request_id || 'unknown'
    };
  }

  /**
   * Maps error types to appropriate status codes
   * @param error The error to analyze
   * @returns Appropriate status code
   */
  private getErrorStatusCode(error: Error): number {
    // Validation errors
    if (
      error.name === 'ValidationError' || 
      error.message.includes('validation') || 
      error.message.includes('invalid')
    ) {
      return 400;
    }
    
    // Not found errors
    if (
      error.name === 'NotFoundError' || 
      error.message.includes('not found') || 
      error.message.includes('does not exist')
    ) {
      return 404;
    }
    
    // Throttling/rate limiting
    if (
      error.name === 'ThrottlingException' || 
      error.message.includes('throttling') || 
      error.message.includes('rate exceeded')
    ) {
      return 429;
    }
    
    // Default to server error
    return 500;
  }
}

// Circuit breaker implementation for external service calls
export class CircuitBreaker {
  private failureCount: number = 0;
  private lastFailureTime?: Date;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  
  constructor(
    private logger: Logger,
    private maxFailures: number = 3,
    private resetTimeoutMs: number = 30000,
    private name: string = 'default'
  ) {}
  
  /**
   * Executes an operation with circuit breaker protection
   * @param operation Function to execute
   * @returns Result of the operation
   */
  public async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      // Check if timeout has elapsed to allow retry
      if (this.lastFailureTime && 
         (new Date().getTime() - this.lastFailureTime.getTime()) > this.resetTimeoutMs) {
        this.logger.info(`Circuit breaker ${this.name} entering half-open state`, {});
        this.state = 'HALF_OPEN';
      } else {
        this.logger.warn(`Circuit breaker ${this.name} is open, rejecting request`, {});
        throw new Error(`Circuit breaker ${this.name} is open`);
      }
    }
    
    try {
      const result = await operation();
      
      if (this.state === 'HALF_OPEN') {
        this.logger.info(`Circuit breaker ${this.name} reset to closed state`, {});
        this.reset();
      }
      
      return result;
    } catch (error) {
      this.lastFailureTime = new Date();
      this.failureCount++;
      
      if (this.state === 'HALF_OPEN' || this.failureCount >= this.maxFailures) {
        this.state = 'OPEN';
        this.logger.warn(`Circuit breaker ${this.name} opened`, { 
          failureCount: this.failureCount,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
      
      throw error;
    }
  }
  
  /**
   * Resets the circuit breaker to closed state
   */
  public reset(): void {
    this.failureCount = 0;
    this.state = 'CLOSED';
    this.lastFailureTime = undefined;
  }
  
  /**
   * Gets the current state of the circuit breaker
   */
  public getState(): string {
    return this.state;
  }
}

// Monitoring utilities
export class MonitoringUtils {
  constructor(private logger: Logger) {}
  
  /**
   * Checks the health of a Dead Letter Queue
   * @param dlqUrl DLQ URL
   * @param region AWS region
   * @returns Health check result
   */
  public async checkDLQHealth(
    dlqUrl: string,
    region: string = process.env.AWS_REGION || 'us-east-1'
  ): Promise<DLQHealthResult> {
    try {
      // Initialize SQS client
      const endpoint = process.env.AWS_ENDPOINT_URL;
      const sqsConfig: AWS.SQS.ClientConfiguration = {
        region,
        ...(endpoint ? { endpoint } : {})
      };
      
      const sqs = new AWS.SQS(sqsConfig);
      
      const response = await sqs.getQueueAttributes({
        QueueUrl: dlqUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible']
      }).promise();
      
      const messageCount = parseInt(
        response.Attributes?.ApproximateNumberOfMessages || '0',
        10
      );
      
      const messagesInFlight = parseInt(
        response.Attributes?.ApproximateNumberOfMessagesNotVisible || '0',
        10
      );
      
      const status = messageCount > 0 ? 'warning' : 'healthy';
      
      if (messageCount > 0) {
        this.logger.warn(`DLQ contains ${messageCount} messages that need attention`, {});
      }
      
      return { 
        status,
        isEmpty: messageCount === 0,
        messagesAvailable: messageCount,
        messagesInFlight,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      this.logger.error('Error checking DLQ status', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      
      return {
        status: 'error',
        isEmpty: false,
        messagesAvailable: -1,
        messagesInFlight: -1,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}

export function calculateSeason(timestamp: string | Date): string {
  // Convert to Date if it's a string
  const eventDate = typeof timestamp === 'string' 
    ? new Date(timestamp) 
    : timestamp;
  
  // Extract month and year
  const month = eventDate.getMonth(); // 0-based (0 = January, 11 = December)
  const year = eventDate.getFullYear();
  
  // Season calculation logic
  if (month < 4) { // January to April
    // If before May, use previous year as first part of season
    return `${year - 1}/${year}`;
  } else if (month >= 6) { // July onwards
    // If July or later, use current year as first part of season
    return `${year}/${year + 1}`;
  } else { // May and June
    // Transitional months, use current year
    return `${year - 1}/${year}`;
  }
}


// Enhanced Logging Utility
export class EventLogger implements Logger {
  private baseLogger: any;

  constructor(baseLogger: any) {
    this.baseLogger = baseLogger;
  }
  
  /**
   * Logs a debug message
   * @param message Message to log
   * @param context Additional context
   */
  public debug(message: string, context: Record<string, any> = {}): void {
    this.log('debug', message, context);
  }
  
  /**
   * Logs an info message
   * @param message Message to log
   * @param context Additional context
   */
  public info(message: string, context: Record<string, any> = {}): void {
    this.log('info', message, context);
  }
  
  /**
   * Logs a warning message
   * @param message Message to log
   * @param context Additional context
   */
  public warn(message: string, context: Record<string, any> = {}): void {
    this.log('warn', message, context);
  }
  
  /**
   * Logs an error message
   * @param message Message to log
   * @param context Additional context
   */
  public error(message: string, s3Error: unknown, context: Record<string, any> = {}): void {
    this.log('error', message, context);
  }
  
  /**
   * Internal log method
   * @param level Log level
   * @param message Message to log
   * @param context Additional context
   */
  private log(level: string, message: string, context: Record<string, any>): void {
    const timestamp = new Date().toISOString();
    const enrichedContext = {
      ...context,
      timestamp,
      service: process.env.SERVICE_NAME || 'football-event-service',
      region: process.env.AWS_REGION || 'us-east-1',
      environment: process.env.STAGE || 'dev'
    };
    
    if (this.baseLogger && typeof this.baseLogger[level] === 'function') {
      this.baseLogger[level](message, enrichedContext);
    } else {
      // Fallback if the expected logger method doesn't exist
      console.log(JSON.stringify({
        level,
        message,
        ...enrichedContext
      }));
    }
  }
}

export { ValidationRule };
