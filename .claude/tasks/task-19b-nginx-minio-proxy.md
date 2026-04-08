# Task 19b — nginx MinIO proxy (console + S3 API)

**Phase:** 19
**Plan:** `.claude/plans/phase-19-minio-recordings.md`
**Agent:** devops

## Scope
Add MinIO console and S3 API proxy blocks to `docker/nginx-proxy.conf`, mirroring `/home/yavadmin/vaulthive/docker/nginx.conf:65-82` and `nginx.dev.conf:69-94`.

## Steps
1. Console redirect + proxy:
   ```nginx
   location = /minio { return 301 $scheme://$http_host/minio/; }
   location /minio/ {
     proxy_pass http://minio:9001/;
     proxy_set_header Host $http_host;
     proxy_set_header X-Real-IP $remote_addr;
     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
     proxy_set_header X-Forwarded-Proto $scheme;
     proxy_http_version 1.1;
     proxy_set_header Upgrade $http_upgrade;
     proxy_set_header Connection "upgrade";
   }
   ```
2. S3 API proxy (for presigned playback URLs):
   ```nginx
   location /s3/ {
     rewrite ^/s3(/.*) $1 break;
     proxy_pass http://minio:9000;
     proxy_set_header Host $host;
     proxy_http_version 1.1;
     proxy_set_header Connection "";
     client_max_body_size 100m;
   }
   ```
3. Bump `client_max_body_size` on the main server block to 100m.

## Verification
- `curl -sI -H 'Host: shellius.yavlabs.com' http://127.0.0.1/minio/` → 200 (console HTML) or 301→200.
- Console loads in browser at `https://shellius.yavlabs.com/minio/`, login with `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`.
- WebSocket for live console works (no 1006 close).
