from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.db import Base, engine
from app.routers import arr_instances, auth, batches, browse, libraries, rules, scans, servers, webhooks

app = FastAPI(title="CreditEngine")

# Self-hosted, JWT-bearer auth (no cookies) — wide open origins is fine, there's no credentialed
# cross-site request to protect against here.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

Base.metadata.create_all(bind=engine)

app.include_router(auth.router)
app.include_router(servers.router)
app.include_router(libraries.router)
app.include_router(scans.router)
app.include_router(rules.router)
app.include_router(batches.router)
app.include_router(webhooks.router)
app.include_router(arr_instances.router)
app.include_router(browse.router)


@app.get("/health")
def health():
    return {"status": "ok"}
