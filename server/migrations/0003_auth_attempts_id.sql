-- Lets a request remove exactly its own attempt row (reserved before checking the limit).
ALTER TABLE auth_attempts ADD COLUMN id bigserial PRIMARY KEY;
