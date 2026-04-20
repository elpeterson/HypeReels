"""pytest tests for deployment documentation and configuration — E10 stories.

What this file tests and why
------------------------------
STORY-022 through STORY-026 (E10: Generic Self-Hoster Deployment) require that:

  1. No hardcoded machine-specific IPs appear outside of clearly-labelled
     reference callout blocks in the deployment docs (TC-050, TC-051).
  2. The Profile 3 deprecation notice is present in infrastructure.md (TC-052).
  3. The .env.example template contains <PLACEHOLDER> markers and no real
     credentials (TC-059).
  4. Profile 3 is not promoted as an active deployment path in any active
     documentation (TC-058).
  5. The InsightFace worker initialises in CPU-only mode (CPU-only profile)
     and gracefully falls back to CPU when no GPU is present (GPU profile)
     (TC-054, TC-055 — validated via the same CPUExecutionProvider unit test
     from test_person_detection.py, confirmed here for the deployment context).

These tests are pure file-system/documentation checks that can run in any CI
environment without Docker or a running stack.

Run with:
    pytest workers/tests/test_deployment.py -v
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

# ── Repository root resolution ────────────────────────────────────────────────
# Workers tests run from the workers/ directory or repo root; resolve relative paths.
_THIS_DIR = Path(__file__).parent
_REPO_ROOT = _THIS_DIR.parent.parent  # workers/tests -> workers -> repo root
_DOCS = _REPO_ROOT / "docs"
_DEPLOYMENT = _DOCS / "deployment"


def _read(path: Path) -> str:
    """Read a file or skip the test if it doesn't exist."""
    if not path.exists():
        pytest.skip(f"File not found — skipping: {path}")
    return path.read_text(encoding="utf-8")


# ── TC-050: Profile-1-cpu.md — no hardcoded IPs outside callout blocks ────────


class TestProfile1CPUDocumentation:
    """TC-050: Profile 1 (CPU-only) deployment docs must not expose machine-specific
    IP addresses outside of clearly-labelled reference callout blocks.

    The following IPs are specific to the reference environment (Case/Quorra)
    and must appear ONLY inside Markdown blockquote / callout sections (lines
    starting with '> ') when they appear at all.
    """

    CASE_IPS = [
        "192.168.1.122",  # Case Proxmox host
        "192.168.1.136",  # CT 113 API LXC
        "192.168.1.137",  # CT 114 Redis LXC
        "192.168.1.138",  # CT 115 MinIO LXC
    ]
    QUORRA_IPS = [
        "192.168.1.100",  # Quorra Unraid host
    ]

    @property
    def _doc(self) -> str:
        return _read(_DEPLOYMENT / "profile-1-cpu.md")

    def _non_callout_lines(self, content: str) -> list[tuple[int, str]]:
        """Return (lineno, line) pairs that are NOT inside Markdown callout/quote blocks."""
        results = []
        for lineno, line in enumerate(content.splitlines(), start=1):
            stripped = line.strip()
            # Callout / blockquote lines start with '>' (Markdown blockquotes)
            if not stripped.startswith(">"):
                results.append((lineno, line))
        return results

    def test_no_case_ips_outside_callouts(self):
        """Case-specific IP addresses must not appear in non-callout lines."""
        content = self._doc
        non_callout = self._non_callout_lines(content)

        violations = []
        for ip in self.CASE_IPS:
            for lineno, line in non_callout:
                if ip in line:
                    violations.append((lineno, ip, line.strip()))

        assert not violations, (
            f"Found Case-specific IPs outside callout blocks in profile-1-cpu.md:\n"
            + "\n".join(f"  Line {ln}: {ip!r} in {line!r}" for ln, ip, line in violations)
        )

    def test_no_quorra_ips_outside_callouts(self):
        """Quorra-specific IP must not appear in non-callout lines of the CPU profile doc."""
        content = self._doc
        non_callout = self._non_callout_lines(content)

        violations = []
        for ip in self.QUORRA_IPS:
            for lineno, line in non_callout:
                if ip in line:
                    violations.append((lineno, ip, line.strip()))

        assert not violations, (
            f"Found Quorra-specific IPs outside callout blocks in profile-1-cpu.md:\n"
            + "\n".join(f"  Line {ln}: {ip!r} in {line!r}" for ln, ip, line in violations)
        )

    def test_placeholder_variable_present(self):
        """The doc must use <HOST_IP>, <PLACEHOLDER>, or <YOUR_HOST_IP> as the generic host."""
        content = self._doc
        placeholder_pattern = re.compile(
            r"<HOST_IP>|<PLACEHOLDER>|<YOUR_HOST_IP>|<your[_-]host[_-]ip>",
            re.IGNORECASE,
        )
        assert placeholder_pattern.search(content), (
            "profile-1-cpu.md must use a <PLACEHOLDER> or <HOST_IP> variable "
            "rather than hardcoded IP addresses for the deployment host."
        )

    def test_hardware_requirements_table_present(self):
        """A hardware requirements table must be present (STORY-022 AC)."""
        content = self._doc
        # Minimum CPU, RAM, Storage should appear
        assert re.search(r"CPU|cores", content, re.IGNORECASE), (
            "profile-1-cpu.md must include minimum CPU requirements"
        )
        assert re.search(r"RAM|memory|GB", content, re.IGNORECASE), (
            "profile-1-cpu.md must include minimum RAM requirements"
        )

    def test_cpu_only_label_present(self):
        """The doc must be clearly labelled as CPU-only (no GPU required)."""
        content = self._doc
        assert re.search(r"cpu.only|no gpu|without gpu", content, re.IGNORECASE), (
            "profile-1-cpu.md must clearly state this profile requires no GPU"
        )

    def test_docker_compose_up_command_present(self):
        """STORY-023 AC: a near-single-command deploy must be documented."""
        content = self._doc
        assert "docker compose up" in content or "docker-compose up" in content, (
            "profile-1-cpu.md must document `docker compose up -d` as the startup command"
        )

    def test_restart_policy_documented(self):
        """STORY-023 AC: auto-restart on host reboot must be documented."""
        content = self._doc
        restart_pattern = re.compile(
            r"restart.*unless.stopped|autostart|systemctl enable|restart: unless-stopped",
            re.IGNORECASE,
        )
        assert restart_pattern.search(content), (
            "profile-1-cpu.md must document the restart policy (restart: unless-stopped or equivalent)"
        )


