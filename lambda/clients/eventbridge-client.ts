import { 
  EventBridgeClient as AwsEventBridgeClient, 
  ListEventBusesCommand, 
  PutEventsCommand, 
  PutEventsCommandOutput 
} from '@aws-sdk/client-eventbridge';
import { BaseClient } from './base-client';
import { AppContext } from '../../lib/utils/app-context';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { S3Client } from './s3-client';

interface EventBridgeClientConfig {
  eventBusName: string;
  eventSource: string;
  region?: string;
  deadLetterQueueUrl: string;
}

interface PublishOptions {
  idempotencyKey?: string;
  timeToLive?: number; // TTL in seconds
}

export class EventBridgeClient extends BaseClient {
  private readonly client: AwsEventBridgeClient;
  private readonly sqsClient: SQSClient;
  private readonly config: EventBridgeClientConfig;
  private readonly eventCache: Map<string, { timestamp: number; retryCount: number }> = new Map();
  private readonly DEFAULT_TTL = 60 * 5; // 5 minutes
  private readonly logger;
  private readonly s3Client: S3Client;
  constructor(context: AppContext, config: EventBridgeClientConfig) {
    super(context);

    
    this.config = config;
    this.logger = context.logging.logger;
  
    // Apply the endpoint to AWS clients
    this.sqsClient = new SQSClient({ 
      region: config.region || context.region, 
      endpoint: this.endpoint 
    });
  
    this.s3Client = new S3Client(context);
  
    this.client = new AwsEventBridgeClient({
      region: config.region || context.region,
      maxAttempts: context.isProd ? 3 : 2,
      endpoint: context.endpoint || process.env.AWS_ENDPOINT, // ✅ Ensure correct endpoint usage
    });
  
    // Periodically clean the cache
    setInterval(() => this.cleanEventCache(), 60000);
  }
  /**
   * Publishes an event to EventBridge
   */
  public async publishMatchEvent(
    matchId: string | number,
    eventType: string,
    detail: Record<string, any> = {},
    options: PublishOptions = {}
  ): Promise<PutEventsCommandOutput> {
    const idempotencyKey = options.idempotencyKey || `${matchId}-${eventType}-${Date.now()}`;
    const ttl = options.timeToLive || this.DEFAULT_TTL;
  
    // Enhanced logging with more context
    this.logger.info('Publishing event to EventBridge', {
      matchId,
      eventType,
      idempotencyKey,
      eventBus: this.config.eventBusName,
      source: this.config.eventSource
    });
  
    // Check if event exists in cache (avoid duplicate processing)
    const cachedEvent = this.eventCache.get(idempotencyKey);
    if (cachedEvent) {
      const now = Date.now();
      const ageInSeconds = (now - cachedEvent.timestamp) / 1000;
  
      if (ageInSeconds < ttl) {
        this.logger.warn('Duplicate event detected within TTL window', {
          ageInSeconds,
          ttl,
        });
  
        return {
          FailedEntryCount: 0,
          Entries: [{ EventId: `cached-${idempotencyKey}` }],
        } as PutEventsCommandOutput;
      }
    }
  
    try {
      // Construct the event with proper structure
      const event = {
        EventBusName: this.config.eventBusName,
        Source: this.config.eventSource,
        DetailType: eventType,
        Detail: JSON.stringify({
          match_id: matchId,
          ...detail,
        }),
        Time: new Date(),
      };
  
      // Debug log the exact event structure being sent
      this.logger.debug('EventBridge event structure', {
        endpoint: this.endpoint || 'Default AWS Endpoint',
        eventStructure: JSON.stringify(event),
        clientConfig: {
          region: this.client.config.region,
          endpoint: this.client.config.endpoint
        }
      });
  
      // For LocalStack compatibility - verify bus exists
      if (this.endpoint) {
        try {
          const listBusesCommand = new ListEventBusesCommand({});
          const buses = await this.client.send(listBusesCommand);
          this.logger.debug('Available EventBuses', {
            buses: buses.EventBuses?.map(b => b.Name) || []
          });
        } catch (error) {
          this.logger.warn('Failed to list EventBuses, continuing anyway', {
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined
          });
        }
      }
  
      // Publish to EventBridge with retry logic
      const result: PutEventsCommandOutput = await this.retryWithBackoff(
        () => this.client.send(new PutEventsCommand({ Entries: [event] })),
        3, // Max retries
        500 // Initial delay (ms)
      );
  
      // Enhanced result logging
      this.logger.debug('EventBridge publish result', {
        result: JSON.stringify(result),
        failedEntryCount: result.FailedEntryCount || 0
      });
  
      // Check for failed entries
      if (result.FailedEntryCount && result.FailedEntryCount > 0) {
        const failedEntry = result.Entries?.find(entry => entry.ErrorCode);
        if (failedEntry) {
          throw new Error(`Failed to publish event: ${failedEntry.ErrorCode} - ${failedEntry.ErrorMessage}`);
        }
      }
  
      // Cache successful events
      this.cacheEvent(idempotencyKey);
  
      this.logger.info('Successfully published event to EventBridge', {
        eventId: result.Entries?.[0]?.EventId,
        eventBus: this.config.eventBusName
      });
  
      return result;
    } catch (err: any) {
      this.logger.error(
        'Failed to publish event to EventBridge', 
        err, // Pass the full error object as the second parameter
        {   // Pass the context as the third parameter
          matchId, 
          eventType, 
          idempotencyKey,
          eventBus: this.config.eventBusName
        }
      );
      // Send to DLQ if EventBridge fails
      await this.sendToDLQ(matchId, eventType, detail, idempotencyKey);
      throw err;
    }
  }
  /**
   * Sends failed events to Dead-Letter Queue (DLQ)
   */
  public async sendToDLQ(
    matchId: string | number,
    eventType: string,
    detail: Record<string, any>,
    idempotencyKey: string
  ) {
    try {
      await this.sqsClient.send(
        new SendMessageCommand({
          QueueUrl: this.config.deadLetterQueueUrl,
          MessageBody: JSON.stringify({
            match_id: matchId,
            event_type: eventType,
            idempotency_key: idempotencyKey,
            payload: detail,
            failed_at: new Date().toISOString(),
          }),
        })
      );

      this.logger.warn('Event sent to SQS DLQ', { idempotencyKey, dlqUrl: this.config.deadLetterQueueUrl });
    } catch (dlqError: any) {
      this.logger.error('Failed to send event to SQS DLQ', dlqError);

      // Fallback: Store in S3 if DLQ fails
      const s3Key = `failed-events/${idempotencyKey}.json`;
      await this.s3Client.uploadRawData(
        'errors',
        s3Key,
        JSON.stringify({
          match_id: matchId,
          event_type: eventType,
          idempotency_key: idempotencyKey,
          payload: detail,
          failed_at: new Date().toISOString(),
        }),
        { contentType: 'application/json' }
      );

      this.logger.warn('Stored failed event in S3 DLQ as fallback', { idempotencyKey, s3Key });
    }
  }

