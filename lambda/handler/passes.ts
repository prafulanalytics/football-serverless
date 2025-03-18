import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { createAppContext } from '../../lib/utils/app-context';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda/trigger/api-gateway-proxy';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // Initialize AppContext to get proper endpoint configuration
  const appContext = createAppContext();
  const logger = appContext.logging.logger;
  
  // Create client using appContext (which handles endpoints correctly)
  const dynamoClient = new DynamoDBClient(appContext);
  const matchId = event.pathParameters?.match_id;
  if (!matchId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ message: 'match_id path parameter is required' }),
    };
  }

  try {
    // Define Query Parameters
    const params = {
      TableName: 'football-serverless-local-events',
      KeyConditionExpression: 'pk = :matchKey',
      FilterExpression: 'event_type = :etype',
      ExpressionAttributeValues: {
        ':matchKey': { S: `MATCH#${matchId}` },
        ':etype': { S: 'pass' }
      }
    };

    // Execute the query using AWS SDK v3
    const command = new QueryCommand(params);
    const queryResult = await dynamoClient.send(command);

    const totalPasses = queryResult.Items?.length || 0;

    return {
      statusCode: 200,
      body: JSON.stringify({ matchId, totalPasses }),
    };
  } catch (error) {
    console.error('Error querying DynamoDB:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Internal Server Error' }),
    };
  }
};
