"""
Gmail API authentication using Application Default Credentials (ADC).

Relies on: gcloud auth application-default login --scopes="...,https://www.googleapis.com/auth/gmail.readonly"
"""

import google.auth
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
QUOTA_PROJECT = "booming-landing-106920"


def get_gmail_service():
    """Build and return an authenticated Gmail API service using ADC."""
    credentials, project = google.auth.default(
        scopes=SCOPES,
        quota_project_id=QUOTA_PROJECT,
    )
    if credentials.expired and credentials.refresh_token:
        credentials.refresh(Request())
    return build("gmail", "v1", credentials=credentials)


if __name__ == "__main__":
    service = get_gmail_service()
    profile = service.users().getProfile(userId="me").execute()
    print(f"Authenticated as: {profile['emailAddress']}")
    print(f"Total messages: {profile.get('messagesTotal', 'unknown')}")
    print(f"Total threads: {profile.get('threadsTotal', 'unknown')}")
