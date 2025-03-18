import { AppContext } from '../../lib/utils/app-context';

export interface RetryOptions {
  maxRetries: number;
  initialDelayMs: number;
  backoffFactor: number;
  maxDelayMs?: number;
  retryCondition?: (error: any) => boolean;
}

export abstract class BaseClient {
  protected readonly defaultRetryOptions: RetryOptions;
  endpoint: string | undefined;

  constructor(protected readonly context: AppContext) {
    if (context.environment === 'local') {
      // Use appropriate endpoints for local development
      // host.docker.internal works from Docker containers to access host machine
      this.endpoint = process.env.AWS_ENDPOINT || 'http://host.docker.internal:4566';
    } else {
      // For non-local environments, use the context endpoint or AWS_ENDPOINT
      this.endpoint = context.endpoint || process.env.AWS_ENDPOINT || undefined;
    }
        
    this.context.logging.logger.info(`BaseClient initialized with endpoint: ${this.endpoint}`);
     

    this.defaultRetryOptions = {
      maxRetries: this.context.isProd ? 5 : 3,
      initialDelayMs: 100,
      backoffFactor: 2,
      maxDelayMs: 10000,
      retryCondition: (error) => this.isRetryableError(error),
    };
  }

  // Logging methods directly using AppContext's structured logging
  protected logInfo(message: string, data?: Record<string, any>): void {
    this.context.logging.logger.info(message, data);
  }

  protected logError(message: string, error: any, data?: Record<string, any>): void {
    this.context.logging.logger.error(message, error, data);
  }

  protected logDebug(message: string, data?: Record<string, any>): void {
    this.context.logging.logger.debug(message, data);
  }

  protected logWarn(message: string, data?: Record<string, any>): void {
    this.context.logging.logger.warn(message, data);
  }

  /**
   * Retry wrapper for executing operations with exponential backoff
   */
  protected async withRetry<T>(
    operation: () => Promise<T>,
    operationName?: string,
    options?: Partial<RetryOptions>
  ): Promise<T> {
    const settings: RetryOptions = { ...this.defaultRetryOptions, ...options };
    let lastError: any;
    
    for (let attempt = 0; attempt <= settings.maxRetries; attempt++) {
      try {
        const result = await operation();
        if (attempt > 0) {
          this.logInfo(`Operation '${operationName}' succeeded after ${attempt} retries`);
        }
        return result;
      } catch (err: any) {
        lastError = err;

        if (attempt >= settings.maxRetries || (settings.retryCondition && !settings.retryCondition(err))) {
          this.logError(`Operation '${operationName}' failed after ${attempt + 1} attempts`, err);
          throw err;
        }

        const delay = this.calculateBackoff(attempt, settings);
        this.logWarn(`Retrying operation '${operationName}' (attempt ${attempt + 1}/${settings.maxRetries})`, {
          errorMessage: err.message,
          errorCode: err.code,
          waitTimeMs: delay,
        });

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  /**
   * Determines if an error is retryable based on AWS error codes and common network issues.
   */
  protected isRetryableError(error: any): boolean {
    const retryableCodes = [
      'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND',
      'ThrottlingException', 'ProvisionedThroughputExceededException',
      'ServiceUnavailable', 'InternalServerError', 'TooManyRequestsException',
      'RequestLimitExceeded'
    ];

    return Boolean(
      error.retryable === true ||
      (error.code && retryableCodes.includes(error.code)) ||
      (error.statusCode && error.statusCode >= 500)
    );
  }

  /**
   * Calculates exponential backoff delay with jitter.
   */
  private calculateBackoff(attempt: number, settings: RetryOptions): number {
    const baseDelay = settings.initialDelayMs * Math.pow(settings.backoffFactor, attempt);
    const jitteredDelay = baseDelay * (0.5 + Math.random());
    return settings.maxDelayMs ? Math.min(jitteredDelay, settings.maxDelayMs) : jitteredDelay;
  }
}
