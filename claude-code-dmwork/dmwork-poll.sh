#!/bin/bash
# DMWork Bot REST API Poller
# Usage: ./dmwork-poll.sh <server_url> <bot_token>
#
# This script polls DMWork for new messages and prints them to stdout.
# Designed for use with Claude Code or similar AI agents that read stdout.

set -euo pipefail

SERVER_URL="${1:?Usage: $0 <server_url> <bot_token>}"
BOT_TOKEN="${2:?Usage: $0 <server_url> <bot_token>}"

AUTH_HEADER="Authorization: Bearer ${BOT_TOKEN}"
CONTENT_TYPE="Content-Type: application/json"
LAST_EVENT_ID=0
HEARTBEAT_INTERVAL=30
POLL_INTERVAL=2

# Register bot
echo "[INFO] Registering bot..."
REGISTER_RESP=$(curl -s -X POST "${SERVER_URL}/v1/bot/register" \
  -H "${AUTH_HEADER}" -H "${CONTENT_TYPE}" \
  -d '{"name": "Claude Code Agent"}')

ROBOT_ID=$(echo "${REGISTER_RESP}" | jq -r '.robot_id // empty')
OWNER_UID=$(echo "${REGISTER_RESP}" | jq -r '.owner_uid // empty')

if [ -z "${ROBOT_ID}" ]; then
  echo "[ERROR] Registration failed: ${REGISTER_RESP}" >&2
  exit 1
fi

echo "[INFO] Registered as: ${ROBOT_ID}"
echo "[INFO] Owner: ${OWNER_UID}"

# Send greeting
curl -s -X POST "${SERVER_URL}/v1/bot/sendMessage" \
  -H "${AUTH_HEADER}" -H "${CONTENT_TYPE}" \
  -d "{\"channel_id\": \"${OWNER_UID}\", \"channel_type\": 1, \"payload\": {\"type\": 1, \"content\": \"Hello! I am online and ready.\"}}" > /dev/null

echo "[INFO] Greeting sent. Starting poll loop..."

LAST_HEARTBEAT=0

while true; do
  NOW=$(date +%s)

  # Heartbeat
  if (( NOW - LAST_HEARTBEAT >= HEARTBEAT_INTERVAL )); then
    curl -s -X POST "${SERVER_URL}/v1/bot/heartbeat" \
      -H "${AUTH_HEADER}" > /dev/null 2>&1 || true
    LAST_HEARTBEAT=${NOW}
  fi

  # Poll events
  EVENTS_RESP=$(curl -s -X POST "${SERVER_URL}/v1/bot/events" \
    -H "${AUTH_HEADER}" -H "${CONTENT_TYPE}" \
    -d "{\"event_id\": ${LAST_EVENT_ID}, \"limit\": 20}")

  STATUS=$(echo "${EVENTS_RESP}" | jq -r '.status // 0')
  if [ "${STATUS}" != "1" ]; then
    sleep "${POLL_INTERVAL}"
    continue
  fi

  # Process events
  RESULTS=$(echo "${EVENTS_RESP}" | jq -c '.results[]? // empty')
  while IFS= read -r event; do
    [ -z "${event}" ] && continue

    EVENT_ID=$(echo "${event}" | jq -r '.event_id')
    FROM_UID=$(echo "${event}" | jq -r '.message.from_uid // empty')
    CONTENT=$(echo "${event}" | jq -r '.message.payload.content // empty')
    CHANNEL_ID=$(echo "${event}" | jq -r '.message.channel_id // empty')
    CHANNEL_TYPE=$(echo "${event}" | jq -r '.message.channel_type // 1')

    if [ -n "${FROM_UID}" ] && [ "${FROM_UID}" != "${ROBOT_ID}" ]; then
      # Output message in a parseable format
      echo "[MESSAGE] event_id=${EVENT_ID} from=${FROM_UID} channel=${CHANNEL_ID} type=${CHANNEL_TYPE} content=${CONTENT}"
    fi

    # Update last event ID
    if [ "${EVENT_ID}" -gt "${LAST_EVENT_ID}" ] 2>/dev/null; then
      LAST_EVENT_ID=${EVENT_ID}
    fi

    # Ack event
    curl -s -X POST "${SERVER_URL}/v1/bot/events/${EVENT_ID}/ack" \
      -H "${AUTH_HEADER}" > /dev/null 2>&1 || true

  done <<< "${RESULTS}"

  sleep "${POLL_INTERVAL}"
done
