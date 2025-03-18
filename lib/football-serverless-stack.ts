import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CoreResourcesConstruct } from './constructs/core-resources';
import { EventIngestionConstruct } from './constructs/event-ingestion';
import { EventProcessingConstruct } from './constructs/event-processing';
import { createAppContext } from './../lib/utils/app-context';
import { Environment } from '../dtos/environment';
import { QueryConstruct } from './constructs/query-events';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';

export interface MatchProcessingStackProps extends cdk.StackProps {
  projectName: string;
  environment: Environment;
}

export class MatchProcessingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MatchProcessingStackProps) {
    super(scope, id, props);

    // ✅ **Create App Context**
    const appContext = createAppContext({
      project: props.projectName,
      environment: props.environment,
      endpoint: props.environment === Environment.LOCAL ? 'http://localhost:4566' : undefined, 
    });

    // ✅ **Core Resources Construct**
    const coreResources = new CoreResourcesConstruct(this, 'CoreResources', { appContext });

    // ✅ **Event Ingestion Construct (API Gateway)**
    const eventIngestion = new EventIngestionConstruct(this, 'EventIngestion', { appContext, coreResources });

    // ✅ **Event Processing Construct**
    new EventProcessingConstruct(this, 'EventProcessing', { appContext, coreResources });

    // ✅ **Use Shared API Gateway from Core Resources**
    const api = eventIngestion.api ?? coreResources.apiGateway;
    let eventsResource = api.root.getResource('events');
    if (!eventsResource) {
      eventsResource = api.root.addResource('events');
    }

    // ✅ **Query Events Construct (Goals & Passes)**
    const queryConstruct = new QueryConstruct(this, 'QueryConstruct', { appContext, coreResources });

    // ✅ **Define API Gateway Routes**
    const matchesResource = api.root.addResource('matches');
    const matchResource = matchesResource.addResource('{match_id}');
    const goalsResource = matchResource.addResource('goals');
    const passesResource = matchResource.addResource('passes');

    // ✅ **Attach Lambda Integrations for Querying**
    goalsResource.addMethod('GET', new apigateway.LambdaIntegration(queryConstruct.goalsLambda));
    passesResource.addMethod('GET', new apigateway.LambdaIntegration(queryConstruct.passesLambda));

    // ✅ **Stack Outputs**
    new cdk.CfnOutput(this, 'APIGatewayURL', { value: api.url });
    new cdk.CfnOutput(this, 'EventBridgeBusName', { value: coreResources.eventBus.eventBusName });
    new cdk.CfnOutput(this, 'S3RawDataBucket', { value: coreResources.eventBucket.bucketName });
    new cdk.CfnOutput(this, 'DynamoDBEventsTable', { value: coreResources.eventsTable.tableName });

    new cdk.CfnOutput(this, 'GoalsAPIEndpoint', { 
      value: `${api.url}/matches/{match_id}/goals` 
    });

    new cdk.CfnOutput(this, 'PassesAPIEndpoint', { 
      value: `${api.url}/matches/{match_id}/passes` 
    });

    new cdk.CfnOutput(this, 'EventsAPIEndpoint', { 
      value: `${api.url}/events`
    });
  }
}
