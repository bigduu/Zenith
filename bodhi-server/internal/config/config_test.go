package config

import (
	"os"
	"strings"
	"testing"
	"time"
)

const (
	testJWTSecret     = "test-secret-that-is-long-enough-for-testing-purposes"
	testEncryptionKey = "1234567890123456789012345678901234567890123456789012345678901234"
)

// unsetBodhiEnvVars clears all BODHI_* environment variables before a test.
func unsetBodhiEnvVars(t *testing.T) {
	t.Helper()
	keys := []string{
		"BODHI_PORT", "BODHI_BIND", "BODHI_PROXY_TIMEOUT", "BODHI_MAX_BODY_MB",
		"BODHI_CORS_ORIGINS", "BODHI_VERSION", "BODHI_DB_URL",
		"BODHI_JWT_SECRET", "BODHI_ENCRYPTION_KEY",
		"BODHI_RATE_LIMIT_RPM", "BODHI_RATE_LIMIT_BURST",
	}
	for _, k := range keys {
		os.Unsetenv(k)
	}
}

func TestLoad_DefaultValues(t *testing.T) {
	unsetBodhiEnvVars(t)
	t.Setenv("BODHI_JWT_SECRET", testJWTSecret)
	t.Setenv("BODHI_ENCRYPTION_KEY", testEncryptionKey)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if cfg.Server.Port != 8080 {
		t.Errorf("Port: expected 8080, got %d", cfg.Server.Port)
	}
	if cfg.Server.Bind != "0.0.0.0" {
		t.Errorf("Bind: expected '0.0.0.0', got %q", cfg.Server.Bind)
	}
	if cfg.Server.ProxyTimeout != 300*time.Second {
		t.Errorf("ProxyTimeout: expected 5m0s, got %v", cfg.Server.ProxyTimeout)
	}
	if cfg.Server.MaxBodyBytes != 50*1024*1024 {
		t.Errorf("MaxBodyBytes: expected %d, got %d", 50*1024*1024, cfg.Server.MaxBodyBytes)
	}
	if cfg.Server.CORSOrigins != nil {
		t.Errorf("CORSOrigins: expected nil, got %v", cfg.Server.CORSOrigins)
	}
	if cfg.Server.Version != "dev" {
		t.Errorf("Version: expected 'dev', got %q", cfg.Server.Version)
	}
	if cfg.Database.URL != "postgres://bodhi:bodhi@localhost:5432/bodhi?sslmode=disable" {
		t.Errorf("DB URL: unexpected value %q", cfg.Database.URL)
	}
	if cfg.Auth.JWTSecret != testJWTSecret {
		t.Errorf("JWTSecret: expected test value, got %q", cfg.Auth.JWTSecret)
	}
	if cfg.Auth.AccessTokenTTL != 15*time.Minute {
		t.Errorf("AccessTokenTTL: expected 15m, got %v", cfg.Auth.AccessTokenTTL)
	}
	if cfg.Auth.RefreshTokenTTL != 7*24*time.Hour {
		t.Errorf("RefreshTokenTTL: expected 168h, got %v", cfg.Auth.RefreshTokenTTL)
	}
	if cfg.RateLimit.RPM != 60 {
		t.Errorf("RateLimit.RPM: expected 60, got %d", cfg.RateLimit.RPM)
	}
	if cfg.RateLimit.Burst != 10 {
		t.Errorf("RateLimit.Burst: expected 10, got %d", cfg.RateLimit.Burst)
	}
}

func TestLoad_CustomValues(t *testing.T) {
	unsetBodhiEnvVars(t)
	t.Setenv("BODHI_PORT", "9090")
	t.Setenv("BODHI_BIND", "127.0.0.1")
	t.Setenv("BODHI_PROXY_TIMEOUT", "600")
	t.Setenv("BODHI_MAX_BODY_MB", "100")
	t.Setenv("BODHI_CORS_ORIGINS", "https://example.com, https://app.test")
	t.Setenv("BODHI_VERSION", "v1.2.3")
	t.Setenv("BODHI_DB_URL", "postgres://user:pass@db:5432/test")
	t.Setenv("BODHI_JWT_SECRET", testJWTSecret)
	t.Setenv("BODHI_ENCRYPTION_KEY", testEncryptionKey)
	t.Setenv("BODHI_RATE_LIMIT_RPM", "120")
	t.Setenv("BODHI_RATE_LIMIT_BURST", "20")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if cfg.Server.Port != 9090 {
		t.Errorf("Port: expected 9090, got %d", cfg.Server.Port)
	}
	if cfg.Server.Bind != "127.0.0.1" {
		t.Errorf("Bind: expected '127.0.0.1', got %q", cfg.Server.Bind)
	}
	if cfg.Server.ProxyTimeout != 600*time.Second {
		t.Errorf("ProxyTimeout: expected 10m0s, got %v", cfg.Server.ProxyTimeout)
	}
	if cfg.Server.MaxBodyBytes != 100*1024*1024 {
		t.Errorf("MaxBodyBytes: expected %d, got %d", 100*1024*1024, cfg.Server.MaxBodyBytes)
	}
	if len(cfg.Server.CORSOrigins) != 2 {
		t.Fatalf("CORSOrigins: expected 2 entries, got %d", len(cfg.Server.CORSOrigins))
	}
	if cfg.Server.CORSOrigins[0] != "https://example.com" {
		t.Errorf("CORSOrigins[0]: expected 'https://example.com', got %q", cfg.Server.CORSOrigins[0])
	}
	if cfg.Server.CORSOrigins[1] != "https://app.test" {
		t.Errorf("CORSOrigins[1]: expected 'https://app.test', got %q", cfg.Server.CORSOrigins[1])
	}
	if cfg.Server.Version != "v1.2.3" {
		t.Errorf("Version: expected 'v1.2.3', got %q", cfg.Server.Version)
	}
	if cfg.Database.URL != "postgres://user:pass@db:5432/test" {
		t.Errorf("DB URL: unexpected value %q", cfg.Database.URL)
	}
	if cfg.RateLimit.RPM != 120 {
		t.Errorf("RateLimit.RPM: expected 120, got %d", cfg.RateLimit.RPM)
	}
	if cfg.RateLimit.Burst != 20 {
		t.Errorf("RateLimit.Burst: expected 20, got %d", cfg.RateLimit.Burst)
	}
}

