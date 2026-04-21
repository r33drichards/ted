-- Bootstrap databases used by the stack. Runs once, on first container start.
-- Keycloak uses H2 in dev mode, so it doesn't need a DB here.

CREATE DATABASE chat;
CREATE DATABASE temporal;
CREATE DATABASE temporal_visibility;
