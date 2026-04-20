#!/usr/bin/env bash
# HypeReels Smoke Test Script
#
# Usage:
#   bash scripts/smoke-test.sh <HOST_IP> [--profile cpu|gpu]
#
# Tests (TC-056, TC-057 — STORY-025):
#   1. API /health         → HTTP 200 {"status":"ok"}
#   2. Python worker /health → HTTP 200 {"status":"ok","service":"hypereels-python-worker"}
#   3. Redis PING          → PONG
#   4. PostgreSQL SELECT 1 → success
#   5. MinIO /minio/health/live → HTTP 200
#   6. MinIO bucket 'hypereels' exists
#
# If all checks pass:   exits 0, prints "All systems operational — HypeReels is ready"
# If any check fails:   exits 1, prints which service failed and a likely cause
#
# Environment variables (override defaults):
#   API_PORT        (default: 3001)
#   WORKER_PORT     (default: 8000)
#   REDIS_HOST      (default: HOST_IP or localhost)
#   REDIS_PORT      (default: 6379)
#   REDIS_PASSWORD  (default: empty)
#   POSTGRES_HOST   (default: HOST_IP or localhost)
#   POSTGRES_PORT   (default: 5432)
#   POSTGRES_USER   (default: hypereels)
#   POSTGRES_DB     (default: hypereels)
#   MINIO_HOST      (default: HOST_IP or localhost)
#   MINIO_PORT      (default: 9000)
#   MINIO_BUCKET    (default: hypereels)

set -euo pipefail

# ── Argument parsing ──────────────────────────────────────────────────────────

HOST_IP="${1:-localhost}"
PROFILE="cpu"

shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      PROFILE="${2:-cpu}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 <HOST_IP> [--profile cpu|gpu]" >&2
      exit 1
      ;;
  esac
done

# ── Service endpoint configuration ───────────────────────────────────────────

API_PORT="${API_PORT:-3001}"
WORKER_PORT="${WORKER_PORT:-8000}"
REDIS_HOST="${REDIS_HOST:-$HOST_IP}"
REDIS_PORT="${REDIS_PORT:-6379}"
REDIS_PASSWORD="${REDIS_PASSWORD:-}"
POSTGRES_HOST="${POSTGRES_HOST:-$HOST_IP}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_USER="${POSTGRES_USER:-hypereels}"
POSTGRES_DB="${POSTGRES_DB:-hypereels}"
MINIO_HOST="${MINIO_HOST:-$HOST_IP}"
MINIO_PORT="${MINIO_PORT:-9000}"
MINIO_BUCKET="${MINIO_BUCKET:-hypereels}"

# ── Colour helpers ────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Colour

PASS=0
FAIL=0
FAILURES=()

pass() {
  echo -e "  ${GREEN}PASS${NC}  $1"
  ((PASS++))
}

fail() {
  local service="$1"
  local detail="$2"
  echo -e "  ${RED}FAIL${NC}  $service — $detail"
  ((FAIL++))
  FAILURES+=("$service: $detail")
}

# ── Check 1: API /health ──────────────────────────────────────────────────────

echo ""
echo "HypeReels Smoke Test — host: $HOST_IP, profile: $PROFILE"
echo "────────────────────────────────────────────────────────────"

printf "Checking API /health (http://%s:%s/health)..." "$HOST_IP" "$API_PORT"
API_RESPONSE=$(curl -sf --max-time 10 "http://$HOST_IP:$API_PORT/health" 2>/dev/null || echo "CURL_FAILED")
if echo "$API_RESPONSE" | grep -q '"status":"ok"' 2>/dev/null; then
  pass "API /health"
else
  fail "API /health" \
    "Expected {\"status\":\"ok\"} from http://$HOST_IP:$API_PORT/health. Got: $API_RESPONSE. Likely cause: API container not running or PORT=$API_PORT incorrect."
fi

# ── Check 2: Python worker /health ───────────────────────────────────────────

printf "Checking Python worker /health (http://%s:%s/health)..." "$HOST_IP" "$WORKER_PORT"
WORKER_RESPONSE=$(curl -sf --max-time 10 "http://$HOST_IP:$WORKER_PORT/health" 2>/dev/null || echo "CURL_FAILED")
if echo "$WORKER_RESPONSE" | grep -q '"status":"ok"' 2>/dev/null; then
  pass "Python worker /health"
else
  fail "Python worker /health" \
    "Expected {\"status\":\"ok\"} from http://$HOST_IP:$WORKER_PORT/health. Got: $WORKER_RESPONSE. Likely cause: hypereels-worker container not running or PORT=$WORKER_PORT incorrect."
fi

# ── Check 3: Redis PING ───────────────────────────────────────────────────────

printf "Checking Redis PING (%s:%s)..." "$REDIS_HOST" "$REDIS_PORT"
if command -v redis-cli &>/dev/null; then
  if [[ -n "$REDIS_PASSWORD" ]]; then
    REDIS_RESULT=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -a "$REDIS_PASSWORD" --no-auth-warning PING 2>/dev/null || echo "FAILED")
  else
    REDIS_RESULT=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" PING 2>/dev/null || echo "FAILED")
  fi
  if [[ "$REDIS_RESULT" == "PONG" ]]; then
    pass "Redis PING"
  else
    fail "Redis PING" \
      "Expected PONG from $REDIS_HOST:$REDIS_PORT. Got: $REDIS_RESULT. Likely cause: Redis container not running or authentication failed. Run: redis-cli -h $REDIS_HOST -p $REDIS_PORT PING"
  fi
