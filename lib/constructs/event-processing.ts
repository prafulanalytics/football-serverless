import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as eventbridge from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { AppContext } from './../utils/app-context';
import { CoreResourcesConstruct } from './core-resources';
import * as path from 'path';

export interface EventProcessingProps {
  coreResources: CoreResourcesConstruct;
  appContext: AppContext;
  functionNameProcessLambda?: string;
  functionNameQueryLambda?: string;
}

export class EventProcessingConstruct extends Construct {
  public readonly processLambda: lambda.Function;
  public readonly queryLambda: lambda.Function;

  constructor(scope: Construct, id: string, props: EventProcessingProps) {
    super(scope, id);

    const { coreResources, appContext } = props;
    const { environment, project } = appContext;
    const isLocal = Boolean(appContext.endpoint);

    const functionNameProcessLambda =
      props.functionNameProcessLambda || `${project}-${environment}-process-lambda`;

    const functionNameQueryLambda =
      props.functionNameQueryLambda || `${project}-${environment}-query-lambda`;

    // ✅ **Lambda for Processing Match Events (WRITE)**
    this.processLambda = new NodejsFunction(this, 'ProcessMatchEventLambda', {
      functionName: functionNameProcessLambda,
      entry: path.join(__dirname, '../.././lambda/handler/event-processing.ts'), // ✅ Use correct path
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      role: coreResources.lambdaExecutionRole, // ✅ Use write-access role
      timeout: cdk.Duration.seconds(200),
      logRetention: cdk.aws_logs.RetentionDays.ONE_WEEK, // ✅ Ensure consistent log retention
      bundling: { externalModules: [], target: 'es2018' },
      environment: {
        EVENTS_TABLE_NAME: coreResources.eventsTable.tableName,
        MATCHES_TABLE_NAME: coreResources.matchesTable.tableName,
        EVENT_BUS_NAME: coreResources.eventBus.eventBusName,
        EVENT_DLQ_URL: coreResources.dlq.queueUrl,
        PROJECT_NAME: project,
        ENVIRONMENT: environment,
      },
      tracing: lambda.Tracing.ACTIVE,
    });

    // ✅ **EventBridge Rule to trigger the processing Lambda**
    const eventRule = new eventbridge.Rule(this, 'MatchEventRule', {
      eventBus: coreResources.eventBus,
      eventPattern: { source: ['football.matches.live'] },
    });

    eventRule.addTarget(
      new eventTargets.LambdaFunction(this.processLambda, {
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(24),
        deadLetterQueue: coreResources.dlq,
      })
    );

    // ✅ **SQS Queue for Event Processing**
    const eventProcessingQueue = new sqs.Queue(this, 'EventProcessingQueue', {
      queueName: `${project}-${environment}-event-processing-queue`,
      visibilityTimeout: cdk.Duration.seconds(120),
      retentionPeriod: cdk.Duration.days(7),
      deadLetterQueue: {
        maxReceiveCount: 5,
        queue: coreResources.dlq,
      },
    });

    // ✅ **Allow Process Lambda to Consume Messages from SQS**
    eventProcessingQueue.grantConsumeMessages(this.processLambda);

    // ✅ **Lambda listens to SQS Queue for batch processing**
    this.processLambda.addEventSource(
      new SqsEventSource(eventProcessingQueue, {
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(5),
      })
    );

    // ✅ **Grant Process Lambda permissions to access DynamoDB tables**
    coreResources.eventsTable.grantReadWriteData(this.processLambda);
    coreResources.matchesTable.grantReadWriteData(this.processLambda);

    // ✅ **Lambda for Querying Match Events (READ-ONLY)**
    this.queryLambda = new NodejsFunction(this, 'QueryMatchEventLambda', {
      functionName: functionNameQueryLambda,
      entry: path.join(__dirname, '../.././lambda/handler/query.ts'), // ✅ Use correct path
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      role: coreResources.queryLambdaExecutionRole, // ✅ Use read-only role
      logRetention: cdk.aws_logs.RetentionDays.ONE_WEEK, // ✅ Ensure consistent log retention
      bundling: { externalModules: [], target: 'es2018' },
      environment: {
        EVENTS_TABLE_NAME: coreResources.eventsTable.tableName,
        MATCHES_TABLE_NAME: coreResources.matchesTable.tableName,
        EVENT_BUS_NAME: coreResources.eventBus.eventBusName,
        EVENT_DLQ_URL: coreResources.dlq.queueUrl,
        PROJECT_NAME: project,
        ENVIRONMENT: environment,
      },
      tracing: lambda.Tracing.ACTIVE,
    });

    // ✅ **Grant Query Lambda Read-Only Access to DynamoDB**
    coreResources.eventsTable.grantReadData(this.queryLambda);
    coreResources.matchesTable.grantReadData(this.queryLambda);

    // ✅ **Monitoring: CloudWatch Alarms**
    new cdk.aws_cloudwatch.Alarm(this, 'DLQNotEmptyAlarm', {
      metric: coreResources.dlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: 'Events are being sent to DLQ',
      alarmName: `${project}-${environment}-events-dlq-not-empty`,
    });

    new cdk.aws_cloudwatch.Alarm(this, 'ProcessLambdaErrorAlarm', {
      metric: this.processLambda.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
      alarmDescription: 'High error rate in event processing Lambda',
      alarmName: `${project}-${environment}-event-process-errors`,
    });
  }
}
