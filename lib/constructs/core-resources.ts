import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as eventbridge from 'aws-cdk-lib/aws-events';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { AppContext } from './../utils/app-context';

export class CoreResourcesConstruct extends Construct {
  public readonly eventBus: eventbridge.EventBus;
  public readonly dlq: sqs.Queue;
  public readonly lambdaExecutionRole: iam.Role;
  public readonly queryLambdaExecutionRole: iam.Role;
  public readonly eventsTable: dynamodb.Table;
  public readonly matchesTable: dynamodb.Table;
  public readonly eventBucket: s3.Bucket;
  public readonly apiGateway: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: { appContext: AppContext }) {
    super(scope, id);

    const { project, environment, s3Buckets, dynamoTables, eventBusName } = props.appContext;

    // ✅ **S3 Bucket for Raw Data**
    this.eventBucket = new s3.Bucket(this, 'EventBucket', {
      bucketName: s3Buckets.rawData ?? `${project}-${environment}-raw-data`,  // ✅ Safe fallback
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ✅ **Lambda Execution Role (for Core Services)**
    this.lambdaExecutionRole = new iam.Role(this, 'LambdaExecutionRole', {
      roleName: `${project}-${environment}-CoreLambdaExec`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // ✅ **Grant Lambda permissions to S3**
    this.eventBucket.grantReadWrite(this.lambdaExecutionRole);

    // ✅ **Dead Letter Queue (DLQ)**
    this.dlq = new sqs.Queue(this, 'EventDLQ', {
      queueName: `${project}-${environment}-event-dlq`,
      retentionPeriod: cdk.Duration.days(14),
    });

    // ✅ **EventBridge Bus**
    this.eventBus = new eventbridge.EventBus(this, 'MatchEventBus', {
      eventBusName,  // ✅ Uses AppContext to ensure consistency
    });

    // ✅ **DynamoDB Tables**
    this.eventsTable = new dynamodb.Table(this, 'EventsTable', {
      tableName: dynamoTables.events,  // ✅ Uses AppContext for consistency
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    this.matchesTable = new dynamodb.Table(this, 'MatchesTable', {
      tableName: dynamoTables.matches,  // ✅ Uses AppContext for consistency
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    // ✅ **Grant Core Lambda Permissions**
    this.eventsTable.grantReadWriteData(this.lambdaExecutionRole);
    this.matchesTable.grantReadWriteData(this.lambdaExecutionRole);
    this.eventBus.grantPutEventsTo(this.lambdaExecutionRole);
    this.dlq.grantSendMessages(this.lambdaExecutionRole);

    // ✅ **IAM Policy for Core Lambda Execution**
    this.lambdaExecutionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents', 'execute-api:Invoke'],
        resources: ['*'],
      })
    );

    this.lambdaExecutionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: ['*'],
      })
    );

    // ✅ **Query Lambda Execution Role (for QueryConstruct)**
    this.queryLambdaExecutionRole = new iam.Role(this, 'QueryLambdaExecutionRole', {
      roleName: `${project}-${environment}-QueryLambdaExec`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // ✅ **Grant Query Lambda Read Access**
    this.eventsTable.grantReadData(this.queryLambdaExecutionRole);
    this.matchesTable.grantReadData(this.queryLambdaExecutionRole);
    this.eventBucket.grantRead(this.queryLambdaExecutionRole);

    // ✅ **API Gateway**
    this.apiGateway = new apigateway.RestApi(this, 'FootballApiGateway', {
      restApiName: `${project}-${environment}-football-api`,
      description: 'Unified API for football events and queries',
      deployOptions: {
        stageName: environment,
        tracingEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    // ✅ **Log Group for Lambda**
    new logs.LogGroup(this, 'LambdaLogGroup', {
      logGroupName: `/aws/lambda/${project}-${environment}-process-lambda`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
