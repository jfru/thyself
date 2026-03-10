use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub data_dir: String,
    pub api_key: String,
    pub subject_name: String,
    pub email: Option<String>,
    pub selected_sources: Vec<String>,
    pub onboarding_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_password: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

fn app_support_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join("Library/Application Support/Thyself")
}

fn profiles_path() -> PathBuf {
    app_support_dir().join("profiles.json")
}

pub fn read_profiles() -> Result<Vec<Profile>, String> {
    let path = profiles_path();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read profiles: {}", e))?;
    serde_json::from_str(&data)
        .map_err(|e| format!("Failed to parse profiles: {}", e))
}

fn write_profiles(profiles: &[Profile]) -> Result<(), String> {
    let dir = app_support_dir();
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create app support dir: {}", e))?;
    let data = serde_json::to_string_pretty(profiles)
        .map_err(|e| format!("Failed to serialize profiles: {}", e))?;
    fs::write(profiles_path(), data)
        .map_err(|e| format!("Failed to write profiles: {}", e))
}

pub fn get_active_profile_id() -> Option<String> {
    let active_path = app_support_dir().join("active_profile");
    fs::read_to_string(active_path).ok().map(|s| s.trim().to_string())
}

fn set_active_profile_id(id: &str) -> Result<(), String> {
    let dir = app_support_dir();
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create app support dir: {}", e))?;
    fs::write(dir.join("active_profile"), id)
        .map_err(|e| format!("Failed to write active profile: {}", e))
}

pub fn create_profile(
    name: String,
    api_key: String,
    subject_name: String,
    email: Option<String>,
    selected_sources: Vec<String>,
) -> Result<Profile, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let data_dir = app_support_dir()
        .join("profiles")
        .join(&id);

    fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create profile dir: {}", e))?;
    fs::create_dir_all(data_dir.join("sessions"))
        .map_err(|e| format!("Failed to create sessions dir: {}", e))?;
    fs::create_dir_all(data_dir.join("extraction_results"))
        .map_err(|e| format!("Failed to create extraction_results dir: {}", e))?;
    fs::create_dir_all(data_dir.join("synthesis_results"))
        .map_err(|e| format!("Failed to create synthesis_results dir: {}", e))?;

    create_database(&data_dir)?;

    let profile = Profile {
        id: id.clone(),
        name,
        data_dir: data_dir.display().to_string(),
        api_key,
        subject_name,
        email,
        selected_sources,
        onboarding_status: "pending".to_string(),
        backup_password: None,
        created_at: chrono::Utc::now().to_rfc3339(),
    };

    let mut profiles = read_profiles()?;
    profiles.push(profile.clone());
    write_profiles(&profiles)?;
    set_active_profile_id(&id)?;

    Ok(profile)
}

pub fn switch_profile(profile_id: &str) -> Result<Profile, String> {
    let profiles = read_profiles()?;
    let profile = profiles
        .iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Profile not found: {}", profile_id))?
        .clone();
    set_active_profile_id(profile_id)?;
    Ok(profile)
}

pub fn update_profile(
    profile_id: &str,
    onboarding_status: Option<String>,
    selected_sources: Option<Vec<String>>,
    api_key: Option<String>,
    subject_name: Option<String>,
    email: Option<String>,
) -> Result<Profile, String> {
    let mut profiles = read_profiles()?;
    let profile = profiles
        .iter_mut()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Profile not found: {}", profile_id))?;

    if let Some(status) = onboarding_status {
        profile.onboarding_status = status;
    }
    if let Some(sources) = selected_sources {
        profile.selected_sources = sources;
    }
    if let Some(key) = api_key {
        profile.api_key = key;
    }
    if let Some(name) = subject_name {
        profile.subject_name = name;
    }
    if let Some(e) = email {
        profile.email = Some(e);
    }

    let updated = profile.clone();
    write_profiles(&profiles)?;
    Ok(updated)
}

pub fn set_backup_password(profile_id: &str, password: &str) -> Result<(), String> {
    let mut profiles = read_profiles()?;
    let profile = profiles
        .iter_mut()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Profile not found: {}", profile_id))?;
    profile.backup_password = Some(password.to_string());
    write_profiles(&profiles)
}

