-- Per-query timing for slow-query diagnosis. Needs the library preloaded
-- (shared_preload_libraries, set in infra/docker-compose.yml) to collect.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
