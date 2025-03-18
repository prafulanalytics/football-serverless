import * as AWS from 'aws-sdk';
import { BaseClient } from './base-client';
import { AppContext } from '../../lib/utils/app-context';

export class DynamoDBClient extends BaseClient {
  checkTableExists(arg0: string) {
    throw new Error('Method not implemented.');
  }
  private readonly docClient: AWS.DynamoDB.DocumentClient;
  private readonly dynamoDB: AWS.DynamoDB;
  private readonly sqs: AWS.SQS;
  private readonly logger;
  private readonly dlqUrl: string;

  constructor(context: AppContext) {
    super(context);
    this.docClient = new AWS.DynamoDB.DocumentClient({ region: context.region, endpoint: this.endpoint });
    this.dynamoDB = new AWS.DynamoDB({ region: context.region, endpoint: this.endpoint });
    this.sqs = new AWS.SQS({ region: context.region, endpoint: this.endpoint });
    this.logger = context.logging.logger;
    this.dlqUrl = process.env.EVENT_DLQ_URL || '';
  }

  private getTableName(tableKey: keyof AppContext['dynamoTables']): string {
    const tableName = this.context.dynamoTables[tableKey];
    if (!tableName) {
      throw new Error(`Invalid DynamoDB table key: '${tableKey}'. Available tables: ${Object.keys(this.context.dynamoTables).join(', ')}`);
    }
    return tableName;
  }

  /**
   * Get a single item by key (Used for Idempotency Check)
   */
  public async getItem<T = Record<string, any>>(
    tableKey: keyof AppContext['dynamoTables'],
    key: Record<string, any>,
    options: { consistentRead?: boolean } = {}
  ): Promise<T | null> {
    const tableName = this.getTableName(tableKey); // ✅ Ensure valid tableName
  
    try {
      this.logger.debug('Fetching item from DynamoDB', { tableName, key });
  
      const result = await this.docClient
        .get({ TableName: tableName, Key: key, ConsistentRead: options.consistentRead })
        .promise();
  
      if (!result.Item) {
        this.logger.debug('Item not found in DynamoDB', { tableName, key });
        return null;
      }
  
      this.logger.info('Item retrieved successfully from DynamoDB', { tableName, key });
      return result.Item as T;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error('Error fetching item from DynamoDB', error, { tableName, key });
      throw error;
    }
  }
  

  public async query<T = Record<string, any>>(
    tableKey: keyof AppContext['dynamoTables'], // Table reference
    keyConditionExpression: string, // Query condition
    expressionAttributeValues: Record<string, any>, // Attribute values
    options: {
      filterExpression?: string;
      expressionAttributeNames?: Record<string, string>;
      indexName?: string;
      scanIndexForward?: boolean;
      limit?: number;
      consistentRead?: boolean;
      exclusiveStartKey?: Record<string, any>; // For pagination
    } = {}
  ): Promise<{ items: T[]; lastEvaluatedKey?: Record<string, any> }> {
    const tableName = this.context.dynamoTables[tableKey];

    try {
      this.logger.debug('Querying DynamoDB', { tableName, keyConditionExpression });

      const params: AWS.DynamoDB.DocumentClient.QueryInput = {
        TableName: tableName,
        KeyConditionExpression: keyConditionExpression,
        ExpressionAttributeValues: expressionAttributeValues,
        ScanIndexForward: options.scanIndexForward ?? true, // Default: ascending order
        Limit: options.limit,
        ConsistentRead: options.consistentRead,
        ExclusiveStartKey: options.exclusiveStartKey, // Handle pagination
        FilterExpression: options.filterExpression,
        ExpressionAttributeNames: options.expressionAttributeNames,
        IndexName: options.indexName,
      };

      const result = await this.withRetry(() => this.docClient.query(params).promise());

      this.logger.info('Successfully queried items', {
        tableName,
        count: result.Count,
        lastEvaluatedKey: result.LastEvaluatedKey,
      });

      return {
        items: (result.Items || []) as T[],
        lastEvaluatedKey: result.LastEvaluatedKey,
      };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error('Failed to query items', error, { tableName, keyConditionExpression });
      throw error;
    }
  }

  /**
   * Put a single item into DynamoDB
   */
  public async putItem<T extends AWS.DynamoDB.DocumentClient.PutItemInputAttributeMap>(
    tableKey: keyof AppContext['dynamoTables'],
    item: T
  ): Promise<T> {
    const tableName = this.getTableName(tableKey); // ✅ Ensure table exists
  
    try {
      this.logger.debug('Putting item into DynamoDB', { tableName, item });
  
      await this.withRetry(() =>
        this.docClient.put({ TableName: tableName, Item: item }).promise()
      );
  
      this.logger.info('Successfully put item into DynamoDB', { tableName, item });
  
      return item;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error('Failed to put item into DynamoDB', error, { tableName });
  
      // **Fallback: Send to SQS DLQ for later retry**
      if (this.dlqUrl) {
        await this.sendToDLQ(item, tableName);
      }
  
      throw error;
    }
  }

  /**
   * **Update an item in DynamoDB**
   */
  public async updateItem(
    tableKey: keyof AppContext['dynamoTables'],
    key: Record<string, any>,
    updateExpression: string,
    expressionAttributeValues?: Record<string, any>,
    expressionAttributeNames?: Record<string, string>
  ): Promise<AWS.DynamoDB.DocumentClient.UpdateItemOutput> {
    const tableName = this.context.dynamoTables[tableKey];

    try {
      this.logger.debug('Updating item in DynamoDB', { tableName, key, updateExpression });

      const params: AWS.DynamoDB.DocumentClient.UpdateItemInput = {
        TableName: tableName,
        Key: key,
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: expressionAttributeValues,
        ExpressionAttributeNames: expressionAttributeNames,
        ReturnValues: 'ALL_NEW',
      };

      const result = await this.withRetry(() => this.docClient.update(params).promise());

      this.logger.info('Successfully updated item in DynamoDB', { tableName, key, result });

      return result;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error('Failed to update item in DynamoDB', error, { tableName, key, updateExpression });

      // **Fallback: Send to SQS DLQ for later retry**
      if (this.dlqUrl) {
        await this.sendToDLQ({ key, updateExpression, expressionAttributeValues }, tableName);
      }

      throw error;
    }
  }

  /**
   * Send failed operations to SQS DLQ
   */
  private async sendToDLQ<T>(item: T, tableName: string): Promise<void> {
    try {
      const messageBody = JSON.stringify({
        tableName,
        item,
        failedAt: new Date().toISOString(),
      });

      await this.sqs
        .sendMessage({
          QueueUrl: this.dlqUrl,
          MessageBody: messageBody,
        })
        .promise();

      this.logger.warn('Item sent to SQS DLQ', { tableName, item });
    } catch (dlqError: unknown) {
      const error = dlqError instanceof Error ? dlqError : new Error(String(dlqError));
      this.logger.error('Failed to send item to SQS DLQ', error, { tableName });
    }
  }
}