pub fn get_backup_password(profile_id: &str) -> Result<Option<String>, String> {
    let profiles = read_profiles()?;
    let profile = profiles
        .iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Profile not found: {}", profile_id))?;
    Ok(profile.backup_password.clone())
}

pub fn delete_profile(profile_id: &str) -> Result<Option<Profile>, String> {
    let profiles = read_profiles()?;
    let profile = profiles
        .iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Profile not found: {}", profile_id))?
        .clone();

    // Only delete data dirs that live inside our profiles/ subfolder
    let profiles_root = app_support_dir().join("profiles");
    let data_dir = PathBuf::from(&profile.data_dir);
    if data_dir.starts_with(&profiles_root) {
        let _ = fs::remove_dir_all(&data_dir);
    }

    let remaining: Vec<Profile> = profiles
        .into_iter()
        .filter(|p| p.id != profile_id)
        .collect();
    write_profiles(&remaining)?;

    // If we deleted the active profile, switch to another (or clear)
    let active_id = get_active_profile_id();
    if active_id.as_deref() == Some(profile_id) {
        if let Some(next) = remaining.first() {
            set_active_profile_id(&next.id)?;
            return Ok(Some(next.clone()));
        } else {
            let _ = fs::remove_file(app_support_dir().join("active_profile"));
            return Ok(None);
        }
    }

    // Return the currently active profile (unchanged)
    if let Some(id) = active_id {
        Ok(remaining.iter().find(|p| p.id == id).cloned())
    } else {
        Ok(remaining.first().cloned())
    }
}

/// On first launch, if an existing thyself.db exists at the legacy location
/// but no profiles.json exists, create a backward-compat profile pointing
/// to the existing data directory. Returns true if migration happened.
pub fn migrate_legacy_data() -> Result<bool, String> {
    let profiles = read_profiles()?;
    if !profiles.is_empty() {
        return Ok(false);
    }

    let legacy_dir = if let Ok(dir) = std::env::var("THYSELF_DATA_DIR") {
        PathBuf::from(dir)
    } else {
        app_support_dir()
    };

    let legacy_db = legacy_dir.join("thyself.db");
    if !legacy_db.exists() {
        return Ok(false);
    }

    let subject_name = std::env::var("THYSELF_SUBJECT_NAME").unwrap_or_else(|_| "User".to_string());
    let api_key = std::env::var("ANTHROPIC_API_KEY").unwrap_or_default();
    let email = std::env::var("THYSELF_EMAIL").ok();

    let id = uuid::Uuid::new_v4().to_string();
    let profile = Profile {
        id: id.clone(),
        name: subject_name.clone(),
        data_dir: legacy_dir.display().to_string(),
        api_key,
        subject_name,
        email,
        selected_sources: vec![],
        onboarding_status: "complete".to_string(),
        backup_password: None,
        created_at: chrono::Utc::now().to_rfc3339(),
    };

    write_profiles(&[profile])?;
    set_active_profile_id(&id)?;
    Ok(true)
}

/// Get the data directory for the active profile, falling back to env/default.
pub fn get_active_data_dir() -> PathBuf {
    if let Some(active_id) = get_active_profile_id() {
        if let Ok(profiles) = read_profiles() {
            if let Some(profile) = profiles.iter().find(|p| p.id == active_id) {
                return PathBuf::from(&profile.data_dir);
            }
        }
    }

    if let Ok(dir) = std::env::var("THYSELF_DATA_DIR") {
        PathBuf::from(dir)
    } else {
        app_support_dir()
    }
}

/// Get the API key for the active profile, falling back to env.
pub fn get_active_api_key() -> Option<String> {
    if let Some(active_id) = get_active_profile_id() {
        if let Ok(profiles) = read_profiles() {
            if let Some(profile) = profiles.iter().find(|p| p.id == active_id) {
                if !profile.api_key.is_empty() {
                    return Some(profile.api_key.clone());
                }
            }
        }
    }
    std::env::var("ANTHROPIC_API_KEY").ok()
}