# ── TC-051: Profile-2-gpu.md — no hardcoded IPs, GPU fallback documented ──────


class TestProfile2GPUDocumentation:
    """TC-051: Profile 2 (GPU-enabled) deployment docs must not expose machine-specific
    IP addresses outside callout blocks, and must document graceful CPU fallback.
    """

    @property
    def _doc(self) -> str:
        return _read(_DEPLOYMENT / "profile-2-gpu.md")

    def test_no_quorra_ips_outside_callouts(self):
        """Quorra IP (192.168.1.100) must not appear outside blockquote/callout sections."""
        content = self._doc
        violations = []
        for lineno, line in enumerate(content.splitlines(), start=1):
            stripped = line.strip()
            if not stripped.startswith(">") and "192.168.1.100" in line:
                violations.append((lineno, line.strip()))

        assert not violations, (
            "Found Quorra IP (192.168.1.100) outside callout blocks in profile-2-gpu.md:\n"
            + "\n".join(f"  Line {ln}: {line!r}" for ln, line in violations)
        )

    def test_cpu_fallback_documented(self):
        """STORY-024 AC: GPU fallback to CPU must be documented."""
        content = self._doc
        fallback_pattern = re.compile(
            r"falls? back|cpu fallback|cpu inference|without gpu|if no.*gpu|gpu.*optional",
            re.IGNORECASE,
        )
        assert fallback_pattern.search(content), (
            "profile-2-gpu.md must document graceful CPU fallback when no GPU is present"
        )

    def test_placeholder_variable_present(self):
        """Generic <PLACEHOLDER> or <HOST_IP> must be used for host address."""
        content = self._doc
        placeholder_pattern = re.compile(
            r"<HOST_IP>|<PLACEHOLDER>|<YOUR_HOST_IP>|<your[_-]host[_-]ip>",
            re.IGNORECASE,
        )
        assert placeholder_pattern.search(content), (
            "profile-2-gpu.md must use a <PLACEHOLDER> or <HOST_IP> variable "
            "for the deployment host address."
        )

    def test_gpu_sharing_contention_documented(self):
        """STORY-024 AC: GPU contention / sharing concerns must be documented."""
        content = self._doc
        contention_pattern = re.compile(
            r"contention|sharing|nvidia-smi|docker inspect|another.*container.*gpu|gpu.*conflict",
            re.IGNORECASE,
        )
        assert contention_pattern.search(content), (
            "profile-2-gpu.md must document how to check for GPU contention with other containers"
        )

    def test_docker_compose_up_command_present(self):
        """STORY-024 AC: near-single-command deploy documented."""
        content = self._doc
        assert "docker compose up" in content or "docker-compose up" in content, (
            "profile-2-gpu.md must document `docker compose up -d` as the startup command"
        )

    def test_nvidia_container_toolkit_documented(self):
        """GPU profile must document NVIDIA Container Toolkit installation."""
        content = self._doc
        assert re.search(r"nvidia.container.toolkit|nvidia-container-toolkit", content, re.IGNORECASE), (
            "profile-2-gpu.md must document nvidia-container-toolkit installation"
        )


