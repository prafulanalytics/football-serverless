#!/bin/bash

# Color codes for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
API_ID="hzaovksyax"
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

# Function to run tests with different payloads
run_test_scenario() {
    local test_name="$1"
    local payload="$2"
    
    echo -e "\n============================================"
    echo -e "🚀 TEST: $test_name"
    echo -e "===========================================\n"
    
    test_event_flow "$payload"
    exit_code=$?

    if [ $exit_code -eq 0 ]; then
        log_success "Test '$test_name' PASSED"
    else
        log_error "Test '$test_name' FAILED at step $exit_code"
    fi

    echo -e "===========================================\n"
}

# Function to submit events and verify their flow
test_event_flow() {
    local payload="$1"
    local match_id=$(echo "$payload" | jq -r '.match_id')
    local event_type=$(echo "$payload" | jq -r '.event_type')

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

    log_step "3" "Checking Process Lambda Event Handling"
    for attempt in $(seq 1 $MAX_RETRIES); do
        log_info "Attempt $attempt of $MAX_RETRIES"
        
        local process_logs=$(awslocal logs get-log-events \
            --log-group-name "/aws/lambda/football-serverless-local-process-lambda" \
            --log-stream-name $(awslocal logs describe-log-streams \
                --log-group-name "/aws/lambda/football-serverless-local-process-lambda" \
                --order-by LastEventTime \
                --descending \
                --limit 1 \
                --query 'logStreams[0].logStreamName' \
                --output text 2>/dev/null))
        
        if echo "$process_logs" | grep -q "Processing EventBridge event" && 
           echo "$process_logs" | grep -q "$match_id"; then
            log_success "Event Processed by Lambda"
            break
        fi
        
        if [ $attempt -eq $MAX_RETRIES ]; then
            log_error "Event NOT processed by Lambda after $MAX_RETRIES attempts"
            return 4
        else
            log_info "Event not yet processed, waiting ${RETRY_WAIT}s..."
            sleep $RETRY_WAIT
        fi
    done

    return 0
}

# Test cases
log_info "Running multiple test cases..."

run_test_scenario "Basic Goal Event" '{
    "match_id": "flow_test_001",
    "event_type": "goal",
    "timestamp": "2025-03-17T14:00:00Z",
    "team": "Home",
    "player": "John Doe"
}'

run_test_scenario "Foul Event" '{
    "match_id": "flow_test_002",
    "event_type": "foul",
    "timestamp": "2025-03-17T14:05:00Z",
    "team": "Away",
    "player": "Jane Smith"
}'

run_test_scenario "Invalid Event (Missing Fields)" '{
    "match_id": "flow_test_003",
    "timestamp": "2025-03-17T14:10:00Z"
}'

run_test_scenario "Large Payload Event" "$(jq -n --arg id "flow_test_004" --argjson data "$(base64 /dev/urandom | head -c 5000)" '{match_id: $id, event_type: "extra_data_test", timestamp: "2025-03-17T14:15:00Z", data: $data}')"

run_test_scenario "Multiple Rapid Events" '{
    "match_id": "flow_test_005",
    "event_type": "goal",
    "timestamp": "2025-03-17T14:20:00Z",
    "team": "Home",
    "player": "Player 1"
}'
run_test_scenario "Multiple Rapid Events" '{
    "match_id": "flow_test_006",
    "event_type": "goal",
    "timestamp": "2025-03-17T14:21:00Z",
    "team": "Away",
    "player": "Player 2"
}'
run_test_scenario "Multiple Rapid Events" '{
    "match_id": "flow_test_007",
    "event_type": "goal",
    "timestamp": "2025-03-17T14:22:00Z",
    "team": "Home",
    "player": "Player 3"
}'

log_info "All tests completed!"
