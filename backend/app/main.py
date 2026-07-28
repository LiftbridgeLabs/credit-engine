import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.db import Base, engine
from app.log_handler import install_log_handler
from app.routers import arr_instances, auth, batches, browse, libraries, logs, rules, scans, servers, webhooks

app = FastAPI(title="CreditEngine")

install_log_handler()

# Self-hosted, JWT-bearer auth (no cookies) — wide open origins is fine, there's no credentialed
# cross-site request to protect against here.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

Base.metadata.create_all(bind=engine)

# Every API route lives under /api — the frontend is served from the same origin (below) and uses
# client-side routes like /servers/3, /logs, /settings that would otherwise collide exactly with
# API paths of the same name (they used to be safely on separate origins/ports; consolidating into
# one container removed that accidental separation).
app.include_router(auth.router, prefix="/api")
app.include_router(servers.router, prefix="/api")
app.include_router(libraries.router, prefix="/api")
app.include_router(scans.router, prefix="/api")
app.include_router(rules.router, prefix="/api")
app.include_router(batches.router, prefix="/api")
app.include_router(webhooks.router, prefix="/api")
app.include_router(arr_instances.router, prefix="/api")
app.include_router(browse.router, prefix="/api")
app.include_router(logs.router, prefix="/api")
app.include_router(logs.settings_router, prefix="/api")


@app.get("/health")
def health():
    return {"status": "ok"}


# The built frontend (Vite's dist/ output) — baked in alongside the backend in the combined
# deployment image so there's only one container to run. Registered last: every API route above
# still wins on its own path, this only catches whatever's left. Local dev doesn't have this
# directory at all (the frontend runs via its own "npm run dev" server instead) — skipped rather
# than erroring so `uvicorn --reload` against the bare source tree still works.
STATIC_DIR = "static"
if os.path.isdir(STATIC_DIR):
    app.mount("/assets", StaticFiles(directory=os.path.join(STATIC_DIR, "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def spa(full_path: str):
        candidate = os.path.join(STATIC_DIR, full_path)
        if full_path and os.path.isfile(candidate):
            return FileResponse(candidate)
        return FileResponse(os.path.join(STATIC_DIR, "index.html"))
