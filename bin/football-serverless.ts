import * as cdk from 'aws-cdk-lib';
import { createAppContext, createLoggingContext } from '../lib/utils/app-context';
import { Environment } from '../dtos/environment';
import { MatchProcessingStack } from '../lib/football-serverless-stack';

// Create CDK App
const app = new cdk.App();

// Get environment from process env
const environment = (process.env.ENVIRONMENT as Environment) || Environment.LOCAL;

// Create contexts
const appContext = createAppContext({
  environment: Environment.LOCAL, // 👈 Explicitly setting Local
  endpoint: 'http://localhost:4566', // 👈 LocalStack URL
});
const loggingContext = createLoggingContext(environment);

// Set contexts
app.node.setContext('app', appContext);
app.node.setContext('logging', loggingContext);

// Stack configuration
const stackConfig = {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: appContext.region
  }
};

// Create stack with enhanced props
new MatchProcessingStack(
  app, 
  `${appContext.project}-${Environment.LOCAL}`,
  {
    ...stackConfig,
    projectName: appContext.project,
    environment: Environment.LOCAL,
  }
);

// Synthesize the app
app.synth();