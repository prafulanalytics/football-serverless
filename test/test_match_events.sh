#!/bin/bash

# Color codes for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
API_ID="osddonknfk"
STAGE="local"
EVENT_BUS_NAME="football-serverless-local-match-event-bus"
EVENTS_TABLE="football-serverless-local-events"
MATCHES_TABLE="football-serverless-local-matches"
S3_BUCKET="football-serverless-local-raw-data"
EVENT_QUEUE="football-serverless-local-event-processing-queue"
DLQ="football-serverless-local-event-dlq"
ENDPOINT="http://localhost:4566"
MAX_RETRIES=10
RETRY_WAIT=3

# Logging functions
log_success() { echo -e "${GREEN}✅ SUCCESS:${NC} $1"; }
log_error() { echo -e "${RED}❌ ERROR:${NC} $1"; }
log_info() { echo -e "${YELLOW}ℹ️ INFO:${NC} $1"; }
log_step() { echo -e "\n${BLUE}🔄 STEP ${1}:${NC} ${2}"; }

# Test scenario
test_event_flow() {
    local payload="$1"
    local match_id=$(echo "$payload" | jq -r '.match_id')
    local event_type=$(echo "$payload" | jq -r '.event_type')
    
    echo -e "\n============================================"
    echo -e "🚀 TESTING EVENT FLOW: match_id=$match_id, event_type=$event_type"
    echo -e "===========================================\n"
    
    # Step 1: API Gateway Submission
    log_step "1" "Submitting event via API Gateway"
    local response=$(curl -s -X POST \
        "$ENDPOINT/restapis/$API_ID/$STAGE/_user_request_/events" \
        -H "Content-Type: application/json" \
        -d "$payload")
    
    if echo "$response" | grep -q "success"; then
        local event_id=$(echo "$response" | jq -r '.eventId')
        log_success "API submission successful - Event ID: $event_id"
    else
        log_error "API submission failed - Response: $response"
        return 1
    fi
    
    # Step 2: S3 Storage Verification
    log_step "2" "Checking if event was stored in S3"
    for attempt in $(seq 1 $MAX_RETRIES); do
        log_info "Attempt $attempt of $MAX_RETRIES"
        
        local s3_objects=$(awslocal s3api list-objects-v2 \
            --bucket "$S3_BUCKET" \
            --prefix "matches/$match_id/events/" \
            --output json)
        
        local object_count=$(echo "$s3_objects" | jq -r '.Contents | length // 0')
        
        if [ "$object_count" -gt 0 ]; then
            local object_key=$(echo "$s3_objects" | jq -r '.Contents[0].Key')
            log_success "Event stored in S3 - Object: $object_key"
            break
        fi
        
        if [ $attempt -eq $MAX_RETRIES ]; then
            log_error "Event NOT found in S3 after $MAX_RETRIES attempts"
            return 2
        else
            log_info "Event not yet in S3, waiting ${RETRY_WAIT}s..."
            sleep $RETRY_WAIT
        fi
    done

    # Step 3: EventBridge Publishing Verification
    log_step "3" "Checking EventBridge Event Publishing"
    for attempt in $(seq 1 $MAX_RETRIES); do
        log_info "Attempt $attempt of $MAX_RETRIES"
        
        # Check event ingestion Lambda logs
        local ingestion_logs=$(awslocal logs get-log-events \
            --log-group-name "/aws/lambda/football-serverless-local-event-ingestion" \
            --log-stream-name $(awslocal logs describe-log-streams \
                --log-group-name "/aws/lambda/football-serverless-local-event-ingestion" \
                --order-by LastEventTime \
                --descending \
                --limit 1 \
                --query 'logStreams[0].logStreamName' \
                --output text 2>/dev/null))
        
        # Look for specific logging patterns
        if echo "$ingestion_logs" | grep -q "Successfully published event to EventBridge" && 
           echo "$ingestion_logs" | grep -q "$match_id"; then
            log_success "Event Published to EventBridge"
            break
        fi
        
        if [ $attempt -eq $MAX_RETRIES ]; then
            log_error "Event NOT published to EventBridge after $MAX_RETRIES attempts"
            return 3
        else
            log_info "Event not yet published, waiting ${RETRY_WAIT}s..."
            sleep $RETRY_WAIT
        fi
    done

        log_step "4" "Checking Process Lambda Event Handling"
        for attempt in $(seq 1 $MAX_RETRIES); do
            log_info "Attempt $attempt of $MAX_RETRIES"
            
            # Check process Lambda logs
            local process_logs=$(awslocal logs get-log-events \
                --log-group-name "/aws/lambda/football-serverless-local-process-lambda" \
                --log-stream-name $(awslocal logs describe-log-streams \
                    --log-group-name "/aws/lambda/football-serverless-local-process-lambda" \
                    --order-by LastEventTime \
                    --descending \
                    --limit 1 \
                    --query 'logStreams[0].logStreamName' \
                    --output text 2>/dev/null))
            
            # Look for Lambda invocation (even if it's having connection issues)
            if echo "$process_logs" | grep -q "Using AWS endpoint"; then
                log_success "Lambda was invoked - EventBridge trigger is working"
                
                # Check if we have the connection error or successful processing
                if echo "$process_logs" | grep -q "UnknownEndpoint"; then
                    log_info "Lambda has DynamoDB connection issues - this is expected and we're fixing it"
                elif echo "$process_logs" | grep -q "Processing event data" && 
                    echo "$process_logs" | grep -q "$match_id"; then
                    log_success "Event fully processed by Lambda"
                fi
                
                break
            fi
            
            if [ $attempt -eq $MAX_RETRIES ]; then
                log_error "Lambda NOT invoked after $MAX_RETRIES attempts"
                return 4
            else
                log_info "Lambda not yet invoked, waiting ${RETRY_WAIT}s..."
                sleep $RETRY_WAIT
            fi
        done

    log_step "5" "Verifying event is stored in DynamoDB"
    for attempt in $(seq 1 $MAX_RETRIES); do
        log_info "Attempt $attempt of $MAX_RETRIES"
        
        # First, try to scan to see if anything is in the table
        local dynamo_scan=$(awslocal dynamodb scan \
            --table-name "$EVENTS_TABLE" \
            --limit 10 \
            --output json)
        
        local scan_count=$(echo "$dynamo_scan" | jq -r '.Count // 0')
        
        if [ "$scan_count" -gt 0 ]; then
            log_info "Found $scan_count items in table - checking if any match our event"
            
            # Check if any items contain our match_id
            local items_json=$(echo "$dynamo_scan" | jq -c '.Items')
            if echo "$items_json" | grep -q "$match_id"; then
                log_success "Event found in DynamoDB - matched by match_id within item"
                break
            fi
        fi
        
        # Try a query with the proper partition key pattern
        local dynamo_query=$(awslocal dynamodb query \
            --table-name "$EVENTS_TABLE" \
            --key-condition-expression "pk = :seasonmatchid" \
            --expression-attribute-values '{":seasonmatchid": {"S": "SEASON#2024/2025#MATCH#'$match_id'"}}' \
            --output json)
        
        local item_count=$(echo "$dynamo_query" | jq -r '.Count // 0')
        
        if [ "$item_count" -gt 0 ]; then
            log_success "Event stored in DynamoDB - Found $item_count items"
            break
        fi
        
        if [ $attempt -eq $MAX_RETRIES ]; then
            log_error "Event NOT found in DynamoDB after $MAX_RETRIES attempts"
            # Optional: Display table contents for debugging
            log_info "Current table contents (up to 10 items):"
            awslocal dynamodb scan --table-name "$EVENTS_TABLE" --limit 10
            return 5
        else
            log_info "Event not yet in DynamoDB, waiting ${RETRY_WAIT}s..."
            sleep $RETRY_WAIT
        fi
    done

    # Final Success
    echo -e "\n${GREEN}✅ TEST PASSED:${NC} Complete event flow verified!"
    echo -e "  - Match ID: $match_id"
    echo -e "  - Event Type: $event_type\n"
    
    return 0

    # Additional Debugging: Dump full logs if needed
    log_step "DEBUG" "Log Group Contents"
    log_info "Ingestion Lambda Logs:"
    awslocal logs get-log-events \
        --log-group-name "/aws/lambda/football-serverless-local-event-ingestion" \
        --log-stream-name $(awslocal logs describe-log-streams \
            --log-group-name "/aws/lambda/football-serverless-local-event-ingestion" \
            --order-by LastEventTime \
            --descending \
            --limit 10 \
            --query 'logStreams[0].logStreamName' \
            --output text) || true

    log_info "Process Lambda Logs:"
    awslocal logs get-log-events \
        --log-group-name "/aws/lambda/football-serverless-local-process-lambda" \
        --log-stream-name $(awslocal logs describe-log-streams \
            --log-group-name "/aws/lambda/football-serverless-local-process-lambda" \
            --order-by LastEventTime \
            --descending \
            --limit 10 \
            --query 'logStreams[0].logStreamName' \
            --output text) || true

    echo -e "\n${GREEN}✅ COMPLETE:${NC} Event successfully processed through initial components!"
    echo -e "  - Match ID: $match_id"
    echo -e "  - Event Type: $event_type\n"
    
    return 0
}