# ── TC-052: infrastructure.md — Profile 3 deprecation notice ─────────────────


class TestInfrastructureDeprecation:
    """TC-052: docs/infrastructure.md must carry a prominent deprecation notice
    for Profile 3 (split-system) at the top of the file.

    STORY-026 AC: 'When this story is complete, docs/infrastructure.md is
    updated to clearly mark Profile 3 as retired with a deprecation notice at
    the top.'
    """

    @property
    def _doc(self) -> str:
        return _read(_DOCS / "infrastructure.md")

    def test_deprecation_notice_in_first_20_lines(self):
        """DEPRECATED must appear within the first 20 lines of infrastructure.md."""
        content = self._doc
        first_20 = "\n".join(content.splitlines()[:20])
        assert re.search(r"DEPRECATED", first_20, re.IGNORECASE), (
            "infrastructure.md must have a DEPRECATED notice within the first 20 lines"
        )

    def test_profile_3_mentioned_in_deprecation(self):
        """Profile 3 must be mentioned in the deprecation block."""
        content = self._doc
        first_20 = "\n".join(content.splitlines()[:20])
        assert re.search(r"Profile 3|profile.3|split.system", first_20, re.IGNORECASE), (
            "infrastructure.md first-20-line deprecation notice must mention 'Profile 3'"
        )

    def test_canonical_profiles_referenced(self):
        """Deprecation block must direct readers to Profile 1 and Profile 2."""
        content = self._doc
        first_30 = "\n".join(content.splitlines()[:30])
        assert "profile-1-cpu.md" in first_30 or "Profile 1" in first_30, (
            "infrastructure.md must reference profile-1-cpu.md in the deprecation notice"
        )
        assert "profile-2-gpu.md" in first_30 or "Profile 2" in first_30, (
            "infrastructure.md must reference profile-2-gpu.md in the deprecation notice"
        )


# ── TC-058: Profile 3 not promoted in active docs ─────────────────────────────


