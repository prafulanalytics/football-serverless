import { EventBridgeEvent, SQSEvent, SQSRecord } from 'aws-lambda';
import * as AWS from 'aws-sdk';
import { createAppContext } from '../../lib/utils/app-context';
import { DynamoDBClient } from '../../lambda/clients/dynamo-client';
import { 
  LambdaUtils, 
  EventLogger, 
  CircuitBreaker, 
  ValidationRule,
  calculateSeason
} from '../../lambda/utils/lambda-utils';

// Validation rules for event
const eventValidationRules: ValidationRule[] = [
  { field: 'match_id', validator: (val) => val != null, message: 'match_id is required' },
  { field: 'event_type', validator: (val) => val != null, message: 'event_type is required' }
];

export const handler = async (event: EventBridgeEvent<'football.matches.live', any> | SQSEvent) => {
  // Debug logging to see the incoming event structure
  console.log("Event received:", JSON.stringify(event, null, 2));
  
  // 1. Initialize AppContext with endpoint awareness
  const appContext = createAppContext();
  const baseLogger = appContext.logging.logger;
  
  // Log endpoint info for debugging
  baseLogger.info(`Using AWS endpoint: ${appContext.endpoint || 'AWS default'}`);

  // 2. Create logger and utilities
  const logger = new EventLogger(baseLogger);
  const utils = new LambdaUtils(logger, appContext);

  // 3. Environment checks
  const isLocalEnv = process.env.ENVIRONMENT === 'local';
  
  // 4. Create your client using the AppContext (which will use the correct endpoint)
  const dynamoClient = new DynamoDBClient(appContext);

  // 5. Logging config
  logger.info('Lambda Configuration', {
    environment: process.env.ENVIRONMENT || 'unknown',
    // Instead of logging table names from env vars,
    // rely on your appContext.dynamoTables
    dynamoTables: appContext.dynamoTables,
    autoCreateTables: process.env.AUTO_CREATE_TABLES === 'true'
  });

  // 6. Table existence check (if needed)
  const ensureTablesExist = async () => {
    const { environment, region, endpoint, logging, dynamoTables } = appContext;
    const tablesToCheck = Object.values(appContext.dynamoTables);
    const isLocal = environment === 'local';
    const AUTO_CREATE_TABLES = process.env.AUTO_CREATE_TABLES === 'true';

    if (isLocal || !AUTO_CREATE_TABLES) return;

    const dynamoDB = new AWS.DynamoDB({ region, ...(endpoint ? { endpoint } : {}) });
    const logger = logging.logger;


    for (const tableName of tablesToCheck) {
      try {
        await dynamoDB.describeTable({ TableName: tableName }).promise();
        logger.info(`Table exists`, { tableName });
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        if ((error as AWS.AWSError).code === 'ResourceNotFoundException') {
          logger.info(`Creating table`, { tableName });
          await dynamoDB.createTable({
            TableName: tableName,
            KeySchema: [
              { AttributeName: 'pk', KeyType: 'HASH' },
              { AttributeName: 'sk', KeyType: 'RANGE' },
            ],
            AttributeDefinitions: [
              { AttributeName: 'pk', AttributeType: 'S' },
              { AttributeName: 'sk', AttributeType: 'S' },
            ],
            BillingMode: 'PAY_PER_REQUEST',
          }).promise();
          logger.info(`Table created successfully`, { tableName });
        }
      }
    }
  };

  await ensureTablesExist();
  
  // 7. SQS Record Processor
  const processSQSRecord = async (record: SQSRecord) => {
    try {
      const messageBody = JSON.parse(record.body);
      if (messageBody.source && messageBody.detail) {
        return await processEventBridgeEvent(messageBody);
      } else {
        return await processEventData(messageBody);
      }
    } catch (error) {
      logger.error('Failed to process SQS record', { 
        messageId: record.messageId, 
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  };

  // 8. EventBridge Event Processor
  const processEventBridgeEvent = async (event: EventBridgeEvent<'football.matches.live', any>) => {
    try {
      const eventDetail = event.detail;
      // Simplified validation in local env
      if (isLocalEnv) {
        return await processEventData(eventDetail || {});
      }
      // Standard validation
      if (!eventDetail || !eventDetail.match_id || !eventDetail.event_type) {
        logger.warn('Event validation failed', {
          detail: JSON.stringify(eventDetail).substring(0, 200),
        });
        const dlqUrl = process.env.EVENT_DLQ_URL || `${appContext.endpoint}/000000000000/football-serverless-dev-event-dlq`; // ✅ Fetch DLQ URL dynamically
        await utils.sendToDLQ(dlqUrl, {
          ...event,
          validation_errors: ['Missing required fields'],
        });
        return {
          status: 'validation_error',
          message: 'Validation failed: Missing required fields',
        };
      }
      return await processEventData(eventDetail);
    } catch (error) {
      logger.error('Error processing EventBridge event', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return {
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  };

  const processEventData = async (eventData: Record<string, any>) => {
    // Enhanced validation with detailed logging
    if (!eventData.match_id) {
      logger.warn('Missing required field: match_id', { eventData });
      throw new Error('Missing required field: match_id');
    }
    
    if (!eventData.event_type) {
      logger.warn('Missing required field: event_type', { eventData });
      throw new Error('Missing required field: event_type');
    }
  
    const { match_id, event_type, timestamp } = eventData;
    const season = calculateSeason(timestamp || new Date().toISOString());
  
    try {
      // Log the event data we're about to process
      logger.info('Processing event data', { 
        match_id, 
        event_type, 
        timestamp,
        season 
      });
  
      const idempotencyKey = isLocalEnv
        ? `${match_id}-${event_type}-${Date.now()}`
        : eventData.idempotencyKey || utils.generateEventIdempotencyKey(eventData);
  
      const eventItem = {
        pk: appContext.eventnameGenerator.generatePartitionKey(season, match_id),
        sk: appContext.eventnameGenerator.generateSortKey('EVENT', idempotencyKey),
        gsi1pk: `EVENT_TYPE#${event_type}`,
        gsi1sk: timestamp || new Date().toISOString(),
        season,
        ...eventData,
        processed_at: new Date().toISOString(),
      };
  
      // Log the keys we're using
      logger.debug('Generated DynamoDB keys', {
        pk: eventItem.pk,
        sk: eventItem.sk,
        gsi1pk: eventItem.gsi1pk,
        gsi1sk: eventItem.gsi1sk
      });
  
      await dynamoClient.putItem('events', eventItem);
  
      return {
        status: 'success',
        matchId: match_id,
        eventId: idempotencyKey,
        message: 'Event processed successfully',
      };
    } catch (error) {
      logger.error('Error processing event', { 
        match_id, 
        event_type, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
  
      const dlqUrl = process.env.EVENT_DLQ_URL 
        ? process.env.EVENT_DLQ_URL 
        : isLocalEnv 
          ? `${appContext.endpoint}/000000000000/football-serverless-dev-event-dlq`
          : undefined;
  
      if (dlqUrl) {
        await utils.sendToDLQ(dlqUrl, eventData);
      }
  
      throw error;
    }
  };
  
  // Determine event type and process accordingly
  if ('Records' in event && Array.isArray(event.Records)) {
    logger.info(`Processing SQS batch`, { recordCount: event.Records.length });
    const results = await Promise.allSettled(event.Records.map(processSQSRecord));
    return {
      batchItemFailures: results
        .map((res, i) => (res.status === 'rejected' ? { itemIdentifier: event.Records[i].messageId } : null))
        .filter(Boolean),
    };
  } else {
    return await processEventBridgeEvent(event as EventBridgeEvent<'football.matches.live', any>);
  }
};