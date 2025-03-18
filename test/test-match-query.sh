#!/bin/bash

# Color codes for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
API_URL="http://localhost:4566/restapis/wch2w4vqwu/local/_user_request_"
MAX_RETRIES=3
RETRY_WAIT=2

# Logging functions
log_success() { echo -e "${GREEN}✅ SUCCESS:${NC} $1"; }
log_error() { echo -e "${RED}❌ ERROR:${NC} $1"; }
log_info() { echo -e "${YELLOW}ℹ️ INFO:${NC} $1"; }
log_step() { echo -e "\n${BLUE}🔄 STEP ${1}:${NC} ${2}"; }

# Test goals query API
test_goals_api() {
    local match_id="$1"
    
    log_step "1" "Testing Goals API for match_id: $match_id"
    
    # Make API call to the goals endpoint
    local response=$(curl -s -X GET "${API_URL}/matches/${match_id}/goals")
    
    # Check if the response is valid JSON
    if ! echo "$response" | jq . >/dev/null 2>&1; then
        log_error "Invalid JSON response: $response"
        return 1
    fi
    
    # Check for goals in the response
    local goals_count=$(echo "$response" | jq '.goals | length')
    
    if [ "$goals_count" == "null" ]; then
        log_error "Response doesn't contain goals array: $response"
        return 1
    fi
    
    log_success "Retrieved $goals_count goals for match $match_id"
    
    # Print goals data
    echo "$response" | jq '.goals[] | {player: .player, team: .team, minute: .minute, timestamp: .timestamp}'
    
    return 0
}

# Test passes query API
test_passes_api() {
    local match_id="$1"
    local options="$2"  # Optional query parameters
    
    log_step "1" "Testing Passes API for match_id: $match_id"
    
    local url="${API_URL}/matches/${match_id}/passes"
    
    # Add query parameters if provided
    if [ -n "$options" ]; then
        url="${url}?${options}"
    fi
    
    # Make API call to the passes endpoint
    local response=$(curl -s -X GET "$url")
    
    # Check if the response is valid JSON
    if ! echo "$response" | jq . >/dev/null 2>&1; then
        log_error "Invalid JSON response: $response"
        return 1
    fi
    
    # Check for passes in the response
    local passes_count=$(echo "$response" | jq '.passes | length')
    
    if [ "$passes_count" == "null" ]; then
        log_error "Response doesn't contain passes array: $response"
        return 1
    fi
    
    log_success "Retrieved $passes_count passes for match $match_id"
    
    # Print passes data
    echo "$response" | jq '.passes[] | {from_player: .from_player, to_player: .to_player, team: .team, minute: .minute, success: .success}'
    
    return 0
}

# First, let's insert some test data
insert_test_data() {
    local match_id="$1"
    
    log_step "1" "Inserting test goal events"
    
    # Insert a goal event
    curl -s -X POST "${API_URL}/events" \
        -H "Content-Type: application/json" \
        -d '{"match_id":"'$match_id'","event_type":"goal","timestamp":"2025-03-18T15:30:00Z","team":"Home","player":"John Doe","minute":15,"second":20,"score":{"home":1,"away":0}}' \
        > /dev/null
    
    curl -s -X POST "${API_URL}/events" \
        -H "Content-Type: application/json" \
        -d '{"match_id":"'$match_id'","event_type":"goal","timestamp":"2025-03-18T16:05:00Z","team":"Away","player":"Jane Smith","minute":50,"second":12,"score":{"home":1,"away":1}}' \
        > /dev/null
    
    log_step "2" "Inserting test pass events"
    
    # Insert pass events
    curl -s -X POST "${API_URL}/events" \
        -H "Content-Type: application/json" \
        -d '{"match_id":"'$match_id'","event_type":"pass","timestamp":"2025-03-18T15:10:00Z","team":"Home","from_player":"John Doe","to_player":"Mark Johnson","minute":10,"second":5,"success":true}' \
        > /dev/null
    
    curl -s -X POST "${API_URL}/events" \
        -H "Content-Type: application/json" \
        -d '{"match_id":"'$match_id'","event_type":"pass","timestamp":"2025-03-18T15:12:00Z","team":"Away","from_player":"Jane Smith","to_player":"Bob Williams","minute":12,"second":30,"success":false}' \
        > /dev/null
    
    # Wait for events to be processed
    log_info "Waiting for events to be processed..."
    sleep 5
    
    log_success "Test data inserted for match_id: $match_id"
}

# Run the tests
run_api_tests() {
    # Generate a unique test match ID
    local test_match_id="test_match_$(date +%s)"
    
    log_info "Starting API tests with match_id: $test_match_id"
    
    # Insert test data
    insert_test_data "$test_match_id"
    
    # Run goals API test
    test_goals_api "$test_match_id"
    goals_result=$?
    
    # Run passes API test
    test_passes_api "$test_match_id"
    passes_result=$?
    
    # Run passes API test with filter
    log_info "Testing passes API with team filter"
    test_passes_api "$test_match_id" "team=Home"
    passes_filter_result=$?
    
    # Show final results
    echo -e "\n${BLUE}===== TEST RESULTS =====${NC}"
    
    if [ $goals_result -eq 0 ]; then
        log_success "Goals API Test: PASSED"
    else
        log_error "Goals API Test: FAILED"
    fi
    
    if [ $passes_result -eq 0 ]; then
        log_success "Passes API Test: PASSED"
    else
        log_error "Passes API Test: FAILED"
    fi
    
    if [ $passes_filter_result -eq 0 ]; then
        log_success "Passes API Test with Filter: PASSED"
    else
        log_error "Passes API Test with Filter: FAILED"
    fi
    
    if [ $goals_result -eq 0 ] && [ $passes_result -eq 0 ] && [ $passes_filter_result -eq 0 ]; then
        log_success "All API tests passed!"
        return 0
    else
        log_error "Some API tests failed"
        return 1
    fi
}

# Execute tests
run_api_tests
exit $?