# HypeReels

## Status
**In progress.** User stories defined (docs/user-stories.md). Next: `@architect`.

## Product

HypeReels is a web application that automatically generates high-energy "hype reel" videos by combining user-uploaded video clips with a chosen song, cut to the beat.

## Domain Concepts

| Term | Definition |
|------|-----------|
| **Clip** | A user-uploaded video file. |
| **Highlight** | A user-defined time range within a clip that *must* appear in the final reel. |
| **Person of Interest** | A subject selected by the user from AI-detected people in the clips. The reel prioritizes moments featuring this person. |
| **Beat Sync** | Aligning video cuts to musical events (beats, drops, phrase boundaries). |
| **HypeReel** | The final generated video: selected clips sequenced and cut to the beat with the user's audio track. |

## MVP Scope

User stories: see `docs/user-stories.md`.

Hard constraints for MVP scoping:
- **No authentication.** Sessions are ephemeral UUID tokens only.
- **No persistence.** All assets deleted after download or TTL expiry.
- **No multi-user.** Single-session, single-user flow.
- **No mobile app.** Web only.
- **One person of interest.** Multi-person selection is Future.

## GPU Acceleration Policy

This is a permanent product decision, not just an MVP constraint:

| Deployment | GPU Acceleration |
|------------|-----------------|
| **Local (self-hosted Docker)** | NVIDIA only (CUDA + ONNX `CUDAExecutionProvider`). All other hardware (AMD, Intel, Apple Silicon) uses CPU-only path. |
| **Cloud (`hypereels.elpeterson.com`)** | Future. Users on non-NVIDIA hardware who want GPU-accelerated generation should use the hosted cloud version. |

**Rationale:** AMD ROCm support requires a separate `onnxruntime-rocm` wheel (Linux-only, complex Docker setup, limited GPU compatibility). Apple Silicon Metal/ANE is similarly non-trivial. Maintaining multiple GPU backends for local deployment is not worth the complexity — NVIDIA + CPU covers the MVP hardware matrix cleanly.

**Future:** When `hypereels.elpeterson.com` launches, it will run on NVIDIA infrastructure and serve as the GPU-accelerated path for non-NVIDIA users.

## Engineering Workflow

Seven specialized agents collaborate in a sequential pipeline:

| Step | Agent | When to Invoke | Primary Output |
|------|-------|---------------|----------------|
| 1 | `@product-owner` | New feature request or sprint kickoff | `docs/user-stories.md` |
| 2 | `@architect` | After user stories are finalized | `docs/architecture.md` |
| 3 | `@frontend-engineer` | After architecture is ready | UI components + pages |
| 4 | `@backend-engineer` | After architecture is ready | APIs + business logic |
| 5 | `@ai-ml-engineer` | After architecture is ready | ML pipelines + processing jobs |
| 6 | `@qa-engineer` | After implementation is complete | `docs/test-plan.md` + tests |
| 7 | `@devops-engineer` | After QA sign-off | CI/CD + deployment config |

Steps 3, 4, and 5 run in parallel once architecture is ready.

## Key Artifact Files

| File | Owner | Purpose |
|------|-------|---------|
| `docs/user-stories.md` | Product Owner | Sprint backlog and acceptance criteria |
| `docs/architecture.md` | Architect | System design, tech stack, data models, component boundaries |
| `docs/api-spec.md` | Backend Engineer | REST API specification |
| `docs/test-plan.md` | QA Engineer | Test strategy, test cases, coverage targets |

## Repository

- Remote: https://github.com/elpeterson/HypeReels.git
- Default branch: `main`
