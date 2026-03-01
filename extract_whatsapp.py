#!/usr/bin/env python3
"""Extract WhatsApp and WhatsApp Business databases from encrypted iPhone backup."""

import os
import sys
import sqlite3
from iphone_backup_decrypt import EncryptedBackup

from config import DATA_DIR, IPHONE_BACKUP_PATH

BACKUP_PATH = os.path.expanduser(IPHONE_BACKUP_PATH) if IPHONE_BACKUP_PATH else ""
if not BACKUP_PATH:
    print("ERROR: Set THYSELF_IPHONE_BACKUP in your .env or environment")
    sys.exit(1)

OUTPUT_DIR = str(DATA_DIR / "whatsapp_export")
os.makedirs(OUTPUT_DIR, exist_ok=True)

PASSWORD = os.environ["WA_BACKUP_PW"]

print("\nDecrypting backup...")
backup = EncryptedBackup(backup_directory=BACKUP_PATH, passphrase=PASSWORD)
print("  Decrypted!\n")

manifest_out = os.path.join(OUTPUT_DIR, "Manifest.db")
backup.save_manifest_file(manifest_out)
print(f"  Manifest saved ({os.path.getsize(manifest_out) / 1024 / 1024:.1f} MB)\n")

conn = sqlite3.connect(manifest_out)
cursor = conn.cursor()

cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = [t[0] for t in cursor.fetchall()]
print(f"Tables: {tables}\n")

print("=== WhatsApp SQLite files in backup ===\n")
cursor.execute("""
    SELECT domain, relativePath 
    FROM Files 
    WHERE (domain LIKE '%whatsapp%' OR relativePath LIKE '%whatsapp%')
    AND relativePath LIKE '%.sqlite'
    ORDER BY domain, relativePath
""")
wa_files = cursor.fetchall()
for domain, path in wa_files:
    print(f"  {domain} / {path}")

conn.close()

print("\n=== Extracting databases ===\n")
for domain, rel_path in wa_files:
    filename = rel_path.split("/")[-1]
    safe_domain = domain.replace(".", "_").replace("-", "_")
    out_name = f"{safe_domain}__{filename}"
    out_path = os.path.join(OUTPUT_DIR, out_name)
    try:
        backup.extract_file(
            relative_path=rel_path,
            domain_like=f"%{domain}%",
            output_filename=out_path
        )
        size_mb = os.path.getsize(out_path) / 1024 / 1024
        print(f"  OK: {out_name} ({size_mb:.1f} MB)")
    except Exception as e:
        print(f"  FAIL: {out_name} -- {e}")

print("\nDone!")