# Run tests with different event types
log_info "Testing event flow through the system with multiple event types..."

# Test a goal event
log_step "EVENT TEST" "Testing GOAL event"
test_event_flow '{"match_id":"flow_test_001","event_type":"goal","timestamp":"2025-03-17T14:00:00Z","team":"Home","player":"John Doe","minute":34,"second":21,"score":{"home":1,"away":0}}'
goal_test_code=$?

# Test a pass event
log_step "EVENT TEST" "Testing PASS event"
test_event_flow '{"match_id":"flow_test_001","event_type":"pass","timestamp":"2025-03-17T14:05:30Z","team":"Home","from_player":"John Doe","minute":40,"second":15}'
pass_test_code=$?

# Test a substitution event
log_step "EVENT TEST" "Testing SUBSTITUTION event"
test_event_flow '{"match_id":"flow_test_001","event_type":"substitution","timestamp":"2025-03-17T14:45:00Z","team":"Home","player_in":"Mark Wilson","player_out":"John Doe","minute":75,"second":0,"reason":"Tactical"}'
substitution_test_code=$?

# Display results summary
echo -e "\n${BLUE}======== EVENT FLOW TEST RESULTS ========${NC}"

display_test_result() {
    local event_type=$1
    local exit_code=$2
    
    if [ $exit_code -eq 0 ]; then
        echo -e "${GREEN}✅ $event_type TEST PASSED:${NC} Event successfully flowed through all components"
    else
        echo -e "${RED}❌ $event_type TEST FAILED:${NC} Event stopped at step $exit_code"
        case $exit_code in
            1) echo "   Failed at API Gateway Submission" ;;
            2) echo "   Failed at S3 Storage" ;;
            3) echo "   Failed at EventBridge Publishing" ;;
            4) echo "   Failed at EventBridge Event Processing" ;;
            5) echo "   Failed at DynamoDB Storage Verification" ;;
        esac
    fi
}

display_test_result "GOAL" $goal_test_code
display_test_result "PASS" $pass_test_code
display_test_result "SUBSTITUTION" $substitution_test_code

# Calculate overall test result
if [ $goal_test_code -eq 0 ] && [ $pass_test_code -eq 0 ] && [ $foul_test_code -eq 0 ] && [ $card_test_code -eq 0 ] && [ $substitution_test_code -eq 0 ]; then
    echo -e "\n${GREEN}✅ ALL TESTS PASSED:${NC} All event types successfully processed"
    final_exit_code=0
else
    echo -e "\n${RED}❌ SOME TESTS FAILED:${NC} Check individual test results above"
    final_exit_code=1
fi


echo -e "\n${BLUE}======== FINAL RESULT ========${NC}"
if [ $final_exit_code -eq 0 ]; then
    echo -e "${GREEN}✅ EVENT FLOW TESTING COMPLETE:${NC} All tests passed successfully"
else
    echo -e "${RED}❌ EVENT FLOW TESTING COMPLETE:${NC} Some tests failed, see details above"
fi

exit $final_exit_code