else
  # Fallback: check if port is open
  if nc -z -w5 "$REDIS_HOST" "$REDIS_PORT" 2>/dev/null; then
    pass "Redis (port open — redis-cli not installed for PING test)"
  else
    fail "Redis" \
      "Port $REDIS_HOST:$REDIS_PORT is not open. Likely cause: Redis container not running. Install redis-cli for full PING test."
  fi
fi

# ── Check 4: PostgreSQL SELECT 1 ─────────────────────────────────────────────

printf "Checking PostgreSQL (%s:%s)..." "$POSTGRES_HOST" "$POSTGRES_PORT"
if command -v psql &>/dev/null; then
  PG_RESULT=$(PGPASSWORD="${POSTGRES_PASSWORD:-test}" psql \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" \
    -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "SELECT 1" -t 2>/dev/null | tr -d ' \n' || echo "FAILED")
  if [[ "$PG_RESULT" == "1" ]]; then
    pass "PostgreSQL SELECT 1"
  else
    fail "PostgreSQL SELECT 1" \
      "Could not run SELECT 1 on $POSTGRES_HOST:$POSTGRES_PORT/$POSTGRES_DB as $POSTGRES_USER. Likely cause: hypereels-postgres container not running, credentials wrong, or database not created. Run: psql -h $POSTGRES_HOST -p $POSTGRES_PORT -U $POSTGRES_USER -c 'SELECT 1'"
  fi
else
  if nc -z -w5 "$POSTGRES_HOST" "$POSTGRES_PORT" 2>/dev/null; then
    pass "PostgreSQL (port open — psql not installed for SELECT 1 test)"
  else
    fail "PostgreSQL" \
      "Port $POSTGRES_HOST:$POSTGRES_PORT is not open. Likely cause: hypereels-postgres container not running. Install psql for full SELECT 1 test."
  fi
fi

# ── Check 5: MinIO /minio/health/live ────────────────────────────────────────

printf "Checking MinIO /minio/health/live (http://%s:%s)..." "$MINIO_HOST" "$MINIO_PORT"
MINIO_HTTP=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  "http://$MINIO_HOST:$MINIO_PORT/minio/health/live" 2>/dev/null || echo "000")
if [[ "$MINIO_HTTP" == "200" ]]; then
  pass "MinIO /minio/health/live"
else
  fail "MinIO /minio/health/live" \
    "Expected HTTP 200, got $MINIO_HTTP from http://$MINIO_HOST:$MINIO_PORT/minio/health/live. Likely cause: MinIO container not running or port $MINIO_PORT incorrect."
fi

# ── Check 6: MinIO bucket 'hypereels' exists ──────────────────────────────────

printf "Checking MinIO bucket '%s' exists..." "$MINIO_BUCKET"
if command -v mc &>/dev/null; then
  # Try to use mc (MinIO Client) if installed
  MC_RESULT=$(mc ls "local/$MINIO_BUCKET" 2>/dev/null && echo "OK" || echo "MISSING")
  if [[ "$MC_RESULT" == "OK" ]]; then
    pass "MinIO bucket '$MINIO_BUCKET' exists"
  else
    fail "MinIO bucket '$MINIO_BUCKET'" \
      "Bucket '$MINIO_BUCKET' not found. Likely cause: MinIO started but bucket not created. Run: mc mb local/$MINIO_BUCKET"
  fi
else
  # Fallback: check the bucket via S3-compatible list API (unsigned request for public buckets)
  BUCKET_HTTP=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
    "http://$MINIO_HOST:$MINIO_PORT/$MINIO_BUCKET" 2>/dev/null || echo "000")
  # 403 = bucket exists but access denied (correct — bucket exists)
  # 404 = bucket does not exist
  # 200 = bucket exists and is public (should not happen for HypeReels)
  if [[ "$BUCKET_HTTP" == "403" || "$BUCKET_HTTP" == "200" ]]; then
    pass "MinIO bucket '$MINIO_BUCKET' exists (HTTP $BUCKET_HTTP)"
  elif [[ "$BUCKET_HTTP" == "404" ]]; then
    fail "MinIO bucket '$MINIO_BUCKET'" \
      "Bucket '$MINIO_BUCKET' returned HTTP 404 — bucket does not exist. Run: mc mb local/$MINIO_BUCKET  (install mc: https://min.io/docs/minio/linux/reference/minio-mc.html)"
  else
    fail "MinIO bucket '$MINIO_BUCKET'" \
      "Unexpected HTTP $BUCKET_HTTP from MinIO bucket check. Install mc for reliable bucket verification."
  fi
fi

# ── Check 7 (GPU profile only): GPU accessible in worker container ─────────────

if [[ "$PROFILE" == "gpu" ]]; then
  printf "Checking GPU accessibility in worker container (profile: gpu)..."
  GPU_RESULT=$(docker exec hypereels-worker nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo "GPU_UNAVAILABLE")
  if [[ "$GPU_RESULT" == "GPU_UNAVAILABLE" ]]; then
    # Not a hard failure for GPU profile — CPU fallback is acceptable
    echo -e "  ${YELLOW}WARN${NC}  GPU not accessible in worker (expected if no NVIDIA GPU or runtime). Confirm CPU fallback via worker logs."
  else
    pass "GPU accessible in worker: $GPU_RESULT"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "────────────────────────────────────────────────────────────"
echo "Results: $PASS passed, $FAIL failed"

if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}All systems operational — HypeReels is ready${NC}"
  exit 0
else
  echo -e "${RED}Smoke test FAILED — $FAIL check(s) failed:${NC}"
  for f in "${FAILURES[@]}"; do
    echo "  - $f"
  done
  echo ""
  echo "Fix the issues above and re-run: bash scripts/smoke-test.sh $HOST_IP"
  exit 1
fi
