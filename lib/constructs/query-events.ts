import { AppContext } from '../utils/app-context';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { CoreResourcesConstruct } from './core-resources';
import * as path from 'path';

export interface QueryConstructProps {
  appContext: AppContext;
  coreResources: CoreResourcesConstruct;
}

export class QueryConstruct extends Construct {
  public readonly goalsLambda: lambda.Function;
  public readonly passesLambda: lambda.Function;

  constructor(scope: Construct, id: string, props: QueryConstructProps) {
    super(scope, id);

    const { appContext, coreResources } = props;
    const { project, environment } = appContext;

    // ✅ **Lambda for Querying Goals**
    this.goalsLambda = new NodejsFunction(this, 'GoalsLambda', {
      functionName: `${project}-goals-function`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'handler',
      entry: path.join(__dirname, '../../lambda/handler/goals.ts'), // ✅ Adjusted path
      role: coreResources.queryLambdaExecutionRole, // ✅ Use read-only IAM role
      logRetention: cdk.aws_logs.RetentionDays.ONE_WEEK,
      environment: {
        TABLE_NAME: coreResources.eventsTable.tableName,
        BUCKET_NAME: coreResources.eventBucket.bucketName,
      },
      deadLetterQueueEnabled: true,
      deadLetterQueue: coreResources.dlq,
    });

    // ✅ **Lambda for Querying Passes**
    this.passesLambda = new NodejsFunction(this, 'PassesLambda', {
      functionName: `${project}-passes-function`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'handler',
      entry: path.join(__dirname, '../../lambda/handler/passes.ts'), // ✅ Adjusted path
      role: coreResources.queryLambdaExecutionRole,
      logRetention: cdk.aws_logs.RetentionDays.ONE_WEEK,
      environment: {
        TABLE_NAME: coreResources.eventsTable.tableName,
        BUCKET_NAME: coreResources.eventBucket.bucketName,
      },
      deadLetterQueueEnabled: true,
      deadLetterQueue: coreResources.dlq,
    });

    // ✅ **Grant Query Lambdas Read-Only Access to DynamoDB**
    coreResources.eventsTable.grantReadData(this.goalsLambda);
    coreResources.eventsTable.grantReadData(this.passesLambda);

    // ✅ **Reference existing API Gateway from CoreResourcesConstruct**
    const api = coreResources.apiGateway;

    // ✅ **Retrieve the existing `events` resource**
    const eventsResource = api.root.getResource('events');
    if (!eventsResource) {
      throw new Error("The 'events' resource must be created before QueryConstruct.");
    }

    const matchResource = eventsResource.addResource('{match_id}');
    const goalsResource = matchResource.addResource('goals');
    const passesResource = matchResource.addResource('passes');

    // ✅ **Integrate Lambda functions with API Gateway**
    goalsResource.addMethod('GET', new apigateway.LambdaIntegration(this.goalsLambda));
    passesResource.addMethod('GET', new apigateway.LambdaIntegration(this.passesLambda));
  }
}