class TestProfile3NotPromoted:
    """TC-058: Search active documentation for references to Profile 3 as an
    active deployment path. Only deprecated/historical mentions are allowed.
    """

    def _active_docs(self) -> list[Path]:
        """Return the list of active (non-deprecated) deployment docs."""
        return [
            _DEPLOYMENT / "profile-1-cpu.md",
            _DEPLOYMENT / "profile-2-gpu.md",
            _DEPLOYMENT / "README.md",
        ]

    def test_profile_1_doc_does_not_promote_profile_3(self):
        """profile-1-cpu.md must not present Profile 3 as an active deployment path."""
        path = _DEPLOYMENT / "profile-1-cpu.md"
        if not path.exists():
            pytest.skip("profile-1-cpu.md not found")
        content = path.read_text(encoding="utf-8")

        # Profile 3 may be mentioned in a deprecation/history callout — that's OK.
        # It must not appear as a step-by-step instruction or recommended path.
        # We check that "Profile 3" does not appear outside of blockquote/callout blocks.
        violations = []
        for lineno, line in enumerate(content.splitlines(), start=1):
            stripped = line.strip()
            if not stripped.startswith(">") and re.search(r"profile.3|split.system", line, re.IGNORECASE):
                violations.append((lineno, line.strip()))

        assert not violations, (
            f"profile-1-cpu.md references Profile 3 / split-system outside deprecated callout:\n"
            + "\n".join(f"  Line {ln}: {line!r}" for ln, line in violations)
        )

    def test_profile_2_doc_does_not_promote_profile_3(self):
        """profile-2-gpu.md must not present Profile 3 as an active deployment path."""
        path = _DEPLOYMENT / "profile-2-gpu.md"
        if not path.exists():
            pytest.skip("profile-2-gpu.md not found")
        content = path.read_text(encoding="utf-8")

        violations = []
        for lineno, line in enumerate(content.splitlines(), start=1):
            stripped = line.strip()
            if not stripped.startswith(">") and re.search(r"profile.3|split.system", line, re.IGNORECASE):
                violations.append((lineno, line.strip()))

        assert not violations, (
            f"profile-2-gpu.md references Profile 3 / split-system outside deprecated callout:\n"
            + "\n".join(f"  Line {ln}: {line!r}" for ln, line in violations)
        )

    def test_infrastructure_md_marked_deprecated_not_instructions(self):
        """infrastructure.md must be clearly marked as historical only — not as instructions."""
        content = _read(_DOCS / "infrastructure.md")
        # Must contain 'DEPRECATED' or 'retired' prominently
        assert re.search(r"DEPRECATED|retired|do not follow", content, re.IGNORECASE), (
            "infrastructure.md must be clearly marked as deprecated / not-to-follow"
        )

    def test_user_stories_story_020_has_superseded_notice(self):
        """STORY-020 in user-stories.md must carry a superseded-by notice per STORY-026 AC."""
        content = _read(_DOCS / "user-stories.md")

        # Find the STORY-020 section
        story_020_match = re.search(r"\[STORY-020\].*?(?=\[STORY-021\]|\Z)", content, re.DOTALL)
        if story_020_match is None:
            pytest.skip("STORY-020 section not found in user-stories.md")

        story_020_text = story_020_match.group(0)
        assert re.search(r"superseded|Superseded", story_020_text), (
            "STORY-020 in user-stories.md must contain a 'Superseded by' notice per STORY-026 AC"
        )


# ── TC-059: .env.example — placeholders and no real credentials ───────────────


class TestEnvTemplate:
    """TC-059: The .env.example (or .env.template) at the repo root must:

    1. Contain <PLACEHOLDER> or CHANGE_ME markers for all secret values.
    2. Contain instructions for generating strong passwords.
    3. Not contain any real credentials.
    """

    def _find_env_template(self) -> Path:
        """Find .env.example or .env.template at the repo root."""
        for name in (".env.example", ".env.template", "env.example"):
            path = _REPO_ROOT / name
            if path.exists():
                return path
        pytest.skip("No .env.example or .env.template found at repo root")

    def test_placeholder_markers_present(self):
        """All secret variables must have <PLACEHOLDER> or CHANGE_ME as their default."""
        path = self._find_env_template()
        content = path.read_text(encoding="utf-8")

        # Check that at least some placeholder markers are present
        assert re.search(r"<PLACEHOLDER>|CHANGE_ME|<YOUR_", content, re.IGNORECASE), (
            f"{path.name} must contain <PLACEHOLDER> or CHANGE_ME markers for secret variables"
        )

    def test_password_generation_instructions_present(self):
        """The template must document how to generate strong passwords."""
        path = self._find_env_template()
        content = path.read_text(encoding="utf-8")

        assert re.search(r"openssl rand|generate.*password|strong password", content, re.IGNORECASE), (
            f"{path.name} must include instructions for generating strong passwords "
            "(e.g., 'openssl rand -base64 32')"
        )

    def test_no_real_credentials(self):
        """The template must not contain real passwords, keys, or secrets."""
        path = self._find_env_template()
        content = path.read_text(encoding="utf-8")

        # Common patterns that indicate a real credential was accidentally committed
        # (non-placeholder, non-example values that look like actual secrets)
        real_cred_patterns = [
            r"password\s*=\s*[a-zA-Z0-9]{16,}(?!.*PLACEHOLDER)(?!.*CHANGE_ME)(?!.*<)",  # Long real password
            r"secret\s*=\s*[a-zA-Z0-9+/=]{32,}(?!.*PLACEHOLDER)(?!.*CHANGE_ME)(?!.*<)",  # Long real secret
            r"aws_secret_access_key\s*=\s*[a-zA-Z0-9+/]{40}",  # AWS secret key
        ]

        for pattern in real_cred_patterns:
            matches = re.findall(pattern, content, re.IGNORECASE)
            # Filter out lines that contain placeholder indicators
            real_matches = [
                m for m in matches
                if "PLACEHOLDER" not in m.upper() and "CHANGE_ME" not in m.upper()
                and "<" not in m
            ]
            assert not real_matches, (
                f"{path.name} appears to contain a real credential matching pattern {pattern!r}. "
                f"Matches: {real_matches}"
            )

    def test_required_variables_present(self):
        """The template must define the core required environment variables."""
        path = self._find_env_template()
        content = path.read_text(encoding="utf-8")

        required_vars = [
            "DATABASE_URL",
            "REDIS_URL",
        ]

        missing = [v for v in required_vars if v not in content]
        assert not missing, (
            f"{path.name} is missing required environment variable definitions: {missing}"
        )


