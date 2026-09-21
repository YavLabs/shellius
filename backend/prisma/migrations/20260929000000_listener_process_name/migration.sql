-- The listening process name the collector has always sent and ingest
-- dropped: the only name a hand-started process has.
ALTER TABLE "host_listeners" ADD COLUMN "process_name" TEXT;
