-- Failed logins and sign-ups, for rate limiting. Rows older than a day are pruned on insert.
CREATE TABLE auth_attempts (
    kind         text NOT NULL CHECK (kind IN ('login_failed', 'register')),
    email        text NOT NULL,
    ip           text NOT NULL,
    attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_attempts_email_idx ON auth_attempts (kind, email, attempted_at);
CREATE INDEX auth_attempts_ip_idx ON auth_attempts (kind, ip, attempted_at);