# ── TC-022 supplement: Hardware requirements documented in profile docs ────────


class TestHardwareRequirements:
    """TC-050 / STORY-022: Verify that a single authoritative hardware requirements
    section exists in at least one of the two profile documents.
    """

    def test_minimum_cpu_documented(self):
        """At least one profile doc must document minimum CPU requirements."""
        found = False
        for doc_name in ("profile-1-cpu.md", "profile-2-gpu.md"):
            path = _DEPLOYMENT / doc_name
            if path.exists():
                content = path.read_text(encoding="utf-8")
                if re.search(r"cores?|threads?|CPU.*GHz|GHz.*CPU", content, re.IGNORECASE):
                    found = True
                    break
        assert found, "Neither profile-1-cpu.md nor profile-2-gpu.md documents minimum CPU requirements"

    def test_minimum_ram_documented(self):
        """At least one profile doc must document minimum RAM requirements."""
        found = False
        for doc_name in ("profile-1-cpu.md", "profile-2-gpu.md"):
            path = _DEPLOYMENT / doc_name
            if path.exists():
                content = path.read_text(encoding="utf-8")
                if re.search(r"\d+\s*GB.*RAM|RAM.*\d+\s*GB|memory", content, re.IGNORECASE):
                    found = True
                    break
        assert found, "Neither profile-1-cpu.md nor profile-2-gpu.md documents minimum RAM requirements"

    def test_minimum_storage_documented(self):
        """At least one profile doc must document minimum storage requirements."""
        found = False
        for doc_name in ("profile-1-cpu.md", "profile-2-gpu.md"):
            path = _DEPLOYMENT / doc_name
            if path.exists():
                content = path.read_text(encoding="utf-8")
                if re.search(r"\d+\s*GB.*[Ss]torage|[Ss]torage.*\d+\s*GB|disk|volume", content, re.IGNORECASE):
                    found = True
                    break
        assert found, "Neither profile-1-cpu.md nor profile-2-gpu.md documents minimum storage requirements"


# ── TC-054 / TC-055 (documentation check): CPU fallback language in GPU profile ─

class TestGPUFallbackLanguage:
    """TC-055: The GPU-enabled profile must document the CPU fallback behaviour
    so deployers know the GPU is optional.

    This is the documentation-level check; the runtime check is done by
    test_person_detection.py::TestInsightFaceCPUInit which verifies CPUExecutionProvider.
    """

    def test_gpu_optional_statement_present(self):
        """profile-2-gpu.md must explicitly state that the GPU is optional."""
        content = _read(_DEPLOYMENT / "profile-2-gpu.md")
        optional_pattern = re.compile(
            r"gpu.*optional|optional.*gpu|no gpu.*required|falls? back to cpu",
            re.IGNORECASE,
        )
        assert optional_pattern.search(content), (
            "profile-2-gpu.md must explicitly state that the GPU is optional "
            "and InsightFace falls back to CPU automatically."
        )

    def test_fallback_warning_message_documented(self):
        """The worker's fallback log message must be mentioned in the deployment doc."""
        content = _read(_DEPLOYMENT / "profile-2-gpu.md")
        # The log message from person_detection_worker.py on CPU fallback
        # Acceptable to document it as a quote or mention "falling back"
        assert re.search(r"falling back|fall.?back|CPUExecutionProvider", content, re.IGNORECASE), (
            "profile-2-gpu.md should document the fallback log message or CPUExecutionProvider"
        )
