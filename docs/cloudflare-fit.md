# Cloudflare Integration Architecture fit for TIMMY

This document outlines the design and integration model for scaling the local-first **TIMMY Agent Trust OS** to Cloudflare's serverless edge network.

TIMMY's philosophy is simple: **trust the receipt, not the model.** While the interactive TUI, CLI execution loop, and tamper-evident run manifests reside strictly on the local client machine, Cloudflare is proposed as a second, off-machine auditor and validation gate (planned: nothing in this tree anchors a chain to Cloudflare today; a local chain is tamper-evident, never tamper-proof, since its signing key is self-generated on the same machine).

---

## 🏛️ System Topology

```
   ┌────────────────────────────────────────────────────────┐
   │                  Local Client Machine                  │
   │   - React Ink TUI (Interactive Console)                │
   │   - Local Agent Execution Loop (OpenRouter Calls)      │
   │   - Tamper-Evident Manifests (.timmy/receipts/)        │
   └──────────────────────────┬─────────────────────────────┘
                              │ Secure HTTPS / WebSocket
                              ▼
   ┌────────────────────────────────────────────────────────┐
   │            Cloudflare Edge (Trust Network)             │
   │                                                        │
   │  ┌───────────────────┐        ┌───────────────────┐    │
   │  │   Durable Object  │        │   Cloudflare R2   │    │
   │  │ (Session Tracker) │        │ (Replays/Artifact)│    │
   │  └─────────┬─────────┘        └─────────▲─────────┘    │
   │            │                            │              │
   │            ▼                            │              │
   │  ┌───────────────────┐                  │              │
   │  │    Cloudflare D1  │──────────────────┘              │
   │  │ (Metadata Index)  │                                 │
   │  └───────────────────┘                                 │
   │                                                        │
   │  ┌───────────────────┐        ┌───────────────────┐    │
   │  │ Cloudflare Queues  │        │ Cloudflare Pages  │    │
   │  │ (Async Auditors)  │        │  (Receipt Viewer) │    │
   │  └─────────┬─────────┘        └───────────────────┘    │
   └────────────────────────────────────────────────────────┘
```

---

## ⚙️ Cloudflare Platform Fit

TIMMY leverages different facets of the Cloudflare platform to extend local execution capabilities into a multi-party verifiable audit log without introducing latency or vendor lock-in.

### 1. Cloudflare Workers (Entry & Dispatch API)
* **Role**: The secure ingest endpoint for the local CLI.
* **Fit**: When a local task completes, TIMMY sends a copy of the key-sorted manifest hash and metadata envelope to the Worker. The Worker validates the cryptographic signature of the receipt and routes the payload to storage.

### 2. Durable Objects (Live Run & Session State)
* **Role**: Real-time state synchronization and WebSocket mirroring.
* **Fit**: The companion browser mirror matches state in real-time. A Durable Object acts as a low-latency, single-instance coordination server, maintaining WebSocket rooms for active CLI sessions, ensuring a mirror of the terminal stream is always secure and inspectable from a browser.

### 3. Cloudflare D1 (Metadata & Query Index)
* **Role**: Fast SQL relational database for audit logs.
* **Fit**: D1 indexes the run metadata (Run ID, Task string, Timestamp, SHA-256 Manifest Hash, status). This allows administrators or security dashboards to perform SQL queries over agent runs (e.g., listing all runs that mutated configuration files) without needing full file lookups.

### 4. Cloudflare R2 (Object Storage for Replays & Artifacts)
* **Role**: Immutable file storage for telemetry logs.
* **Fit**: Full terminal replay files (`replay.md`) and evidence artifacts generated during task execution are pushed to R2 buckets. They are served via content-addressed URLs tied directly to the manifest hash registered in D1.

### 5. Cloudflare Queues (Background Verification & Safety Gates)
* **Role**: Asynchronous validation pipeline.
* **Fit**: When a manifest is registered, a message is queued for background processing. Workers verify that files in R2 match the hashes declared in the manifest, check for leaked secrets, and flag anomalous system behaviors.

### 6. Cloudflare AI Gateway (Model Routing & Visibility)
* **Role**: Observability and proxying layer for LLM calls.
* **Fit**: Acts as the central pipeline proxy for OpenRouter and other provider API requests. It caches identical prompts to minimize token costs, logs request/response telemetry, and enforces client-side spending limits.

### 7. Cloudflare Pages (Static Frontend Receipt Viewer)
* **Role**: Static hosting for the developer dashboard.
* **Fit**: A simple React or static HTML web console hosted on Cloudflare Pages. Developers can view their receipts, read run replays, and verify the cryptographic integrity of their runs from a clean web interface.

---

## 🔒 Security & Verification Loop

1. **Sealed Manifest**: The local TIMMY CLI generates a receipt and computes a deterministic SHA-256 hash by key-sorting the JSON attributes.
2. **Push to Edge**: The receipt is pushed to Cloudflare Workers.
3. **Consensus**: The edge database (D1) stores the manifest hash. If a developer attempts to modify a local receipt or log, any subsequent verification request to the Cloudflare Edge API will detect the mismatch and sound an alert.
