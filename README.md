# Football Match Events Processing System
A serverless application for ingesting, processing, and querying football (soccer) match events in real-time.

## Architecture

(https://github.com/prafulanalytics/football-serverless/issues/1#issue-2928429373)

### Overview
    This stack provides a complete serverless solution for processing football match events. The system follows a modern event-driven architecture with the following components:

    1. Event Ingestion: Captures events via API Gateway and stores them in S3 while publishing to EventBridge
    2. Event Processing: Processes events via Lambda functions, supporting both real-time and batch processing
    3. Event Storage: Stores processed events in DynamoDB with efficient access patterns
    4. Event Querying: Provides specialized API endpoints for querying specific event types

    5. API Endpoints  (awslocal apigateway get-rest-apis) Use this to replace the id in API ID in test 

    EndpointMethodDescription/events
    POST Submit a new match 
    event/matches/{match_id}/goals  
    GET Retrieve all goals for a specific match/matches/{match_id}/passes
    GET Retrieve all passes for a specific match
    Event Submission Format
    jsonCopy{
    "match_id": "match_123",
    "event_type": "goal",
    "timestamp": "2025-03-18T15:30:00Z",
    "team": "Home",
    "player": "John Doe",
    "minute": 15,
    "second": 20,
    "score": {
        "home": 1,
        "away": 0
    }
    }


3. Supported Event Types

    1. goal: Goal scored by a player
    2. pass: Pass between players
    3. foul: Foul committed by a player
    4. card: Yellow/red card shown to a player
    5. substitution: Player substitution

4. Query Parameters for Passes Endpoint
    The /matches/{match_id}/passes endpoint supports the following query parameters:

    team: Filter passes by team ("Home" or "Away")
    player: Filter passes involving a specific player
    success: Filter passes by success status (true/false)

## Testing Suite
The project includes comprehensive testing scripts located in the ./test directory:
Test ScriptDescriptiontest-event-flow.shTests the complete event flow from API to DynamoDB storagetest-api-queries.shTests the goals and passes query endpointstest-local-deploy.shVerifies local infrastructure deployment
Running Tests
bashCopy# Test the complete event flow
./test/test-event-flow.sh

## Test API query endpoints
./test/test-api-queries.sh

## Test with a specific event type

    ./test/test_match_events.sh
    ./test/test-match-query.sh

1. Deployment Prerequisites

    AWS CLI configured with appropriate credentials
    Node.js 18 or higher
    Docker (for local testing)
    LocalStack (for local development)
    cdklocal synth
    cdklocal bootstrap
    cdklocal deploy
    
    export LOCALSTACK_HOST=127.0.0.1
    export AWS_ENDPOINT_URL=http://127.0.0.1:4566
    export AWS_ENDPOINT=http://host.docker.internal:4566
    export AWS_ACCESS_KEY_ID=test
    export AWS_SECRET_ACCESS_KEY=test
    export AWS_SESSION_TOKEN=test
    export AWS_DEFAULT_REGION=us-east-1


Local Development
bashCopy# Install dependencies
npm install

## Start LocalStack
docker-compose up -d

## Deploy to local environment
npm run deploy:local

## Test the local deployment

Use awslocal apigateway get-rest-apis to retrieve the API ID
run ./test_match_events.sh
run ./test-match-query.sh

## Deploy to production environment
npm run deploy:prod
DynamoDB Schema
The event data is stored in DynamoDB with the following access patterns:

Primary Key: pk (Partition Key) = SEASON#{season}#MATCH#{match_id}, sk (Sort Key) = EVENT#{event_type}#{timestamp}
GSI1: gsi1pk = EVENT_TYPE#{event_type}, gsi1sk = {timestamp}

This design enables efficient queries for:

All events for a specific match
All events of a specific type (goals, passes, etc.)
Time-ordered event sequences


Resource Check 
1. awslocal apigateway get-rest-apis
3. awslocal dynamodb list-tables
4. awslocal dynamodb describe-table --table-name "football-serverless-local-events"
5. awslocal dynamodb scan --table-name EventsTable
6. awslocal s3 ls: 
7. awslocal events list-rules
8. awslocal sqs list-queues
9. awslocal sqs receive-message --queue-url http://localhost:4566/000000000000/EventDLQ --max-number-of-messages 10
10. awslocal lambda list-functions


S3 Testing

1. awslocal s3 ls s3://football-serverless-local-raw-data/events/

## Get specific details about objects
awslocal s3api list-objects-v2 \
  --bucket football-serverless-local-raw-data

2. Event Check:  awslocal s3 ls s3://football-serverless-local-raw-data --recursive 

3. DynamoDB 
awslocal dynamodb list-tables
1. football-serverless-local-events
2. football-serverless-local-matches
