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
    label_ids_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT,
    synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_strings_file ON source_strings (file_id);

-- Project-wide label definitions (Crowdin: Strings > Labels) — small,
-- rarely changes, synced wholesale alongside the tree crawl rather than
-- per-file. label_ids_json above is the only per-string cost, and it's
-- already present in the same list_strings response file_content_sync
-- fetches anyway, so this is free beyond the once-per-sync labels call.
CREATE TABLE IF NOT EXISTS labels (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    synced_at TEXT NOT NULL
);

-- Whole-glossary wholesale sync (glossary_sync.py) — explicit, user-
-- triggered (a ~30k-row fetch takes tens of seconds), unlike
-- glossary_matches above which stays a live per-string lookup since it
-- needs Crowdin's own relevance ranking. This table exists purely so
-- glossary SEARCH (browsing/looking up any term, not "what's in this
-- string") can run fully offline against the local cache. One row per
-- term per language; a source+target pair share the same concept_id.
CREATE TABLE IF NOT EXISTS glossary_terms (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL,
    glossary_id INTEGER NOT NULL,
    concept_id INTEGER NOT NULL,
    language_id TEXT NOT NULL,
    text TEXT NOT NULL,
    description TEXT,
    synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_glossary_terms_project_concept ON glossary_terms (project_id, concept_id);
CREATE INDEX IF NOT EXISTS idx_glossary_terms_project_text ON glossary_terms (project_id, text);

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

-- TM/glossary suggestions, fetched lazily per string (first lookup is as
-- slow as Crowdin's own editor since it's the same live concordance-
-- search call; cached so any revisit is instant). Both are fully
-- replaced (delete-then-insert) per string on each fetch rather than
-- upserted by a stable id — Crowdin's concordance search doesn't return
-- a per-string-scoped stable identity worth tracking across refreshes,
-- and re-querying is cheap at this per-string scale.
CREATE TABLE IF NOT EXISTS tm_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    string_id INTEGER NOT NULL,
    language_id TEXT NOT NULL,
    source_text TEXT NOT NULL,
    target_text TEXT NOT NULL,
    relevant INTEGER NOT NULL,
    tm_name TEXT,
    updated_at TEXT,
    cached_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tm_matches_string_lang ON tm_matches (string_id, language_id);

-- Lets a TM match be traced back to a real translation elsewhere in the
-- project (same target text) for "who/when + jump to it" — see
-- get_tm_matches in main.py.
CREATE INDEX IF NOT EXISTS idx_translations_text_lang ON translations (text, language_id);

CREATE TABLE IF NOT EXISTS glossary_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    string_id INTEGER NOT NULL,
    language_id TEXT NOT NULL,
    source_term TEXT NOT NULL,
    target_term TEXT NOT NULL,
    description TEXT,
    glossary_name TEXT,
    cached_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_glossary_matches_string_lang ON glossary_matches (string_id, language_id);

-- Row count alone can't tell "never looked up" apart from "looked up,
-- found zero matches" — and a string with no TM/glossary hits is the
-- common case for unique prose in this project. Without this, an empty
-- result would re-run the expensive concordance search on every single
-- open. One row per (string_id, language_id, kind) marks that a lookup
-- has actually happened, regardless of how many matches it found.
CREATE TABLE IF NOT EXISTS suggestion_lookups (
    string_id INTEGER NOT NULL,
    language_id TEXT NOT NULL,
    kind TEXT NOT NULL,                  -- 'tm' | 'glossary'
    synced_at TEXT NOT NULL,
    PRIMARY KEY (string_id, language_id, kind)
);

-- Per-file/per-directory translation+approval progress, matching the
-- badges Crowdin's own tree shows. There is no bulk endpoint for this —
-- confirmed live, get_file_progress is one call per file — so with
-- ~19,866 files in this project these are only ever fetched lazily for
-- whatever's currently visible (a folder's direct children, right when
-- it's expanded), never for the whole tree at once.
CREATE TABLE IF NOT EXISTS file_progress (
    file_id INTEGER NOT NULL,
    language_id TEXT NOT NULL,
    translation_progress INTEGER NOT NULL,
    approval_progress INTEGER NOT NULL,
    cached_at TEXT NOT NULL,
    PRIMARY KEY (file_id, language_id)
);

CREATE TABLE IF NOT EXISTS directory_progress (
    directory_id INTEGER NOT NULL,
    language_id TEXT NOT NULL,
    translation_progress INTEGER NOT NULL,
    approval_progress INTEGER NOT NULL,
    cached_at TEXT NOT NULL,
    PRIMARY KEY (directory_id, language_id)
);

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

-- Full-text search over cached source + target string text. Only ever
-- covers strings whose file content has actually been synced locally —
-- this app never bulk-fetches string content by default (see
-- file_content_sync.py) — either from ordinarily opening files, or the
-- explicit background indexing job in search_index.py for whoever wants
-- full-project coverage. Kept in sync explicitly, right alongside the
-- writes in sync_file_content, rather than via FTS5 external-content
-- triggers — simpler to reason about at this scale. rowid = string_id.
-- target_text is every cached translation candidate for that string
-- space-joined, so a match on any candidate's wording is found.
CREATE VIRTUAL TABLE IF NOT EXISTS strings_fts USING fts5(
    identifier,
    source_text,
    target_text
);
