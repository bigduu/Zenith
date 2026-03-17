# Test Coverage Report - 2026-03-17 (Latest Update)

## Current Coverage Status

### Lotus (Frontend)
**Coverage Metrics:**
- **Statements**: 74.51% (need +15.49% to reach 90%)
- **Branch**: 63.38% ⚠️ **(need +26.62% to reach 90%) - BIGGEST GAP**
- **Functions**: 77.15% (need +12.85% to reach 90%)
- **Lines**: 75.76% (need +14.24% to reach 90%)

**Tests**: 1,852+ passing ✅
**Note**: Some ChatView tests failing due to mock issues

### Bamboo (Backend)
**Coverage Metrics:**
- **Regions**: 72.56% (need +17.44% to reach 90%)
- **Functions**: 72.79% (need +17.21% to reach 90%)
- **Lines**: 72.39% (need +17.61% to reach 90%)

**Tests**: 1,420 passing ✅ (6 new tests added this session)

---

## Latest Test Additions (This Session)

### 1. SystemSettingsKeywordMaskingTab Tests ✅
**File**: `lotus/src/pages/SettingsPage/components/SystemSettingsPage/__tests__/SystemSettingsKeywordMaskingTab.test.tsx`

**Coverage Improvement**:
- Statements: 52.38% → **97.14%** (+44.76 pts)
- Branch: 21.05% → **78.94%** (+57.89 pts)
- Functions: 39.13% → **100%** (+60.87 pts)
- Lines: 54.45% → **99%** (+44.55 pts)

**Tests**: 20 comprehensive tests

### 2. ChatPage Store Extended Tests ✅
**File**: `lotus/src/pages/ChatPage/store/__tests__/index-extended.test.ts`

**Tests**: 31 comprehensive tests
- AgentAvailabilitySlice extended (6 tests)
- SessionIndexSyncSlice (5 tests)
- Proxy Auth initialization (3 tests)
- Bootstrap Proxy Auth Gate (5 tests)
- Chat Lookup Cache (3 tests)
- Selectors edge cases (4 tests)
- Store state management (2 tests)
- Edge cases handling (3 tests)

### 3. Bamboo Health Handler Tests ✅
**File**: `bamboo/src/server/handlers/agent/health.rs`

**Tests**: 5 comprehensive tests
- `test_health_handler_returns_ok`
- `test_health_handler_responds_to_request`
- `test_health_handler_returns_200_status`
- `test_health_handler_content_type`
- `test_health_handler_multiple_requests`

### 4. Bamboo Keyword Masking Validate Handler Tests ✅
**File**: `bamboo/src/server/handlers/settings/keyword_masking/handlers/validate.rs`

**Tests**: 6 comprehensive tests
- `test_validate_empty_entries`
- `test_validate_valid_entries`
- `test_validate_invalid_regex_pattern`
- `test_validate_multiple_entries_with_mixed_validity`
- `test_validate_valid_regex_pattern`
- `test_validate_disabled_entry`

---

## Priority Files for Testing

### Lotus - Lowest Branch Coverage (< 35%)

| File | Branch Coverage | Priority |
|------|----------------|----------|
| `ChatView/index.tsx` | 27.9% | 🔴 P0 |
| `ChatPage/store/index.ts` | 29.26% | 🔴 P0 |
| `ProviderSettings/index.tsx` | 31.28% | 🟡 P1 |

### Bamboo - 0% Coverage (67 files)

**Top Priority Files**:
1. `server/handlers/openai/chat/non_stream.rs`
2. `server/handlers/openai/chat/prepare.rs`
3. `server/handlers/openai/chat/stream/worker.rs`
4. `server/handlers/openai/config.rs`
5. `server/handlers/settings/keyword_masking/handlers/update.rs`
6. `server/handlers/settings/provider/endpoints/reload.rs`
7. `server/metrics.rs`
8. `server/logging.rs`

---

## Session Statistics

**Total Tests Added**: 62 new tests
- Lotus: 51 tests (20 + 31)
- Bamboo: 11 tests (5 + 6)

**Total Test Count**:
- Lotus: 1,852+ tests
- Bamboo: 1,420 tests
- **Combined**: 3,272+ passing tests ✅

---

## Next Actions

### Immediate (Next 1-2 hours)
1. **Fix ChatView tests** - Mock configuration issues causing 20 test failures
2. **Add ChatPage Store async tests** - Target +10% branch coverage
3. **Add ProviderSettings tests** - Target +15% branch coverage

### Short-term (Next 4-8 hours)
4. **Add Bamboo handler tests** - OpenAI chat handlers, settings handlers
5. **Add component tests** - ModalFooter, PromptSelector

### Goal
Reach **90%+ coverage** for all metrics:
- Lotus: Need +15-26 percentage points
- Bamboo: Need +17 percentage points

---

**Report Generated**: 2026-03-17 14:00
**Status**: In Progress - Coverage improvement ongoing
