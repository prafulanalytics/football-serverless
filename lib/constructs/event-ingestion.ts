import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { AppContext } from './../utils/app-context';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { CoreResourcesConstruct } from './core-resources';
import * as path from 'path';

export interface EventIngestionProps {
  coreResources: CoreResourcesConstruct;
  appContext: AppContext;
  constructName?: string;
}

export class EventIngestionConstruct extends Construct {
  public readonly ingestLambda: lambda.Function;
  public readonly api: apigateway.RestApi; // ✅ Expose API Gateway

  constructor(scope: Construct, id: string, props: EventIngestionProps) {
    super(scope, id);

    const { coreResources, appContext } = props;
    const { project, environment, eventBusName } = appContext;
    const constructName = props.constructName || `${project}-${environment}-event-ingestion`;

    // ✅ **Lambda for Storing Raw Events in S3**
    this.ingestLambda = new NodejsFunction(this, 'StoreMatchEventLambda', {
      functionName: constructName,
      entry: path.join(__dirname, '../../lambda/handler/raw-storage.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      role: coreResources.lambdaExecutionRole, // ✅ Use write-access role
      logRetention: cdk.aws_logs.RetentionDays.ONE_WEEK,
      bundling: { externalModules: [], target: 'es2018' },
      environment: {
        EVENT_BUCKET_NAME: coreResources.eventBucket.bucketName,
        EVENT_BUS_NAME: eventBusName,
        EVENT_DLQ_URL: coreResources.dlq.queueUrl,
        PROJECT_NAME: project,
        ENVIRONMENT: environment,
      },
    });

    // ✅ **Allow EventBridge to Invoke Lambda**
    this.ingestLambda.addPermission('AllowEventBridgeInvoke', {
      principal: new cdk.aws_iam.ServicePrincipal('events.amazonaws.com'),
      sourceArn: coreResources.eventBus.eventBusArn,
    });

    // ✅ **Grant permissions**
    coreResources.eventBus.grantPutEventsTo(this.ingestLambda);
    coreResources.eventBucket.grantWrite(this.ingestLambda);

    // ✅ **Use Shared API Gateway from Core Resources**
    this.api = coreResources.apiGateway;

    // ✅ **Check if `events` resource already exists, if not, create it**
    let eventsResource = this.api.root.getResource('events');
    if (!eventsResource) {
      eventsResource = this.api.root.addResource('events');
    }

    eventsResource.addMethod('POST', new apigateway.LambdaIntegration(this.ingestLambda));
  }
}