func TestLoad_ValidationErrors(t *testing.T) {
	tests := []struct {
		name        string
		setup       func()
		wantErr     bool
		errContains string
	}{
		{
			name: "missing JWT secret",
			setup: func() {
				unsetBodhiEnvVars(t)
				t.Setenv("BODHI_ENCRYPTION_KEY", testEncryptionKey)
			},
			wantErr:     true,
			errContains: "BODHI_JWT_SECRET is required",
		},
		{
			name: "missing encryption key",
			setup: func() {
				unsetBodhiEnvVars(t)
				t.Setenv("BODHI_JWT_SECRET", testJWTSecret)
			},
			wantErr:     true,
			errContains: "BODHI_ENCRYPTION_KEY is required",
		},
		{
			name: "wrong encryption key length",
			setup: func() {
				unsetBodhiEnvVars(t)
				t.Setenv("BODHI_JWT_SECRET", testJWTSecret)
				t.Setenv("BODHI_ENCRYPTION_KEY", "short-key")
			},
			wantErr:     true,
			errContains: "must be 64 hex characters",
		},
		{
			name: "valid config with all required fields",
			setup: func() {
				unsetBodhiEnvVars(t)
				t.Setenv("BODHI_JWT_SECRET", testJWTSecret)
				t.Setenv("BODHI_ENCRYPTION_KEY", testEncryptionKey)
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.setup != nil {
				tt.setup()
			}
			cfg, err := Load()
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil", tt.errContains)
				}
				if tt.errContains != "" {
					if !strings.Contains(err.Error(), tt.errContains) {
						t.Errorf("error %q does not contain %q", err.Error(), tt.errContains)
					}
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if cfg == nil {
				t.Fatal("expected non-nil config, got nil")
			}
		})
	}
}

func TestGetEnv(t *testing.T) {
	key := "BODHI_TEST_GETENV"
	os.Unsetenv(key)
	defer os.Unsetenv(key)

	if got := getEnv(key, "fallback"); got != "fallback" {
		t.Errorf("getEnv(empty): expected 'fallback', got %q", got)
	}

	t.Setenv(key, "value")
	if got := getEnv(key, "fallback"); got != "value" {
		t.Errorf("getEnv(set): expected 'value', got %q", got)
	}
}

func TestGetEnvInt(t *testing.T) {
	key := "BODHI_TEST_GETENVINT"
	os.Unsetenv(key)
	defer os.Unsetenv(key)

	if got := getEnvInt(key, 42); got != 42 {
		t.Errorf("getEnvInt(empty): expected 42, got %d", got)
	}

	t.Setenv(key, "99")
	if got := getEnvInt(key, 42); got != 99 {
		t.Errorf("getEnvInt(set): expected 99, got %d", got)
	}

	t.Setenv(key, "not-a-number")
	if got := getEnvInt(key, 42); got != 42 {
		t.Errorf("getEnvInt(invalid): expected fallback 42, got %d", got)
	}
}

func TestParseCSV(t *testing.T) {
	tests := []struct {
		input    string
		expected []string
	}{
		{"", nil},
		{"a", []string{"a"}},
		{"a,b,c", []string{"a", "b", "c"}},
		{" a , b , c ", []string{"a", "b", "c"}},
		{",,,", nil},
		{"a,,b", []string{"a", "b"}},
		{"  a  ,  b  ", []string{"a", "b"}},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := parseCSV(tt.input)
			if len(got) != len(tt.expected) {
				t.Fatalf("parseCSV(%q): expected %v, got %v", tt.input, tt.expected, got)
			}
			for i := range got {
				if got[i] != tt.expected[i] {
					t.Errorf("parseCSV(%q)[%d]: expected %q, got %q", tt.input, i, tt.expected[i], got[i])
				}
			}
		})
	}
}
