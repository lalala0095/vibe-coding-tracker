import os
from datetime import datetime

import pytz
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import clients, goals, models, projects, tasks, trackers, sessions, settings, invoices, auth_router

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

load_dotenv()  # No-op in Cloud Run (env vars are injected directly)

# ---------------------------------------------------------------------------
# App instance
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Vibe Coding Tracker API",
    description="Track your AI-assisted coding sessions.",
    version="1.0.0",
)

# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------

_raw_origins = os.getenv("CORS_ORIGINS", "*")
if _raw_origins.strip() == "*":
    allow_origins = ["*"]
else:
    allow_origins = [o.strip() for o in _raw_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------

app.include_router(auth_router.router)
app.include_router(models.router)
app.include_router(goals.router)
app.include_router(clients.router)
app.include_router(projects.router)
app.include_router(tasks.router)
app.include_router(trackers.router)
app.include_router(sessions.router)
app.include_router(settings.router)
app.include_router(invoices.router)

# ---------------------------------------------------------------------------
# Health endpoint
# ---------------------------------------------------------------------------

SGT = pytz.timezone("Asia/Singapore")


@app.get("/health", tags=["health"])
async def health() -> dict:
    """
    Lightweight health-check endpoint used for Cloud Run pre-warming and
    uptime monitoring.  Does not require authentication.
    """
    return {
        "status": "ok",
        "timestamp": datetime.now(tz=SGT).isoformat(),
    }