/// Get the subject name for the active profile, falling back to env.
pub fn get_active_subject_name() -> String {
    if let Some(active_id) = get_active_profile_id() {
        if let Ok(profiles) = read_profiles() {
            if let Some(profile) = profiles.iter().find(|p| p.id == active_id) {
                return profile.subject_name.clone();
            }
        }
    }
    std::env::var("THYSELF_SUBJECT_NAME").unwrap_or_else(|_| "User".to_string())
}

fn create_database(data_dir: &std::path::Path) -> Result<(), String> {
    let db_path = data_dir.join("thyself.db");
    let conn = Connection::open(&db_path)
        .map_err(|e| format!("Failed to create database: {}", e))?;

    conn.execute_batch(BASE_TABLES)
        .map_err(|e| format!("Failed to create base tables: {}", e))?;
    conn.execute_batch(CHATGPT_TABLES)
        .map_err(|e| format!("Failed to create chatgpt tables: {}", e))?;
    conn.execute_batch(GMAIL_TABLES)
        .map_err(|e| format!("Failed to create gmail tables: {}", e))?;
    conn.execute_batch(SYNC_TABLES)
        .map_err(|e| format!("Failed to create sync tables: {}", e))?;
    conn.execute_batch(EXTRACTION_TABLES)
        .map_err(|e| format!("Failed to create extraction tables: {}", e))?;
    conn.execute_batch(SYNTHESIS_TABLES)
        .map_err(|e| format!("Failed to create synthesis tables: {}", e))?;
    conn.execute_batch(CORRECTIONS_TABLES)
        .map_err(|e| format!("Failed to create corrections tables: {}", e))?;

    Ok(())
}

const BASE_TABLES: &str = "
CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    display_name TEXT,
    first_name TEXT,
    last_name TEXT,
    phone TEXT,
    email TEXT,
    imessage_handle TEXT,
    whatsapp_id TEXT,
    whatsapp_jid TEXT,
    relationship_type TEXT,
    relationship_subtype TEXT,
    how_we_met TEXT,
    location TEXT,
    organization TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contact_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER REFERENCES contacts(id),
    alias_type TEXT,
    alias_value TEXT,
    source TEXT,
    UNIQUE(alias_type, alias_value)
);

CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    source_id TEXT,
    is_group BOOLEAN DEFAULT FALSE,
    group_name TEXT,
    participant_count INTEGER,
    created_at DATETIME,
    last_message_at DATETIME
);

CREATE TABLE IF NOT EXISTS conversation_participants (
    conversation_id INTEGER REFERENCES conversations(id),
    contact_id INTEGER REFERENCES contacts(id),
    PRIMARY KEY (conversation_id, contact_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER REFERENCES conversations(id),
    contact_id INTEGER REFERENCES contacts(id),
    source TEXT NOT NULL,
    source_id TEXT,
    is_from_me BOOLEAN,
    content TEXT,
    content_type TEXT,
    sent_at DATETIME,
    read_at DATETIME,
    word_count INTEGER,
    has_attachment BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id);
CREATE INDEX IF NOT EXISTS idx_messages_sent ON messages(sent_at);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
";

const CHATGPT_TABLES: &str = "
CREATE TABLE IF NOT EXISTS chatgpt_conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    create_time REAL,
    update_time REAL,
    model_slug TEXT,
    gizmo_id TEXT,
    is_archived BOOLEAN DEFAULT 0,
    message_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chatgpt_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    parent_id TEXT,
    role TEXT NOT NULL,
    content_type TEXT,
    text TEXT,
    model_slug TEXT,
    status TEXT,
    create_time REAL,
    update_time REAL,
    position INTEGER,
    weight REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES chatgpt_conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_chatgpt_msg_conv ON chatgpt_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chatgpt_msg_role ON chatgpt_messages(role);
CREATE INDEX IF NOT EXISTS idx_chatgpt_msg_create ON chatgpt_messages(create_time);
CREATE INDEX IF NOT EXISTS idx_chatgpt_conv_create ON chatgpt_conversations(create_time);
";

const GMAIL_TABLES: &str = "
CREATE TABLE IF NOT EXISTS gmail_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gmail_id TEXT UNIQUE NOT NULL,
    thread_id TEXT NOT NULL,
    subject TEXT,
    from_addr TEXT,
    from_name TEXT,
    to_addrs TEXT,
    cc_addrs TEXT,
    bcc_addrs TEXT,
    sent_at DATETIME,
    received_at DATETIME,
    body_text TEXT,
    word_count INTEGER,
    is_from_me BOOLEAN,
    labels TEXT,
    snippet TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_gmail_thread ON gmail_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_gmail_sent ON gmail_messages(sent_at);
CREATE INDEX IF NOT EXISTS idx_gmail_from ON gmail_messages(from_addr);
";

const SYNC_TABLES: &str = "
CREATE TABLE IF NOT EXISTS sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    started_at DATETIME NOT NULL,
    finished_at DATETIME,
    messages_added INTEGER DEFAULT 0,
    status TEXT DEFAULT 'running',
    error_message TEXT,
    last_message_at DATETIME
);
";

