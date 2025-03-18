import { EventBridgeEvent } from 'aws-lambda';
import { createAppContext } from '../../lib/utils/app-context';
import { DynamoDBClient } from '../clients/dynamo-client';
import * as AWS from 'aws-sdk';

const endpoint = process.env.AWS_ENDPOINT_URL || 'http://localhost:4566';

// Initialize SQS for DLQ Handling
const sqs = new AWS.SQS({
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint,
});

const DLQ_URL = process.env.EVENT_DLQ_URL || `${endpoint}/000000000000/football-serverless-dev-event-dlq`;

// Validation Rules for events
const eventValidationRules = [
  {
    field: 'match_id',
    validator: (value: any) => typeof value === 'string' && value.length > 0,
    message: 'Match ID is required and must be a non-empty string',
  },
  {
    field: 'event_type',
    validator: (value: any) => ['goal', 'card', 'substitution','pass'].includes(value),
    message: 'Invalid event type',
  },
  {
    field: 'timestamp',
    validator: (value: any) => !isNaN(new Date(value).getTime()),
    message: 'Timestamp must be a valid date',
  },
];

export const handler = async (event: EventBridgeEvent<'football.matches.live', any>) => {
  // Initialize the application context (includes configuration and table names)
  const appContext = createAppContext();
  const { logger } = appContext.logging;
  const dynamoClient = new DynamoDBClient(appContext);

  try {
    logger.debug('Received event', { event });

    // Validate event payload against our rules
    const validationResult = validateEventPayload(event.detail);
    if (!validationResult.valid) {
      logger.warn('Validation failed', { errors: validationResult.errors });
      return {
        status: 'validation_error',
        message: `Validation failed: ${validationResult.errors.join(', ')}`,
      };
    }

    // Destructure the event details
    const { match_id, event_type, timestamp, idempotency_key } = event.detail;

    // Ensure the events table exists
    try {
      const tableExists = await dynamoClient.checkTableExists('events');
      if (typeof tableExists !== 'boolean' || !tableExists) {
        throw new Error('DynamoDB table does not exist: events');
      }
    } catch (error) {
      logger.error('Error checking DynamoDB table existence', {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : 'No stack trace',
        name: ''
      });
      throw new Error('Failed to verify DynamoDB table existence');
    }

    // Check if this event has already been processed (duplicate detection)
    const existingEvent = await dynamoClient.getItem('events', {
      pk: `MATCH#${match_id}`,
      sk: `EVENT#${idempotency_key}`,
    });
    if (existingEvent) {
      logger.warn('Duplicate event detected, skipping processing', { match_id, idempotency_key });
      return {
        status: 'skipped',
        message: 'Duplicate event, already processed',
      };
    }

    // Build the event item to be stored
    const eventItem = {
      pk: `MATCH#${match_id}`,
      sk: `EVENT#${idempotency_key}`,
      ...event.detail,
      processed_at: new Date().toISOString(),
    };

    // Try to write the event and update the match record
    try {
      await dynamoClient.putItem('events', eventItem);
      await updateMatchRecord(dynamoClient, match_id, event.detail);
    } catch (error) {
      logger.error('Error storing event in DynamoDB', {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : 'No stack trace',
        name: ''
      });
      throw new Error('Failed to store event in DynamoDB');
    }

    logger.info('Successfully processed match event', { match_id, event_type });
    return {
      status: 'success',
      matchId: match_id,
      message: 'Event processed successfully',
    };
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Error processing event', {
      message: err.message,
      stack: err.stack,
      name: ''
    });
    await sendToDLQ(event);
    return {
      status: 'error',
      message: err.message || 'Unexpected error occurred',
    };
  }
};

function validateEventPayload(payload: any) {
  const errors: string[] = [];
  eventValidationRules.forEach((rule) => {
    if (!rule.validator(payload[rule.field])) {
      errors.push(rule.message);
    }
  });
  return { valid: errors.length === 0, errors };
}

async function updateMatchRecord(dynamoClient: DynamoDBClient, matchId: string, eventDetails: any) {
  const matchKey = { pk: `MATCH#${matchId}`, sk: 'METADATA' };
  const updateExpression = 'SET last_event_type = :event_type, last_event_timestamp = :timestamp';
  const expressionAttributeValues = {
    ':event_type': eventDetails.event_type,
    ':timestamp': eventDetails.timestamp,
  };
  await dynamoClient.updateItem('matches', matchKey, updateExpression, expressionAttributeValues);
}

async function sendToDLQ(event: EventBridgeEvent<'football.matches.live', any>) {
  if (!DLQ_URL) {
    console.warn('DLQ URL not configured. Failed event will not be retried.');
    return;
  }
  try {
    await sqs.sendMessage({ QueueUrl: DLQ_URL, MessageBody: JSON.stringify(event) }).promise();
    console.warn('Event sent to DLQ for retry', { eventId: event.id });
  } catch (error) {
    console.error('Failed to send event to DLQ', { 
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : 'No stack trace'
    });
  }
}