  /**
   * Caches events to prevent duplicate processing
   */
  public cacheEvent(idempotencyKey: string): void {
    this.eventCache.set(idempotencyKey, {
      timestamp: Date.now(),
      retryCount: 0,
    });
  }

  public async retryWithBackoff(
    fn: () => Promise<PutEventsCommandOutput>,
    maxRetries = 3,
    delay = 500
  ): Promise<PutEventsCommandOutput> {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        return await fn(); // ✅ Returns successfully if the function succeeds
      } catch (error: unknown) { // ✅ Explicitly use `unknown` for error handling
        const err = error instanceof Error ? error : new Error(String(error)); // ✅ Ensure error is an `Error` object

        if (attempt === maxRetries - 1) {
          this.logger.error('Max retries reached. EventBridge publish failed.', {
            message: err.message, // ✅ Correct logging
            stack: err.stack || 'No stack trace available',
            name: ''
          });
          throw new Error(`EventBridge publish failed after ${maxRetries} retries: ${err.message}`);
        }

        const waitTime = delay * Math.pow(2, attempt);
        this.logger.warn(`Retrying EventBridge publish after ${waitTime}ms`, { 
          attempt, 
          message: err.message 
        });

        await new Promise((resolve) => setTimeout(resolve, waitTime));
        attempt++;
      }
    }

    throw new Error('Unexpected state in retryWithBackoff()'); 
  }
  /**
   * Cleans expired events from cache
   */
  public cleanEventCache(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];

    this.eventCache.forEach((entry, key) => {
      const ageInSeconds = (now - entry.timestamp) / 1000;
      if (ageInSeconds > this.DEFAULT_TTL) {
        expiredKeys.push(key);
      }
    });

    expiredKeys.forEach((key) => this.eventCache.delete(key));

    if (expiredKeys.length > 0) {
      this.logger.debug('Cleaned expired events from cache', {
        cleanedCount: expiredKeys.length,
        remainingCount: this.eventCache.size,
      });
    }
  }
}
