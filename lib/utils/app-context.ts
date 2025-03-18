import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Environment } from '../../dtos/environment';
import { NameGenerator } from '../modules/name-generator';
import { EventNameGenerator } from '../modules/name-gen-dynamo';

export interface LoggingContext {
  level: string;
  retentionDays: RetentionDays;
  enableTracing: boolean;
  logFormat: string;
  logger: {
    debug: (message: string, context?: Record<string, any>) => void;
    info: (message: string, context?: Record<string, any>) => void;
    warn: (message: string, context?: Record<string, any>) => void;
    error: (message: string, error?: Error, context?: Record<string, any>) => void;
  };
}

export function createLoggingContext(environment: Environment): LoggingContext {
  const level = process.env.LOG_LEVEL || (environment === Environment.PROD ? 'ERROR' : 'INFO');
  const logFormat = process.env.LOG_FORMAT || 'json';

  const logFunction = (logLevel: string) => (message: string, context?: Record<string, any>) => {
    const logEntry = {
      level: logLevel,
      message,
      context,
      timestamp: new Date().toISOString()
    };
    if (logFormat === 'json') {
      console.log(JSON.stringify(logEntry));
    } else {
      console.log(`[${logLevel.toUpperCase()}] ${message} - ${JSON.stringify(context || {})}`);
    }
  };

  return {
    level,
    retentionDays: RetentionDays.THREE_MONTHS, // ✅ Align with AWS best practices
    enableTracing: process.env.ENABLE_TRACING === 'true' || environment === Environment.PROD,
    logFormat,
    logger: {
      debug: logFunction('DEBUG'),
      info: logFunction('INFO'),
      warn: logFunction('WARN'),
      error: (message, error, context) => {
        const logEntry = {
          level: 'ERROR',
          message,
          error: error ? { name: error.name, message: error.message, stack: error.stack } : undefined,
          context,
          timestamp: new Date().toISOString()
        };
        console.error(logFormat === 'json' ? JSON.stringify(logEntry) : `[ERROR] ${message} - ${JSON.stringify(context || {})}`);
      }
    }
  };
}

export interface AppContext {
  eventBusName: string;
  project: string;
  appName: string;
  environment: Environment;
  stage: Environment;
  region: string;
  nameGenerator: NameGenerator;
  isProd: boolean;
  logging: LoggingContext;
  endpoint?: string; // Custom endpoint for local environment
  s3ForcePathStyle: boolean; // For local S3 compatibility
  
  dynamoTables: Record<'events' | 'matches', string>; // ✅ Fixed error
  s3Buckets: Record<'rawData' | 'logs' | 'backups' | 'errors', string>;
  eventnameGenerator: EventNameGenerator;
  getS3BucketName: (bucketType: keyof AppContext['s3Buckets']) => string;
}

export function createAppContext(overrides: Partial<AppContext> = {}): AppContext {
  const environment = overrides.environment || (process.env.ENVIRONMENT as Environment) || Environment.DEV;
  const isProd = environment === Environment.PROD;
  const isLocal = environment === Environment.LOCAL;

  const project = 'football-serverless';
  const appName = process.env.APP_NAME || 'football-serverless-app';
  const region = process.env.AWS_REGION || 'us-east-1';

  const endpoint = overrides.endpoint ?? process.env.AWS_ENDPOINT ?? (isLocal ? 'http://localhost:4566' : undefined);

  const s3ForcePathStyle = isLocal;
  const logging = createLoggingContext(environment);

  const dynamoTables: Record<'events' | 'matches', string> = {
    events: `${project}-${environment}-events`,
    matches: `${project}-${environment}-matches`,
  };

  const s3Buckets: Record<'rawData' | 'logs' | 'backups' | 'errors', string> = {
    rawData: `${project}-${environment}-raw-data`,
    logs: `${project}-${environment}-logs`,
    backups: `${project}-${environment}-backups`,
    errors: `${project}-${environment}-errors`,
  };

  return {
    eventBusName: `${project}-${environment}-event-bus`,
    project,
    appName,
    environment,
    stage: environment,
    region,
    nameGenerator: new NameGenerator(),
    isProd,
    logging,
    endpoint,
    s3ForcePathStyle,
    dynamoTables,
    s3Buckets,
    getS3BucketName: (bucketType: keyof AppContext['s3Buckets']) => s3Buckets[bucketType],
    eventnameGenerator: new EventNameGenerator(),
    ...overrides,
  };
}

