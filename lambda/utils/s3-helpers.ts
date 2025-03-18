// File: utils/s3-helpers.ts
import { S3Client } from '../../lambda/clients/s3-client';
import { LambdaUtils } from './lambda-utils';

/**
 * Get S3 bucket name and key from a storage path
 * @param storagePath Format: "s3://bucket-name/path/to/object"
 * @returns Object containing bucket name and key
 */
export function parseS3Uri(storagePath: string): { bucketName: string; objectKey: string } {
  const s3Uri = new URL(storagePath.replace('s3://', 'http://'));
  const bucketName = s3Uri.hostname;
  const objectKey = s3Uri.pathname.substring(1); // Remove leading slash
  
  return { bucketName, objectKey };
}

/**
 * Retrieve and parse an object from S3
 * @param s3Client S3 client instance
 * @param storagePath S3 URI
 * @param utils Lambda utilities instance for retries
 * @returns Parsed object data
 */
export async function getObjectFromS3(
  s3Client: S3Client,
  storagePath: string,
  utils: LambdaUtils
): Promise<Record<string, any>> {
  // Extract bucket name and object key
  const { objectKey } = parseS3Uri(storagePath);
  
  // Use the correct bucket type based on your app context
  const bucketType = 'rawData';
  
  // Download object with retry logic
  const result = await utils.retryWithBackoff(
    () => s3Client.downloadObject(bucketType, objectKey),
    {
      retries: 3,
      initialDelay: 500,
      retryableErrors: ['NoSuchKey', 'ServiceUnavailable']
    }
  );
  
  // Parse the result
  if (result.Body) {
    const dataString = result.Body.toString('utf-8');
    return JSON.parse(dataString);
  }
  
  throw new Error('Empty response from S3');
}

/**
 * Ensure S3 bucket exists
 * @param s3Client S3 client instance
 * @param bucketType Bucket type from context
 * @returns Bucket name
 */
export async function ensureBucketExists(
  s3Client: S3Client, 
  bucketType: string
): Promise<string> {
  return await s3Client.createBucketIfNotExists(bucketType as any);
}