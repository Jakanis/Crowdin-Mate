-- Phase 0/1 schema. Extended in later phases (tm_matches, mt_suggestions,
-- glossary_terms, comments, qa_checks, offline_queue) as those features land.

CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    source_language TEXT NOT NULL,
    target_languages_json TEXT NOT NULL DEFAULT '[]',
    last_full_sync_at TEXT
);

CREATE TABLE IF NOT EXISTS directories (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL,
    parent_id INTEGER,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    updated_at TEXT,
    synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_directories_project_parent
    ON directories (project_id, parent_id);

CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL,
    directory_id INTEGER,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    strings_count INTEGER,
    updated_at TEXT,
    synced_at TEXT NOT NULL,
    content_synced_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_project_directory
    ON files (project_id, directory_id);

-- Phase 1: source strings + translations for whichever files have been opened.
-- Field shapes below were confirmed against a live API response (see the
-- Phase 1 spike), not assumed from docs — notably: translations use
-- `translationId` as their id (not `id`), have no `updatedAt` or
-- `isApproved` field at all (approvals are a separate resource, deferred
-- to Phase 3), and source strings carry `hasPlurals`/`maxLength`, which
-- the Phase 1 UI surfaces but does not yet build a full plural-form editor
-- around.
CREATE TABLE IF NOT EXISTS source_strings (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL,
    project_id INTEGER NOT NULL,
    identifier TEXT,
    text TEXT NOT NULL,
    context TEXT,
    max_length INTEGER,
    has_plurals INTEGER NOT NULL DEFAULT 0,
    is_hidden INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT,
    synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_strings_file ON source_strings (file_id);

-- Holds ALL submitted translations per string+language, not just the top
-- one — a string commonly has several candidate translations from
-- different contributors, and the proofreading workflow needs to see them
-- all and which is approved. `is_approved`/`approval_id` are derived from
-- the separate approvals resource (list_translation_approvals): a
-- translation is approved iff an approval row points at its id, and
-- approval_id is what's needed to later un-approve it.
CREATE TABLE IF NOT EXISTS translations (
    id INTEGER PRIMARY KEY,              -- Crowdin's translationId
    string_id INTEGER NOT NULL,
    language_id TEXT NOT NULL,
    text TEXT NOT NULL,
    user_id INTEGER,
    user_name TEXT,
    rating INTEGER NOT NULL DEFAULT 0,
    is_approved INTEGER NOT NULL DEFAULT 0,
    approval_id INTEGER,
    created_at TEXT,
    synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_translations_string_lang
    ON translations (string_id, language_id);

-- String-level comments and issues. Fetched lazily per string (most
-- strings have none), cached here once seen.
CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY,
    string_id INTEGER NOT NULL,
    project_id INTEGER NOT NULL,
    language_id TEXT,
    text TEXT NOT NULL,
    user_id INTEGER,
    user_name TEXT,
    type TEXT,                           -- 'comment' | 'issue'
    issue_type TEXT,
    issue_status TEXT,
    is_resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT,
    synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_string ON comments (string_id);

CREATE TABLE IF NOT EXISTS translation_drafts (
    string_id INTEGER NOT NULL,
    language_id TEXT NOT NULL,
    draft_text TEXT NOT NULL,
    local_updated_at TEXT NOT NULL,
    dirty INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (string_id, language_id)
);

CREATE TABLE IF NOT EXISTS offline_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    string_id INTEGER,
    language_id TEXT,
    created_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT,
    last_error TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_offline_queue_status ON offline_queue (status);

CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT
);
