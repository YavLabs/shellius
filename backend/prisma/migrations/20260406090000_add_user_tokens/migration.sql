CREATE TABLE "user_tokens" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_tokens_token_hash_key" UNIQUE ("token_hash"),
  CONSTRAINT "user_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "user_tokens_user_id_idx" ON "user_tokens"("user_id");
CREATE INDEX "user_tokens_expires_at_idx" ON "user_tokens"("expires_at");
