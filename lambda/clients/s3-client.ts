import * as AWS from 'aws-sdk';
import { BaseClient } from './base-client';
import { AppContext } from '../../lib/utils/app-context';

export class S3Client extends BaseClient {
  private readonly s3: AWS.S3;
  private readonly sqs: AWS.SQS;
  private readonly sns: AWS.SNS;
  formatError: any;

  constructor(context: AppContext) {
    super(context);
    this.endpoint = context.endpoint; // Ensure the endpoint is set
  
    this.s3 = new AWS.S3({
      region: context.region,
      endpoint: this.endpoint, // Apply endpoint
      maxRetries: context.isProd ? 5 : 3,
      s3ForcePathStyle: true, 
    });
  
    this.sqs = new AWS.SQS({
      region: context.region,
      endpoint: this.endpoint, // Apply endpoint
    });
  
    this.sns = new AWS.SNS({
      region: context.region,
      endpoint: this.endpoint, // Apply endpoint
    });
  }

  /**
   * Checks if a bucket exists
   */
  public async getBucket(bucketName: string): Promise<AWS.S3.HeadBucketOutput> {
    try {
      this.logDebug('Checking if bucket exists', { bucketName });
      const result = await this.s3.headBucket({ Bucket: bucketName }).promise();
      this.logDebug('Bucket exists', { bucketName });
      return result;
    } catch (error: any) {
      this.logError('Error checking bucket', error, { bucketName });
      throw error;
    }
  }

  /**
   * Creates an S3 bucket
   */
  public async createBucket(bucketName: string): Promise<AWS.S3.CreateBucketOutput> {
    try {
      this.logInfo('Creating bucket', { bucketName });
      const result = await this.s3.createBucket({
        Bucket: bucketName,
        CreateBucketConfiguration: { LocationConstraint: this.context.region },
      }).promise();
      
      this.logInfo('Successfully created bucket', { bucketName });
      return result;
    } catch (error: any) {
      this.logError('Failed to create bucket', error, { bucketName });
      throw error;
    }
  }

  /**
   * Creates an S3 bucket if it doesn't exist.
   */
  public async createBucketIfNotExists(bucketType: keyof AppContext['s3Buckets']): Promise<string> {
    const bucketName = this.context.getS3BucketName(bucketType);

    try {
      this.logDebug('Checking if bucket exists', { bucketName });
      await this.s3.headBucket({ Bucket: bucketName }).promise();
      this.logInfo('Bucket already exists', { bucketName });
    } catch (err: any) {
      if (err.code === 'NotFound' || err.code === 'NoSuchBucket') {
        this.logInfo('Bucket does not exist, creating', { bucketName });

        try {
          await this.withRetry(() =>
            this.s3.createBucket({
              Bucket: bucketName,
              CreateBucketConfiguration: { LocationConstraint: this.context.region },
            }).promise()
          );

          this.logInfo('Successfully created bucket', { bucketName });
        } catch (createErr: any) {
          this.logError('Failed to create bucket', createErr, { bucketName });
          throw createErr;
        }
      } else {
        this.logError('Error checking bucket existence', err, { bucketName });
        throw err;
      }
    }

    return bucketName;
  }

  /**
   * Uploads data to S3.
   */
  public async uploadRawData(
    bucketType: keyof AppContext['s3Buckets'],
    key: string,
    data: Buffer | string,
    metadata: Record<string, string> = {}
  ): Promise<AWS.S3.ManagedUpload.SendData> {
    const bucketName = this.context.getS3BucketName(bucketType);

    try {
      this.logDebug('Uploading raw data to S3', {
        bucketName,
        key,
        sizeBytes: typeof data === 'string' ? Buffer.byteLength(data) : data.length,
      });

      const result = await this.withRetry(() =>
        this.s3.upload({
          Bucket: bucketName,
          Key: key,
          Body: data,
          Metadata: metadata,
          ContentType: metadata.contentType || 'application/octet-stream',
        }).promise()
      );

      this.logInfo('Successfully uploaded data to S3', { bucketName, key, etag: result.ETag });

      return result;
    } catch (err: any) {
      this.logError('Failed to upload data to S3', err, { bucketName, key });
      throw err;
    }
  }

  /**
   * Downloads an object from S3.
   */
  public async downloadObject(
    bucketType: keyof AppContext['s3Buckets'],
    key: string
  ): Promise<AWS.S3.GetObjectOutput> {
    const bucketName = this.context.getS3BucketName(bucketType);

    try {
      this.logDebug('Downloading object from S3', { bucketName, key });

      const result = await this.withRetry(() =>
        this.s3.getObject({ Bucket: bucketName, Key: key }).promise()
      );

      this.logInfo('Successfully downloaded object from S3', { bucketName, key, sizeBytes: result.ContentLength });

      return result;
    } catch (err: any) {
      this.logError('Failed to download object from S3', err, { bucketName, key });
      throw err;
    }
  }

  /**
   * Logs error details to a dedicated error bucket.
   */
  public async logErrorDetails(
    operation: string,
    error: any,
    context: any,
    payload?: any
  ): Promise<string | null> {
    const bucketName = this.context.getS3BucketName('errors');

    try {
      const timestamp = new Date().toISOString();
      const errorKey = `errors/${operation}/${timestamp}.json`;

      const errorData = {
        timestamp,
        requestId: context.awsRequestId || 'unknown',
        functionName: context.functionName,
        operation,
        error: this.formatError(error),
        payload,
        service: this.context.appName,
        environment: this.context.environment,
      };

      await this.withRetry(() =>
        this.s3.putObject({
          Bucket: bucketName,
          Key: errorKey,
          Body: JSON.stringify(errorData, null, 2),
          ContentType: 'application/json',
        }).promise()
      );

      this.logInfo('Successfully logged error details to S3', { bucketName, key: errorKey });

      return errorKey;
    } catch (logErr: any) {
      this.logError('Failed to log error details to S3', logErr);
      return null;
    }
  }

  /**
   * Sends a critical alert to SNS.
   */
  public async sendCriticalAlert(
    subject: string,
    message: string,
    details: Record<string, any> = {}
  ): Promise<boolean> {
    try {
      const alertMessage = {
        timestamp: new Date().toISOString(),
        message,
        details,
        service: this.context.appName,
        environment: this.context.environment,
      };

      await this.withRetry(() =>
        this.sns.publish({
          TopicArn: process.env.ALERT_TOPIC_ARN,
          Subject: `[${this.context.environment}] ${subject}`,
          Message: JSON.stringify(alertMessage, null, 2),
        }).promise()
      );

      this.logInfo('Successfully sent alert to SNS', { subject });

      return true;
    } catch (err: any) {
      this.logError('Failed to send alert to SNS', err);
      return false;
    }
  }

  

  /**
   * Handles an error comprehensively - logs, alerts, and queues.
   */
  public async handleError(
    operation: string,
    error: any,
    context: any,
    payload?: any,
    options: { sendAlert?: boolean } = { sendAlert: true }
  ): Promise<void> {
    const errorKey = await this.logErrorDetails(operation, error, context, payload);

    if (options.sendAlert) {
      await this.sendCriticalAlert(
        `Error in ${operation}`,
        error.message || 'An error occurred',
        { operation, errorType: error.name, requestId: context.awsRequestId, errorKey }
      );
    }
  }
}