const EXTRACTION_TABLES: &str = "
CREATE TABLE IF NOT EXISTS extraction_months (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL UNIQUE,
    summary TEXT,
    emotional_overall TEXT,
    energy_level TEXT,
    emotional_indicators TEXT,
    stress_signals TEXT,
    joy_signals TEXT,
    raw_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_extraction_months_month ON extraction_months(month);

CREATE TABLE IF NOT EXISTS extraction_people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month_id INTEGER NOT NULL REFERENCES extraction_months(id),
    canonical_name TEXT NOT NULL,
    aliases TEXT,
    contact_id INTEGER REFERENCES contacts(id),
    UNIQUE(month_id, canonical_name)
);

CREATE INDEX IF NOT EXISTS idx_extraction_people_month ON extraction_people(month_id);
CREATE INDEX IF NOT EXISTS idx_extraction_people_name ON extraction_people(canonical_name);
CREATE INDEX IF NOT EXISTS idx_extraction_people_contact ON extraction_people(contact_id);

CREATE TABLE IF NOT EXISTS extraction_episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month_id INTEGER NOT NULL REFERENCES extraction_months(id),
    name TEXT NOT NULL,
    description TEXT,
    status TEXT,
    people TEXT,
    emotional_tone TEXT,
    key_evidence TEXT,
    sources TEXT
);

CREATE INDEX IF NOT EXISTS idx_extraction_episodes_month ON extraction_episodes(month_id);
CREATE INDEX IF NOT EXISTS idx_extraction_episodes_status ON extraction_episodes(status);

CREATE TABLE IF NOT EXISTS extraction_relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month_id INTEGER NOT NULL REFERENCES extraction_months(id),
    person TEXT NOT NULL,
    role TEXT,
    quality_this_month TEXT,
    notable_exchanges TEXT,
    sources TEXT
);

CREATE INDEX IF NOT EXISTS idx_extraction_rels_month ON extraction_relationships(month_id);
CREATE INDEX IF NOT EXISTS idx_extraction_rels_person ON extraction_relationships(person);

CREATE TABLE IF NOT EXISTS extraction_themes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month_id INTEGER NOT NULL REFERENCES extraction_months(id),
    name TEXT NOT NULL,
    description TEXT,
    intensity TEXT,
    sources TEXT,
    cross_source_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_extraction_themes_month ON extraction_themes(month_id);
CREATE INDEX IF NOT EXISTS idx_extraction_themes_name ON extraction_themes(name);

CREATE TABLE IF NOT EXISTS extraction_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month_id INTEGER NOT NULL REFERENCES extraction_months(id),
    description TEXT NOT NULL,
    status TEXT,
    stakes TEXT,
    evidence TEXT
);

CREATE INDEX IF NOT EXISTS idx_extraction_decisions_month ON extraction_decisions(month_id);

CREATE TABLE IF NOT EXISTS extraction_tensions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month_id INTEGER NOT NULL REFERENCES extraction_months(id),
    description TEXT NOT NULL,
    evidence TEXT
);

CREATE INDEX IF NOT EXISTS idx_extraction_tensions_month ON extraction_tensions(month_id);

CREATE TABLE IF NOT EXISTS extraction_absences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month_id INTEGER NOT NULL REFERENCES extraction_months(id),
    description TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_extraction_absences_month ON extraction_absences(month_id);

