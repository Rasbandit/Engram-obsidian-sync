## Engram Backend — Quick Reference

Backend repo: `/home/open-claw/documents/code-projects/engram/`. Python 3.12, FastAPI.

### All Endpoints

All endpoints require `Authorization: Bearer <api_key>` unless noted. All data scoped by user.

**Notes:** `POST /notes` (upsert), `GET /notes/{path}` (read), `DELETE /notes/{path}` (soft-delete), `GET /notes/changes?since=` (sync), `POST /notes/rename` ({old_path, new_path}), `POST /notes/append` ({path, text})

**Search:** `POST /search` ({query, limit?, tags?} — rate limited), `GET /tags` (tag counts), `GET /folders` (folder tree), `GET /folders/list?folder=` (notes in folder), `POST /folders/search` ({query, limit} — folder suggestions), `POST /folders/reindex` (rebuild folder vectors), `POST /folders/rename` (rename folder + notes)

**Attachments:** `POST /attachments` (upsert base64), `GET /attachments/{path}` (read base64), `DELETE /attachments/{path}` (soft-delete), `GET /attachments/changes?since=` (sync)

**Live Sync:** `GET /notes/stream` (SSE — `event: connected` then `event: note_change`)

**Auth:** `POST /register`, `POST /login` (→ JWT), `GET /logout`, `POST /api-keys` (create `engram_` + 32 chars), `GET /api-keys` (list), `DELETE /api-keys/{id}` (revoke)

**System:** `GET /health` (no auth), `GET /health/deep` (checks PG, Qdrant, Ollama, Redis), `GET /user/storage` (used/max bytes), `GET /rate-limit` ({requests_per_minute}, 0=unlimited)

**MCP:** `POST /mcp` (SSE transport, Bearer auth via MCPAuthMiddleware)

**Web UI:** `GET /login`, `GET /register`, `GET /search`, `GET /search/results?query=&tags=`

### Search Pipeline

```
Query → embed(query) via Ollama (nomic-embed-text, 768d)
  → Qdrant query_points (4x limit candidates, cosine similarity, filtered by user_id + tags)
  → Jina /rerank (optional — graceful fallback to vector-only if Jina unavailable)
  → Blend: 0.4 * vector_score + 0.6 * rerank_score
  → Sort, return top N
```

SearchResult: `{text, title, heading_path, source_path, tags[], wikilinks[], score, vector_score, rerank_score}`

### Indexing Pipeline

```
POST /notes → note_store.upsert_note() (PostgreSQL)
  → parse_markdown_content() (heading-aware chunking, max 512 tokens, 50 overlap)
  → embed each chunk (Ollama)
  → qdrant_store.upsert_chunks() (obsidian_notes collection)
  → event_bus.publish() (PostgreSQL NOTIFY → SSE fan-out)
  → folder_index rebuild (if folder set changed)
```

### Auth System

- API keys: `engram_` + `secrets.token_urlsafe(32)`, stored as SHA256 hash in `api_keys` table
- Validation path: Redis cache (5-min TTL) → DB fallback → local dict cache
- Session auth (web UI): JWT in `engram_session` cookie (HS256, 7-day expiry)
- All data scoped by `user_id` in WHERE clauses (multi-tenant)
- MCP auth: MCPAuthMiddleware validates Bearer, sets `_current_user_id` contextvar

### MCP Tools (8 tools at /mcp)

`search_notes`, `get_note`, `list_tags`, `list_folders`, `list_folder`, `suggest_folder`, `delete_note`, `rename_note`

### Configuration (Key Env Vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `DATABASE_URL` | — | PostgreSQL connection |
| `QDRANT_URL` | `http://localhost:6333` | Vector store |
| `OLLAMA_URL` | `http://localhost:11434` | Embeddings |
| `JINA_URL` | `http://localhost:8082` | Reranker (optional) |
| `REDIS_URL` | (empty=in-memory) | Cache/queue |
| `JWT_SECRET` | — | Auth signing |
| `EMBED_MODEL` | `nomic-embed-text` | Embedding model |
| `EMBED_DIMS` | `768` | Vector dimensions |
| `RATE_LIMIT_RPM` | `120` | Requests/min per user |
| `ASYNC_INDEXING` | `false` | Background indexing |

### Key Source Files

| File | Purpose |
|------|---------|
| `api/main.py` | FastAPI app, all endpoints, lifespan |
| `api/note_store.py` | Note CRUD, folder ops |
| `api/search.py` | Two-stage search (Qdrant + Jina) |
| `api/indexing.py` | Parse → embed → upsert |
| `api/mcp_tools.py` | MCP tool definitions |
| `api/parsers/markdown.py` | Heading-aware chunking |
| `api/db.py` | Auth DB, API key validation |
| `api/events.py` | PostgreSQL LISTEN/NOTIFY EventBus |
| `api/stores/qdrant_store.py` | Qdrant vector CRUD |
| `api/routes/stream.py` | SSE endpoint |

### Notable Patterns

- **Soft deletes** — `deleted_at` timestamp, never hard-delete
- **4x oversampling** — Qdrant fetches 4x limit, then reranks to limit
- **Graceful Jina fallback** — search works without reranker (vector scores only)
- **LISTEN/NOTIFY** — PostgreSQL native pub/sub for SSE fan-out across workers
- **Throttled last_used** — API key `last_used` updates only every 60 seconds
