import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { 
  LambdaUtils, 
  EventLogger, 
  CircuitBreaker 
} from '../../lambda/utils/lambda-utils';
import { createAppContext } from '../../lib/utils/app-context';
import { S3Client } from '../../lambda/clients/s3-client';
import { EventBridgeClient } from '../../lambda/clients/eventbridge-client';

// Configuration Constants
const EVENT_CONFIG = {
  VALID_EVENT_TYPES: ['goal', 'yellow_card', 'red_card', 'substitution', 'pass', 'kickoff', 'halftime', 'fulltime'],
  RETRY_STRATEGIES: {
    s3: {
      maxAttempts: 3,
      initialDelay: 500,
      maxDelay: 5000,
      retryableErrors: ['NoSuchBucket', 'ServiceUnavailable', 'NetworkError']
    },
    eventBridge: {
      maxAttempts: 3,
      initialDelay: 500,
      maxDelay: 5000,
      retryableErrors: ['ThrottlingException', 'ServiceUnavailable', 'InternalFailure']
    }
  }
};

const EVENT_VALIDATION_RULES = [
  {
    field: 'match_id',
    validator: (value: any) => value !== undefined && value !== null && 
              (typeof value === 'string' || typeof value === 'number') && 
              (typeof value === 'string' ? value.length > 0 : true),
    message: 'match_id is required and must be a non-empty string or number'
  },
  {
    field: 'event_type',
    validator: (value: any) => typeof value === 'string' && 
              EVENT_CONFIG.VALID_EVENT_TYPES.includes(value),
    message: `event_type is required and must be one of: ${EVENT_CONFIG.VALID_EVENT_TYPES.join(', ')}`
  },
  {
    field: 'timestamp',
    validator: (value: any) => {
      if (!value) return false;
      const date = new Date(value);
      const now = new Date();
      const maxFutureDate = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
      const minPastDate = new Date(now.getFullYear() - 10, now.getMonth(), now.getDate());

      return !isNaN(date.getTime()) && 
             date <= maxFutureDate && 
             date >= minPastDate;
    },
    message: 'timestamp is required and must be a valid date within the last 10 years and not more than 1 year in the future'
  },
  {
    field: 'team',
    validator: (value: any) => value && typeof value === 'string' && value.trim().length > 0,
    message: 'team is required and must be a non-empty string'
  }
];


export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // Initialize app context and utilities
  const appContext = createAppContext();
  const baseLogger = appContext.logging.logger;
  const logger = new EventLogger(baseLogger);
  const utils = new LambdaUtils(logger, appContext);
  let rawBody: any = {};

  // Circuit breakers for resilience
  const s3CircuitBreaker = new CircuitBreaker(
    logger, 
    3,  // max failures
    30000,  // reset timeout
    'S3'
  );

  const eventBridgeCircuitBreaker = new CircuitBreaker(
    logger, 
    3,  // max failures
    30000,  // reset timeout
    'EventBridge'
  );

  // Configuration
  const LOCALSTACK_HOST = process.env.LOCALSTACK_HOSTNAME || "localhost";
  const endpoint = `http://${LOCALSTACK_HOST}:4566`;
  const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME || 'football-serverless-dev-match-event-bus';
  const DLQ_URL = process.env.EVENT_DLQ_URL || 'http://localhost:4566/000000000000/football-serverless-dev-event-dlq';

  try {
    // Parse input
    const rawBody = event.body ? JSON.parse(event.body) : {};
    
    // Validate event using shared utility
    const validationResult = utils.validateEventData(rawBody, EVENT_VALIDATION_RULES);
    if (!validationResult.valid) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          status: 'validation_error',
          message: 'Invalid event data',
          errors: validationResult.errors
        })
      };
    }

    // Generate idempotency key
    const idempotencyKey = utils.generateEventIdempotencyKey(rawBody);
    
    // Add tracing information
    const processedEvent = utils.addTracingInfo(rawBody);

    // Initialize clients
    const s3Client = new S3Client({
      ...appContext,
      endpoint,
      s3ForcePathStyle: true
    });

    const eventBridgeClient = new EventBridgeClient(
      {...appContext, endpoint}, 
      {
        eventBusName: EVENT_BUS_NAME,
        eventSource: 'football.matches.live',
        deadLetterQueueUrl: DLQ_URL,
      }
    );

    // S3 Storage with circuit breaker and retry
    await s3CircuitBreaker.execute(async () => {
      await utils.retryWithBackoff(
        () => s3Client.uploadRawData(
          'rawData', 
          `matches/${processedEvent.match_id}/events/${processedEvent.event_id}.json`, 
          JSON.stringify(processedEvent),
          {
            match_id: String(processedEvent.match_id),
            event_type: String(processedEvent.event_type),
            idempotency_key: idempotencyKey,
            contentType: 'application/json',
          }
        ),
        EVENT_CONFIG.RETRY_STRATEGIES.s3
      );
    });

    // EventBridge Publishing with circuit breaker and retry
    const eventBridgeResponse = await eventBridgeCircuitBreaker.execute(async () => {
      return await utils.retryWithBackoff(
        () => eventBridgeClient.publishMatchEvent(
          processedEvent.match_id,
          processedEvent.event_type,
          processedEvent
        ),
        EVENT_CONFIG.RETRY_STRATEGIES.eventBridge
      );
    });

    // Log successful processing
    logger.info('Event successfully processed', {
      match_id: processedEvent.match_id,
      event_type: processedEvent.event_type,
      event_id: processedEvent.event_id
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: 'success',
        eventId: processedEvent.event_id,
        eventBridgeId: eventBridgeResponse.Entries?.[0]?.EventId,
        idempotencyKey
      })
    };
  } catch (error) {
    // Use shared error handling
    const errorResponse = await utils.handleError(
      error, 
      { 
        request_id: event.requestContext?.requestId,
        path: event.path,
        method: event.httpMethod 
      },
      // Optional DLQ callback
      () => utils.sendToDLQ(DLQ_URL, rawBody)
    );

    return {
      statusCode: errorResponse.code,
      body: JSON.stringify(errorResponse)
    };
  }
};