CREATE TABLE IF NOT EXISTS extraction_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month_id INTEGER NOT NULL REFERENCES extraction_months(id),
    observation TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_extraction_observations_month ON extraction_observations(month_id);
";

const SYNTHESIS_TABLES: &str = "
CREATE TABLE IF NOT EXISTS synthesis_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    months_covered TEXT,
    raw_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS life_chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES synthesis_runs(id),
    name TEXT NOT NULL,
    start_month TEXT,
    end_month TEXT,
    description TEXT,
    defining_relationships TEXT,
    defining_themes TEXT,
    how_it_ended TEXT,
    source_evidence TEXT,
    position INTEGER
);

CREATE INDEX IF NOT EXISTS idx_life_chapters_run ON life_chapters(run_id);

CREATE TABLE IF NOT EXISTS relationship_arcs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES synthesis_runs(id),
    person TEXT NOT NULL,
    role TEXT,
    arc_summary TEXT,
    peak_period TEXT,
    current_status TEXT,
    defining_moments TEXT,
    contact_id INTEGER REFERENCES contacts(id)
);

CREATE INDEX IF NOT EXISTS idx_relationship_arcs_run ON relationship_arcs(run_id);
CREATE INDEX IF NOT EXISTS idx_relationship_arcs_person ON relationship_arcs(person);

CREATE TABLE IF NOT EXISTS theme_evolution (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES synthesis_runs(id),
    theme TEXT NOT NULL,
    trajectory TEXT,
    key_moments TEXT,
    source_evidence TEXT
);

CREATE INDEX IF NOT EXISTS idx_theme_evolution_run ON theme_evolution(run_id);

CREATE TABLE IF NOT EXISTS recurring_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES synthesis_runs(id),
    pattern TEXT NOT NULL,
    instances TEXT,
    source_evidence TEXT
);

CREATE INDEX IF NOT EXISTS idx_recurring_patterns_run ON recurring_patterns(run_id);

CREATE TABLE IF NOT EXISTS synthesis_contradictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES synthesis_runs(id),
    description TEXT NOT NULL,
    evidence TEXT,
    source_evidence TEXT
);

CREATE INDEX IF NOT EXISTS idx_synth_contradictions_run ON synthesis_contradictions(run_id);

CREATE TABLE IF NOT EXISTS turning_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES synthesis_runs(id),
    month TEXT,
    description TEXT NOT NULL,
    before_after TEXT,
    source_evidence TEXT
);

CREATE INDEX IF NOT EXISTS idx_turning_points_run ON turning_points(run_id);

CREATE TABLE IF NOT EXISTS person_portrait (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES synthesis_runs(id),
    drives TEXT,
    fears TEXT,
    unnamed_wants TEXT,
    character_summary TEXT,
    source_evidence TEXT
);

CREATE INDEX IF NOT EXISTS idx_person_portrait_run ON person_portrait(run_id);
";

const CORRECTIONS_TABLES: &str = "
CREATE TABLE IF NOT EXISTS person_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_name TEXT NOT NULL UNIQUE,
    description TEXT,
    contact_id INTEGER REFERENCES contacts(id),
    first_seen TEXT,
    last_seen TEXT,
    months_seen INTEGER,
    roles TEXT,
    sources TEXT,
    relationship_summary TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS person_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_identity_id INTEGER NOT NULL REFERENCES person_identities(id),
    alias TEXT NOT NULL,
    context TEXT,
    UNIQUE(alias, context)
);

CREATE INDEX IF NOT EXISTS idx_person_aliases_identity ON person_aliases(person_identity_id);
CREATE INDEX IF NOT EXISTS idx_person_aliases_alias ON person_aliases(alias);

CREATE TABLE IF NOT EXISTS corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    correction_type TEXT NOT NULL,
    layer TEXT NOT NULL,
    target TEXT,
    original_claim TEXT NOT NULL,
    corrected_claim TEXT NOT NULL,
    evidence TEXT,
    months_affected TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_corrections_type ON corrections(correction_type);
CREATE INDEX IF NOT EXISTS idx_corrections_status ON corrections(status);
";
