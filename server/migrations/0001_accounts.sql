CREATE TABLE users (
    id            uuid PRIMARY KEY,
    email         text NOT NULL,
    name          text NOT NULL,
    password_hash text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

-- One row per signed-in device. Only hashes of refresh tokens are stored.
CREATE TABLE sessions (
    id           uuid PRIMARY KEY,
    user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    device_name  text NOT NULL,
    refresh_hash bytea NOT NULL UNIQUE,
    -- The token this one replaced: seeing it again means it was stolen.
    prev_hash    bytea,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz NOT NULL DEFAULT now(),
    revoked_at   timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_prev_hash_idx ON sessions (prev_hash);

CREATE TABLE workspaces (
    id         uuid PRIMARY KEY,
    name       text NOT NULL,
    kind       text NOT NULL CHECK (kind IN ('personal', 'team')),
    owner_id   uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);

CREATE TABLE workspace_members (
    workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    role         text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
    PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members (user_id);
